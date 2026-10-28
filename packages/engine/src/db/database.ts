import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AccountId } from '@cslytics/ports';
import type { CommandAuthority, CommandMemberState } from './alphabets.js';
import { applySchema, existingVersion, SchemaNewerThanAppError, SCHEMA_VERSION } from './index.js';
import { backupBeforeUpgrade } from './backup.js';
import { WorkStore, isSettled } from './work.js';
import { OrderStore } from './orders.js';
import type { OrderVenue } from './alphabets.js';

export type AccountRow = {
  id: string;
  steam_id64: string;
  account_name: string;
  added_at: string;
  persona_name: string | null;
  avatar_hash: string | null;
  persona_obs: number | null;
  /** The account's own trade token and the read that gave it (D14); the partner id is derived from the SteamID64. */
  trade_token: string | null;
  trade_token_obs: number | null;
};

/** Steam login names are unique and case-insensitive; this is the local `accountId`. */
export function canonicalAccountId(username: string): string {
  const id = username.trim().toLowerCase();
  if (!id) throw new Error('Steam username is required');
  return id;
}

export type ObservationStart = {
  accountId: AccountId;
  surface: string;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  pagesWalked?: number;
  totalExpected?: number;
  generation?: number;
  error?: string;
  scopeKind?: ScopeKind;
  scopeId?: string;
};

export type ScopeKind = 'account' | 'casket' | 'item' | 'listing';
export type ObservationRow = {
  id: number; account_id: string; surface: string; scope_kind: ScopeKind | null; scope_id: string | null;
  generation: number | null; started_at: string; finished_at: string; complete: number;
  pages_walked: number | null; total_expected: number | null; error: string | null;
};
export type AttemptRow = {
  id: string; action_id: string; started_at: string; finished_at: string | null;
  outcome: string | null; request_ref: string | null; response_ref: string | null;
  /** When the venue that refused this attempt says the same request may go again; null for every other answer. */
  retry_after: string | null;
};

export type ItemRow = {
  local_id: string;
  account_id: string;
  def_index: number;
  paint_index: number | null;
  paint_wear: number | null;
  paint_seed: number | null;
  quality: number;
  /** The identity key's fourth field, derived on ingest by `kernel/identity.kitToken`. */
  kit: string;
  stable_key: string;
  asset_id: string | null;
  /**
   * Where the Game Coordinator holds the unit. Never "on the market": the GC keeps a listed item in
   * the inventory, so being listed is an open listing (`db/steam-listing.ts`), not a location.
   */
  location: 'MAIN' | 'CASKET' | 'MISSING';
  casket_id: string | null;
  tradable_after: string | null;
  trade_protected_until: string | null;
  first_seen_obs: number;
  last_seen_obs: number;
  location_obs: number | null;
  location_generation: number | null;
  /** `individual` (paint tuple, storage unit) or `fungible`; decides the read model's row shape. */
  unit_kind: 'individual' | 'fungible';
  /** The interchangeability key (holdings plan D4): `kernel/identity.groupKey`. */
  group_key: string;
  quantity: number;
  reserved_command: string | null;
  /** `kernel/attributes.encodeAttributes`: every attribute the GC sent, decoded, as JSON. */
  attributes_json: string;
  end_reason: 'sold' | 'traded' | 'consumed' | 'unknown' | null;
};

export type ItemLineageRow = {
  account_id: string;
  from_local_id: string;
  to_local_id: string;
  evidence: 'trade-receipt' | 'fingerprint';
  observation_id: number;
  created_at: string;
};

export type ItemAccessoryRow = {
  account_id: string;
  local_id: string;
  kind: 'sticker-slot' | 'charm-slot';
  slot: number;
  kit_id: number;
  wear: number | null;
  scale: number | null;
  rotation: number | null;
  pattern: number | null;
  highlight: number | null;
  observation_id: number;
};

export type ActionRow = {
  id: string;
  account_id: string;
  kind: string;
  target_id: string;
  desired_version: number;
  desired_id: string | null;
  state: 'READY' | 'RUNNING' | 'AWAITING_OBSERVATION' | 'DONE' | 'FAILED';
  resource_key: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  /** Step snapshot for this attempt. The standing goal lives on `desired_state`. */
  params_json: string | null;
  resolved_by_obs: number | null;
  resolution: 'OBSERVED_APPLIED' | 'OBSERVED_NOT_APPLIED' | null;
  /** The hop of a command this action carries, when no standing intent does (consolidation plan D3). */
  step_id: string | null;
};

export type DesiredStateRow = {
  id: string;
  account_id: string;
  target_kind: string;
  target_id: string;
  version: number;
  intent: string;
  params_json: string;
  created_at: string;
  superseded_by: string | null;
  authority: string;
  suspended_reason: string | null;
  suspended_at: string | null;
  blocked_until: string | null;
  expires_at: string | null;
  /** The command that set the goal, when one did (consolidation plan D15). */
  command_id: string | null;
};

/** A stack as `commodityStacks` reads it: the fungible units of one group at one location, summed. */
export type CommodityStackRow = {
  account_id: string;
  stack_key: string;
  location: ItemRow['location'];
  casket_id: string;
  def_index: number;
  quality: number;
  kit: string;
  quantity: number;
  last_seen_obs: number;
};

export type StorageUnitRow = {
  account_id: string;
  casket_id: string;
  label: string | null;
  contains_count: number;
  contents_obs: number | null;
  state: 'ACTIVE' | 'FULL' | 'DISABLED';
  /** The observation that last wrote `label`. A label is only as good as its proof. */
  label_obs: number | null;
};

export type CommandRow = {
  id: string;
  correlation_id: string;
  kind: string;
  state: 'DRAFT' | 'REJECTED' | 'ADMITTED' | 'RUNNING' | 'PARTIAL' | 'COMPLETE' | 'STOPPED';
  reject_reason: string | null;
  created_at: string;
  preparing?: number;
  manifest_token?: string | null;
  observed_completed?: number;
  revision?: number;
  filter_json?: string | null;
  /** Whose the command is (strategy authority plan D1); a person's when not said. */
  authority?: CommandAuthority;
};

/** The kind of a command that is a selection draft (consolidation plan §4.4). */
export const SELECTION_KIND = 'SELECTION';

