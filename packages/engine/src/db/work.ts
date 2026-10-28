import { randomUUID } from 'node:crypto';
import type { MutationOutcome } from '@cslytics/ports';
import type { ActionRow, EngineDatabase } from './database.js';
import { OPEN_STEP_STATES, SETTLED_STEP_STATES, sqlList, type CommandAuthority, type WorkStepKind, type WorkStepState } from './alphabets.js';

/**
 * One row per hop of a command (consolidation plan D2). A step names the holding or the remote
 * object it is about, the one action that carries it when one exists, the observation that settled
 * it, and the terms it was admitted with, frozen in `params_json`. Its state is the one work
 * alphabet; the venue's own view of the same hop (a listing pending confirmation, an offer in
 * escrow) is read from the venue's rows at read time and never copied here.
 */
export type WorkStepRow = {
  id: string;
  command_id: string;
  account_id: string;
  local_id: string | null;
  /** The remote object the step is about: a listing id, an order id, a trade id, a transaction id. */
  target_id: string | null;
  /** The Steam offer the step sent or acts on. */
  offer_id: string | null;
  ordinal: number;
  kind: WorkStepKind;
  state: WorkStepState;
  action_id: string | null;
  /** A standing intent the step set, for a hop a goal carries (a listing at a price). */
  desired_id: string | null;
  reason: string | null;
  params_json: string | null;
  /** The observation that settled the step (D16: a decided row carries one). */
  observation_id: number | null;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TransferDetailRow = {
  step_id: string; account_id: string; destination_account_id: string; destination_baseline_json: string;
  accepted_at: string | null; accepted_obs: number | null; completed_source_obs: number | null; completed_destination_obs: number | null;
};

export type StoreLineRow = {
  step_id: string; account_id: string; line_index: number; entry_key: string; def_index: number; quantity: number;
  unit_price_cents: number; baseline_quantity: number; observed_quantity: number;
};

export type StepInput = {
  id?: string;
  commandId: string;
  accountId: string;
  ordinal: number;
  kind: WorkStepKind;
  localId?: string | null;
  targetId?: string | null;
  offerId?: string | null;
  params?: unknown;
  reason?: string | null;
  desiredId?: string | null;
  deadlineAt?: string | null;
  now: string;
};

export const OPEN_STEP_STATES_SQL = `(${sqlList(OPEN_STEP_STATES)})`;
export const SETTLED_STEP_STATES_SQL = `(${sqlList(SETTLED_STEP_STATES)})`;

/** The reason on a hop that was never reached, because an earlier hop of the same member failed. */
export const HOP_NOT_REACHED = 'An earlier hop failed';

export function isSettled(step: Pick<WorkStepRow, 'state'>): boolean {
  return (SETTLED_STEP_STATES as readonly string[]).includes(step.state);
}

export class WorkStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * Admits a command row for work that arrives with its own id, as a CSFloat edit or a store
   * purchase does. A command that exists is returned as it is: the same id is the same command.
   */
  adoptCommand(id: string, kind: string, now: string, authority: CommandAuthority = 'HUMAN'): void {
    this.db.raw().prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed, authority)
      VALUES (?, ?, ?, 'ADMITTED', NULL, ?, 0, NULL, 0, ?)`).run(id, randomUUID(), kind, now, authority);
  }

  insert(input: StepInput): WorkStepRow {
    const id = input.id ?? randomUUID();
    this.db.raw().prepare(`
      INSERT INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
        reason, params_json, observation_id, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, ?, ?, ?, NULL, ?, ?, ?)
    `).run(id, input.commandId, input.accountId, input.localId ?? null, input.targetId ?? null, input.offerId ?? null, input.ordinal, input.kind,
      input.desiredId ?? null, input.reason ?? null, input.params === undefined ? null : JSON.stringify(input.params), input.deadlineAt ?? null, input.now, input.now);
    this.db.touch(input.accountId, 'work');
    return this.step(id)!;
  }

  step(id: string): WorkStepRow | undefined {
    return this.db.raw().prepare('SELECT * FROM work_step WHERE id=?').get(id) as WorkStepRow | undefined;
  }

  /** A command's steps, each account's in hop order. */
  steps(commandId: string, accountId?: string): WorkStepRow[] {
    return this.db.raw().prepare(`SELECT * FROM work_step WHERE command_id=? ${accountId ? 'AND account_id=?' : ''} ORDER BY account_id, ordinal, id`)
      .all(commandId, ...(accountId ? [accountId] : [])) as WorkStepRow[];
  }

  byAction(actionId: string): WorkStepRow | undefined {
    return this.db.raw().prepare('SELECT * FROM work_step WHERE action_id=?').get(actionId) as WorkStepRow | undefined;
  }

  /** Steps about one holding, newest command first. */
  stepsFor(accountId: string, localId: string): WorkStepRow[] {
    return this.db.raw().prepare('SELECT * FROM work_step WHERE account_id=? AND local_id=? ORDER BY created_at DESC, ordinal DESC').all(accountId, localId) as WorkStepRow[];
  }

  /** Unsettled steps of an account, oldest first, optionally of some kinds. */
  open(accountId: string, kinds?: readonly WorkStepKind[]): WorkStepRow[] {
    const byKind = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    return this.db.raw().prepare(`SELECT * FROM work_step WHERE account_id=? AND state IN ${OPEN_STEP_STATES_SQL}${byKind} ORDER BY created_at, ordinal, id`)
      .all(accountId, ...(kinds ?? [])) as WorkStepRow[];
  }

  /**
   * Unsettled steps of an account's commands of some kinds, oldest first; `kinds` narrows the hop.
   * A driver asks this way because a hop kind is shared: a `RETRIEVE` under a CSFloat listing is
   * the CSFloat driver's, and one under a Steam listing is the command service's.
   */
  openOf(accountId: string, commandKinds: readonly string[], kinds?: readonly WorkStepKind[]): WorkStepRow[] {
    if (!commandKinds.length) return [];
    const byKind = kinds?.length ? ` AND s.kind IN (${kinds.map(() => '?').join(',')})` : '';
    return this.db.raw().prepare(`SELECT s.* FROM work_step s JOIN command c ON c.id=s.command_id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND c.kind IN (${commandKinds.map(() => '?').join(',')})${byKind}
      ORDER BY s.created_at, s.ordinal, s.id`).all(accountId, ...commandKinds, ...(kinds ?? [])) as WorkStepRow[];
  }

  /** Unsettled steps about one remote object, as an order or a listing is named. */
  openForTarget(accountId: string, kind: WorkStepKind, targetId: string): WorkStepRow[] {
    return this.db.raw().prepare(`SELECT * FROM work_step WHERE account_id=? AND kind=? AND target_id=? AND state IN ${OPEN_STEP_STATES_SQL} ORDER BY created_at, id`)
      .all(accountId, kind, targetId) as WorkStepRow[];
  }

  /** The hops of one member of a command: the steps sharing the step's command, account and holding, in order. */
  hops(step: WorkStepRow): WorkStepRow[] {
    return this.db.raw().prepare('SELECT * FROM work_step WHERE command_id=? AND account_id=? AND local_id IS ? ORDER BY ordinal, id')
      .all(step.command_id, step.account_id, step.local_id) as WorkStepRow[];
  }

  /** One member's hops, in order: a command's steps about one holding. */
  hopsOf(commandId: string, accountId: string, localId: string): WorkStepRow[] {
    return this.db.raw().prepare('SELECT * FROM work_step WHERE command_id=? AND account_id=? AND local_id=? ORDER BY ordinal, id')
      .all(commandId, accountId, localId) as WorkStepRow[];
  }

  update(id: string, patch: Partial<Pick<WorkStepRow, 'local_id' | 'target_id' | 'offer_id' | 'state' | 'action_id' | 'desired_id' | 'reason' | 'params_json' | 'observation_id' | 'deadline_at'>>, now: string): void {
    const columns = Object.keys(patch) as Array<keyof typeof patch>;
    if (!columns.length) return;
    const touched = this.db.raw().prepare(`UPDATE work_step SET ${columns.map((column) => `${column}=?`).join(', ')}, updated_at=? WHERE id=? RETURNING account_id`)
      .get(...columns.map((column) => patch[column] ?? null), now, id) as { account_id: string } | undefined;
    if (touched) this.db.touch(touched.account_id, 'work');
  }

  setState(id: string, state: WorkStepState, now: string, reason: string | null = null): void {
    this.update(id, { state, reason }, now);
  }

  /** Settles a step on an observation, or on a refusal when there is none. */
  settle(id: string, state: 'DONE' | 'FAILED' | 'STOPPED', observationId: number | null, now: string, reason: string | null = null): void {
    this.update(id, { state, reason, observation_id: observationId }, now);
  }

  /**
   * Fails a hop and stops every later hop of the same member. A chain does not continue past a
   * hop that did not happen, and the hops after it record that they were never reached rather
   * than that they failed: nothing was ever sent for them.
   */
  failHop(step: WorkStepRow, reason: string, now: string, observationId: number | null = null): void {
    this.db.transaction(() => {
      this.settle(step.id, 'FAILED', observationId, now, reason);
      this.stopLater(step, now);
    });
  }

  /** Stops every unsettled hop after `step` of the same member: an earlier hop ended the chain. */
  stopLater(step: WorkStepRow, now: string, reason: string = HOP_NOT_REACHED): void {
    for (const later of this.hops(step)) {
      if (later.ordinal > step.ordinal && !isSettled(later)) this.settle(later.id, 'STOPPED', null, now, reason);
    }
  }

  attachAction(id: string, actionId: string, now: string): void {
    this.update(id, { action_id: actionId }, now);
  }

  /**
   * A command of one hop, admitted with its own id: a delist asked for by hand, a buy order placed
   * or cancelled. The work panel reads it as any other hop (consolidation plan §4.4).
   */
  lone(commandKind: string, input: Omit<StepInput, 'id' | 'commandId' | 'ordinal'>, authority: CommandAuthority = 'HUMAN'): WorkStepRow {
    const commandId = randomUUID();
    this.adoptCommand(commandId, commandKind, input.now, authority);
    return this.insert({ ...input, id: `${commandId}:0`, commandId, ordinal: 0 });
  }

  /**
   * Brings the hop an action carries, if any, to what the action now says, and a command whose
   * hops are all settled to its outcome. A surface calls it after a send, the resender after a
   * resend, so the panel reads the reply's state the moment it is known.
   */
  mirror(actionId: string, now: string): void {
    const step = this.byAction(actionId);
    if (!step) return;
    const after = isSettled(step) ? step : this.reflectAction(step, now);
    if (!isSettled(after)) return;
    const hops = this.steps(after.command_id);
    if (!hops.every(isSettled)) return;
    const command = this.db.command(after.command_id);
    if (command && (command.state === 'ADMITTED' || command.state === 'RUNNING')) {
      this.db.setCommandState(after.command_id, hops.some((hop) => hop.state === 'FAILED') ? 'PARTIAL' : 'COMPLETE');
    }
  }

  /**
   * A refusal before anything went out, on the hop an action carries: the action fails with the
   * reason, the hop with it, and the hops after it are never reached (OP-08).
   */
  refuse(actionId: string, reason: string, now: string): void {
    const step = this.byAction(actionId);
    if (!step || isSettled(step)) return;
    if (this.db.action(actionId)?.state === 'READY') this.db.setActionState(actionId, 'FAILED', now, reason);
    this.failHop(step, reason, now);
    this.mirror(actionId, now);
  }

  /** Sends an action and keeps the hop it carries in step: the reply's state after the send, the refusal when nothing went out. */
  async send(actionId: string, call: () => Promise<MutationOutcome>, now: () => string): Promise<MutationOutcome> {
    try {
      const outcome = await call();
      this.mirror(actionId, now());
      return outcome;
    } catch (error) {
      this.refuse(actionId, error instanceof Error ? error.message : String(error), now());
      throw error;
    }
  }

  params<T>(step: WorkStepRow): T {
    return JSON.parse(step.params_json ?? 'null') as T;
  }

  /**
   * The step state an action's state implies while the action is the authority: before an
   * observation has said anything about the hop.
   */
  stateOf(action: ActionRow | undefined): WorkStepState {
    if (!action) return 'QUEUED';
    if (action.state === 'RUNNING') return 'SENT';
    if (action.state === 'AWAITING_OBSERVATION') return 'AWAITING_OBSERVATION';
    if (action.state === 'DONE') return 'DONE';
    if (action.state === 'FAILED') return 'FAILED';
    return action.resolution === 'OBSERVED_NOT_APPLIED' ? 'RETRYING' : 'QUEUED';
  }

  /** Brings an unsettled step to the state its action implies, keeping its reason unless the action failed. */
  reflectAction(step: WorkStepRow, now: string): WorkStepRow {
    if (!step.action_id || isSettled(step)) return step;
    const action = this.db.action(step.action_id);
    const state = this.stateOf(action);
    if (state === step.state) return step;
    const reason = state === 'FAILED' ? action?.error ?? step.reason : state === 'DONE' ? null : step.reason;
    this.update(step.id, { state, reason, ...(state === 'DONE' || state === 'FAILED' ? { observation_id: action?.resolved_by_obs ?? null } : {}) }, now);
    return this.step(step.id)!;
  }

  /** Every unsettled step of a command that has no attempt yet, stopped on the person's word. */
  stopUnsent(commandId: string, now: string): WorkStepRow[] {
    const stopped: WorkStepRow[] = [];
    for (const step of this.steps(commandId)) {
      if (step.state !== 'QUEUED') continue;
      if (step.action_id && this.db.latestAttempt(step.action_id)) continue;
      this.setState(step.id, 'STOPPED', now, 'command-stopped');
      stopped.push(this.step(step.id)!);
    }
    return stopped;
  }

  insertTransferDetail(row: TransferDetailRow): void {
    this.db.raw().prepare(`INSERT INTO transfer_detail(step_id, account_id, destination_account_id, destination_baseline_json, accepted_at, accepted_obs, completed_source_obs, completed_destination_obs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.step_id, row.account_id, row.destination_account_id, row.destination_baseline_json, row.accepted_at, row.accepted_obs, row.completed_source_obs, row.completed_destination_obs);
  }

  transferDetail(stepId: string): TransferDetailRow | undefined {
    return this.db.raw().prepare('SELECT * FROM transfer_detail WHERE step_id=?').get(stepId) as TransferDetailRow | undefined;
  }

  updateTransferDetail(stepId: string, patch: Partial<Omit<TransferDetailRow, 'step_id' | 'account_id'>>): void {
    const columns = Object.keys(patch) as Array<keyof typeof patch>;
    if (!columns.length) return;
    this.db.raw().prepare(`UPDATE transfer_detail SET ${columns.map((column) => `${column}=?`).join(', ')} WHERE step_id=?`)
      .run(...columns.map((column) => patch[column] ?? null), stepId);
  }

  insertStoreLine(row: StoreLineRow): void {
    this.db.raw().prepare(`INSERT INTO store_line(step_id, account_id, line_index, entry_key, def_index, quantity, unit_price_cents, baseline_quantity, observed_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.step_id, row.account_id, row.line_index, row.entry_key, row.def_index, row.quantity, row.unit_price_cents, row.baseline_quantity, row.observed_quantity);
  }

  storeLines(stepId: string): StoreLineRow[] {
    return this.db.raw().prepare('SELECT * FROM store_line WHERE step_id=? ORDER BY line_index').all(stepId) as StoreLineRow[];
  }

  setObservedQuantity(stepId: string, lineIndex: number, quantity: number): void {
    this.db.raw().prepare('UPDATE store_line SET observed_quantity=? WHERE step_id=? AND line_index=?').run(quantity, stepId, lineIndex);
  }
}
