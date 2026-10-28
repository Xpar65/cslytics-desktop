import type { AccountId, ConfirmationPress, ConfirmationTarget, MutationOutcome } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import { CONFIRM, ConfirmationStore, type ConfirmStepParams, type OwedConfirmation } from '../db/confirmations.js';
import { CsfloatStore } from '../db/csfloat.js';
import { WorkStore, type WorkStepRow } from '../db/work.js';
import { executeMutation, type EngineContext } from '../kernel/context.js';
import { ACCOUNT_MARKET, attemptReturned, postAttempt, type ProofNeed, type SurfaceRef } from '../kernel/evidence.js';
import { attemptsMade, settleNotApplied } from '../kernel/not-applied.js';
import { RETRY_POLICY, retryPlan } from '../kernel/retry-policy.js';
import { errorMessage } from '../kernel/support.js';
import type { ProofOwner } from '../policy/proof.js';

/** At most this many targets in one call: one call lists what awaits confirmation once, and a pass need not wait for the rest. */
export const CONFIRM_BATCH_LIMIT = 25;
/** The least time between two calls for one account (D12): Steam limits how often the list may be asked for. */
export const CONFIRM_PRESS_GAP_MS = 60_000;
/** The longest a loop rests between looks: a floor under the wake path, not the cadence. */
const IDLE_MS = 60_000;

const OFFERS: SurfaceRef = { surface: 'steam-trade-offers', scope: { kind: 'account' } };

type LoopControl = { stop: boolean; wake?: (() => void) | undefined };

/**
 * The engine's own confirmation of the listings and offers its own hops made, where a host has
 * composed a confirmation port (strategy authority and confirmations plan D7–D13).
 *
 * Without the port it does nothing at all: the desktop composes none, and a listing or an offer
 * there waits on the person's phone exactly as `read/queries/waiting.ts` describes. With one:
 *
 *  - **Only its own work** (D8). After every walk of the book or the offers it opens a
 *    confirmation, a command of one hop, for each `LIST` hop whose own attempt's listing the walk
 *    shows awaiting a tap and each send hop whose offer the walk shows at state 9. Nothing else is
 *    ever pressed: not a listing made by hand, not an offer this app did not send.
 *  - **Only a walk proves it** (D10). The port's answer is recorded as the attempt's outcome and
 *    believed by nothing. A walk showing the target past the tap settles it, whoever tapped; a
 *    complete walk begun after the press that still shows it waiting proves it did not apply, and
 *    the retry table sends it again on its schedule.
 *  - **Never for ended work** (D11). Before every press, the hop it follows must be open, and a
 *    CSFloat sale must still be pending and inside its deadline: a confirmed offer for an ended
 *    sale gives the item away.
 *  - **One call per account per minute** (D12), carrying every due target. A throttled call
 *    pressed nothing, and the account waits the time Steam named with no attempt recorded. A press
 *    is recorded after its answer for that reason; a crash in between leaves no attempt, and the
 *    next pass presses again, which confirming what is already confirmed survives.
 */
export class ConfirmationService implements ProofOwner {
  protected readonly store: ConfirmationStore;
  protected readonly work: WorkStore;
  private readonly loops = new Map<AccountId, LoopControl>();
  private readonly heldUntil = new Map<AccountId, number>();
  private readonly lastCallAt = new Map<AccountId, number>();
  private stopped = false;

  constructor(protected readonly context: EngineContext) {
    this.store = new ConfirmationStore(context.database);
    this.work = new WorkStore(context.database);
  }

  /** Whether a host composed the port. Without it nothing here runs. */
  get composed(): boolean {
    return this.context.ports.confirmation !== undefined;
  }

  /** Looks once; starts the account's loop if there is anything to do, or wakes the one running. */
  schedule(accountId: AccountId): void {
    if (this.stopped || !this.composed) return;
    const running = this.loops.get(accountId);
    if (running) { running.wake?.(); return; }
    const control: LoopControl = { stop: false };
    this.loops.set(accountId, control);
    void this.loop(accountId, control)
      .catch((error: unknown) => {
        if (!this.stopped) {
          try { this.context.database.addEvent(accountId, 'confirmation-loop-error', { message: errorMessage(error) }, this.context.now()); } catch { /* closed under us */ }
        }
      })
      .finally(() => { if (this.loops.get(accountId) === control) this.loops.delete(accountId); });
  }