/** One frozen member of a selection draft, as `command_member.input_json` keeps it. */
export type DraftMember = { accountId: string; localId?: string; stackKey?: string; quantity: number; location: string | null; casketId: string | null };
export type DraftMemberRow = DraftMember & { memberId: string };

/**
 * A command member: the holding a command is about, the terms it was admitted with, and the words
 * no hop can say for it (`COMMAND_MEMBER_STATES`). What it is doing is its hops in `work_step`.
 */
export type CommandMemberRow = {
  input_json?: string | null;
  command_id: string;
  account_id: string;
  local_id: string;
  stack_key: string | null;
  quantity: number;
  destination: string | null;
  price_receive_cents: number | null;
  state: CommandMemberState;
};

/** A member as read back, with the action its latest hop carries, for callers that act on it. */
export type CommandMemberView = CommandMemberRow & { action_id: string | null };

const IN_FLIGHT_STATES = "('READY','RUNNING','AWAITING_OBSERVATION')";

/** What `enqueueAction` takes: the common fields and exactly one carrier. */
export type EnqueueActionInput = {
  accountId: string;
  actionKind: string;
  targetId: string;
  resourceKey: string;
  params: unknown;
  now: string;
} & ({ desiredId: string; desiredVersion: number } | { stepId: string });

export type CheckpointRow = {
  account_id: string; surface: string; scope_id: string; cursor_json: string;
  covered_through: string | null; observation_id: number | null; updated_at: string;
};

export class EngineDatabase {
  private readonly sqlite: DatabaseSync;

  /**
   * `now` is the engine's clock, used for the two stamps written while the record opens: the
   * schema stamp and the recovery of actions interrupted mid-flight. No statement here asks SQLite
   * for the time (consolidation plan D23); the runtime passes its clock and a test its virtual one.
   */
  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    this.sqlite = new DatabaseSync(path);
    try {
      // The connection, in one place (consolidation plan D20). Foreign keys are off by default in
      // SQLite and every delete here relies on them; the busy timeout covers a read-only diagnostic
      // copy, since the runtime is the only writer.
      this.sqlite.exec('PRAGMA foreign_keys = ON');
      this.sqlite.exec('PRAGMA busy_timeout = 5000');
      // A record a newer build wrote is refused before anything here writes to it — switching the
      // journal to WAL rewrites the file header — and a record this build is about to upgrade is
      // copied first. Both throw with the record untouched, and the handle is closed so the file
      // is not left locked on Windows for whoever handles the error.
      const found = existingVersion(this.sqlite);
      if (found !== null && found > SCHEMA_VERSION) throw new SchemaNewerThanAppError(found, SCHEMA_VERSION);
      this.sqlite.exec('PRAGMA journal_mode = WAL');
      // FULL, not NORMAL: a committed intent (a command, a sent attempt) must survive a power cut,
      // because the next open reasons from it. The log is truncated after a checkpoint so a busy
      // walk does not leave a large -wal beside the record for good.
      this.sqlite.exec('PRAGMA synchronous = FULL');
      this.sqlite.exec('PRAGMA journal_size_limit = 16777216');
      if (found !== null && found < SCHEMA_VERSION && path !== ':memory:') backupBeforeUpgrade(this.sqlite, path, found, new Date(now()));
      applySchema(this.sqlite, now());
      // Statistics for the planner, gathered only when SQLite judges them stale (D20). Without
      // them every index choice is a guess, and records in use had none for five weeks.
      this.sqlite.exec('PRAGMA optimize');
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
    this.recoverInterruptedActions(now());
  }

  close(): void {
    if (!this.sqlite.isOpen) return;
    try {
      this.sqlite.exec('PRAGMA optimize');
    } catch {
      // Statistics are a courtesy to the next open; closing never waits on them.
    }
    this.sqlite.close();
  }

  transaction<T>(work: () => T): T {
    // Callers may compose short synchronous database operations in one outer transaction.
    if (this.sqlite.isTransaction) return work();
    this.sqlite.exec('BEGIN IMMEDIATE');
    this.sqlite.exec('PRAGMA defer_foreign_keys = ON');
    try {
      const result = work();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  addAccount(accountId: string, steamId64: string, accountName: string, now: string): void {
    this.sqlite.prepare(`
      INSERT INTO account(id, steam_id64, account_name, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET steam_id64=excluded.steam_id64, account_name=excluded.account_name
    `).run(accountId, steamId64, accountName, now);
  }

  account(accountId: string): AccountRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM account WHERE id=?`).get(accountId) as AccountRow | undefined;
  }

  findAccountByName(username: string): AccountRow | undefined {
    const name = username.trim();
    if (!name) return undefined;
    return this.sqlite.prepare(`
      SELECT * FROM account WHERE account_name = ? COLLATE NOCASE OR id = ? COLLATE NOCASE LIMIT 1
    `).get(name, name) as AccountRow | undefined;
  }

  listAccounts(): AccountRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM account ORDER BY account_name COLLATE NOCASE, id
    `).all() as AccountRow[];
  }

  /**
   * Inserts a Steam account, or returns the existing row for that username / SteamID64.
   * The local id is the canonical Steam username so the same login cannot create two rows.
   */
  ensureAccount(preferredId: string, steamId64: string, accountName: string, now: string): string {
    const name = accountName.trim() || preferredId.trim();
    if (!name) throw new Error('Steam authenticated without an account name');
    const id = canonicalAccountId(preferredId.trim() || name);

    const existing = this.findAccountByName(name)
      ?? this.findAccountByName(id)
      ?? (this.sqlite.prepare(`SELECT * FROM account WHERE steam_id64=?`).get(steamId64) as AccountRow | undefined);
    if (existing) {
      this.sqlite.prepare(`UPDATE account SET steam_id64=?, account_name=? WHERE id=?`)
        .run(steamId64, name, existing.id);
      return existing.id;
    }

    this.sqlite.prepare(`
      INSERT INTO account(id, steam_id64, account_name, added_at) VALUES (?, ?, ?, ?)
    `).run(id, steamId64, name, now);
    return id;
  }

