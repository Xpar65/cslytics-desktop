import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AccountId } from '@cslytics/ports';
import { applySchema, existingVersion, SchemaNewerThanAppError, SCHEMA_VERSION } from './index.js';
import { backupBeforeUpgrade } from './backup.js';

export type AccountRow = {
  id: string;
  steam_id64: string;
  account_name: string;
  added_at: string;
  persona_name: string | null;
  avatar_hash: string | null;
  persona_obs: number | null;
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
  outcome: string | null; request_ref: string | null;
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
  current_asset_id: string | null;
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
  row_generation?: number;
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
  desired_id: string;
  state: 'READY' | 'RUNNING' | 'AWAITING_OBSERVATION' | 'DONE' | 'FAILED';
  resource_key: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  /** Step snapshot for this attempt. The standing goal lives on `desired_state`. */
  params_json: string | null;
  resolved_by_obs: number | null;
  resolution: 'OBSERVED_APPLIED' | 'OBSERVED_NOT_APPLIED' | null;
};

export type DesiredStateRow = {
  id: string;
  account_id: string;
  target_kind: string;
  target_id: string;
  version: number;
  intent: string;
  params_json: string;
  basis: string;
  created_at: string;
  superseded_by: string | null;
  authority: string;
  suspended_reason: string | null;
  suspended_at: string | null;
  blocked_until: string | null;
  expires_at: string | null;
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
  state: 'REJECTED' | 'ADMITTED' | 'RUNNING' | 'PARTIAL' | 'COMPLETE' | 'STOPPED';
  reject_reason: string | null;
  created_at: string;
  preparing?: number;
  manifest_token?: string | null;
  observed_completed?: number;
};

export type PublicationRow = {
  account_id: string;
  surface: string;
  scope_id: string;
  published_generation: number | null;
  staging_generation: number | null;
  staging_state: string;
  published_at: string | null;
};

export type SelectionManifestRow = {
  token: string;
  revision: number;
  state: 'DRAFT' | 'COMPLETE' | 'RELEASED';
  account_ids_json: string;
  filter_json: string;
  created_at: string;
  handle_count: number;
  quantity_total: number;
};

export type SelectionMemberRow = {
  token: string;
  revision: number;
  account_id: string;
  member_id: string;
  stack_key: string | null;
  location: string | null;
  casket_id: string | null;
  quantity: number;
};

export type CommandMemberRow = {
  input_json?: string | null;
  command_id: string;
  account_id: string;
  member_id: string;
  stack_key: string | null;
  quantity: number;
  destination: string | null;
  price_receive_cents: number | null;
  state: string;
  action_id: string | null;
};

const IN_FLIGHT_STATES = "('READY','RUNNING','AWAITING_OBSERVATION')";

export type CheckpointRow = {
  account_id: string; surface: string; scope_id: string; cursor_json: string;
  covered_through: string | null; observation_id: number | null; updated_at: string;
};

export class EngineDatabase {
  private readonly sqlite: DatabaseSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    try {
      this.sqlite.exec('PRAGMA foreign_keys = ON');
      this.sqlite.exec('PRAGMA busy_timeout = 5000');
      // A record a newer build wrote is refused before anything here writes to it — switching the
      // journal to WAL rewrites the file header — and a record this build is about to upgrade is
      // copied first. Both throw with the record untouched, and the handle is closed so the file
      // is not left locked on Windows for whoever handles the error.
      const found = existingVersion(this.sqlite);
      if (found !== null && found > SCHEMA_VERSION) throw new SchemaNewerThanAppError(found, SCHEMA_VERSION);
      this.sqlite.exec('PRAGMA journal_mode = WAL');
      if (found !== null && found < SCHEMA_VERSION && path !== ':memory:') backupBeforeUpgrade(this.sqlite, path, found, new Date());
      applySchema(this.sqlite);
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
    this.recoverInterruptedActions();
  }