  stopAccount(accountId: AccountId): void {
    const control = this.loops.get(accountId);
    if (!control) return;
    control.stop = true;
    control.wake?.();
  }

  stop(): void {
    this.stopped = true;
    for (const accountId of [...this.loops.keys()]) this.stopAccount(accountId);
  }

  /** What a pressed confirmation needs walked: the book for a listing, the offers for an offer, begun after the press returned. */
  needs(action: ActionRow): ProofNeed {
    if (action.kind !== CONFIRM) return { kind: 'none' };
    const target = (this.context.database.actionParams(action) as ConfirmStepParams).target;
    return { kind: 'walks', walks: [{ ref: target.kind === 'SELL_LISTING' ? ACCOUNT_MARKET : OFFERS, startedAfter: attemptReturned(this.context.database, action) }] };
  }

  /**
   * Settles each open confirmation by what the walks show (D10), run by every settle. Evidence
   * only, and idempotent: a target past the tap is done, one that ended without a tap is stopped,
   * and one a complete walk begun after the press still shows waiting was not applied.
   */
  reconcile(accountId: AccountId): void {
    if (!this.composed) return;
    for (const step of this.store.open(accountId)) this.judge(step);
  }

  protected judge(step: WorkStepRow): void {
    const { database } = this.context;
    const params = this.work.params<ConfirmStepParams>(step);
    const sighting = this.store.sighting(step.account_id, params.target);
    if (!sighting) return;
    const action = step.action_id ? database.action(step.action_id) : undefined;
    const now = this.context.now();
    if (sighting.state === 'confirmed') {
      database.transaction(() => {
        if (action && (action.state === 'READY' || action.state === 'AWAITING_OBSERVATION')) database.resolveAction(action, sighting.observationId, true, now);
        this.work.settle(step.id, 'DONE', sighting.observationId, now);
        database.setCommandState(step.command_id, 'COMPLETE');
      });
      return;
    }
    if (sighting.state === 'ended') {
      this.end(step, sighting.words ?? 'It ended before it was confirmed', sighting.observationId);
      return;
    }
    // Waiting. Only a walk begun after the press returned proves the press did not apply (rule 1).
    if (!action || action.state !== 'AWAITING_OBSERVATION') return;
    const obs = database.observation(step.account_id, sighting.observationId);
    if (!obs || !postAttempt(database, action, obs, true)) return;
    this.provedNotApplied(action, obs.id);
  }

  /** The press a walk proved did not apply: the retry table says when it goes again, or that it is done trying. Isolated so a saboteur can believe the answer instead. */
  protected provedNotApplied(action: ActionRow, observationId: number): void {
    const plan = settleNotApplied(this.context, action, observationId, 'Steam still shows it waiting for confirmation');
    this.work.mirror(action.id, this.context.now());
    if (plan.kind === 'exhausted') this.context.database.setCommandState(this.work.byAction(action.id)!.command_id, 'PARTIAL');
  }

  /** Ends a confirmation that must not be pressed: its target or the work it follows ended first. */
  protected end(step: WorkStepRow, reason: string, observationId: number | null): void {
    const { database } = this.context;
    const now = this.context.now();
    database.transaction(() => {
      const action = step.action_id ? database.action(step.action_id) : undefined;
      if (action && action.state !== 'DONE' && action.state !== 'FAILED') database.setActionState(action.id, 'FAILED', now, reason);
      this.work.settle(step.id, 'STOPPED', observationId, now, reason);
      database.setCommandState(step.command_id, 'PARTIAL', reason);
    });
  }