  addCredentialRef(accountId: string, kind: string, keychainKey: string): void {
    this.sqlite.prepare(`
      INSERT INTO credential_ref(account_id, kind, keychain_key) VALUES (?, ?, ?)
      ON CONFLICT(account_id, kind) DO UPDATE SET keychain_key=excluded.keychain_key
    `).run(accountId, kind, keychainKey);
  }

  insertObservation(observation: ObservationStart): number {
    const result = this.sqlite.prepare(`
      INSERT INTO observation(account_id, surface, generation, started_at, finished_at, complete, pages_walked, total_expected, error, scope_kind, scope_id)
      VALUES (@accountId, @surface, @generation, @startedAt, @finishedAt, @complete, @pagesWalked, @totalExpected, @error, @scopeKind, @scopeId)
    `).run({
      accountId: observation.accountId,
      surface: observation.surface,
      generation: observation.generation ?? null,
      startedAt: observation.startedAt,
      finishedAt: observation.finishedAt,
      complete: observation.complete ? 1 : 0,
      pagesWalked: observation.pagesWalked ?? 0,
      totalExpected: observation.totalExpected ?? null,
      error: observation.error ?? null,
      scopeKind: observation.scopeKind ?? 'account',
      scopeId: observation.scopeId ?? null
    });
    return Number(result.lastInsertRowid);
  }