  close(): void {
    if (!this.sqlite.isOpen) return;
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
      scopeKind: observation.scopeKind ?? (observation.surface.startsWith('gc-casket:') ? 'casket' : 'account'),
      scopeId: observation.scopeId ?? (observation.surface.startsWith('gc-casket:') ? observation.surface.slice(10) : null)
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
  activeRowGeneration(accountId: string, surface: string, scopeId: string, fallback: number | null): number {
    const pub = this.publication(accountId, surface, scopeId);
    if (pub?.staging_state === 'STAGING' && pub.staging_generation != null) return pub.staging_generation;
    if (pub?.published_generation != null) return pub.published_generation;
    return fallback ?? 0;
  }

  reserveMainSlot(accountId: string, actionId: string): void {
    this.sqlite.prepare(`
      INSERT INTO reservation(account_id, ref_kind, ref_id, amount_cents, state)
      VALUES (?, 'MAIN_SLOT', ?, 1, 'ACTIVE')
      ON CONFLICT(account_id, ref_kind, ref_id) DO UPDATE SET state='ACTIVE', amount_cents=1
    `).run(accountId, actionId);
  }

  markSlotSubmitted(accountId: string, actionId: string): void {
    this.sqlite.prepare(`UPDATE reservation SET state='SUBMITTED_UNOBSERVED' WHERE account_id=? AND ref_kind='MAIN_SLOT' AND ref_id=?`).run(accountId, actionId);
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
    const incoming = this.sqlite.prepare(`SELECT COALESCE(SUM(json_extract(asset.value,'$.quantity')),0) AS count
      FROM transfer_batch batch,json_each(batch.assets_json) asset
      WHERE batch.destination_account_id=? AND batch.state NOT IN ('DONE','ENDED','FAILED')`).get(accountId) as { count: number };
    return row.count + incoming.count;
  }

  insertCommand(row: CommandRow): void {
    this.sqlite.prepare(`
      INSERT INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.correlation_id,
      row.kind,
      row.state,
      row.reject_reason,
      row.created_at,
      row.preparing ?? 0,
      row.manifest_token ?? null,
      row.observed_completed ?? 0
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
      INSERT INTO command_member(command_id, account_id, member_id, stack_key, quantity, destination, price_receive_cents, state, action_id, input_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.command_id, row.account_id, row.member_id, row.stack_key, row.quantity, row.destination, row.price_receive_cents, row.state, row.action_id, row.input_json ?? null);
  }

  commandMembers(commandId: string): CommandMemberRow[] {
    return this.sqlite.prepare(`SELECT * FROM command_member WHERE command_id=?`).all(commandId) as CommandMemberRow[];
  }

  setCommandMember(commandId: string, accountId: string, memberId: string, patch: { state?: string; action_id?: string | null }): void {
    if (patch.state !== undefined) {
      this.sqlite.prepare(`UPDATE command_member SET state=? WHERE command_id=? AND account_id=? AND member_id=?`).run(patch.state, commandId, accountId, memberId);
    }
    if (patch.action_id !== undefined) {
      this.sqlite.prepare(`UPDATE command_member SET action_id=? WHERE command_id=? AND account_id=? AND member_id=?`).run(patch.action_id, commandId, accountId, memberId);
    }
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
  }

  /** Why a `MISSING` row ended, once evidence names it (holdings plan D8). Never overwrites a reason. */
  setEndReason(accountId: string, localId: string, reason: 'sold' | 'traded' | 'consumed' | 'unknown'): void {
    this.sqlite.prepare(`UPDATE item SET end_reason=? WHERE account_id=? AND local_id=? AND location='MISSING' AND end_reason IS NULL`).run(reason, accountId, localId);
  }

  itemByLocalId(accountId: string, localId: string): ItemRow | undefined {
    const visible = this.publishedInventoryVisibility(accountId);
    return this.sqlite.prepare(`
      SELECT * FROM ${this.inventoryReadTable('item', accountId)} WHERE account_id=? AND local_id=?${visible.sql}
    `).get(accountId, localId, ...visible.params) as ItemRow | undefined;
  }

  itemByAssetId(accountId: string, assetId: string): ItemRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM item WHERE account_id=? AND current_asset_id=?`).get(accountId, assetId) as ItemRow | undefined;
  }

  items(accountId: string): ItemRow[] {
    const visible = this.publishedInventoryVisibility(accountId);
    return this.sqlite.prepare(`
      SELECT * FROM ${this.inventoryReadTable('item', accountId)} WHERE account_id=?${visible.sql} ORDER BY local_id
    `).all(accountId, ...visible.params) as ItemRow[];
  }

  /**
   * Reader-facing inventory table. While a snapshot is staging, MAIN rows come from the
   * last published backup; CASKET/MISSING stay on the live table. When nothing is staging this
   * is the base table so a 200k COUNT can use the ordinary indexes.
   */
  inventoryReadTable(table: 'item', accountId: string): string {
    if (this.publication(accountId, 'gc-inventory', '')?.staging_state !== 'STAGING') return table;
    const quoted = (this.sqlite.prepare('SELECT quote(?) AS q').get(accountId) as { q: string }).q;
    return `(SELECT * FROM ${table} WHERE account_id=${quoted} AND location IN ('CASKET','MISSING')
      UNION ALL SELECT * FROM inventory_backup_${table} WHERE account_id=${quoted})`;
  }

  /**
   * Hide MAIN rows from an unpublished staging generation. MISSING stays visible:
   * an unresolved fingerprint or a concluded absence is still the last known identity.
   */
  publishedInventoryVisibility(accountId: string): { sql: string; params: number[] } {
    const published = this.publication(accountId, 'gc-inventory', '')?.published_generation;
    if (published == null) return { sql: '', params: [] };
    return { sql: ` AND (location IN ('CASKET','MISSING') OR row_generation=?)`, params: [published] };
  }

  /** Units in main inventory, of either kind, by quantity. */
  countMainItems(accountId: string): number {
    const visible = this.publishedInventoryVisibility(accountId);
    const row = this.sqlite.prepare(`
      SELECT COALESCE(SUM(quantity),0) AS count FROM ${this.inventoryReadTable('item', accountId)} WHERE account_id=? AND location='MAIN'${visible.sql}
    `).get(accountId, ...visible.params) as { count: number };
    return row.count;
  }

  createDesiredAction(input: {
    accountId: string;
    targetKind: string;
    targetId: string;
    intent: string;
    params: unknown;
    basis: string;
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
        INSERT INTO desired_state(id, account_id, target_kind, target_id, version, intent, params_json, basis, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(desiredId, input.accountId, input.targetKind, input.targetId, version, input.intent, JSON.stringify(input.params), input.basis, input.now);
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
    basis: string;
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
        INSERT INTO desired_state(id, account_id, target_kind, target_id, version, intent, params_json, basis, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(desiredId, input.accountId, input.targetKind, input.targetId, version, input.intent, paramsJson, input.basis, input.now);
      return this.desiredState(desiredId)!;
    });
  }

  /** Effect-layer row for a goal that already exists. Never used to store a future sequence. */
  enqueueAction(input: {
    accountId: string;
    desiredId: string;
    desiredVersion: number;
    actionKind: string;
    targetId: string;
    resourceKey: string;
    params: unknown;
    now: string;
  }): ActionRow {
    return this.transaction(() => {
      if (this.inFlight(input.accountId, input.resourceKey)) {
        throw new Error(`Resource ${input.resourceKey} already has an in-flight action`);
      }
      const actionId = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO action(id, account_id, kind, target_id, desired_version, desired_id, state, resource_key, created_at, updated_at, params_json)
        VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?)
      `).run(
        actionId,
        input.accountId,
        input.actionKind,
        input.targetId,
        input.desiredVersion,
        input.desiredId,
        input.resourceKey,
        input.now,
        input.now,
        JSON.stringify(input.params)
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

  finishAttempt(actionId: string, attemptId: string, outcome: string, response: unknown, now: string, error?: string): void {
    this.transaction(() => {
      const action = this.action(actionId);
      if (!action) throw new Error(`Unknown action ${actionId}`);
      const desired = this.sqlite.prepare(`SELECT superseded_by FROM desired_state WHERE id=?`).get(action.desired_id) as { superseded_by: string | null };
      const state = outcome === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION';
      this.sqlite.prepare(`UPDATE attempt SET finished_at=?, outcome=?, response_ref=? WHERE id=?`).run(now, outcome, JSON.stringify(response), attemptId);
      this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, error=? WHERE id=?`).run(state, now, desired.superseded_by ? 'superseded' : error ?? null, actionId);
    });
  }