  /**
   * Opens a confirmation for each listing and offer of ours newly awaiting a tap (D8, D9). One per
   * target, ever: a target whose confirmation ended is never opened again, so a confirmation the
   * person stopped, or that ran out of presses, stays theirs.
   */
  protected openOwed(accountId: AccountId): void {
    const { database } = this.context;
    for (const owed of this.owed(accountId)) {
      const now = this.context.now();
      database.transaction(() => {
        if (this.store.forTarget(accountId, owed.targetId)) return;
        const params: ConfirmStepParams = { target: { kind: owed.kind, id: owed.targetId }, stepId: owed.stepId, commandId: owed.commandId, tradeId: owed.tradeId };
        const step = this.work.lone(CONFIRM, {
          accountId, kind: CONFIRM, localId: owed.localId, targetId: owed.targetId,
          offerId: owed.kind === 'TRADE_OFFER' ? owed.targetId : null, params, deadlineAt: this.deadlineOf(owed), now
        }, owed.authority);
        const action = database.enqueueAction({ accountId, stepId: step.id, actionKind: CONFIRM, targetId: owed.targetId,
          resourceKey: `confirm:${owed.kind}:${owed.targetId}`, params, now });
        this.work.attachAction(step.id, action.id, now);
        database.addEvent(accountId, 'confirmation-opened', { commandId: step.command_id, kind: owed.kind, targetId: owed.targetId, follows: owed.stepId }, now);
      });
    }
  }

  /** Our own hops awaiting a tap. Isolated so a saboteur can confirm what the account holds instead. */
  protected owed(accountId: AccountId): OwedConfirmation[] {
    return this.store.owed(accountId);
  }

  /** A delivery's offer must be confirmed before its sale's deadline; nothing else has one. */
  private deadlineOf(owed: OwedConfirmation): string | null {
    if (!owed.tradeId) return null;
    const trade = new CsfloatStore(this.context.database).trade(owed.accountId, owed.tradeId);
    return trade ? (JSON.parse(trade.data_json) as { deadlineAt?: string | null }).deadlineAt ?? null : null;
  }

  /**
   * Why this confirmation may no longer be pressed (D11), or `null`. The hop it follows has ended;
   * or it is a delivery's offer and the sale is no longer pending, or its deadline has passed.
   * Isolated so a saboteur can press regardless.
   */
  protected endedWork(step: WorkStepRow): string | null {
    const params = this.work.params<ConfirmStepParams>(step);
    const follows = this.work.step(params.stepId);
    // Settled at all: a hop that finished without the target past the tap has nothing left for a tap to do.
    if (!follows || ['DONE', 'FAILED', 'STOPPED'].includes(follows.state)) return 'The work it confirms has ended';
    const now = this.context.now();
    if (step.deadline_at && step.deadline_at <= now) return 'The sale\'s deadline has passed; confirming now would give the item away';
    if (params.tradeId) {
      const trade = new CsfloatStore(this.context.database).trade(step.account_id, params.tradeId);
      if (!trade || trade.state_word !== 'pending') return `The CSFloat sale is ${trade?.state_word ?? 'gone'}; confirming now would give the item away`;
    }
    return null;
  }

  /** When an open confirmation is next due: now for one never pressed, its retry time for one proved not applied, never while a press waits for its walk. */
  protected dueAt(step: WorkStepRow): number {
    const action = step.action_id ? this.context.database.action(step.action_id) : undefined;
    if (!action || action.state !== 'READY') return Number.POSITIVE_INFINITY;
    const attempts = attemptsMade(this.context.database, action.id);
    if (attempts === 0) return 0;
    if (action.resolution !== 'OBSERVED_NOT_APPLIED') return Number.POSITIVE_INFINITY;
    const plan = retryPlan(RETRY_POLICY[CONFIRM]!, attempts, action.updated_at);
    return plan.kind === 'again' ? Date.parse(plan.retryAt) : Number.POSITIVE_INFINITY;
  }

  private async loop(accountId: AccountId, control: LoopControl): Promise<void> {
    while (!control.stop && !this.stopped) {
      const next = await this.context.locks.run(accountId, () => this.pass(accountId));
      if (next === null || control.stop || this.stopped) return;
      const wait = next - this.context.ports.clock.now().getTime();
      if (wait > 0) await this.rest(control, Math.min(wait, IDLE_MS));
    }
  }