  latestObservation(accountId: string, surface: string): ObservationRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM observation
      WHERE account_id=? AND surface=? ORDER BY id DESC LIMIT 1
    `).get(accountId, surface) as ObservationRow | undefined;
  }

  observation(accountId: string, id: number | null): ObservationRow | undefined {
    if (id === null) return undefined;
    return this.sqlite.prepare(`SELECT * FROM observation WHERE account_id=? AND id=?`).get(accountId, id) as ObservationRow | undefined;
  }

  latestObservationForScope(accountId: string, kind: ScopeKind, id: string | null, surface?: string): ObservationRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM observation WHERE account_id=? AND scope_kind=? AND scope_id IS ?
      ${surface ? 'AND surface=?' : ''} ORDER BY id DESC LIMIT 1`)
      .get(accountId, kind, id, ...(surface ? [surface] : [])) as ObservationRow | undefined;
  }

  /**
   * Last finished walk of a scope. An in-progress snapshot (`complete=0`) is not a walk:
   * it cannot prove presence or absence, and it must not hide the last published one
   * (plans/completed/delivery-step-3-plan.md §3.4).
   */
  latestCompleteObservationForScope(accountId: string, kind: ScopeKind, id: string | null, surface?: string): ObservationRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM observation WHERE account_id=? AND scope_kind=? AND scope_id IS ?
      ${surface ? 'AND surface=?' : ''} AND complete=1 AND error IS NULL ORDER BY id DESC LIMIT 1`)
      .get(accountId, kind, id, ...(surface ? [surface] : [])) as ObservationRow | undefined;
  }

  /**
   * The row generation a walk writes under: the staging one while a snapshot stages, else the
   * published one. `HoldingsStore.upsertUnit` is the writer that needs it.
   */
  reserveMainSlot(accountId: string, actionId: string): void {
    this.sqlite.prepare(`
      INSERT INTO reservation(account_id, ref_kind, ref_id, amount_cents, state)
      VALUES (?, 'MAIN_SLOT', ?, 1, 'ACTIVE')
      ON CONFLICT(account_id, ref_kind, ref_id) DO UPDATE SET state='ACTIVE', amount_cents=1
    `).run(accountId, actionId);
  }

  markSlotSubmitted(accountId: string, actionId: string): void {
    // Only a slot still held: a retrieve's own SO event can prove it, and consume the slot, before
    // its answer arrives, and the answer must not hold the slot again (L-10, 2026-10-16).
    this.sqlite.prepare(`UPDATE reservation SET state='SUBMITTED_UNOBSERVED' WHERE account_id=? AND ref_kind='MAIN_SLOT' AND ref_id=? AND state='ACTIVE'`).run(accountId, actionId);
  }

  storageUnit(accountId: string, casketId: string): StorageUnitRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM storage_unit WHERE account_id=? AND casket_id=?`).get(accountId, casketId) as StorageUnitRow | undefined;
  }

  /**
   * Records an observed label and the observation that carried it.
   *
   * Only a known unit is touched: a label is never how a unit is discovered, and an SO update
   * for a unit this account has not walked yet says nothing about ownership.
   */
  setStorageUnitLabel(accountId: string, casketId: string, label: string | null, observationId: number): void {
    this.sqlite.prepare(`UPDATE storage_unit SET label=?, label_obs=? WHERE account_id=? AND casket_id=?`).run(label, observationId, accountId, casketId);
    this.touch(accountId, 'storage_unit');
  }

  releaseSlot(accountId: string, actionId: string, consumed: boolean): void {
    this.sqlite.prepare(`UPDATE reservation SET state=? WHERE account_id=? AND ref_kind='MAIN_SLOT' AND ref_id=?`)
      .run(consumed ? 'CONSUMED' : 'RELEASED', accountId, actionId);
  }

  reservedMainSlots(accountId: string): number {
    const row = this.sqlite.prepare(`
      SELECT COALESCE(SUM(amount_cents),0) AS count FROM reservation
      WHERE account_id=? AND ref_kind='MAIN_SLOT' AND state IN ('ACTIVE','SUBMITTED_UNOBSERVED')
    `).get(accountId) as { count: number };
    // Every member of an open transfer toward this account holds one of its slots until the
    // delivery is proved or the offer ends.
    const incoming = this.sqlite.prepare(`SELECT COALESCE(SUM(m.quantity),0) AS count
      FROM work_step s JOIN transfer_detail d ON d.step_id=s.id
      JOIN command_member m ON m.command_id=s.command_id AND m.account_id=s.account_id
      WHERE s.kind='SEND' AND d.destination_account_id=? AND s.state IN ('QUEUED','SENT','AWAITING_OBSERVATION','RETRYING')`).get(accountId) as { count: number };
    return row.count + incoming.count;
  }

  insertCommand(row: CommandRow): void {
    this.sqlite.prepare(`
      INSERT INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed, revision, filter_json, authority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.correlation_id,
      row.kind,
      row.state,
      row.reject_reason,
      row.created_at,
      row.preparing ?? 0,
      row.manifest_token ?? null,
      row.observed_completed ?? 0,
      row.revision ?? 1,
      row.filter_json ?? null,
      row.authority ?? 'HUMAN'
    );
  }

  command(id: string): CommandRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM command WHERE id=?`).get(id) as CommandRow | undefined;
  }

  setCommandState(id: string, state: CommandRow['state'], rejectReason: string | null = null): void {
    this.sqlite.prepare(`UPDATE command SET state=?, reject_reason=COALESCE(?, reject_reason) WHERE id=?`).run(state, rejectReason, id);
  }

  insertCommandMember(row: CommandMemberRow): void {
    this.sqlite.prepare(`
      INSERT INTO command_member(command_id, account_id, local_id, stack_key, quantity, destination, price_receive_cents, state, input_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.command_id, row.account_id, row.local_id, row.stack_key, row.quantity, row.destination, row.price_receive_cents, row.state, row.input_json ?? null);
    this.touch(row.account_id, 'command_member');
  }

  /** A command's members in the order they were written, each with the action its latest hop carries. */
  commandMembers(commandId: string): CommandMemberView[] {
    return this.sqlite.prepare(`SELECT m.*, (
        SELECT s.action_id FROM work_step s WHERE s.command_id=m.command_id AND s.account_id=m.account_id AND s.local_id=m.local_id AND s.action_id IS NOT NULL
        ORDER BY s.ordinal DESC LIMIT 1) AS action_id
      FROM command_member m WHERE m.command_id=? ORDER BY m.rowid`).all(commandId) as CommandMemberView[];
  }

  setCommandMember(commandId: string, accountId: string, memberId: string, patch: { state: CommandMemberState }): void {
    this.sqlite.prepare(`UPDATE command_member SET state=? WHERE command_id=? AND account_id=? AND local_id=?`).run(patch.state, commandId, accountId, memberId);
    this.touch(accountId, 'command_member');
  }

  canUpdateLocation(item: ItemRow, observation: ObservationRow): boolean {
    if (observation.generation !== null && item.location_generation !== null && observation.generation < item.location_generation) return false;
    if (observation.surface === 'gc-event' && observation.generation !== null && item.location_generation !== null && observation.generation === item.location_generation) return false;
    const previous = this.observation(item.account_id, item.location_obs);
    return !previous || observation.started_at >= previous.started_at;
  }

  /**
   * Where a unit is now, with the observation that proved it. A `MISSING` row keeps its asset id:
   * nothing else will ever carry it, and the same id coming back is the same holding (D1).
   */
  setItemLocation(accountId: string, localId: string, obsId: number, location: ItemRow['location'], casketId: string | null = null): void {
    const item = this.sqlite.prepare(`SELECT * FROM item WHERE account_id=? AND local_id=?`).get(accountId, localId) as ItemRow | undefined;
    const obs = this.observation(accountId, obsId);
    if (!item || !obs || !this.canUpdateLocation(item, obs)) return;
    this.sqlite.prepare(`UPDATE item SET location=?, casket_id=?, location_obs=?,
      location_generation=COALESCE(?,location_generation),
      last_seen_obs=CASE WHEN ?='MISSING' THEN last_seen_obs ELSE ? END WHERE account_id=? AND local_id=?`)
      .run(location, casketId, obsId, obs.generation, location, obsId, accountId, localId);
    this.touch(accountId, 'item');
  }

  /** Why a `MISSING` row ended, once evidence names it (holdings plan D8). Never overwrites a reason. */
  setEndReason(accountId: string, localId: string, reason: 'sold' | 'traded' | 'consumed' | 'unknown'): void {
    this.sqlite.prepare(`UPDATE item SET end_reason=? WHERE account_id=? AND local_id=? AND location='MISSING' AND end_reason IS NULL`).run(reason, accountId, localId);
    this.touch(accountId, 'item');
  }

  itemByLocalId(accountId: string, localId: string): ItemRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM item WHERE account_id=? AND local_id=?`).get(accountId, localId) as ItemRow | undefined;
  }

  itemByAssetId(accountId: string, assetId: string): ItemRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM item WHERE account_id=? AND asset_id=?`).get(accountId, assetId) as ItemRow | undefined;
  }

  items(accountId: string): ItemRow[] {
    return this.sqlite.prepare(`SELECT * FROM item WHERE account_id=? ORDER BY local_id`).all(accountId) as ItemRow[];
  }

  /** Units in main inventory, of either kind, by quantity. */
  countMainItems(accountId: string): number {
    const row = this.sqlite.prepare(`SELECT COALESCE(SUM(quantity),0) AS count FROM item WHERE account_id=? AND location='MAIN'`).get(accountId) as { count: number };
    return row.count;
  }

  createDesiredAction(input: {
    accountId: string;
    targetKind: string;
    targetId: string;
    intent: string;
    params: unknown;
    commandId: string | null;
    actionKind: string;
    resourceKey: string;
    now: string;
  }): ActionRow {
    return this.transaction(() => {
      const current = this.sqlite.prepare(`
        SELECT id, version FROM desired_state
        WHERE account_id=? AND target_kind=? AND target_id=? AND superseded_by IS NULL
      `).get(input.accountId, input.targetKind, input.targetId) as { id: string; version: number } | undefined;
      const desiredId = randomUUID();
      const version = (current?.version ?? 0) + 1;
      if (current) this.sqlite.prepare(`UPDATE desired_state SET superseded_by=? WHERE id=?`).run(desiredId, current.id);
      if (current) this.retireUnsent(current.id, input.now);
      if (input.resourceKey.startsWith('item:') && this.unresolvedInFlight(input.accountId, input.resourceKey)) throw new Error('Item has an unresolved in-flight action; declare a goal to supersede its intent');
      this.sqlite.prepare(`
        INSERT INTO desired_state(id, account_id, target_kind, target_id, version, intent, params_json, command_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(desiredId, input.accountId, input.targetKind, input.targetId, version, input.intent, JSON.stringify(input.params), input.commandId, input.now);
      const actionId = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO action(id, account_id, kind, target_id, desired_version, desired_id, state, resource_key, created_at, updated_at, params_json)
        VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?)
      `).run(
        actionId,
        input.accountId,
        input.actionKind,
        input.targetId,
        version,
        desiredId,
        input.resourceKey,
        input.now,
        input.now,
        JSON.stringify(input.params)
      );
      return this.action(actionId)!;
    });
  }

  /**
   * Standing goal only. Does not enqueue an action — the planner recomputes the next legal
   * step from this row and the observed world.
   */
  upsertDesired(input: {
    accountId: string;
    targetKind: string;
    targetId: string;
    intent: string;
    params: unknown;
    commandId: string | null;
    now: string;
  }): DesiredStateRow {
    return this.transaction(() => {
      const current = this.currentDesiredState(input.accountId, input.targetKind, input.targetId);
      const paramsJson = JSON.stringify(input.params);
      if (current && current.intent === input.intent && current.params_json === paramsJson) return current;
      const desiredId = randomUUID();
      const version = (current?.version ?? 0) + 1;
      if (current) this.sqlite.prepare(`UPDATE desired_state SET superseded_by=? WHERE id=?`).run(desiredId, current.id);
      if (current) this.retireUnsent(current.id, input.now);
      this.sqlite.prepare(`
        INSERT INTO desired_state(id, account_id, target_kind, target_id, version, intent, params_json, command_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(desiredId, input.accountId, input.targetKind, input.targetId, version, input.intent, paramsJson, input.commandId, input.now);
      return this.desiredState(desiredId)!;
    });
  }

  /** Effect-layer row for a goal that already exists. Never used to store a future sequence. */
  /**
   * Queues one action. It carries a standing intent (`desiredId`) or one hop of a command
   * (`stepId`), never both (consolidation plan D3); a step-carried action has no goal to be
   * suspended, superseded or to expire, and its step says what it is for.
   */
  enqueueAction(input: EnqueueActionInput): ActionRow {
    return this.transaction(() => {
      if (input.resourceKey.startsWith('item:')) {
        // A holding's one action (D3). A request not yet sent, or proved absent and waiting its
        // resend, gives way to the newer one, as a goal's unsent action did; an attempt no walk
        // has explained cannot be built on (N-SELL-04), and one a walk explained may be.
        this.retireReady(input.accountId, input.resourceKey, input.now);
        if (this.unresolvedInFlight(input.accountId, input.resourceKey)) throw new Error('Item has an unresolved in-flight action; wait for the walk that explains it');
      } else if (this.inFlight(input.accountId, input.resourceKey)) {
        throw new Error(`Resource ${input.resourceKey} already has an in-flight action`);
      }
      const actionId = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO action(id, account_id, kind, target_id, desired_version, desired_id, state, resource_key, created_at, updated_at, params_json, step_id)
        VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?)
      `).run(
        actionId,
        input.accountId,
        input.actionKind,
        input.targetId,
        'stepId' in input ? 0 : input.desiredVersion,
        'stepId' in input ? null : input.desiredId,
        input.resourceKey,
        input.now,
        input.now,
        JSON.stringify(input.params),
        'stepId' in input ? input.stepId : null
      );
      return this.action(actionId)!;
    });
  }

  desiredState(desiredId: string): DesiredStateRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM desired_state WHERE id=?`).get(desiredId) as DesiredStateRow | undefined;
  }

  currentDesiredState(accountId: string, targetKind: string, targetId: string): DesiredStateRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM desired_state
      WHERE account_id=? AND target_kind=? AND target_id=? AND superseded_by IS NULL
    `).get(accountId, targetKind, targetId) as DesiredStateRow | undefined;
  }

  currentGoals(accountId: string, targetKind: string, intent: string): DesiredStateRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM desired_state
      WHERE account_id=? AND target_kind=? AND intent=? AND superseded_by IS NULL
      ORDER BY created_at, id
    `).all(accountId, targetKind, intent) as DesiredStateRow[];
  }

  inFlight(accountId: string, resourceKey: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS hit FROM action WHERE account_id=? AND resource_key=? AND state IN ${IN_FLIGHT_STATES}
    `).get(accountId, resourceKey) as { hit: number } | undefined;
    return Boolean(row);
  }

  /** Whether a store or retrieve of ours has gone out on this item and is not settled yet. Asked per GC item event. */
  casketMoveOut(accountId: string, localId: string): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM action WHERE account_id=? AND state IN ('RUNNING','AWAITING_OBSERVATION')
      AND kind IN ('STORE_IN_CASKET','RETRIEVE_FROM_CASKET') AND target_id=? LIMIT 1`).get(accountId, localId) !== undefined;
  }

  /**
   * An attempt on this resource whose outcome no observation has explained yet.
   *
   * In flight is not the same as unresolved. A listing the walk shows awaiting the phone tap is
   * still `AWAITING_OBSERVATION` — the tap is what it waits for — but the walk has already said
   * what the attempt did, and cancelling that listing is a thing a person is allowed to do. The
   * refusal this feeds is for the attempt nobody can yet explain: a second mutation on top of an
   * ambiguous one is how an item gets acted on twice (rule 1).
   */
  unresolvedInFlight(accountId: string, resourceKey: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS hit FROM action WHERE account_id=? AND resource_key=? AND state IN ${IN_FLIGHT_STATES} AND resolved_by_obs IS NULL
    `).get(accountId, resourceKey) as { hit: number } | undefined;
    return Boolean(row);
  }

  /** An attempt sent for the resource that no observation has explained yet: a mutation nobody can yet account for. */
  unexplainedAttempt(accountId: string, resourceKey: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS hit FROM action WHERE account_id=? AND resource_key=? AND state IN ('RUNNING','AWAITING_OBSERVATION') AND resolved_by_obs IS NULL
    `).get(accountId, resourceKey) as { hit: number } | undefined;
    return Boolean(row);
  }

  /** Fails the unsent actions on a resource as superseded by a newer request, and the hops they carry with them. */
  private retireReady(accountId: string, resourceKey: string, now: string): void {
    const ready = this.sqlite.prepare(`SELECT id FROM action WHERE account_id=? AND resource_key=? AND state='READY'`).all(accountId, resourceKey) as Array<{ id: string }>;
    if (!ready.length) return;
    const work = new WorkStore(this);
    for (const { id } of ready) {
      this.setActionState(id, 'FAILED', now, 'superseded');
      const step = work.byAction(id);
      if (step && !isSettled(step)) work.failHop(step, 'Superseded by a later request', now);
    }
  }

  inFlightAction(accountId: string, resourceKey: string): ActionRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM action WHERE account_id=? AND resource_key=? AND state IN ${IN_FLIGHT_STATES}
      ORDER BY created_at, id LIMIT 1
    `).get(accountId, resourceKey) as ActionRow | undefined;
  }

  /** Step params if the action carries them; otherwise the goal params (legacy rows). */
  actionParams(action: ActionRow): unknown {
    if (action.params_json) return JSON.parse(action.params_json) as unknown;
    return this.desiredParams(action);
  }

  action(actionId: string): ActionRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM action WHERE id=?`).get(actionId) as ActionRow | undefined;
  }

  actions(accountId: string, state?: ActionRow['state']): ActionRow[] {
    if (state) return this.sqlite.prepare(`SELECT * FROM action WHERE account_id=? AND state=? ORDER BY created_at, id`).all(accountId, state) as ActionRow[];
    return this.sqlite.prepare(`SELECT * FROM action WHERE account_id=? ORDER BY created_at, id`).all(accountId) as ActionRow[];
  }

  /**
   * The account's actions awaiting observation, oldest first, less the hops of these commands. A
   * command whose dispatch is running proves its own round, so proof demand leaves its hops out
   * here rather than asking each one's owner what it needs and then dropping it: a store of 968
   * asked that, a few queries each, of every waiting store on every answer.
   */
  awaitingActionsOutside(accountId: string, commandIds: readonly string[]): ActionRow[] {
    if (commandIds.length === 0) return this.actions(accountId, 'AWAITING_OBSERVATION');
    return this.sqlite.prepare(`SELECT a.* FROM action a WHERE a.account_id=? AND a.state='AWAITING_OBSERVATION'
      AND NOT EXISTS (SELECT 1 FROM work_step s WHERE s.id=a.step_id AND s.command_id IN (SELECT value FROM json_each(?)))
      ORDER BY a.created_at, a.id`).all(accountId, JSON.stringify(commandIds)) as ActionRow[];
  }

  /**
   * The account's actions awaiting observation of these kinds, oldest first. A reconciler that
   * settles two kinds asks for those two: loading every waiting action to skip the rest cost each
   * settle of a bulk store a row per waiting move.
   */
  awaitingActionsOfKinds(accountId: string, kinds: readonly string[]): ActionRow[] {
    return this.sqlite.prepare(`SELECT * FROM action WHERE account_id=? AND state='AWAITING_OBSERVATION'
      AND kind IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`).all(accountId, JSON.stringify(kinds)) as ActionRow[];
  }

  /**
   * The account's actions awaiting observation that are about one of these items, and every rename,
   * oldest first: what an item event can settle. The key list is one JSON value, however long.
   */
  awaitingActionsAbout(accountId: string, targetIds: readonly string[]): ActionRow[] {
    return this.sqlite.prepare(`SELECT * FROM action WHERE account_id=? AND state='AWAITING_OBSERVATION'
      AND (kind='RENAME_CASKET' OR target_id IN (SELECT value FROM json_each(?))) ORDER BY created_at, id`).all(accountId, JSON.stringify(targetIds)) as ActionRow[];
  }

  startAttempt(actionId: string, now: string): string {
    const attemptId = randomUUID();
    this.transaction(() => {
      const changed = this.sqlite.prepare(`UPDATE action SET state='RUNNING', updated_at=?, error=NULL, resolved_by_obs=NULL, resolution=NULL WHERE id=? AND state='READY'`).run(now, actionId);
      if (changed.changes !== 1) throw new Error('Action is no longer READY');
      const watermark = (this.sqlite.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM observation WHERE account_id=(SELECT account_id FROM action WHERE id=?)`).get(actionId) as { id: number }).id;
      this.sqlite.prepare(`INSERT INTO attempt(id, action_id, started_at, request_ref) VALUES (?, ?, ?, ?)`).run(attemptId, actionId, now, JSON.stringify({ observationWatermark: watermark }));
      const action = this.action(actionId)!;
      if (action.kind === 'CREATE_SELL_LISTING') this.openOrder(action, 'steam', now);
    });
    return attemptId;
  }

  finishAttempt(actionId: string, attemptId: string, outcome: string, response: unknown, now: string, error?: string, retryAfter: string | null = null): void {
    this.transaction(() => {
      const action = this.action(actionId);
      if (!action) throw new Error(`Unknown action ${actionId}`);
      const desired = action.desired_id === null ? { superseded_by: null }
        : this.sqlite.prepare(`SELECT superseded_by FROM desired_state WHERE id=?`).get(action.desired_id) as { superseded_by: string | null };
      const state = outcome === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION';
      this.sqlite.prepare(`UPDATE attempt SET finished_at=?, outcome=?, response_ref=?, retry_after=? WHERE id=?`).run(now, outcome, JSON.stringify(response), retryAfter, attemptId);
      this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, error=? WHERE id=?`).run(state, now, desired.superseded_by ? 'superseded' : error ?? null, actionId);
    });
  }

  setActionState(actionId: string, state: ActionRow['state'], now: string, error?: string): void {
    this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, error=? WHERE id=?`).run(state, now, error ?? null, actionId);
  }

  /** The goal a goal-carried action belongs to; a step-carried action has none, and this says so. */
  goalOf(action: ActionRow): string {
    if (action.desired_id === null) throw new Error(`Action ${action.id} carries a step, not a goal`);
    return action.desired_id;
  }

  currentDesired(action: ActionRow): boolean {
    if (action.desired_id === null) return true;
    const row = this.sqlite.prepare(`SELECT superseded_by FROM desired_state WHERE id=?`).get(action.desired_id) as { superseded_by: string | null } | undefined;
    return row?.superseded_by === null;
  }

  desiredParams(action: ActionRow): unknown {
    if (action.desired_id === null) return JSON.parse(action.params_json ?? 'null') as unknown;
    const row = this.sqlite.prepare(`SELECT params_json FROM desired_state WHERE id=?`).get(action.desired_id) as { params_json: string };
    return JSON.parse(row.params_json);
  }

  addEvent(accountId: string, kind: string, payload: unknown, now: string): void {
    this.sqlite.prepare(`INSERT INTO event(id, account_id, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), accountId, kind, JSON.stringify(payload), now);
    this.touch(accountId, 'event');
  }

  /**
   * Records a verdict only the first time it is reached.
   *
   * For a reconciler's "still undecided" findings, which hold across many settles: written with
   * `addEvent`, each one grew the timeline by a row per walk, and once settling followed every
   * observation it would have grown by a row per observation of anything. The same kind with the
   * same payload is the same verdict; a payload that changes is a new one and is written.
   */
  addEventOnce(accountId: string, kind: string, payload: unknown, now: string): void {
    const json = JSON.stringify(payload);
    const seen = this.sqlite.prepare(`SELECT 1 FROM event WHERE account_id=? AND kind=? AND payload_json=? LIMIT 1`).get(accountId, kind, json);
    if (seen) return;
    this.sqlite.prepare(`INSERT INTO event(id, account_id, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), accountId, kind, json, now);
    this.touch(accountId, 'event');
  }

  events(accountId: string): Array<{ id: string; kind: string; payload_json: string; at: string }> {
    return this.sqlite.prepare(`SELECT id, kind, payload_json, at FROM event WHERE account_id=? ORDER BY at, id`).all(accountId) as Array<{ id: string; kind: string; payload_json: string; at: string }>;
  }

  raw(): DatabaseSync {
    return this.sqlite;
  }

  latestAttempt(actionId: string): AttemptRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM attempt WHERE action_id=? ORDER BY rowid DESC LIMIT 1`).get(actionId) as AttemptRow | undefined;
  }

  /** Our own sell order, opened as the create attempt starts (`OrderStore.open`). */
  openOrder(action: ActionRow, venue: OrderVenue, now: string): string {
    return new OrderStore(this).open(action, venue, now);
  }

  resolveAction(action: ActionRow, observationId: number, applied: boolean, now: string): void {
    if (!this.observation(action.account_id, observationId)) throw new Error('Resolution observation belongs to another account');
    const state = applied ? 'DONE' : this.currentDesired(action) ? 'READY' : 'FAILED';
    this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, resolved_by_obs=?, resolution=?, error=? WHERE id=?`)
      .run(state, now, observationId, applied ? 'OBSERVED_APPLIED' : 'OBSERVED_NOT_APPLIED', applied ? null : 'complete-observation-proved-not-applied', action.id);
    if (!applied) new OrderStore(this).endNotApplied(action, observationId, now);
  }

  suspendGoal(accountId: string, desiredId: string, reason: string, now: string, blockedUntil: string | null = null): void {
    this.sqlite.prepare(`UPDATE desired_state SET suspended_reason=?, suspended_at=COALESCE(suspended_at,?), blocked_until=?
      WHERE account_id=? AND id=? AND superseded_by IS NULL`).run(reason, now, blockedUntil, accountId, desiredId);
    this.retireUnsent(desiredId, now);
  }

  resolveGoalConflict(accountId: string, desiredId: string, resolution: 'resume' | 'adopt', now: string): DesiredStateRow {
    return this.transaction(() => {
      const goal = this.desiredState(desiredId);
      if (!goal || goal.account_id !== accountId || goal.superseded_by || !goal.suspended_reason) throw new Error('No current suspended goal for this account');
      const id = randomUUID();
      this.sqlite.prepare(`UPDATE desired_state SET superseded_by=? WHERE account_id=? AND id=?`).run(id, accountId, desiredId);
      this.retireUnsent(desiredId, now);
      this.sqlite.prepare(`INSERT INTO desired_state(id,account_id,target_kind,target_id,version,intent,params_json,command_id,created_at,authority,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'HUMAN',?)`).run(id, accountId, goal.target_kind, goal.target_id, goal.version + 1,
          resolution === 'resume' ? goal.intent : 'NONE', goal.params_json, null, now, new Date(Date.parse(now) + 7 * 86400_000).toISOString());
      return this.desiredState(id)!;
    });
  }

  // --- Selection drafts ---------------------------------------------------

  /**
   * A selection capture is a command in `DRAFT` (kind `SELECTION`) whose members are the frozen
   * set (consolidation plan §4.4): the window holds its token and submits it as the members of an
   * executable command, which copies them. `preparing` is 1 while a matching capture is still
   * writing pages; a capture that could not finish is `STOPPED` with the reason, and one a crash
   * interrupted is `REJECTED` on the next open, as any interrupted preparation is.
   */
  insertDraft(token: string, accountIds: readonly string[], filter: unknown, now: string, preparing: boolean): void {
    this.insertCommand({ id: token, correlation_id: randomUUID(), kind: SELECTION_KIND, state: 'DRAFT', reject_reason: null, created_at: now,
      preparing: preparing ? 1 : 0, manifest_token: null, observed_completed: 0, revision: 1, filter_json: JSON.stringify({ accountIds, filter: filter ?? {} }) });
  }

  draft(token: string): CommandRow | undefined {
    const row = this.command(token);
    return row?.kind === SELECTION_KIND ? row : undefined;
  }

  insertDraftMember(token: string, member: DraftMember): void {
    this.insertCommandMember({ command_id: token, account_id: member.accountId, local_id: member.localId ?? member.stackKey ?? randomUUID(),
      stack_key: member.stackKey ?? null, quantity: member.quantity, destination: null, price_receive_cents: null, state: 'DRAFT', input_json: JSON.stringify(member) });
  }

  /** A draft's members in account and member order: one page after a key, or all of them. */
  draftMembers(token: string, page?: { after: readonly [string, string]; limit: number }): DraftMemberRow[] {
    const rows = (page
      ? this.sqlite.prepare(`SELECT account_id, local_id, input_json FROM command_member WHERE command_id=? AND state='DRAFT' AND (account_id, local_id)>(?, ?)
          ORDER BY account_id, local_id LIMIT ?`).all(token, page.after[0], page.after[1], page.limit)
      : this.sqlite.prepare(`SELECT account_id, local_id, input_json FROM command_member WHERE command_id=? AND state='DRAFT' ORDER BY account_id, local_id`).all(token)
    ) as Array<{ account_id: string; local_id: string; input_json: string | null }>;
    return rows.map((row) => ({ ...(JSON.parse(row.input_json ?? '{}') as DraftMember), accountId: row.account_id, memberId: row.local_id }));
  }

  draftCounts(token: string): { handles: number; quantity: number } {
    return this.sqlite.prepare(`SELECT COUNT(*) AS handles, COALESCE(SUM(quantity),0) AS quantity FROM command_member WHERE command_id=? AND state='DRAFT'`)
      .get(token) as { handles: number; quantity: number };
  }

  /** Drops members from a draft and counts a new revision, so the token submitted with the old one is refused as stale. */
  excludeDraftMembers(token: string, exclude: ReadonlyArray<{ accountId: string; memberId: string }>): void {
    this.transaction(() => {
      const remove = this.sqlite.prepare(`DELETE FROM command_member WHERE command_id=? AND account_id=? AND local_id=? AND state='DRAFT'`);
      for (const member of exclude) remove.run(token, member.accountId, member.memberId);
      for (const accountId of new Set(exclude.map((member) => member.accountId))) this.touch(accountId, 'command_member');
      this.sqlite.prepare('UPDATE command SET revision=revision+1 WHERE id=?').run(token);
    });
  }

  /** Freezes matching rows into a draft in SQLite. The renderer never receives the member list. */
  captureMatchingDraft(
    token: string,
    accountIds: readonly string[],
    filter?: { search?: string; location?: ItemRow['location'] }
  ): { handles: number; quantity: number } {
    let handles = 0;
    let quantity = 0;
    for (const accountId of accountIds) {
      // One member per holding, of either kind.
      const itemSql = `
        SELECT local_id, location, casket_id, quantity FROM item
        WHERE account_id=? AND location<>'MISSING'
        ${filter?.location ? 'AND location=?' : ''}
      `;
      const itemParams: Array<string | number> = [accountId, ...(filter?.location ? [filter.location] : [])];
      for (const row of this.sqlite.prepare(itemSql).all(...itemParams) as Array<{ local_id: string; location: string; casket_id: string | null; quantity: number }>) {
        this.insertDraftMember(token, { accountId, localId: row.local_id, quantity: row.quantity, location: row.location, casketId: row.casket_id });
        handles += 1;
        quantity += row.quantity;
      }
    }
    return { handles, quantity };
  }

  // --- Observation coverage -----------------------------------------------

  checkpoint(accountId: string, surface: string, scopeId = ''): CheckpointRow | undefined {
    return this.sqlite.prepare(`SELECT account_id, surface, scope_id, cursor_json, covered_through, observation_id, updated_at
      FROM surface_state WHERE account_id=? AND surface=? AND scope_id=? AND cursor_json IS NOT NULL`)
      .get(accountId, surface, scopeId) as CheckpointRow | undefined;
  }

  /**
   * Counts a write to a paged surface (consolidation plan D9). The store that writes the table
   * calls it in the same transaction, and a keyset cursor cut under the old count is refused
   * (`read/queries/paging.ts`). There is no trigger: the engine is the sole writer, and
   * `tests/unit/revision-sites.test.ts` holds every write site to this call.
   */
  touch(accountId: string, surface: string): void {
    this.sqlite.prepare(`INSERT INTO surface_state(account_id, surface, scope_id, revision) VALUES (?, ?, '', 1)
      ON CONFLICT(account_id, surface, scope_id) DO UPDATE SET revision=revision+1`).run(accountId, surface);
  }

  /**
   * The duplicate-protection switch (consolidation plan D13): this desktop's preference, handed in
   * by main when the runtime starts and on every change, steering admission across venues and
   * persisted nowhere in the record. `version` counts the changes, so a step admitted under one
   * setting can say which.
   */
  private protection = { preventDuplicates: true, version: 1 };
  marketplaceProtection(): { preventDuplicates: boolean; version: number } { return { ...this.protection }; }
  setMarketplaceProtection(enabled: boolean): void {
    if (this.protection.preventDuplicates === enabled) return;
    this.protection = { preventDuplicates: enabled, version: this.protection.version + 1 };
  }

  /** Every surface written at least once for the accounts, with its count: what a cursor is bound to. */
  revisionMarks(accounts: readonly string[]): Array<{ account_id: string; surface: string; revision: number }> {
    return this.sqlite.prepare(`SELECT account_id, surface, revision FROM surface_state WHERE account_id IN (${accounts.map(() => '?').join(',')}) AND revision>0
      ORDER BY account_id, surface`).all(...accounts) as Array<{ account_id: string; surface: string; revision: number }>;
  }

  /**
   * Moves a surface's committed coverage boundary.
   *
   * Only ever called inside the same transaction that wrote the rows it covers, and only for a
   * walk that completed: a checkpoint advanced past a page that failed is exactly how the next
   * sync skips history nobody ever saw (TRD-05, N-TRD-03).
   */
  advanceCheckpoint(input: {
    accountId: string; surface: string; scopeId?: string; cursor: unknown;
    coveredThrough: string | null; observationId: number; now: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO surface_state(account_id, surface, scope_id, cursor_json, covered_through, observation_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, surface, scope_id) DO UPDATE SET cursor_json=excluded.cursor_json,
        covered_through=excluded.covered_through, observation_id=excluded.observation_id, updated_at=excluded.updated_at
    `).run(input.accountId, input.surface, input.scopeId ?? '', JSON.stringify(input.cursor),
      input.coveredThrough, input.observationId, input.now);
  }

  knownAccountIds(accountIds: readonly string[]): string[] {
    const known = new Set(this.listAccounts().map((row) => row.id));
    return accountIds.filter((id) => known.has(id));
  }

  private retireUnsent(desiredId: string, now: string): void {
    this.sqlite.prepare(`UPDATE action SET state='FAILED', error='superseded-or-suspended', updated_at=?
      WHERE desired_id=? AND state='READY'`).run(now, desiredId);
  }

  private recoverInterruptedActions(now: string): void {
    this.sqlite.prepare("UPDATE command SET state='REJECTED',reject_reason='Preparation interrupted before admission',preparing=0 WHERE preparing=1").run();
    this.sqlite.prepare(`
      UPDATE action SET state='AWAITING_OBSERVATION', error='process-interrupted-before-outcome', updated_at=?
      WHERE state='RUNNING'
    `).run(now);
  }
}