  setActionState(actionId: string, state: ActionRow['state'], now: string, error?: string): void {
    this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, error=? WHERE id=?`).run(state, now, error ?? null, actionId);
  }

  currentDesired(action: ActionRow): boolean {
    const row = this.sqlite.prepare(`SELECT superseded_by FROM desired_state WHERE id=?`).get(action.desired_id) as { superseded_by: string | null } | undefined;
    return row?.superseded_by === null;
  }

  desiredParams(action: ActionRow): unknown {
    const row = this.sqlite.prepare(`SELECT params_json FROM desired_state WHERE id=?`).get(action.desired_id) as { params_json: string };
    return JSON.parse(row.params_json);
  }

  addEvent(accountId: string, kind: string, payload: unknown, now: string): void {
    this.sqlite.prepare(`INSERT INTO event(id, account_id, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), accountId, kind, JSON.stringify(payload), now);
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

  openOrder(action: ActionRow, venue: string, now: string): string {
    const existing = this.sqlite.prepare(`SELECT order_id FROM venue_order WHERE account_id=? AND action_id=?`).get(action.account_id, action.id) as { order_id: string } | undefined;
    const conflict = this.sqlite.prepare(`SELECT 1 FROM venue_order WHERE account_id=? AND local_id=? AND side='SELL'
          AND state NOT LIKE 'ENDED_%' AND order_id<>?`).get(action.account_id, action.target_id, existing?.order_id ?? '');
    if (conflict) throw new Error('Item already has an open or unexplained order');
    if (existing) {
      this.sqlite.prepare(`UPDATE venue_order SET state='SUBMITTED', ended_at=NULL, end_reason=NULL, end_evidence=NULL WHERE account_id=? AND order_id=?`).run(action.account_id, existing.order_id);
      return existing.order_id;
    }
    const orderId = randomUUID();
    this.sqlite.prepare(`INSERT INTO venue_order(account_id,order_id,venue,side,local_id,price_receive_cents,opened_at,
      opened_from_intent,intent_version,action_id,managed,state,venue_detail_json) VALUES (?,?,?,'SELL',?,?,?,?,?,?,1,'SUBMITTED',?)`)
      .run(action.account_id, orderId, venue, action.target_id, (this.actionParams(action) as { priceReceiveCents: number }).priceReceiveCents,
        now, action.desired_id, action.desired_version, action.id,
        JSON.stringify({ assetId: this.itemByLocalId(action.account_id, action.target_id)?.current_asset_id }));
    return orderId;
  }

