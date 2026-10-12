import { randomUUID } from 'node:crypto';
import type { AccountId, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, CommandMemberRow, CommandRow, ItemRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { required } from '../kernel/support.js';
import { MAIN_INVENTORY_HARD_CAP, StorageService } from '../surfaces/storage.js';
import { InventoryService } from '../surfaces/inventory.js';
import { ListingPlanner } from '../policy/listing-planner.js';
import { ConvergenceService } from './convergence.js';
import { TradeService } from '../surfaces/trades.js';
import type { MarketService } from '../surfaces/market.js';
import { inventoryQuery, type InventoryFilter } from '../db/inventory-query.js';
import { COMMAND_BASIS, MEMBER_CARRIER_JOINS, MEMBER_STATE_SQL } from '../db/member-state.js';
import { csfloatClaimedAssets, marketplaceBlock } from '../kernel/marketplace-commitments.js';
import { isUntradableGroup, restrictionOf } from '../kernel/identity.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { HoldingsStore } from '../db/holdings.js';
import { TransferStore } from '../db/transfers.js';
import type { Settling } from './settle.js';
import type { Observe } from './refresh.js';

export type CommandKind = 'STORE' | 'RETRIEVE' | 'LIST' | 'TRANSFER' | 'REPRICE' | 'DELIST_TO_STORE';

/** The chains whose first hop is cancelling an open listing. */
const DELIST_FIRST: readonly CommandKind[] = ['REPRICE', 'DELIST_TO_STORE'];

export type CommandMemberInput = {
  accountId: AccountId;
  localId?: string;
  stackKey?: string;
  quantity?: number;
  sourceCasketId?: string;
  destinationCasketId?: string;
  priceReceiveCents?: number;
};

export type CommandRequest = {
  commandId: string;
  kind: CommandKind;
  members?: readonly CommandMemberInput[];
  manifestToken?: string;
  manifestRevision?: number;
  destinations?: Readonly<Record<string, string>>;
  priceReceiveCents?: number;
};

export type SelectionMemberInput = {
  accountId: AccountId;
  localId?: string;
  stackKey?: string;
  quantity?: number;
  location?: ItemRow['location'];
  casketId?: string | null;
};

export type SelectionCaptureRequest = {
  accountIds: readonly AccountId[];
  members?: readonly SelectionMemberInput[];
  filter?: InventoryFilter;
};

export type SelectionSnapshot = {
  token: string;
  revision: number;
  state: string;
  counts: { handles: number; quantity: number };
};

export type CommandProgress = {
  commandId: string;
  state: string;
  observedCompleted: number;
  members: Array<{ accountId: string; memberId: string; state: string; quantity: number }>;
};

/** Where chunked preparation has reached, and what it has already admitted against capacity. */
type PrepareCursor = { afterAccount: string; afterKey: string; offset: number; admitted: Map<string, number> };

export type CommandServices = {
  storage: StorageService;
  inventory: InventoryService;
  planner: ListingPlanner;
  convergence: ConvergenceService;
  trades: TradeService;
  /** The delist-first chains cancel and relist through it; nothing else here touches the market. */
  market: MarketService;
  /** A hop that decides on its own fresh read settles it first; nothing here calls a reconciler. */
  settle: Settling;
  /** The governed read (`RefreshService.observe`): the budget, the breaker, then the settle. */
  observe: Observe;
};

/**
 * One user click becomes one durable command. The backend owns fan-out, preflight and
 * account-keyed work. A known-invalid member rejects the whole batch before any mutation.
 */
export class CommandService {
  /** The holdings write path: units, reservations, stacks as a read (`db/holdings.ts`). */
  protected get holdings(): HoldingsStore { return new HoldingsStore(this.context.database); }
  /** Preparation and dispatch in flight, per command, so `settled` has something to await. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(protected readonly context: EngineContext, protected readonly services: CommandServices) {}

  /**
   * Durable receipt first; no action/goal exists until every input has passed preflight.
   *
   * The first chunk is preflighted and written **synchronously**, before this returns, and that
   * is not an optimisation. Two things depend on it:
   *
   *  - A refusal reaches the caller. `submitApprovedCommand` throws whatever comes back, and the
   *    renderer prints the engine's own words. When preflight ran later in a floating promise the
   *    reason was written to `command.reject_reason` and nowhere else, so the window showed
   *    "Storing 4 items — Submitted." on top of a store that had already been refused.
   *  - The work panel has rows to show. The renderer reads `work.open` the instant `invoke`
   *    resolves and only starts polling once it has seen an open row, so a read that answers zero
   *    is a permanently empty panel, not a slow one.
   *
   * A batch larger than one chunk, or one drawn from a manifest, still yields between writes: the
   * remainder is prepared in the background, and a refusal there takes the durable path instead.
   */
  prepare(request: CommandRequest): CommandRow {
    const db = this.context.database;
    const existing = db.command(request.commandId);
    if (existing) return existing;
    const manifest = request.manifestToken ? db.selectionManifest(request.manifestToken) : undefined;
    if (request.manifestToken && (!manifest || manifest.state !== 'COMPLETE' || (request.manifestRevision !== undefined && manifest.revision !== request.manifestRevision))) throw new Error('Selection token is unexecutable or stale');
    if (!manifest && !request.members?.length) throw new Error('Command has no members');
    db.insertCommand({ id: request.commandId, correlation_id: randomUUID(), kind: request.kind, state: 'ADMITTED', reject_reason: null, created_at: this.context.now(), preparing: 1, manifest_token: request.manifestToken ?? null, observed_completed: 0 });

    const cursor: PrepareCursor = { afterAccount: '', afterKey: '', offset: 0, admitted: new Map() };
    let more: boolean;
    try {
      more = this.prepareChunk(request, manifest?.revision, cursor);
    } catch (error) {
      this.reject(request, error);
      throw error;
    }
    const settle = more
      ? this.prepareRemaining(request, manifest?.revision, cursor)
      : Promise.resolve();
    this.track(request.commandId, settle.then(async () => {
      if (db.command(request.commandId)?.state === 'ADMITTED') await this.dispatch(request.commandId);
    }).catch(error => {
      try {
        const command = db.command(request.commandId);
        if (command?.preparing) this.reject(request, error);
        else if (command) db.setCommandState(request.commandId, 'PARTIAL', String(error));
      } catch {
        // The runtime closed SQLite while this was in flight — a shutdown mid-dispatch, which is
        // ordinary. There is nowhere left to record anything, and throwing here would surface as
        // an unhandled rejection in the utility process rather than as information. What was
        // already written is durable, and `recoverInterruptedActions` reads it on the next open.
      }
    }));
    return db.command(request.commandId)!;
  }

  /**
   * Sends the work an earlier run queued and never got to.
   *
   * `dispatch` used to have exactly one caller: the continuation inside `prepare`. So a command
   * whose dispatch died — the process closed, the Game Coordinator never connected, the response
   * to the fourth member never came — left its members `PREPARED` or `QUEUED` and nothing, ever,
   * looked at them again. A listing survived that, because `setListingGoal` writes a durable goal
   * and convergence owns goals; a store and a retrieve did not, because their actions are queued
   * directly and only `dispatch` sends them.
   *
   * This is the missing half. It resumes by *identity*, not by retry: a member is only re-sent if
   * it never reached a mutation, which is what `QUEUED`/`PREPARED` mean. A `SUBMITTED` member has
   * been sent once and is settled by observation alone (rule 1), and a `STOPPED` or `REJECTED`
   * command is dead and stays dead (OP-03) — reviving one would be exactly the resurrection
   * `N-BATCH-02` forbids.
   */
  async resume(accountId: AccountId): Promise<string[]> {
    const { database } = this.context;
    const rows = database.raw().prepare(`
      SELECT DISTINCT c.id AS id FROM command c JOIN command_member m ON m.command_id=c.id
      WHERE m.account_id=? AND c.state IN ('ADMITTED','RUNNING','PARTIAL') AND c.preparing=0
        AND m.state IN ('PREPARED','QUEUED')
      ORDER BY c.created_at LIMIT 50
    `).all(accountId) as Array<{ id: string }>;
    const resumed: string[] = [];
    for (const row of rows) {
      if (this.inflight.has(row.id)) continue;
      resumed.push(row.id);
      database.addEvent(accountId, 'command-resumed', { commandId: row.id }, this.context.now());
      this.track(row.id, this.dispatch(row.id).then(() => undefined).catch(error => {
        try { database.setCommandState(row.id, 'PARTIAL', String(error)); } catch { /* closed under us */ }
      }));
    }
    await Promise.all(resumed.map(id => this.settled(id)));
    return resumed;
  }

  /**
   * Preparation and dispatch, as something a caller can wait for.
   *
   * The desktop deliberately does not wait — a command is a durable receipt and the window
   * reports progress from `work.open`. A test has to, and the alternative is sleeping, which
   * asserts nothing. This is an observable completion handle, not a fault-injection hook.
   */
  settled(commandId: string): Promise<void> {
    return this.inflight.get(commandId) ?? Promise.resolve();
  }

  private track(commandId: string, work: Promise<void>): void {
    const done = work.finally(() => {
      if (this.inflight.get(commandId) === done) this.inflight.delete(commandId);
    });
    this.inflight.set(commandId, done);
  }

  /**
   * Records a refusal everywhere a person could look for it.
   *
   * The state and reason are the durable record (OP-02). The event is what reaches Activity,
   * because a toast is gone in seconds. The member rows are what let the work panel show the
   * refusal at all — with no rows the command's `JOIN command_member` matches nothing and the
   * panel is empty, which is indistinguishable from nothing having happened.
   */
  protected reject(request: CommandRequest, error: unknown): void {
    const db = this.context.database;
    const reason = error instanceof Error ? error.message : String(error);
    const accounts = new Set((request.members ?? []).map(member => member.accountId));
    db.transaction(() => {
      db.setCommandState(request.commandId, 'REJECTED', reason);
      db.raw().prepare('UPDATE command SET preparing=0 WHERE id=?').run(request.commandId);
      db.raw().prepare(`UPDATE command_member SET state='REJECTED' WHERE command_id=?`).run(request.commandId);
      const existing = new Set(db.commandMembers(request.commandId).map(row => `${row.account_id}:${row.member_id}`));
      for (const [index, member] of (request.members ?? []).entries()) {
        const memberId = member.localId ?? `${member.stackKey ?? 'member'}:${index}`;
        if (existing.has(`${member.accountId}:${memberId}`)) continue;
        db.insertCommandMember({ command_id: request.commandId, account_id: member.accountId, member_id: memberId,
          stack_key: member.stackKey ?? null, quantity: member.quantity ?? 1, destination: member.destinationCasketId ?? null,
          price_receive_cents: member.priceReceiveCents ?? null, state: 'REJECTED', action_id: null, input_json: JSON.stringify(member) });
      }
      for (const accountId of accounts.size ? accounts : db.commandMembers(request.commandId).map(row => row.account_id)) {
        db.addEvent(accountId, 'command-rejected', { commandId: request.commandId, kind: request.kind, reason }, this.context.now());
      }
    });
  }

  /** One page of members: preflighted and written, or thrown. Returns whether more remain. */
  private prepareChunk(request: CommandRequest, manifestRevision: number | undefined, cursor: PrepareCursor): boolean {
    const db = this.context.database;
    if (db.command(request.commandId)?.state === 'STOPPED') return false;
    const input: Array<{ key: string; member: CommandMemberInput }> = request.manifestToken
      ? (db.raw().prepare('SELECT * FROM selection_member WHERE token=? AND revision=? AND (account_id,member_id)>(?,?) ORDER BY account_id,member_id LIMIT 250')
        .all(request.manifestToken, manifestRevision!, cursor.afterAccount, cursor.afterKey) as Array<{ member_id: string; account_id: string; stack_key: string | null; casket_id: string | null; quantity: number }>).map(row => ({ key: row.member_id, member: {
          accountId: row.account_id, ...(row.stack_key ? { stackKey: row.stack_key } : { localId: row.member_id }), quantity: row.quantity,
          ...(row.casket_id ? { sourceCasketId: row.casket_id } : {}), ...(request.destinations?.[row.account_id] ? { destinationCasketId: request.destinations[row.account_id]! } : {}),
          ...(request.priceReceiveCents ? { priceReceiveCents: request.priceReceiveCents } : {}) } }))
      : [...(request.members ?? [])].slice(cursor.offset, cursor.offset + 250).map((member, i) => ({ key: member.localId ?? `${member.stackKey}:${cursor.offset+i}`, member }));
    if (!input.length) {
      db.raw().prepare('UPDATE command SET preparing=0 WHERE id=?').run(request.commandId);
      return false;
    }
    const reason = this.preflight({ ...request, members: input.map(row => row.member) });
    if (reason) throw new Error(reason);
    for (const { member } of input) {
      if (request.kind === 'RETRIEVE' || request.kind === 'TRANSFER') {
        const quantity = (cursor.admitted.get(member.accountId) ?? 0) + (member.quantity ?? 1);
        cursor.admitted.set(member.accountId, quantity);
        if (db.countMainItems(member.accountId) + db.reservedMainSlots(member.accountId) + quantity > MAIN_INVENTORY_HARD_CAP) throw new Error('Retrieve would exceed main inventory capacity');
      }
    }
    db.transaction(() => {
      for (const { key, member } of input) db.insertCommandMember({ command_id: request.commandId, account_id: member.accountId, member_id: key,
        stack_key: member.stackKey ?? null, quantity: member.quantity ?? 1, destination: member.destinationCasketId ?? null, price_receive_cents: member.priceReceiveCents ?? null,
        state: 'PREPARED', action_id: null, input_json: JSON.stringify(member) });
    });
    cursor.afterAccount = input.at(-1)!.member.accountId; cursor.afterKey = input.at(-1)!.key; cursor.offset += input.length;
    // A short page is the last page for an inline member list; a manifest has to ask again.
    if (!request.manifestToken && input.length < 250) {
      db.raw().prepare('UPDATE command SET preparing=0 WHERE id=?').run(request.commandId);
      return false;
    }
    return true;
  }

  /** Everything after the first page, yielding between short writes so nothing blocks. */
  private async prepareRemaining(request: CommandRequest, manifestRevision: number | undefined, cursor: PrepareCursor): Promise<void> {
    while (true) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!this.prepareChunk(request, manifestRevision, cursor)) return;
    }
  }

  /** Capture yields between short writes. A changed ownership revision invalidates the capture. */
  async captureMatching(request: SelectionCaptureRequest): Promise<SelectionSnapshot> {
    const db = this.context.database;
    const accounts = [...new Set(request.accountIds)].sort();
    if (!accounts.length || accounts.length !== request.accountIds.length || db.knownAccountIds(accounts).length !== accounts.length) throw new Error('Invalid selection account scope');
    const token = randomUUID();
    const marks = () => JSON.stringify(db.raw().prepare(`SELECT * FROM read_revision WHERE account_id IN (${accounts.map(() => '?')}) ORDER BY account_id,surface`).all(...accounts));
    const revision = marks();
    db.insertSelectionManifest({ token, revision: 1, state: 'DRAFT', account_ids_json: JSON.stringify(accounts), filter_json: JSON.stringify(request.filter ?? {}), created_at: this.context.now(), handle_count: 0, quantity_total: 0 });
    let afterAccount = '', afterKey = '', quantity = 0;
    try {
      while (true) {
        if (revision !== marks()) throw new Error('Selection changed during capture; capture again');
        const query = inventoryQuery(db, accounts, request.filter, { after: [afterAccount, afterKey], limit: 500 });
        const rows = db.raw().prepare(`SELECT accountId,rowKey,stackKey,location,casketId,quantity FROM (${query.sql}) ORDER BY accountId,rowKey LIMIT 500`)
          .all(...query.params) as Array<{ accountId: string; rowKey: string; stackKey: string | null; location: string; casketId: string | null; quantity: number }>;
        if (!rows.length) break;
        db.transaction(() => {
          for (const row of rows) {
            db.insertSelectionMember({ token, revision: 1, account_id: row.accountId, member_id: row.rowKey, stack_key: row.stackKey, location: row.location, casket_id: row.casketId, quantity: row.quantity });
            quantity += row.quantity;
          }
        });
        afterAccount = rows.at(-1)!.accountId; afterKey = rows.at(-1)!.rowKey;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      db.updateSelectionManifest(token, { state: 'COMPLETE', handle_count: quantity, quantity_total: quantity });
      return this.readSelection(token);
    } catch (error) {
      db.updateSelectionManifest(token, { state: 'RELEASED' });
      throw error;
    }
  }

  submit(request: CommandRequest): CommandRow {
    const { database } = this.context;
    const existing = database.command(request.commandId);
    if (existing) return existing;
    const members = this.resolveMembers(request);
    if (members.length === 0) throw new Error('Command has no members');
    const normalized: CommandRequest & { members: readonly CommandMemberInput[] } = { ...request, members };

    const now = this.context.now();
    const correlationId = randomUUID();
    return database.transaction(() => {
      const reason = this.preflight(normalized);
      database.insertCommand({
        id: request.commandId,
        correlation_id: correlationId,
        kind: request.kind,
        state: reason ? 'REJECTED' : 'ADMITTED',
        reject_reason: reason,
        created_at: now,
        preparing: 0,
        manifest_token: request.manifestToken ?? null,
        observed_completed: 0
      });
      if (reason) {
        for (const [index, member] of members.entries()) {
          database.insertCommandMember({
            command_id: request.commandId,
            account_id: member.accountId,
            member_id: member.localId ?? `${member.stackKey ?? 'member'}:${index}`,
            stack_key: member.stackKey ?? null,
            quantity: member.quantity ?? 1,
            destination: member.destinationCasketId ?? null,
            price_receive_cents: member.priceReceiveCents ?? null,
            state: 'REJECTED',
            action_id: null
          });
        }
        database.addEvent(members[0]!.accountId, 'command-rejected', { commandId: request.commandId, reason }, now);
        return database.command(request.commandId)!;
      }

      for (const [index, member] of members.entries()) {
        const queued = this.queueMember(request.commandId, request.kind, member, index);
        for (const row of queued) database.insertCommandMember(row);
      }
      return database.command(request.commandId)!;
    });
  }

  /**
   * One dispatch, held in `inflight` for its duration whoever called it, so a settle's
   * `advanceChains` never starts a second advance beside the one a dispatch is running inline.
   * `prepare` and `resume` track their own continuation as well; the nesting is harmless.
   */
  dispatch(commandId: string): Promise<MutationOutcome[]> {
    const work = this.runDispatch(commandId);
    this.track(commandId, work.then(() => undefined, () => undefined));
    return work;
  }

  private async runDispatch(commandId: string): Promise<MutationOutcome[]> {
    const { database } = this.context;
    const command = required(database.command(commandId), `Unknown command ${commandId}`);
    if (command.state === 'REJECTED' || command.state === 'STOPPED' || command.state === 'COMPLETE') return [];
    if (command.preparing) return [];
    database.setCommandState(commandId, 'RUNNING');
    const results: MutationOutcome[] = [];
    const accounts = (database.raw().prepare('SELECT DISTINCT account_id FROM command_member WHERE command_id=?').all(commandId) as Array<{ account_id: string }>).map(row => row.account_id);
    const runAccount = async (accountId: AccountId): Promise<void> => {
      await this.context.ports.gc.connect(accountId, 30_000);
      await this.context.locks.run(accountId, async () => {
        if (command.kind === 'TRANSFER') await this.resumeTransfer(commandId, accountId);
        if (DELIST_FIRST.includes(command.kind as CommandKind)) await this.resumeDelistChain(commandId, accountId);
        let after = '', expandedIndex = 0;
        while (true) {
          const page = database.raw().prepare('SELECT * FROM command_member WHERE command_id=? AND account_id=? AND member_id>? ORDER BY member_id LIMIT 100').all(commandId, accountId, after) as CommandMemberRow[];
          if (!page.length) break;
          after = page.at(-1)!.member_id;
          const members: CommandMemberRow[] = [];
          for (const row of page) {
            if (row.state !== 'PREPARED' || !row.input_json) { members.push(row); continue; }
            const input = JSON.parse(row.input_json) as CommandMemberInput;
            const reason = this.preflight({ commandId, kind: command.kind as CommandKind, members: [input] });
            if (reason) { database.setCommandMember(commandId, accountId, row.member_id, { state: 'REJECTED' }); continue; }
            database.transaction(() => {
              const queued = this.queueMember(commandId, command.kind as CommandKind, input, expandedIndex++);
              database.raw().prepare('DELETE FROM command_member WHERE command_id=? AND account_id=? AND member_id=?').run(commandId, accountId, row.member_id);
              for (const next of queued) { database.insertCommandMember(next); members.push(next); }
            });
          }
          for (const member of members) {
          const latest = database.command(commandId)!;
          if (latest.state === 'STOPPED') return;
          if (member.state !== 'QUEUED' || !member.action_id) continue;
          const action = database.action(member.action_id);
          if (!action || action.state !== 'READY') continue;
          const outcome = await this.executeMember(command.kind as CommandKind, action);
          results.push(outcome);
          if (action.kind === 'RETRIEVE_FROM_CASKET' && outcome.kind !== 'DEFINITIVELY_REJECTED') {
            database.markSlotSubmitted(accountId, action.id);
          }
          const midChain = outcome.kind !== 'DEFINITIVELY_REJECTED'
            && ((command.kind === 'TRANSFER' && action.kind === 'RETRIEVE_FROM_CASKET')
              || (DELIST_FIRST.includes(command.kind as CommandKind) && action.kind === 'REMOVE_SELL_LISTING'));
          const nextState = midChain
            ? 'IN_TRANSIT'
            : outcome.kind === 'SUBMITTED' || outcome.kind === 'AMBIGUOUS' ? 'SUBMITTED' : outcome.kind === 'DEFINITIVELY_REJECTED' ? 'REJECTED' : 'QUEUED';
          database.setCommandMember(commandId, member.account_id, member.member_id, { state: nextState });
          if (nextState === 'IN_TRANSIT') {
            const row = database.raw().prepare('SELECT * FROM command_member WHERE command_id=? AND account_id=? AND member_id=?')
              .get(commandId, member.account_id, member.member_id) as CommandMemberRow;
            if (command.kind === 'TRANSFER') await this.advanceTransfer(commandId, row);
            else await this.advanceDelistChain(commandId, command.kind as CommandKind, row);
          }
        }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (command.kind === 'TRANSFER') await this.resumeTransfer(commandId, accountId);
        if (DELIST_FIRST.includes(command.kind as CommandKind)) await this.resumeDelistChain(commandId, accountId);
      });
    };
    if (this.dispatchSequentially()) {
      for (const accountId of accounts) await runAccount(accountId);
    } else {
      await Promise.all(accounts.map((accountId) => runAccount(accountId)));
    }

    if (command.kind === 'LIST') {
      for (const accountId of accounts) {
        if (database.command(commandId)!.state === 'STOPPED') break;
        await this.services.convergence.converge(accountId);
      }
      for (const member of database.commandMembers(commandId)) {
        if (member.state === 'QUEUED') {
          database.setCommandMember(commandId, member.account_id, member.member_id, { state: 'SUBMITTED' });
        }
      }
    }

    this.finish(commandId);
    return results;
  }

  stop(commandId: string): CommandRow {
    const { database } = this.context;
    const command = required(database.command(commandId), `Unknown command ${commandId}`);
    if (command.state === 'REJECTED' || command.state === 'COMPLETE') return command;
    return database.transaction(() => {
      for (const member of database.commandMembers(commandId)) {
        if (member.state !== 'QUEUED') continue;
        database.setCommandMember(commandId, member.account_id, member.member_id, { state: 'STOPPED' });
        if (!member.action_id) continue;
        const action = database.action(member.action_id);
        if (action && action.state === 'READY') {
          database.raw().prepare(`UPDATE action SET state='FAILED', error=?, updated_at=? WHERE id=?`)
            .run('command-stopped', this.context.now(), action.id);
          database.releaseSlot(member.account_id, action.id, false);
          // A unit the command reserved is the action's target; a stop hands it back.
          this.holdings.releaseUnit(member.account_id, action.target_id, commandId);
        }
      }
      database.setCommandState(commandId, 'STOPPED');
      return database.command(commandId)!;
    });
  }

  protected dispatchSequentially(): boolean {
    return false;
  }

  protected resolveMembers(request: CommandRequest): CommandMemberInput[] {
    if (request.manifestToken) {
      const manifest = this.context.database.selectionManifest(request.manifestToken);
      if (!manifest || manifest.state !== 'COMPLETE') throw new Error('Selection token is unexecutable');
      if (request.manifestRevision !== undefined && manifest.revision !== request.manifestRevision) {
        throw new Error('Selection token revision is stale');
      }
      return this.context.database.selectionMembers(request.manifestToken, manifest.revision).map((row) => ({
        accountId: row.account_id,
        ...(row.stack_key ? { stackKey: row.stack_key } : { localId: row.member_id }),
        quantity: row.quantity,
        ...(row.casket_id ? { sourceCasketId: row.casket_id } : {}),
        ...(request.destinations?.[row.account_id] ? { destinationCasketId: request.destinations[row.account_id] } : {}),
        ...(request.priceReceiveCents ? { priceReceiveCents: request.priceReceiveCents } : {})
      }));
    }
    return [...(request.members ?? [])];
  }

  captureSelection(request: SelectionCaptureRequest): SelectionSnapshot {
    const token = randomUUID();
    const explicit = request.members ?? [];
    if (explicit.length === 0 && !request.filter) throw new Error('Selection capture needs members or a filter');
    this.context.database.transaction(() => {
      this.context.database.insertSelectionManifest({
        token,
        revision: 1,
        state: 'COMPLETE',
        account_ids_json: JSON.stringify(request.accountIds),
        filter_json: JSON.stringify(request.filter ?? {}),
        created_at: this.context.now(),
        handle_count: 0,
        quantity_total: 0
      });
      let handles = 0;
      let quantity = 0;
      if (explicit.length > 0) {
        for (const member of explicit) {
          this.context.database.insertSelectionMember({
            token,
            revision: 1,
            account_id: member.accountId,
            member_id: member.localId ?? member.stackKey ?? randomUUID(),
            stack_key: member.stackKey ?? null,
            location: member.location ?? null,
            casket_id: member.casketId ?? null,
            quantity: member.quantity ?? 1
          });
          handles += 1;
          quantity += member.quantity ?? 1;
        }
      } else {
        const captured = this.context.database.captureMatchingSelection(token, 1, request.accountIds, request.filter);
        handles = captured.handles;
        quantity = captured.quantity;
      }
      this.context.database.updateSelectionManifest(token, { handle_count: handles, quantity_total: quantity });
    });
    return this.readSelection(token);
  }

  updateSelection(token: string, revision: number, patch: { exclude?: readonly SelectionMemberInput[] }): SelectionSnapshot {
    const manifest = required(this.context.database.selectionManifest(token), 'Unknown selection');
    if (manifest.revision !== revision) throw new Error('Selection revision mismatch');
    const next = revision + 1;
    const keep = this.context.database.selectionMembers(token, revision).filter((row) => {
      return !(patch.exclude ?? []).some((member) => member.accountId === row.account_id && (member.localId ?? member.stackKey) === row.member_id);
    });
    this.context.database.transaction(() => {
      for (const row of keep) this.context.database.insertSelectionMember({ ...row, revision: next });
      this.context.database.updateSelectionManifest(token, {
        revision: next,
        handle_count: keep.length,
        quantity_total: keep.reduce((sum, row) => sum + row.quantity, 0)
      });
    });
    return this.readSelection(token);
  }

  readSelection(token: string): SelectionSnapshot {
    const manifest = required(this.context.database.selectionManifest(token), 'Unknown selection');
    return {
      token,
      revision: manifest.revision,
      state: manifest.state,
      counts: { handles: manifest.handle_count, quantity: manifest.quantity_total }
    };
  }

  commandProgress(commandId: string): CommandProgress {
    const command = required(this.context.database.command(commandId), `Unknown command ${commandId}`);
    // The same words `work.open` uses (`db/member-state.ts`): a listing member is carried by its
    // goal's newest action, and observed completed counts `DONE` only, through that action.
    const members = this.context.database.raw().prepare(`SELECT m.account_id AS accountId, m.member_id AS memberId, ${MEMBER_STATE_SQL} AS state, m.quantity AS quantity
      FROM command c JOIN command_member m ON m.command_id=c.id ${MEMBER_CARRIER_JOINS}
      WHERE c.id=? ORDER BY m.account_id, m.member_id LIMIT 100`).all(commandId) as CommandProgress['members'];
    const observedCompleted = (this.context.database.raw().prepare(`SELECT COALESCE(SUM(m.quantity),0) AS n
      FROM command c JOIN command_member m ON m.command_id=c.id ${MEMBER_CARRIER_JOINS}
      WHERE c.id=? AND (${MEMBER_STATE_SQL})='COMPLETE'`).get(commandId) as { n: number }).n;
    return { commandId, state: command.state, observedCompleted, members };
  }

  /**
   * A unit advertised on, or owed to, another marketplace is not free to store, list or send,
   * whatever the Game Coordinator says about its location (CSF-13). The same check runs again
   * at dispatch; here it keeps a known-invalid member from admitting the batch at all.
   */
  protected marketplaceProblem(kind: CommandKind, member: CommandMemberInput, item: ItemRow): string | null {
    const purpose = kind === 'LIST' || kind === 'REPRICE' ? 'steam-list' : kind === 'TRANSFER' ? 'transfer' : kind === 'RETRIEVE' ? null
      : kind === 'DELIST_TO_STORE' ? 'delist-to-store' : 'storage';
    if (!purpose) return null;
    const reason = marketplaceBlock(this.context.database, member.accountId, item.local_id, purpose, this.context.now());
    return reason ? `Item ${member.localId}: ${reason}` : null;
  }

  protected preflight(request: CommandRequest): string | null {
    const { database } = this.context;
    const retrievesByAccount = new Map<string, number>();
    // Read once per account rather than per member: a two-thousand-member batch must not run
    // two thousand joins to answer the same question.
    const pledged = new Map<string, ReturnType<TradeService['committedAssets']>>();
    const pledgedFor = (accountId: string): ReturnType<TradeService['committedAssets']> => {
      const found = pledged.get(accountId) ?? this.services.trades.committedAssets(accountId);
      pledged.set(accountId, found);
      return found;
    };
    for (const member of request.members ?? []) {
      if (member.destinationCasketId && member.localId) {
        const item = database.itemByLocalId(member.accountId, member.localId);
        if (item && request.kind === 'STORE' && item.account_id !== member.accountId) {
          return `Destination is not in account ${member.accountId}`;
        }
      }
      if (member.localId) {
        const item = database.itemByLocalId(member.accountId, member.localId);
        if (!item) return `Unknown item ${member.localId}`;
        if (item.account_id !== member.accountId) return `Item ${member.localId} is not owned by ${member.accountId}`;
        const problem = this.itemProblem(request.kind, member, item);
        if (problem) return problem;
        // Moving or listing an item a counterparty has been offered would invalidate a real
        // person's trade. The app refuses instead, and never cancels the offer to make room
        // (TRD-06). Nothing here reaches the network: it reads the last observed offer book.
        const commitment = item.current_asset_id ? pledgedFor(member.accountId).get(item.current_asset_id) : undefined;
        if (commitment) return `Item ${member.localId} is pledged to trade offer ${commitment.offerId} (${commitment.status})`;
        const marketplace = this.marketplaceProblem(request.kind, member, item);
        if (marketplace) return marketplace;
      } else if (member.stackKey) {
        if (DELIST_FIRST.includes(request.kind)) return 'A stack has no listing of its own to reprice or delist; cancel the listing itself';
        const untradable = this.untradableProblem(request.kind, { stackKey: member.stackKey });
        if (untradable) return untradable;
        if (request.kind === 'LIST') {
          if (!Number.isInteger(member.priceReceiveCents) || (member.priceReceiveCents ?? 0) <= 0) return 'Seller-receives price must be positive integer cents';
          const lockedUntil = this.stackLockedUntil(member.stackKey);
          if (lockedUntil) return `Locked items cannot be listed until ${lockedUntil}`;
        }
        const quantity = member.quantity ?? 1;
        const source = request.kind === 'RETRIEVE' || request.kind === 'TRANSFER' ? 'CASKET' : 'MAIN';
        const casketId = request.kind === 'RETRIEVE' || request.kind === 'TRANSFER' ? member.sourceCasketId ?? null : null;
        const committed = pledgedFor(member.accountId);
        // A unit on the market, or sent there and not yet walked, is not free to list, store or
        // send, whatever its location says: a listed item stays in the GC inventory
        // (`db/steam-listing.ts`), so a handle's location cannot answer this on its own.
        const listed = this.services.market.listedAssets(member.accountId);
        // Nor is a unit CSFloat holds for a listing or a sale (`csfloatClaimedAssets`).
        const claimed = csfloatClaimedAssets(database, member.accountId);
        const units = this.holdings.units(member.accountId, member.stackKey)
          .filter((unit) => unit.location === source && (unit.casket_id ?? '') === (casketId ?? '') && unit.current_asset_id
            && !unit.reserved_command && !committed.has(unit.current_asset_id) && !listed.has(unit.current_asset_id) && !claimed.has(unit.current_asset_id));
        if (request.kind === 'LIST' && units.length > 0 && units.every((unit) => this.marketableProblem(member.accountId, unit.current_asset_id!))) {
          return `${member.stackKey} is not marketable on Steam`;
        }
        const free = units
          .filter((unit) => request.kind !== 'LIST' || !this.marketableProblem(member.accountId, unit.current_asset_id!))
          .reduce((sum, unit) => sum + unit.quantity, 0);
        if (free < quantity) return `Not enough unreserved quantity on ${member.stackKey}`;
        if (request.kind === 'STORE' && this.stackRestricted(member.accountId, member.stackKey)) {
          return `Trade-protected items cannot be stored`;
        }
      } else {
        return 'Each member needs a localId or a stackKey';
      }
      if (request.kind === 'RETRIEVE' || request.kind === 'TRANSFER') {
        retrievesByAccount.set(member.accountId, (retrievesByAccount.get(member.accountId) ?? 0) + (member.quantity ?? 1));
      }
      if (request.kind === 'STORE' && !member.destinationCasketId) return 'STORE requires destinationCasketId';
      if (request.kind === 'RETRIEVE' && !member.sourceCasketId && !member.localId) return 'RETRIEVE requires sourceCasketId';
      if (request.kind === 'TRANSFER') {
        const transfer = this.transferProblem(member);
        if (transfer) return transfer;
      }
      if (request.kind === 'LIST' && member.localId && !(member.priceReceiveCents && member.priceReceiveCents > 0)) {
        return 'LIST requires a positive seller-receives price';
      }
      if (DELIST_FIRST.includes(request.kind)) {
        const chain = this.delistChainProblem(request.kind, member);
        if (chain) return chain;
      }
    }
    for (const [accountId, extra] of retrievesByAccount) {
      if (database.countMainItems(accountId) + database.reservedMainSlots(accountId) + extra > MAIN_INVENTORY_HARD_CAP) {
        return `Retrieve would exceed main inventory capacity on ${accountId}`;
      }
    }
    return null;
  }

  protected itemProblem(kind: CommandKind, member: CommandMemberInput, item: ItemRow): string | null {
    const untradable = this.untradableProblem(kind, { item });
    if (untradable) return untradable;
    if (kind === 'STORE') {
      if (item.location !== 'MAIN' || !item.current_asset_id) return `Item ${item.local_id} is not in main inventory`;
      if (item.trade_protected_until && new Date(item.trade_protected_until) > this.context.ports.clock.now()) {
        return 'Trade-protected items cannot be stored';
      }
      if (!member.destinationCasketId) return 'STORE requires destinationCasketId';
    }
    if (kind === 'RETRIEVE' || kind === 'TRANSFER') {
      if (item.location !== 'CASKET' || !item.current_asset_id) return `Item ${item.local_id} is not in the casket`;
    }
    if (kind === 'LIST' && item.location === 'MISSING') return `Item ${item.local_id} is missing`;
    if (kind === 'LIST' && item.current_asset_id) {
      const marketable = this.marketableProblem(item.account_id, item.current_asset_id);
      if (marketable) return `Item ${item.local_id} ${marketable}`;
    }
    // A reprice or a delist-to-store needs an open listing, which `delistChainProblem` asks of the
    // listing book. The item's location cannot answer it: a listed item is in main inventory.
    return null;
  }

  /**
   * Whether a group's units in main inventory are trade-protected: a store would time out on
   * the Game Coordinator (csgomarketv3, measured), so it is refused whole before anything is sent.
   * The lock is on each row, the same two columns a skin carries.
   */
  /**
   * Steam's `marketable` flag on the last Community read of this asset (holdings plan D7). No GC
   * attribute says whether a unit can be sold on the market at all — a viewer pass, a coin, a pet —
   * so without this the app offers it and Steam refuses it at send as unmarketable. Unread is
   * unknown, and unknown is allowed, as it always was.
   */
  protected marketableProblem(accountId: string, assetId: string): string | null {
    const eligibility = new TransferStore(this.context.database).eligibility(accountId, assetId);
    return eligibility?.marketable === 0 ? 'is not marketable on Steam' : null;
  }

  /**
   * A unit the Game Coordinator marks `cannot trade` (attribute 2) is held, not handled: it is
   * neither listed nor stored. Retrieving one that somehow sits in a unit stays allowed, so nothing
   * is ever trapped. An item is read off its row's own attributes, re-derived on every walk; a
   * group by its key, whose restriction field is `untradable` for exactly those units.
   */
  protected untradableProblem(kind: CommandKind, subject: { item?: ItemRow; stackKey?: string }): string | null {
    if (kind !== 'LIST' && kind !== 'STORE') return null;
    if (subject.item && storedCannotTrade(subject.item.attributes_json)) return `Item ${subject.item.local_id} is marked untradable by Steam`;
    if (subject.stackKey && isUntradableGroup(subject.stackKey)) return `${subject.stackKey} is marked untradable by Steam`;
    return null;
  }

  /** The asset ids of a group's units the last Community read holds unmarketable. */
  protected unmarketableAssets(accountId: string, stackKey: string): string[] {
    return this.holdings.units(accountId, stackKey)
      .filter((unit) => unit.current_asset_id && this.marketableProblem(accountId, unit.current_asset_id))
      .map((unit) => unit.current_asset_id!);
  }

  protected stackRestricted(accountId: string, stackKey: string): boolean {
    const now = this.context.now();
    return this.holdings.units(accountId, stackKey)
      .some((unit) => unit.location === 'MAIN' && unit.trade_protected_until !== null && unit.trade_protected_until > now);
  }

  /**
   * The lock a group is under, while it still runs. A group key's last field is its restriction
   * token (`kernel/identity.ts` `restrictionOf`): a market lock or trade protection, so a locked
   * case is a different group from a free one and is refused whole.
   */
  protected stackLockedUntil(stackKey: string): string | null {
    const until = restrictionOf(stackKey);
    return until && until > this.context.now() ? until : null;
  }

  protected queueMember(commandId: string, kind: CommandKind, member: CommandMemberInput, index: number): CommandMemberRow[] {
    if (member.stackKey && !member.localId) return this.queueStack(commandId, kind, member, index);
    const memberId = member.localId ?? `member:${index}`;
    const action = this.queueOne(kind, member, member.localId!);
    if ((kind === 'RETRIEVE' || kind === 'TRANSFER') && action) this.context.database.reserveMainSlot(member.accountId, action.id);
    return [{
      command_id: commandId,
      account_id: member.accountId,
      member_id: memberId,
      stack_key: member.stackKey ?? null,
      quantity: member.quantity ?? 1,
      destination: member.destinationCasketId ?? null,
      price_receive_cents: member.priceReceiveCents ?? null,
      state: 'QUEUED',
      action_id: action?.id ?? null,
      input_json: JSON.stringify(member)
    }];
  }

  protected queueStack(commandId: string, kind: CommandKind, member: CommandMemberInput, index: number): CommandMemberRow[] {
    const location = kind === 'RETRIEVE' || kind === 'TRANSFER' ? 'CASKET' : 'MAIN';
    const casketId = kind === 'RETRIEVE' || kind === 'TRANSFER' ? member.sourceCasketId ?? null : null;
    // A unit on the Steam market is not the group's to hand out for anything, though the GC still
    // holds it in main inventory, and neither is one CSFloat holds for a listing or a sale. Nor,
    // for a listing, is one Steam's Community read says is unmarketable: preflight counted only
    // the marketable units as free, so allocation must hand out only those, not whichever sorts first.
    const exclude = new Set([
      ...this.services.market.listedAssets(member.accountId),
      ...(kind === 'LIST' ? this.unmarketableAssets(member.accountId, member.stackKey!) : []),
      ...csfloatClaimedAssets(this.context.database, member.accountId)
    ]);
    const units = this.allocate(member.accountId, member.stackKey!, location, casketId, member.quantity ?? 1, commandId, exclude);
    return units.map((unit, unitIndex) => {
      const synthetic: CommandMemberInput = {
        accountId: member.accountId,
        ...(member.destinationCasketId ? { destinationCasketId: member.destinationCasketId } : {}),
        ...(member.sourceCasketId ? { sourceCasketId: member.sourceCasketId } : {}),
        ...(member.priceReceiveCents ? { priceReceiveCents: member.priceReceiveCents } : {})
      };
      const action = this.queueUnit(kind, synthetic, unit.local_id);
      if ((kind === 'RETRIEVE' || kind === 'TRANSFER') && action) this.context.database.reserveMainSlot(member.accountId, action.id);
      return {
        command_id: commandId,
        account_id: member.accountId,
        member_id: `${member.stackKey}:${index}:${unitIndex}`,
        stack_key: member.stackKey ?? null,
        quantity: unit.quantity,
        destination: member.destinationCasketId ?? null,
        price_receive_cents: member.priceReceiveCents ?? null,
        state: 'QUEUED',
        action_id: action?.id ?? null,
        input_json: JSON.stringify(member)
      };
    });
  }

  /** Isolated so a saboteur can allocate the whole group. */
  protected allocate(accountId: string, stackKey: string, location: ItemRow['location'], casketId: string | null, quantity: number, commandId: string, exclude?: ReadonlySet<string>): ItemRow[] {
    return this.holdings.allocateUnits(accountId, stackKey, location, casketId, quantity, commandId, exclude);
  }

  protected queueOne(kind: CommandKind, member: CommandMemberInput, localId: string): ActionRow | undefined {
    if (DELIST_FIRST.includes(kind)) {
      const listing = this.openListingFor(member.accountId, localId);
      // Named as the command's, because a delist asked for by hand is open work in its own right
      // (`delistOpenWork`) and this one is already reported through its member.
      return listing ? this.services.market.queueDelist(member.accountId, listing, COMMAND_BASIS) : undefined;
    }
    if (kind === 'STORE') return this.services.storage.queueStore(member.accountId, localId, member.destinationCasketId!);
    if (kind === 'RETRIEVE' || kind === 'TRANSFER') {
      return this.services.storage.queueRetrieve(member.accountId, localId, member.sourceCasketId ?? this.context.database.itemByLocalId(member.accountId, localId)!.casket_id!);
    }
    this.services.planner.setListingGoal(member.accountId, localId, member.priceReceiveCents!);
    return undefined;
  }

  /**
   * One reserved unit of a group. The same storage actions as an individual item; a LIST is a
   * direct listing action rather than a planner goal, because a group lists from main inventory
   * or is refused, and the walk matches the listing back to the row under the asset id a
   * round-trip keeps (rule 3).
   */
  protected queueUnit(kind: CommandKind, member: CommandMemberInput, localId: string): ActionRow | undefined {
    if (kind === 'LIST') return this.services.market.queueSellListing(member.accountId, localId, member.priceReceiveCents!);
    return this.queueOne(kind, member, localId);
  }

  protected executeMember(kind: CommandKind, action: ActionRow): Promise<MutationOutcome> {
    // A group unit's LIST member carries its own listing action; an individual item's carries
    // none, because its listing is a goal the planner sends (`db/member-state.ts`).
    if (action.kind === 'CREATE_SELL_LISTING') return this.services.market.executeSellListing(action.id);
    if (kind === 'LIST') return Promise.resolve({ kind: 'SUBMITTED', evidence: 'listing-goal-set', raw: null });
    if (action.kind === 'REMOVE_SELL_LISTING') return this.services.market.executeDelist(action.id);
    return this.services.storage.execute(action.id);
  }

  /** Destination exists, differs from source, and has a complete occupancy observation. */
  protected transferProblem(member: CommandMemberInput): string | null {
    if (!member.destinationCasketId) return 'TRANSFER requires destinationCasketId';
    const source = member.sourceCasketId
      ?? (member.localId ? this.context.database.itemByLocalId(member.accountId, member.localId)?.casket_id : null);
    if (!source && !member.localId) return 'TRANSFER requires sourceCasketId';
    if (source && source === member.destinationCasketId) return 'TRANSFER destination must differ from source';
    const unit = this.context.database.raw()
      .prepare(`SELECT casket_id, contents_obs FROM storage_unit WHERE account_id=? AND casket_id=?`)
      .get(member.accountId, member.destinationCasketId) as { casket_id: string; contents_obs: number | null } | undefined;
    if (!unit) return `Unknown destination unit ${member.destinationCasketId}`;
    const obs = unit.contents_obs
      ? this.context.database.raw().prepare(`SELECT complete FROM observation WHERE id=?`).get(unit.contents_obs) as { complete: number } | undefined
      : undefined;
    if (!obs?.complete) return `Destination ${member.destinationCasketId} contents are not a complete observation`;
    const occupancy = new HoldingsStore(this.context.database).casketQuantity(member.accountId, member.destinationCasketId);
    if (occupancy + (member.quantity ?? 1) > MAIN_INVENTORY_HARD_CAP) {
      return `Destination ${member.destinationCasketId} cannot hold the requested quantity`;
    }
    return null;
  }

  protected transferSource(member: CommandMemberRow): string | undefined {
    if (member.input_json) {
      const input = JSON.parse(member.input_json) as CommandMemberInput;
      if (input.sourceCasketId) return input.sourceCasketId;
    }
    const action = member.action_id ? this.context.database.action(member.action_id) : undefined;
    if (action?.kind === 'RETRIEVE_FROM_CASKET') {
      return (this.context.database.actionParams(action) as { casketId?: string }).casketId;
    }
    return undefined;
  }

  /** Isolated so a saboteur can skip the observation that gates the store hop. */
  protected async observeTransferTransit(accountId: AccountId, sourceCasketId: string | undefined, destCasketId: string): Promise<void> {
    // Proof after the hop's mutation: no walk that began before this moment can answer it.
    const startedAfter = this.context.now();
    await this.services.observe(accountId, { surface: 'gc-inventory', scope: { kind: 'account' } }, { startedAfter });
    if (sourceCasketId) await this.services.observe(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: sourceCasketId } }, { startedAfter });
    await this.services.observe(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: destCasketId } }, { startedAfter });
    this.services.settle.settleNow(accountId);
  }

  protected memberOutcomeState(outcome: MutationOutcome): string {
    if (outcome.kind === 'SUBMITTED' || outcome.kind === 'AMBIGUOUS') return 'SUBMITTED';
    if (outcome.kind === 'DEFINITIVELY_REJECTED') return 'REJECTED';
    return 'QUEUED';
  }

  /**
   * Second hop of a unit-to-unit move: store only after MAIN residency is observed.
   *
   * The retrieve acknowledgement is not that evidence (rule 1). Crash recovery re-enters here
   * for `IN_TRANSIT` members and for retrieves that died mid-call.
   */
  protected async advanceTransfer(commandId: string, member: CommandMemberRow): Promise<void> {
    const dest = member.destination;
    if (!dest) return;
    const source = this.transferSource(member);
    this.context.database.setCommandMember(commandId, member.account_id, member.member_id, { state: 'IN_TRANSIT' });
    await this.observeTransferTransit(member.account_id, source, dest);

    const action = member.action_id ? this.context.database.action(member.action_id) : undefined;
    // A group member's id is not a row; the unit it moves is its first hop's target.
    const localId = member.stack_key ? action?.target_id : member.member_id;
    const item = localId ? this.context.database.itemByLocalId(member.account_id, localId) : undefined;
    if (!item) return;
    if (item.location === 'CASKET' && item.casket_id === dest) {
      this.context.database.setCommandMember(commandId, member.account_id, member.member_id, { state: 'SUBMITTED' });
      return;
    }
    if (item.location !== 'MAIN' || !item.current_asset_id) return;
    const store = this.services.storage.queueStore(member.account_id, item.local_id, dest);
    this.context.database.setCommandMember(commandId, member.account_id, member.member_id, { action_id: store.id, state: 'QUEUED' });
    const outcome = await this.services.storage.execute(store.id);
    this.context.database.setCommandMember(commandId, member.account_id, member.member_id, { state: this.memberOutcomeState(outcome) });
    await this.observeTransferTransit(member.account_id, source, dest);
  }

  /**
   * The second hop of a reprice or a delist-to-store: never taken until the cancel is proved.
   *
   * The whole point of this method is what it refuses to do. A cancel whose response was
   * ambiguous, a listing still open in the latest complete walk, or an item no inventory walk
   * since the cancel has shown still held all leave the member `IN_TRANSIT` and send nothing.
   * Relisting or storing before the cancel is proved is the failure SELL-09 and N-SELL-02 exist
   * to prevent: Steam keeps the asset id across the round-trip (`steam/market-listings.md`), so
   * the old handle is still *the* handle, and acting on it while the listing may still be open is
   * how one item ends up with two orders (SM-19). A new price is a new listing with a new id.
   *
   * The item never left main inventory — the Game Coordinator keeps a listed item there
   * (`db/steam-listing.ts`) — so "it is in main inventory" proves nothing on its own. What proves
   * the cancel rather than a sale is the cancel's own action settling: `MarketService.reconcile`
   * marks it done only when a complete walk shows the listing gone and an inventory walk begun
   * after the cancel still holds the item. Until then a new action on the item would sit on top of
   * one nobody has explained.
   *
   * A sale during the chain is not a failure of the cancel; it is a different outcome. It stops
   * the chain, because there is no longer an item to reprice or store.
   */
  protected async advanceDelistChain(commandId: string, kind: CommandKind, member: CommandMemberRow): Promise<void> {
    const { database } = this.context;
    const accountId = member.account_id;
    this.context.database.setCommandMember(commandId, accountId, member.member_id, { state: 'IN_TRANSIT' });
    await this.observeDelistReturn(accountId, member.destination ?? undefined);

    // Order matters. Still listed means nothing was proved, so nothing may follow. A sale is
    // checked next and deliberately before the item row, because a sold item leaves the account:
    // asking "is it back in main inventory?" first turns the one outcome we can explain into the
    // one we cannot.
    if (this.openListingFor(accountId, member.member_id)) return;
    if (this.saleEndedTheChain(accountId, member.member_id)) {
      database.setCommandMember(commandId, accountId, member.member_id, { state: 'SOLD' });
      database.addEvent(accountId, 'chain-stopped-by-sale', { commandId, localId: member.member_id }, this.context.now());
      return;
    }
    // An order of ours that has not been explained yet is the same reason to wait: until the
    // cancel is graded, "no open listing" only means the book did not show one, and relisting
    // into that gap is how one item ends up with two orders (SM-19, SELL-09).
    if (kind === 'REPRICE' && this.unexplainedOrderFor(accountId, member.member_id)) return;
    // Proved cancelled: the cancel settled as applied, on the item observed still held after it.
    const item = database.itemByLocalId(accountId, member.member_id);
    const cancel = member.action_id ? database.action(member.action_id) : undefined;
    if (!item || item.location !== 'MAIN' || !item.current_asset_id) return;
    if (cancel?.kind !== 'REMOVE_SELL_LISTING' || cancel.state !== 'DONE' || cancel.resolution !== 'OBSERVED_APPLIED') return;

    const next = kind === 'REPRICE'
      ? this.services.market.queueSellListing(accountId, member.member_id, member.price_receive_cents!)
      : this.services.storage.queueStore(accountId, member.member_id, member.destination!);
    database.setCommandMember(commandId, accountId, member.member_id, { action_id: next.id, state: 'QUEUED' });
    const outcome = await this.executeMember(kind, next);
    database.setCommandMember(commandId, accountId, member.member_id, { state: this.memberOutcomeState(outcome) });
    await this.observeDelistReturn(accountId, member.destination ?? undefined);
  }

  /**
   * Continues a reprice or delist-to-store whose cancel a settle has just proved, from a walk the
   * loop made rather than one the chain asked for.
   *
   * `advanceDelistChain` runs once, inline, after the cancel is sent, and returns with the member
   * `IN_TRANSIT` when the first walks still show the listing. Nothing re-entered it after that
   * but a restart, and only when some other member was still queued: a cancel that landed late,
   * or was sent again by `RetryService`, left the chain parked with its second hop never sent.
   * Called from `wakeDrivers` after every settled market or inventory walk.
   *
   * It advances only a chain that can move — cancel `DONE`, item held in main inventory, no open
   * listing or unexplained order — so a settle that proves nothing costs two `SELECT`s and makes
   * no walk; `advanceDelistChain` walks once itself, and a wake during that walk finds the command
   * in flight and leaves it. The checks are the method's own, in the same order and for the same
   * reasons.
   */
  advanceChains(accountId: AccountId): void {
    const { database } = this.context;
    const rows = database.raw().prepare(`SELECT c.id AS commandId, c.kind AS kind, m.* FROM command c JOIN command_member m ON m.command_id=c.id
      WHERE m.account_id=? AND c.kind IN ('REPRICE','DELIST_TO_STORE') AND c.state IN ('ADMITTED','RUNNING','PARTIAL') AND m.state='IN_TRANSIT'
      ORDER BY c.created_at, m.member_id`).all(accountId) as Array<CommandMemberRow & { commandId: string; kind: CommandKind }>;
    for (const row of rows) {
      if (this.inflight.has(row.commandId)) continue;
      const cancel = row.action_id ? database.action(row.action_id) : undefined;
      if (cancel?.kind !== 'REMOVE_SELL_LISTING' || cancel.state !== 'DONE' || cancel.resolution !== 'OBSERVED_APPLIED') continue;
      const item = database.itemByLocalId(accountId, row.member_id);
      if (!item || item.location !== 'MAIN' || !item.current_asset_id) continue;
      if (this.openListingFor(accountId, row.member_id)) continue;
      if (row.kind === 'REPRICE' && this.unexplainedOrderFor(accountId, row.member_id)) continue;
      const { commandId, kind, member_id: memberId } = row;
      this.track(commandId, this.context.locks.run(accountId, async () => {
        // Re-read under the lock: a dispatch that held it may have moved the member on meanwhile,
        // and an advance always begins by writing `IN_TRANSIT`, which must never undo `SOLD`.
        const member = database.commandMembers(commandId).find((candidate) => candidate.account_id === accountId && candidate.member_id === memberId);
        if (member?.state !== 'IN_TRANSIT') return;
        await this.advanceDelistChain(commandId, kind, member);
      })
        .then(() => this.finish(commandId))
        .catch((error: unknown) => {
          try { database.setCommandState(commandId, 'PARTIAL', String(error)); } catch { /* closed under us */ }
        }));
    }
  }

  /** Picks the chain back up after a restart, from whatever the durable member state says. */
  protected async resumeDelistChain(commandId: string, accountId: AccountId): Promise<void> {
    const command = this.context.database.command(commandId);
    if (!command) return;
    for (const member of this.context.database.commandMembers(commandId).filter((row) => row.account_id === accountId)) {
      const action = member.action_id ? this.context.database.action(member.action_id) : undefined;
      if (member.state === 'IN_TRANSIT'
        || (action?.kind === 'REMOVE_SELL_LISTING' && action.state !== 'READY' && action.state !== 'FAILED')) {
        await this.advanceDelistChain(commandId, command.kind as CommandKind, member);
      }
    }
  }

  protected async observeDelistReturn(accountId: AccountId, destinationCasketId?: string): Promise<void> {
    const startedAfter = this.context.now();
    await this.services.observe(accountId, { surface: 'steam-market', scope: { kind: 'account' } }, { startedAfter });
    await this.services.observe(accountId, { surface: 'gc-inventory', scope: { kind: 'account' } }, { startedAfter });
    if (destinationCasketId) await this.services.observe(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: destinationCasketId } }, { startedAfter });
    this.services.settle.settleNow(accountId);
  }

  /** A sell order for this item that no observation has closed out yet. */
  protected unexplainedOrderFor(accountId: string, localId: string): boolean {
    return Boolean(this.context.database.raw().prepare(`SELECT 1 FROM venue_order
      WHERE account_id=? AND local_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%' LIMIT 1`).get(accountId, localId));
  }

  protected openListingFor(accountId: string, localId: string): string | undefined {
    const row = this.context.database.raw().prepare(`SELECT listing_id FROM market_listing
      WHERE account_id=? AND local_id=? AND status IN ('ACTIVE','ON_HOLD','PENDING_CONFIRMATION') LIMIT 1`)
      .get(accountId, localId) as { listing_id: string } | undefined;
    return row?.listing_id;
  }

  /** A sell order for this item that ended as a fill, on evidence the order service graded. */
  protected saleEndedTheChain(accountId: string, localId: string): boolean {
    return Boolean(this.context.database.raw().prepare(`SELECT 1 FROM venue_order
      WHERE account_id=? AND local_id=? AND side='SELL' AND state='ENDED_FILLED' LIMIT 1`).get(accountId, localId));
  }

  /** Both chains need an open listing to cancel and their own second-hop input. */
  protected delistChainProblem(kind: CommandKind, member: CommandMemberInput): string | null {
    if (!member.localId) return `${kind} needs an individual item`;
    if (!this.openListingFor(member.accountId, member.localId)) return `Item ${member.localId} has no open listing`;
    if (kind === 'REPRICE' && !(member.priceReceiveCents && member.priceReceiveCents > 0)) {
      return 'REPRICE requires a positive seller-receives price';
    }
    if (kind === 'DELIST_TO_STORE' && !member.destinationCasketId) return 'DELIST_TO_STORE requires destinationCasketId';
    return null;
  }

  protected async resumeTransfer(commandId: string, accountId: AccountId): Promise<void> {
    const members = this.context.database.commandMembers(commandId).filter((row) => row.account_id === accountId);
    for (const member of members) {
      if (!member.destination) continue;
      const action = member.action_id ? this.context.database.action(member.action_id) : undefined;
      if (action?.kind === 'STORE_IN_CASKET' && action.state === 'READY' && member.state === 'QUEUED') {
        const outcome = await this.services.storage.execute(action.id);
        this.context.database.setCommandMember(commandId, accountId, member.member_id, { state: this.memberOutcomeState(outcome) });
        await this.observeTransferTransit(accountId, this.transferSource(member), member.destination);
        continue;
      }
      if (member.state === 'IN_TRANSIT'
        || (action?.kind === 'RETRIEVE_FROM_CASKET' && action.state !== 'READY' && action.state !== 'FAILED')) {
        await this.advanceTransfer(commandId, member);
      }
    }
  }

  protected finish(commandId: string): void {
    const { database } = this.context;
    const command = database.command(commandId);
    if (!command || command.state === 'STOPPED' || command.state === 'REJECTED') return;
    const members = database.commandMembers(commandId);
    const rejected = members.some((member) => member.state === 'REJECTED');
    const submitted = members.some((member) => member.state === 'SUBMITTED' || member.state === 'QUEUED' || member.state === 'IN_TRANSIT');
    const done = members.every((member) => member.state === 'SUBMITTED' || member.state === 'REJECTED' || member.state === 'STOPPED');
    if (rejected && submitted) database.setCommandState(commandId, 'PARTIAL');
    else if (done && !rejected) database.setCommandState(commandId, 'COMPLETE');
    else if (rejected) database.setCommandState(commandId, 'PARTIAL');
  }
}