  private async rest(control: LoopControl, delayMs: number): Promise<void> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    control.wake = wake;
    try {
      await Promise.race([this.context.ports.clock.sleep(delayMs), woken]);
    } finally {
      control.wake = undefined;
    }
  }

  /**
   * One pass, under the account's lock: open what is owed, stop what may no longer be pressed,
   * press what is due. Returns when to look again, or `null` when nothing open has a time.
   */
  protected async pass(accountId: AccountId): Promise<number | null> {
    this.openOwed(accountId);
    const pressable: WorkStepRow[] = [];
    for (const step of this.store.open(accountId)) {
      const ended = this.endedWork(step);
      if (ended) this.end(step, ended, null);
      else pressable.push(step);
    }
    const nowMs = this.context.ports.clock.now().getTime();
    const times = pressable.map((step) => this.dueAt(step)).filter(Number.isFinite);
    if (!times.length) return null;
    const allowed = Math.max(this.heldUntil.get(accountId) ?? 0, (this.lastCallAt.get(accountId) ?? Number.NEGATIVE_INFINITY) + CONFIRM_PRESS_GAP_MS);
    const due = pressable.filter((step) => this.dueAt(step) <= nowMs).slice(0, CONFIRM_BATCH_LIMIT);
    if (!due.length || allowed > nowMs) return Math.max(allowed, Math.min(...times));
    await this.press(accountId, due);
    return nowMs + CONFIRM_PRESS_GAP_MS;
  }

  /** One call for every due target, then each target's attempt from the answer (D12). */
  protected async press(accountId: AccountId, due: readonly WorkStepRow[]): Promise<void> {
    const port = this.context.ports.confirmation!;
    const targets: ConfirmationTarget[] = due.map((step) => this.work.params<ConfirmStepParams>(step).target);
    let answer: ConfirmationPress;
    try {
      answer = await port.confirm(accountId, targets);
    } catch (error) {
      // The call failed before any answer: each target may or may not have been pressed, and the walk decides.
      answer = { kind: 'pressed', outcomes: Object.fromEntries(targets.map((target) => [target.id, { kind: 'AMBIGUOUS', cause: 'transport', raw: errorMessage(error) } as MutationOutcome])) };
    }
    this.lastCallAt.set(accountId, this.context.ports.clock.now().getTime());
    if (answer.kind === 'throttled') this.throttled(accountId, due, answer.retryAfterMs);
    else await this.record(due, answer.outcomes);
  }

  /** Nothing was pressed (D12): the account waits the time Steam named, and no attempt is recorded. Isolated so a saboteur can count it as a press. */
  protected throttled(accountId: AccountId, due: readonly WorkStepRow[], retryAfterMs: number): void {
    const until = new Date(this.context.ports.clock.now().getTime() + Math.max(1_000, retryAfterMs)).toISOString();
    this.heldUntil.set(accountId, Date.parse(until));
    for (const step of due) this.work.update(step.id, { reason: `Steam is limiting confirmations; the next press is after ${until}` }, this.context.now());
    this.context.database.addEvent(accountId, 'confirmation-throttled', { until, targets: due.map((step) => step.target_id) }, this.context.now());
  }

  /** Each pressed target's attempt, from the answer: evidence for the walk, never the settlement (D10). */
  protected async record(due: readonly WorkStepRow[], outcomes: Readonly<Record<string, MutationOutcome>>): Promise<void> {
    for (const step of due) {
      const action = step.action_id ? this.context.database.action(step.action_id) : undefined;
      if (!action || action.state !== 'READY') continue;
      const id = this.work.params<ConfirmStepParams>(step).target.id;
      const outcome = this.recorded(outcomes[id] ?? { kind: 'AMBIGUOUS', cause: 'unclassified', raw: 'the answer did not name this target' });
      try {
        await executeMutation(this.context, action, () => Promise.resolve(outcome));
        this.work.update(step.id, { reason: null }, this.context.now());
      } catch (error) {
        // Refused before it was recorded (an open circuit): nothing more is known, and it stays due.
        this.work.update(step.id, { reason: errorMessage(error) }, this.context.now());
      }
      this.work.mirror(action.id, this.context.now());
    }
  }

  /**
   * The answer as the attempt records it. A refusal is evidence, never an ending (D10): "not found"
   * is also what an already-applied confirmation answers, so it is kept verbatim and the walk decides.
   */
  protected recorded(outcome: MutationOutcome): MutationOutcome {
    return outcome.kind === 'DEFINITIVELY_REJECTED' ? { kind: 'SUBMITTED', evidence: `answered: ${outcome.reason}`, raw: outcome.raw } : outcome;
  }
}