  resolveAction(action: ActionRow, observationId: number, applied: boolean, now: string): void {
    if (!this.observation(action.account_id, observationId)) throw new Error('Resolution observation belongs to another account');
    const state = applied ? 'DONE' : this.currentDesired(action) ? 'READY' : 'FAILED';
    this.sqlite.prepare(`UPDATE action SET state=?, updated_at=?, resolved_by_obs=?, resolution=?, error=? WHERE id=?`)
      .run(state, now, observationId, applied ? 'OBSERVED_APPLIED' : 'OBSERVED_NOT_APPLIED', applied ? null : 'complete-observation-proved-not-applied', action.id);
    if (!applied) this.sqlite.prepare(`UPDATE venue_order SET state='ENDED_NOT_APPLIED', ended_at=?, end_evidence=?, confidence='proven',
      end_reason='Complete observation proved request absent' WHERE account_id=? AND action_id=? AND first_open_obs IS NULL`).run(now, observationId, action.account_id, action.id);
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
      this.sqlite.prepare(`INSERT INTO desired_state(id,account_id,target_kind,target_id,version,intent,params_json,basis,created_at,authority,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'HUMAN',?)`).run(id, accountId, goal.target_kind, goal.target_id, goal.version + 1,
          resolution === 'resume' ? goal.intent : 'NONE', goal.params_json, `human-${resolution}`, now, new Date(Date.parse(now) + 7 * 86400_000).toISOString());
      return this.desiredState(id)!;
    });
  }

  publication(accountId: string, surface: string, scopeId: string): PublicationRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM inventory_publication WHERE account_id=? AND surface=? AND scope_id=?
    `).get(accountId, surface, scopeId) as PublicationRow | undefined;
  }

  beginStaging(accountId: string, surface: string, scopeId: string, generation: number): number {
    if (surface === 'gc-inventory' && scopeId === '' && this.publication(accountId, surface, scopeId)?.staging_state !== 'STAGING') {
      this.sqlite.prepare(`DELETE FROM inventory_backup_item WHERE account_id=?`).run(accountId);
      this.sqlite.prepare(`INSERT INTO inventory_backup_item SELECT * FROM item WHERE account_id=? AND location NOT IN ('CASKET','MISSING')`).run(accountId);
    }
    this.sqlite.prepare(`
      INSERT INTO inventory_publication(account_id, surface, scope_id, published_generation, staging_generation, staging_state, published_at)
      VALUES (?, ?, ?, NULL, ?, 'STAGING', NULL)
      ON CONFLICT(account_id, surface, scope_id) DO UPDATE SET staging_generation=excluded.staging_generation, staging_state='STAGING'
    `).run(accountId, surface, scopeId, generation);
    return generation;
  }

  abortStaging(accountId: string, surface: string, scopeId: string, generation: number): void {
    if (surface === 'gc-inventory' && scopeId === '') {
      const columns = (this.sqlite.prepare(`PRAGMA table_info(item)`).all() as Array<{ name: string }>).map(row => row.name);
      this.sqlite.prepare(`INSERT INTO item SELECT * FROM inventory_backup_item WHERE account_id=?
        ON CONFLICT(local_id) DO UPDATE SET ${columns.map(name => `${name}=excluded.${name}`).join(',')}`).run(accountId);
      this.sqlite.prepare(`DELETE FROM inventory_backup_item WHERE account_id=?`).run(accountId);
    }
    this.sqlite.prepare(`
      UPDATE inventory_publication SET staging_state='INACTIVE', staging_generation=NULL
      WHERE account_id=? AND surface=? AND scope_id=? AND staging_generation=?
    `).run(accountId, surface, scopeId, generation);
    this.sqlite.prepare(`
      DELETE FROM item WHERE account_id=? AND row_generation=? AND location<>'CASKET'
    `).run(accountId, generation);
    // Rows first seen by the aborted walk are gone; their accessory rows must not outlive them.
    this.sqlite.prepare(`DELETE FROM item_accessory WHERE account_id=? AND local_id NOT IN (SELECT local_id FROM item WHERE account_id=?)`).run(accountId, accountId);
  }

  publishGeneration(accountId: string, surface: string, scopeId: string, generation: number): void {
    if (surface === 'gc-inventory' && scopeId === '') this.sqlite.prepare(`DELETE FROM inventory_backup_item WHERE account_id=?`).run(accountId);
    this.sqlite.prepare(`
      INSERT INTO inventory_publication(account_id, surface, scope_id, published_generation, staging_generation, staging_state, published_at)
      VALUES (?, ?, ?, ?, NULL, 'INACTIVE', datetime('now'))
      ON CONFLICT(account_id, surface, scope_id) DO UPDATE SET
        published_generation=excluded.published_generation, staging_generation=NULL, staging_state='INACTIVE', published_at=excluded.published_at
    `).run(accountId, surface, scopeId, generation);
  }

  insertSelectionManifest(row: SelectionManifestRow): void {
    this.sqlite.prepare(`
      INSERT INTO selection_manifest(token, revision, state, account_ids_json, filter_json, created_at, handle_count, quantity_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.token, row.revision, row.state, row.account_ids_json, row.filter_json, row.created_at, row.handle_count, row.quantity_total);
  }

  selectionManifest(token: string): SelectionManifestRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM selection_manifest WHERE token=?`).get(token) as SelectionManifestRow | undefined;
  }

  updateSelectionManifest(token: string, patch: Partial<Pick<SelectionManifestRow, 'revision' | 'state' | 'handle_count' | 'quantity_total'>>): void {
    if (patch.revision !== undefined) this.sqlite.prepare(`UPDATE selection_manifest SET revision=? WHERE token=?`).run(patch.revision, token);
    if (patch.state !== undefined) this.sqlite.prepare(`UPDATE selection_manifest SET state=? WHERE token=?`).run(patch.state, token);
    if (patch.handle_count !== undefined) this.sqlite.prepare(`UPDATE selection_manifest SET handle_count=? WHERE token=?`).run(patch.handle_count, token);
    if (patch.quantity_total !== undefined) this.sqlite.prepare(`UPDATE selection_manifest SET quantity_total=? WHERE token=?`).run(patch.quantity_total, token);
  }

  insertSelectionMember(row: SelectionMemberRow): void {
    this.sqlite.prepare(`
      INSERT INTO selection_member(token, revision, account_id, member_id, stack_key, location, casket_id, quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.token, row.revision, row.account_id, row.member_id, row.stack_key, row.location, row.casket_id, row.quantity);
  }

  selectionMembers(token: string, revision: number): SelectionMemberRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM selection_member WHERE token=? AND revision=? ORDER BY account_id, member_id
    `).all(token, revision) as SelectionMemberRow[];
  }

  /** Freezes matching rows in SQLite. The renderer never receives the member list. */
  captureMatchingSelection(
    token: string,
    revision: number,
    accountIds: readonly string[],
    filter?: { search?: string; location?: ItemRow['location'] }
  ): { handles: number; quantity: number } {
    const insert = this.sqlite.prepare(`
      INSERT INTO selection_member(token, revision, account_id, member_id, stack_key, location, casket_id, quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let handles = 0;
    let quantity = 0;
    for (const accountId of accountIds) {
      // One member per holding, of either kind. The published-generation predicate applies to
      // individual rows only, as it does on the inventory page (`inventoryQuery`).
      const visible = this.publishedInventoryVisibility(accountId);
      const itemSql = `
        SELECT local_id, location, casket_id, quantity FROM item
        WHERE account_id=? AND location<>'MISSING'
          AND (unit_kind='fungible' OR (unit_kind='individual'${visible.sql}))
        ${filter?.location ? 'AND location=?' : ''}
      `;
      const itemParams: Array<string | number> = [accountId, ...visible.params, ...(filter?.location ? [filter.location] : [])];
      for (const row of this.sqlite.prepare(itemSql).all(...itemParams) as Array<{ local_id: string; location: string; casket_id: string | null; quantity: number }>) {
        insert.run(token, revision, accountId, row.local_id, null, row.location, row.casket_id, row.quantity);
        handles += 1;
        quantity += row.quantity;
      }
    }
    return { handles, quantity };
  }

  // --- Observation coverage -----------------------------------------------

  checkpoint(accountId: string, surface: string, scopeId = ''): CheckpointRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM observation_checkpoint WHERE account_id=? AND surface=? AND scope_id=?`)
      .get(accountId, surface, scopeId) as CheckpointRow | undefined;
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
      INSERT INTO observation_checkpoint(account_id, surface, scope_id, cursor_json, covered_through, observation_id, updated_at)
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

  private recoverInterruptedActions(): void {
    this.sqlite.prepare("UPDATE command SET state='REJECTED',reject_reason='Preparation interrupted before admission',preparing=0 WHERE preparing=1").run();
    this.sqlite.prepare(`
      UPDATE action SET state='AWAITING_OBSERVATION', error='process-interrupted-before-outcome', updated_at=datetime('now')
      WHERE state='RUNNING'
    `).run();
  }
}
