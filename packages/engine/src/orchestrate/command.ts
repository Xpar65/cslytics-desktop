import { randomUUID } from 'node:crypto';
import type { AccountId, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, CommandMemberRow, CommandRow, DraftMemberRow, ItemRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage, required } from '../kernel/support.js';
import { CASKET_CAPACITY, MAIN_INVENTORY_HARD_CAP, StorageService, type CasketParams } from '../surfaces/storage.js';
import { InventoryService } from '../surfaces/inventory.js';
import { TradeService } from '../surfaces/trades.js';
import type { MarketService } from '../surfaces/market.js';
import { inventoryQuery, type InventoryFilter } from '../db/inventory-query.js';
import { MEMBER_HOP_JOINS, MEMBER_STATE_SQL } from '../db/member-state.js';
import { csfloatClaimedAssets, marketplaceBlock, MARKETPLACE_CONSENTS, type MarketplaceConsent } from '../kernel/marketplace-commitments.js';
import { isUntradableGroup, restrictionOf } from '../kernel/identity.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { HoldingsStore } from '../db/holdings.js';
import { OrderStore, type SteamListingRow } from '../db/orders.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { priceChangeRefusal } from '../kernel/price-cadence.js';
import { OPEN_STEP_STATES_SQL, WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { sqlList, type CommandAuthority, type WorkStepKind } from '../db/alphabets.js';
import { claimForPerson, strategyRefusal } from '../policy/authority.js';
import { attemptsMade } from '../kernel/not-applied.js';
import { RETRY_POLICY, retryPlan } from '../kernel/retry-policy.js';
import { ACCOUNT_INVENTORY, ObservationRequired, surfaceEvidence, surfaceName, type SurfaceRef } from '../kernel/evidence.js';
import type { SentMutation } from '../kernel/context.js';
import { storePrecheck, type StorePrecheck, type StorePrecheckRequest } from './store-precheck.js';
import type { Settling } from './settle.js';
import type { Need, Reading } from './reads.js';

export type CommandKind = 'STORE' | 'RETRIEVE' | 'LIST' | 'TRANSFER' | 'REPRICE' | 'DELIST_TO_STORE';

/** The commands this service drives: one Steam account's holdings, moved, listed or delisted. */
export const COMMAND_KINDS: readonly CommandKind[] = ['STORE', 'RETRIEVE', 'LIST', 'TRANSFER', 'REPRICE', 'DELIST_TO_STORE'];
const COMMAND_KINDS_SQL = `(${sqlList(COMMAND_KINDS)})`;

/**
 * The commands whose hops this service keeps in step with their actions after a settle: its own
 * chains, and the work of one hop asked for by hand (`WorkStore.lone`), whose actions the market
 * and buy-order reconcilers settle and whose hops nothing else would otherwise read back.
 */
const MIRRORED_KINDS_SQL = `(${sqlList([...COMMAND_KINDS, 'DELIST', 'BUY_ORDER_CREATE', 'BUY_ORDER_CANCEL'])})`;

/** The chains whose first hop is cancelling an open listing. */
const DELIST_FIRST: readonly CommandKind[] = ['REPRICE', 'DELIST_TO_STORE'];

/** The kinds whose proved-not-applied resend this service owns for a hop (`kernel/retry-policy.ts`, `resend: 'owner'`). */
const RESENT_HERE: ReadonlySet<string> = new Set(['CREATE_SELL_LISTING', 'STORE_IN_CASKET', 'RETRIEVE_FROM_CASKET']);

/** The reason on a chain's hops when its item sold before the chain reached them. */
export const SOLD_BEFORE_REACHED = 'Sold before the chain reached it';
/** The reason on a delist hop whose listing sold before the cancel was proved. */
export const SOLD_BEFORE_CANCEL = 'Sold before the cancel took';

/**
 * The reason a store or retrieve is refused, or failed unsent, while the account's Game Coordinator
 * session is not up. Nothing is held back for it to return: the person presses again (a product decision of
 * 2026-10-16; bulk storage plan D4).
 */
export const GC_NOT_CONNECTED = 'CS2 is not connected for this account, so nothing was sent';

/** A move refused at submit because the account's Game Coordinator session is not up (bulk storage plan D4). */
export function gcRefusal(accountId: string): string {
  return `CS2 is not connected for ${accountId}; connect it and press again`;
}

/** The reason on the moves a pass did not send once the breaker had opened on a silent Game Coordinator. */
export const GC_NOT_ANSWERING = 'The Game Coordinator stopped answering, so this was not sent';

/** The step kinds that move an item between main inventory and a unit, and so need the account's Game Coordinator session. */
const MOVES: ReadonlySet<string> = new Set(['STORE', 'RETRIEVE']);

/** The commands every member of which moves an item through a unit; a listing does only for a crated member. */
const GC_COMMANDS: readonly CommandKind[] = ['STORE', 'RETRIEVE', 'TRANSFER', 'DELIST_TO_STORE'];

/**
 * The words a hop refused before it went out is failed with. The breaker's own message names a
 * kind and an account; what a person needs is what happened and that nothing was sent.
 */
function refusalWords(error: unknown): string {
  const message = errorMessage(error);
  return message.startsWith('Circuit open') ? GC_NOT_ANSWERING : message;
}

/** The id of a member's hop: the command's, the holding's, and the hop's place in the chain. */
export function commandHopId(commandId: string, localId: string, ordinal: number): string {
  return `${commandId}:${localId}:${ordinal}`;
}

export type CommandMemberInput = {
  accountId: AccountId;
  localId?: string;
  stackKey?: string;
  quantity?: number;
  sourceCasketId?: string;
  destinationCasketId?: string;
  priceReceiveCents?: number;
  /** The claims on the item the person chose to store it despite (bulk storage plan D9). Only a store carries it. */
  consent?: readonly MarketplaceConsent[];
};

export type CommandRequest = {
  commandId: string;
  kind: CommandKind;
  members?: readonly CommandMemberInput[];
  manifestToken?: string;
  manifestRevision?: number;
  destinations?: Readonly<Record<string, string>>;
  priceReceiveCents?: number;
  /**
   * What the person agreed to when the store pre-check named it: store an item listed on CSFloat,
   * owed to a CSFloat buyer, or pledged to a trade offer anyway (bulk storage plan D9). Every member
   * carries it; it lets through only the claims it names, and only for a store.
   */
  consent?: readonly MarketplaceConsent[];
  /**
   * A person's decision to change a price inside the venue's price-change interval
   * (`kernel/price-cadence.ts`). Read by a `REPRICE` only, and recorded on each member it admitted.
   */
  force?: boolean;
  /**
   * Whose the command is: a person's unless it says otherwise (strategy authority and
   * confirmations plan D1). A strategy's is refused on a holding a person holds (`policy/authority.ts`).
   */
  authority?: CommandAuthority;
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

/** The frozen terms of a hop, in `work_step.params_json`. */
export type CommandHopParams = { casketId?: string; forListing?: boolean; priceReceiveCents?: number; listingId?: string; consent?: readonly MarketplaceConsent[] };

/** What a chain's next hop may do: send, wait for proof, be settled by what a walk already showed, or end in a sale. */
type HopGate = 'ready' | 'wait' | 'done' | 'sold';

/**
 * What one round of a stage has done so far: the moves that went out, the answers still owed, the
 * units and listing destinations its proof read must cover, and the reads its held-back hops wait for.
 */
type StageRound = {
  sent: number;
  /** Hops of the stage found already sent and not yet proved: the dispatch reads for them once. */
  inFlight: number;
  answers: Array<Promise<void>>;
  units: Set<string>;
  transits: Set<string>;
  /** The units the round's cancels are bound for, `''` for none: each is read with the book. */
  destinations: Set<string>;
  listed: boolean;
  waiting: SurfaceRef[];
  /** When the round's last answer came, and whether any answer was ambiguous: the proof read must begin after it. */
  lastAnswerAt: string;
  ambiguous: boolean;
};

/**
 * How a pass over a stage is driven. A dispatch drives each stage through its rounds and reads once
 * per round for the proof; a wake after a walk makes one pass and only reads, because the walk was
 * the wake. `stage` is the ordinal the pass is at and `round` what it has done; a caller that gives
 * neither moves the member's earliest open hop. `signal` is the dispatch's: Stop withdraws every
 * read it is waiting on. `locked` says the caller already holds the account lock, as a wake does.
 */
type Advance = { walk: boolean; results?: MutationOutcome[]; stage?: number; round?: StageRound; signal?: AbortSignal; locked?: boolean };

/** A hop not sent because the read it is judged on is incomplete or stale, and that read. */
type Waiting = { kind: 'WAITING'; want: SurfaceRef };

export type CommandServices = {
  storage: StorageService;
  inventory: InventoryService;
  trades: TradeService;
  /** Listing hops and delist hops go through it; nothing else here touches the market. */
  market: MarketService;
  /** A hop that decides on its own fresh read settles it first; nothing here calls a reconciler. */
  settle: Settling;
  /** The read broker: every read a dispatch waits for is a need it answers, and none is waited for under the account lock. */
  reads: Reading;
};

/**
 * One user click becomes one durable command. The backend owns fan-out, preflight and
 * account-keyed work. A known-invalid member rejects the whole batch before any mutation.
 *
 * A member is a holding and a chain of hops (consolidation plan D2): a store is one hop, a
 * transfer between two units a retrieve then a store, a reprice a delist then a listing, a listing
 * from a unit a retrieve then the listing. The hops are written at admission with the terms they
 * were asked with; the first gets its action at once, each later one when the chain reaches it,
 * which is only ever after an observation proved the hop before (rule 1). `advanceMember` is the
 * one place a chain moves, whether a dispatch, a restart or a settled walk drives it.
 */
export class CommandService {
  /** The holdings write path: units, reservations, stacks as a read (`db/holdings.ts`). */
  protected get holdings(): HoldingsStore { return new HoldingsStore(this.context.database); }
  /** The hops (`db/work.ts`). */
  protected get work(): WorkStore { return new WorkStore(this.context.database); }
  /** Preparation and dispatch in flight, per command, so `settled` has something to await. */
  private readonly inflight = new Map<string, Promise<void>>();

  /** The commands whose dispatch is running: each proves its own rounds, so the cadence leaves their hops to it. */
  dispatchingCommands(): string[] {
    return [...this.inflight.keys()];
  }
  /** Each running dispatch's signal: Stop aborts it, and the broker answers its needs `withdrawn` at once (read broker plan D8). */
  private readonly aborts = new Map<string, AbortController>();
  /** Commands a settle woke while a pass of theirs was still running: each gets one more pass when it ends, so no proof is lost between two walks. */
  private readonly rewake = new Map<string, AccountId>();

  constructor(protected readonly context: EngineContext, protected readonly services: CommandServices) {}

  /**
   * Durable receipt first; no action or hop exists until every input has passed preflight.
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
    const draft = request.manifestToken ? db.draft(request.manifestToken) : undefined;
    if (request.manifestToken && (!draft || draft.preparing || draft.state !== 'DRAFT' || (request.manifestRevision !== undefined && draft.revision !== request.manifestRevision))) throw new Error('Selection token is unexecutable or stale');
    if (!draft && !request.members?.length) throw new Error('Command has no members');
    db.insertCommand({ id: request.commandId, correlation_id: randomUUID(), kind: request.kind, state: 'ADMITTED', reject_reason: null, created_at: this.context.now(), preparing: 1, manifest_token: request.manifestToken ?? null, observed_completed: 0,
      authority: request.authority ?? 'HUMAN' });

    const cursor: PrepareCursor = { afterAccount: '', afterKey: '', offset: 0, admitted: new Map() };
    let more: boolean;
    try {
      const room = this.storeRoomProblem(request);
      if (room) throw new Error(room);
      more = this.prepareChunk(request, cursor);
    } catch (error) {
      this.reject(request, error);
      throw error;
    }
    const settle = more
      ? this.prepareRemaining(request, cursor)
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
   * to the fourth member never came — left its members unsent and nothing, ever, looked at them
   * again. This is the missing half. It resumes by *identity*, not by retry: a member is only
   * re-sent if it never reached a mutation, which is what a `PREPARED` member or a `QUEUED` hop
   * means. A hop that was sent once is settled by observation alone (rule 1), and a `STOPPED` or
   * `REJECTED` command is dead and stays dead (OP-03) — reviving one would be exactly the
   * resurrection `N-BATCH-02` forbids. A chain whose first hop was proved while nothing ran picks
   * up at its next hop, because that hop is `QUEUED` too.
   */
  async resume(accountId: AccountId): Promise<string[]> {
    const { database } = this.context;
    const rows = database.raw().prepare(`
      SELECT c.id AS id FROM command c
      WHERE c.kind IN ${COMMAND_KINDS_SQL} AND c.state IN ('ADMITTED','RUNNING','PARTIAL') AND c.preparing=0
        AND (EXISTS (SELECT 1 FROM command_member m WHERE m.command_id=c.id AND m.account_id=? AND m.state='PREPARED')
          OR EXISTS (SELECT 1 FROM work_step s WHERE s.command_id=c.id AND s.account_id=? AND s.state='QUEUED'))
      ORDER BY c.created_at LIMIT 50
    `).all(accountId, accountId) as Array<{ id: string }>;
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

  /**
   * The engine is shutting down: a dispatch that finishes after this wakes nothing. Its rewake would
   * read the record after the runtime has closed it, and surface as a rejection nobody awaits.
   */
  shutdown(): void {
    this.shutDown = true;
  }

  private shutDown = false;

  private track(commandId: string, work: Promise<void>): void {
    const done = work.finally(() => {
      if (this.inflight.get(commandId) === done) this.inflight.delete(commandId);
      const woken = this.rewake.get(commandId);
      if (woken !== undefined && !this.shutDown) {
        this.rewake.delete(commandId);
        this.advanceSteps(woken);
      }
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
      for (const accountId of new Set(db.commandMembers(request.commandId).map(row => row.account_id))) db.touch(accountId, 'command_member');
      const existing = new Set(db.commandMembers(request.commandId).map(row => `${row.account_id}:${row.local_id}`));
      for (const [index, member] of (request.members ?? []).entries()) {
        const memberId = member.localId ?? `${member.stackKey ?? 'member'}:${index}`;
        if (existing.has(`${member.accountId}:${memberId}`)) continue;
        db.insertCommandMember({ command_id: request.commandId, account_id: member.accountId, local_id: memberId,
          stack_key: member.stackKey ?? null, quantity: member.quantity ?? 1, destination: member.destinationCasketId ?? null,
          price_receive_cents: member.priceReceiveCents ?? null, state: 'REJECTED', input_json: JSON.stringify(member) });
      }
      for (const accountId of accounts.size ? accounts : db.commandMembers(request.commandId).map(row => row.account_id)) {
        db.addEvent(accountId, 'command-rejected', { commandId: request.commandId, kind: request.kind, reason }, this.context.now());
      }
    });
  }

  /** A draft's frozen member as this request asks for it: the request supplies the destination and price, the draft the rest. */
  private memberOf(row: DraftMemberRow, request: CommandRequest): CommandMemberInput {
    return {
      accountId: row.accountId,
      ...(row.stackKey ? { stackKey: row.stackKey } : { localId: row.localId ?? row.memberId }),
      quantity: row.quantity,
      ...(row.casketId ? { sourceCasketId: row.casketId } : {}),
      ...(request.destinations?.[row.accountId] ? { destinationCasketId: request.destinations[row.accountId]! } : {}),
      ...(request.priceReceiveCents ? { priceReceiveCents: request.priceReceiveCents } : {})
    };
  }

  /** One page of members: preflighted and written, or thrown. Returns whether more remain. */
  private prepareChunk(request: CommandRequest, cursor: PrepareCursor): boolean {
    const db = this.context.database;
    if (db.command(request.commandId)?.state === 'STOPPED') return false;
    const input: Array<{ key: string; member: CommandMemberInput }> = request.manifestToken
      ? db.draftMembers(request.manifestToken, { after: [cursor.afterAccount, cursor.afterKey], limit: 250 }).map((row) => ({ key: row.memberId, member: this.withConsent(request, this.memberOf(row, request)) }))
      : [...(request.members ?? [])].slice(cursor.offset, cursor.offset + 250).map((member, i) => ({ key: member.localId ?? `${member.stackKey}:${cursor.offset+i}`, member: this.withConsent(request, member) }));
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
      // A forced price change is recorded on the member it admitted, so the record says it was a decision.
      for (const { key, member } of input) db.insertCommandMember({ command_id: request.commandId, account_id: member.accountId, local_id: key,
        stack_key: member.stackKey ?? null, quantity: member.quantity ?? 1, destination: member.destinationCasketId ?? null, price_receive_cents: member.priceReceiveCents ?? null,
        state: 'PREPARED', input_json: JSON.stringify(request.kind === 'REPRICE' && request.force ? { ...member, force: true } : member) });
      claimForPerson(db, request.authority, request.commandId, input.map((row) => row.member), this.context.now());
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
  private async prepareRemaining(request: CommandRequest, cursor: PrepareCursor): Promise<void> {
    while (true) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!this.prepareChunk(request, cursor)) return;
    }
  }

  /**
   * Capture yields between short writes. A changed ownership revision invalidates the capture.
   * The draft is `preparing` until its last page is written, and a capture that cannot finish is
   * stopped with the reason, so its token is never executable.
   */
  async captureMatching(request: SelectionCaptureRequest): Promise<SelectionSnapshot> {
    const db = this.context.database;
    const accounts = [...new Set(request.accountIds)].sort();
    if (!accounts.length || accounts.length !== request.accountIds.length || db.knownAccountIds(accounts).length !== accounts.length) throw new Error('Invalid selection account scope');
    const token = randomUUID();
    // Every write the capture makes is a draft member, and each one moves the account's
    // `command_member` mark: compared too, that mark refused every capture on its second page.
    const marks = () => JSON.stringify(db.revisionMarks(accounts).filter((mark) => mark.surface !== 'command_member'));
    const revision = marks();
    db.insertDraft(token, accounts, request.filter ?? {}, this.context.now(), true);
    let afterAccount = '', afterKey = '';
    try {
      while (true) {
        if (revision !== marks()) throw new Error('Selection changed during capture; capture again');
        const query = inventoryQuery(db, accounts, request.filter ?? {}, this.context.now(), { after: [afterAccount, afterKey], limit: 500 });
        // Every row is one holding (the inventory has no stack rows), so every member names its
        // holding. The query lost its `stackKey` column with the stack rows, and a capture that
        // still asked for it failed outright: Select all over more than a thousand items said
        // "Could not select" every time (N-SCALE-11).
        const rows = db.raw().prepare(`SELECT accountId,rowKey,location,casketId,quantity FROM (${query.sql}) ORDER BY accountId,rowKey LIMIT 500`)
          .all(...query.params) as Array<{ accountId: string; rowKey: string; location: string; casketId: string | null; quantity: number }>;
        if (!rows.length) break;
        db.transaction(() => {
          for (const row of rows) {
            db.insertDraftMember(token, { accountId: row.accountId, localId: row.rowKey, quantity: row.quantity, location: row.location, casketId: row.casketId });
          }
        });
        afterAccount = rows.at(-1)!.accountId; afterKey = rows.at(-1)!.rowKey;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      db.raw().prepare('UPDATE command SET preparing=0 WHERE id=?').run(token);
      return this.readSelection(token);
    } catch (error) {
      db.transaction(() => {
        db.setCommandState(token, 'STOPPED', errorMessage(error));
        db.raw().prepare('UPDATE command SET preparing=0 WHERE id=?').run(token);
      });
      throw error;
    }
  }

  submit(request: CommandRequest): CommandRow {
    const { database } = this.context;
    const existing = database.command(request.commandId);
    if (existing) return existing;
    const members = this.resolveMembers(request).map((member) => this.withConsent(request, member));
    if (members.length === 0) throw new Error('Command has no members');
    const normalized: CommandRequest & { members: readonly CommandMemberInput[] } = { ...request, members };

    const now = this.context.now();
    const correlationId = randomUUID();
    return database.transaction(() => {
      const reason = this.preflight(normalized) ?? this.storeRoomProblem(normalized);
      database.insertCommand({
        id: request.commandId,
        correlation_id: correlationId,
        kind: request.kind,
        state: reason ? 'REJECTED' : 'ADMITTED',
        reject_reason: reason,
        created_at: now,
        preparing: 0,
        manifest_token: request.manifestToken ?? null,
        observed_completed: 0,
        authority: request.authority ?? 'HUMAN'
      });
      if (reason) {
        for (const [index, member] of members.entries()) {
          database.insertCommandMember({
            command_id: request.commandId,
            account_id: member.accountId,
            local_id: member.localId ?? `${member.stackKey ?? 'member'}:${index}`,
            stack_key: member.stackKey ?? null,
            quantity: member.quantity ?? 1,
            destination: member.destinationCasketId ?? null,
            price_receive_cents: member.priceReceiveCents ?? null,
            state: 'REJECTED'
          });
        }
        database.addEvent(members[0]!.accountId, 'command-rejected', { commandId: request.commandId, reason }, now);
        return database.command(request.commandId)!;
      }

      for (const [index, member] of members.entries()) {
        const admitted = this.admitMember(request.commandId, request.kind, member, index);
        // A forced price change is recorded on the member it admitted, so the record says it was a decision.
        for (const row of admitted) database.insertCommandMember(request.kind === 'REPRICE' && request.force && row.input_json
          ? { ...row, input_json: JSON.stringify({ ...(JSON.parse(row.input_json) as object), force: true }) } : row);
      }
      claimForPerson(database, request.authority, request.commandId, members, now);
      return database.command(request.commandId)!;
    });
  }

  /**
   * One dispatch, held in `inflight` for its duration whoever called it, so a settle's
   * `advanceSteps` never starts a second advance beside the one a dispatch is running inline.
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
    const controller = new AbortController();
    this.aborts.set(commandId, controller);
    // The account lock is taken for admission and for each pass's sends, and released across every
    // read and every round's wait (read broker plan D8): a second command on the account admits
    // while this one waits for a walk, which the teardown of L-10 spent eight minutes unable to do.
    const runAccount = async (accountId: AccountId): Promise<void> => {
      try {
        await this.context.ports.gc.connect(accountId, 30_000);
      } catch (error) {
        if (!this.failsWithoutGc(commandId, accountId)) throw error;
      }
      await this.context.locks.run(accountId, async () => { this.expandPrepared(command, accountId); });
      await this.advanceMembers(commandId, accountId, { walk: true, results, signal: controller.signal });
    };
    try {
      if (this.dispatchSequentially()) {
        for (const accountId of accounts) await runAccount(accountId);
      } else {
        await Promise.all(accounts.map((accountId) => runAccount(accountId)));
      }
    } finally {
      if (this.aborts.get(commandId) === controller) this.aborts.delete(commandId);
    }
    this.finish(commandId);
    return results;
  }

  /**
   * Admits the members `prepare` wrote and did not preflight past the first page: each is
   * preflighted on its own and becomes its hops, or is refused, in pages, so a large batch never
   * holds one transaction open.
   */
  private expandPrepared(command: CommandRow, accountId: AccountId): void {
    const { database } = this.context;
    let expandedIndex = 0;
    while (true) {
      if (database.command(command.id)?.state === 'STOPPED') return;
      const page = database.raw().prepare(`SELECT * FROM command_member WHERE command_id=? AND account_id=? AND state='PREPARED' ORDER BY local_id LIMIT 100`)
        .all(command.id, accountId) as CommandMemberRow[];
      if (!page.length) return;
      for (const row of page) {
        if (!row.input_json) { database.setCommandMember(command.id, accountId, row.local_id, { state: 'REJECTED' }); continue; }
        const input = JSON.parse(row.input_json) as CommandMemberInput;
        const reason = this.preflight({ commandId: command.id, kind: command.kind as CommandKind, members: [input] }, 'dispatch');
        if (reason) { database.setCommandMember(command.id, accountId, row.local_id, { state: 'REJECTED' }); continue; }
        database.transaction(() => {
          const admitted = this.admitMember(command.id, command.kind as CommandKind, input, expandedIndex++);
          database.raw().prepare('DELETE FROM command_member WHERE command_id=? AND account_id=? AND local_id=?').run(command.id, accountId, row.local_id);
          database.touch(accountId, 'command_member');
          for (const next of admitted) database.insertCommandMember(next);
        });
      }
    }
  }

  /**
   * Stop halts what was never sent and claims nothing about what was. An unsent hop is stopped
   * and its action failed as `command-stopped`; a hop already sent stays exactly as it is, settled
   * by observation alone (N-BATCH-05). A hop a walk has proved did not land is owed only a resend,
   * which is a send not yet made, so it stops too (`stopNotApplied`). A member none of whose hops
   * went out is stopped in its own word, and the unit it reserved is handed back.
   */
  stop(commandId: string): CommandRow {
    const { database } = this.context;
    const command = required(database.command(commandId), `Unknown command ${commandId}`);
    if (command.state === 'REJECTED' || command.state === 'COMPLETE') return command;
    // The reads the dispatch is waiting on are withdrawn: a stopped command's reader answers at once.
    this.aborts.get(commandId)?.abort();
    return database.transaction(() => {
      const now = this.context.now();
      for (const member of database.commandMembers(commandId)) {
        if (member.state === 'PREPARED') database.setCommandMember(commandId, member.account_id, member.local_id, { state: 'STOPPED' });
      }
      for (const step of this.work.stopUnsent(commandId, now)) this.failStopped(step, now);
      database.setCommandState(commandId, 'STOPPED');
      for (const step of this.work.steps(commandId)) {
        if (!isSettled(step) && this.provedNotApplied(step)) this.stopNotApplied(step);
      }
      this.closeStoppedMembers(commandId);
      return database.command(commandId)!;
    });
  }

  /**
   * A hop of a stopped command that a walk proved did not land. Its next send would be a new one,
   * and Stop halts every send not yet made, so the hop stops in the person's word, on the walk that
   * proved it, and its action fails as `command-stopped` as an unsent one does. Left alone it read
   * "Trying again" for ever: nothing sends a stopped command's hops (L-03, 2026-10-15).
   */
  protected stopNotApplied(hop: WorkStepRow): void {
    const { database } = this.context;
    const now = this.context.now();
    const proof = hop.action_id ? database.action(hop.action_id)?.resolved_by_obs ?? null : null;
    database.transaction(() => {
      this.failStopped(hop, now);
      this.work.settle(hop.id, 'STOPPED', proof, now, 'command-stopped');
      this.work.stopLater(hop, now, 'command-stopped');
      // The member was still open, since this hop was: it is closed if nothing else of it is.
      if (hop.local_id) this.closeIfStopped(hop.command_id, hop.account_id, hop.local_id);
    });
  }

  /** Whether a hop's action is waiting only for a resend: a walk proved its last attempt did not land. */
  private provedNotApplied(hop: WorkStepRow): boolean {
    const action = hop.action_id ? this.context.database.action(hop.action_id) : undefined;
    return action?.state === 'READY' && action.resolution === 'OBSERVED_NOT_APPLIED';
  }

  /** The action of a hop Stop halted fails as `command-stopped`, and the main-inventory slot it held is handed back. */
  private failStopped(hop: WorkStepRow, now: string): void {
    const { database } = this.context;
    const action = hop.action_id ? database.action(hop.action_id) : undefined;
    if (action?.state !== 'READY') return;
    database.setActionState(action.id, 'FAILED', now, 'command-stopped');
    database.releaseSlot(hop.account_id, action.id, false);
  }

  /** Each open member every hop of which Stop halted is stopped in its own word. */
  private closeStoppedMembers(commandId: string): void {
    for (const member of this.context.database.commandMembers(commandId)) {
      if (member.state === 'QUEUED') this.closeIfStopped(commandId, member.account_id, member.local_id);
    }
  }

  /** Stops an open member whose every hop Stop halted, and hands back the unit it reserved and never moved. */
  private closeIfStopped(commandId: string, accountId: string, localId: string): void {
    const hops = this.work.hopsOf(commandId, accountId, localId);
    if (!hops.length || !hops.every((hop) => hop.state === 'STOPPED')) return;
    this.context.database.setCommandMember(commandId, accountId, localId, { state: 'STOPPED' });
    this.holdings.releaseUnit(accountId, localId, commandId);
  }

  protected dispatchSequentially(): boolean {
    return false;
  }

  /**
   * Whether a dispatch whose Game Coordinator session never came up goes on without it. It does
   * when the command moves items for the account: each move then fails unsent with the reason as
   * the pass reaches it (`sendMove`), and a loose listing beside them still goes. The person presses
   * again once CS2 is up; nothing is held back for the session to return (a product decision of 2026-10-16; bulk
   * storage plan D4). A command that moves nothing gives up the dispatch, as it always did.
   */
  protected failsWithoutGc(commandId: string, accountId: AccountId): boolean {
    const kind = this.context.database.command(commandId)?.kind as CommandKind | undefined;
    if (kind && GC_COMMANDS.includes(kind)) return true;
    return Boolean(this.context.database.raw().prepare(`SELECT 1 FROM work_step WHERE command_id=? AND account_id=? AND kind IN ('STORE','RETRIEVE') LIMIT 1`).get(commandId, accountId));
  }

  /**
   * A store the destination unit cannot hold is refused before anything is sent, and says how many
   * fit (a product decision of 2026-10-16; bulk storage plan D12). Room is the unit's observed count, less the
   * stores already on their way to it, against the thousand a unit holds. Counted over the whole
   * selection at once, which a page-by-page preflight cannot do.
   */
  protected storeRoomProblem(request: CommandRequest): string | null {
    if (request.kind !== 'STORE') return null;
    const db = this.context.database;
    const wanted = new Map<string, number>();
    const add = (accountId: string, casketId: string, quantity: number): void => {
      const key = `${accountId}\u0000${casketId}`;
      wanted.set(key, (wanted.get(key) ?? 0) + quantity);
    };
    if (request.manifestToken) {
      const rows = db.raw().prepare(`SELECT account_id, COALESCE(SUM(quantity),0) AS n FROM command_member WHERE command_id=? AND state='DRAFT' GROUP BY account_id`)
        .all(request.manifestToken) as Array<{ account_id: string; n: number }>;
      for (const row of rows) {
        const casketId = request.destinations?.[row.account_id];
        if (casketId) add(row.account_id, casketId, row.n);
      }
    } else {
      for (const member of request.members ?? []) if (member.destinationCasketId) add(member.accountId, member.destinationCasketId, member.quantity ?? 1);
    }
    for (const [key, quantity] of wanted) {
      const [accountId, casketId] = key.split('\u0000') as [string, string];
      const unit = db.storageUnit(accountId, casketId);
      // An unknown unit is refused by the preflight, in its own words.
      if (!unit) continue;
      const onTheWay = (db.raw().prepare(`SELECT COUNT(*) AS n FROM work_step WHERE account_id=? AND kind='STORE' AND state IN ${OPEN_STEP_STATES_SQL}
        AND json_extract(params_json,'$.casketId')=?`).get(accountId, casketId) as { n: number }).n;
      const room = Math.max(0, CASKET_CAPACITY - unit.contains_count - onTheWay);
      if (quantity > room) {
        return `${unit.label ?? `Storage unit ${casketId}`} has room for ${room} more ${room === 1 ? 'item' : 'items'}, and ${quantity} ${quantity === 1 ? 'was' : 'were'} selected`;
      }
    }
    return null;
  }

  /**
   * What a store of these items would meet, from the record alone: what is left out, what the
   * person decides, how old the reads behind it are, each unit's room, and which accounts cannot
   * store now (bulk storage plan §5.1). The window asks it when Store is chosen, before anything
   * is submitted; nothing it answers is a refusal, which only the submit makes.
   */
  precheck(request: StorePrecheckRequest): StorePrecheck {
    return storePrecheck(this.context, this.services.trades, request);
  }

  /** Whether this command moves this item through a unit, which takes the account's Game Coordinator session. */
  protected movesThroughUnit(kind: CommandKind, item: ItemRow): boolean {
    return GC_COMMANDS.includes(kind) || (kind === 'LIST' && item.location === 'CASKET');
  }

  /** A store carries the consent the request was sent with, frozen on each member (bulk storage plan D9). */
  private withConsent(request: CommandRequest, member: CommandMemberInput): CommandMemberInput {
    if (request.kind !== 'STORE' || !request.consent?.length) return member;
    return { ...member, consent: request.consent.filter((claim) => MARKETPLACE_CONSENTS.includes(claim)) };
  }

  protected resolveMembers(request: CommandRequest): CommandMemberInput[] {
    if (request.manifestToken) {
      const draft = this.context.database.draft(request.manifestToken);
      if (!draft || draft.preparing || draft.state !== 'DRAFT') throw new Error('Selection token is unexecutable');
      if (request.manifestRevision !== undefined && draft.revision !== request.manifestRevision) {
        throw new Error('Selection token revision is stale');
      }
      return this.context.database.draftMembers(request.manifestToken).map((row) => this.memberOf(row, request));
    }
    return [...(request.members ?? [])];
  }

  /**
   * Freezes a selection as a command in `DRAFT` (consolidation plan §4.4): the members named, or
   * everything matching a filter, written in one transaction. The window keeps the token and
   * submits it as the members of an executable command; nothing the inventory does afterwards
   * joins the set (N-SCALE-03).
   */
  captureSelection(request: SelectionCaptureRequest): SelectionSnapshot {
    const token = randomUUID();
    const explicit = request.members ?? [];
    if (explicit.length === 0 && !request.filter) throw new Error('Selection capture needs members or a filter');
    this.context.database.transaction(() => {
      this.context.database.insertDraft(token, request.accountIds, request.filter ?? {}, this.context.now(), false);
      if (explicit.length > 0) {
        for (const member of explicit) {
          this.context.database.insertDraftMember(token, {
            accountId: member.accountId,
            ...(member.localId ? { localId: member.localId } : {}),
            ...(member.stackKey ? { stackKey: member.stackKey } : {}),
            quantity: member.quantity ?? 1,
            location: member.location ?? null,
            casketId: member.casketId ?? null
          });
        }
      } else {
        this.context.database.captureMatchingDraft(token, request.accountIds, request.filter);
      }
    });
    return this.readSelection(token);
  }

  updateSelection(token: string, revision: number, patch: { exclude?: readonly SelectionMemberInput[] }): SelectionSnapshot {
    const draft = required(this.context.database.draft(token), 'Unknown selection');
    if (draft.revision !== revision) throw new Error('Selection revision mismatch');
    this.context.database.excludeDraftMembers(token, (patch.exclude ?? []).map((member) => ({ accountId: member.accountId, memberId: member.localId ?? member.stackKey ?? '' })));
    return this.readSelection(token);
  }

  readSelection(token: string): SelectionSnapshot {
    const draft = required(this.context.database.draft(token), 'Unknown selection');
    return {
      token,
      revision: draft.revision ?? 1,
      state: draft.preparing ? 'DRAFT' : draft.state === 'DRAFT' ? 'COMPLETE' : 'RELEASED',
      counts: this.context.database.draftCounts(token)
    };
  }

  commandProgress(commandId: string): CommandProgress {
    const command = required(this.context.database.command(commandId), `Unknown command ${commandId}`);
    // The same words `work.open` uses (`db/member-state.ts`): a member is on its hop, and observed
    // completed counts `DONE` hops only, which an observation wrote.
    const members = this.context.database.raw().prepare(`SELECT m.account_id AS accountId, m.local_id AS memberId, ${MEMBER_STATE_SQL} AS state, m.quantity AS quantity
      FROM command c JOIN command_member m ON m.command_id=c.id ${MEMBER_HOP_JOINS}
      WHERE c.id=? ORDER BY m.account_id, m.local_id LIMIT 100`).all(commandId) as CommandProgress['members'];
    const observedCompleted = (this.context.database.raw().prepare(`SELECT COALESCE(SUM(m.quantity),0) AS n
      FROM command c JOIN command_member m ON m.command_id=c.id ${MEMBER_HOP_JOINS}
      WHERE c.id=? AND (${MEMBER_STATE_SQL})='COMPLETE'`).get(commandId) as { n: number }).n;
    return { commandId, state: command.state, observedCompleted, members };
  }

  /**
   * A unit advertised on, or owed to, another marketplace is not free to store, list or send,
   * whatever the Game Coordinator says about its location (CSF-13). The same check runs again
   * at dispatch; here it keeps a known-invalid member from admitting the batch at all. A move
   * between units is judged as the store its second hop is: it never leaves the account, and
   * `'transfer'` is the send to a CSFloat buyer (bulk storage plan D7).
   */
  protected marketplaceProblem(kind: CommandKind, member: CommandMemberInput, item: ItemRow): string | null {
    const purpose = kind === 'LIST' || kind === 'REPRICE' ? 'steam-list' : kind === 'RETRIEVE' ? null
      : kind === 'DELIST_TO_STORE' ? 'delist-to-store' : 'storage';
    if (!purpose) return null;
    const reason = marketplaceBlock(this.context.database, member.accountId, item.local_id, purpose, this.context.now(), '', kind === 'STORE' ? member.consent ?? [] : []);
    return reason ? `Item ${member.localId}: ${reason}` : null;
  }

  /**
   * `phase` is when the batch is judged. At `submit` a move is refused while CS2 is not connected;
   * at `dispatch`, where a later page of a batch the person already sent is admitted, the session
   * is the send's to judge, and a move it cannot make fails with the reason rather than vanishing
   * as a refusal nobody was told about (bulk storage plan D4).
   */
  protected preflight(request: CommandRequest, phase: 'submit' | 'dispatch' = 'submit'): string | null {
    const { database } = this.context;
    // Who may send it, judged at admission only: a strategy's work already admitted gives way to
    // a person's newer request through the hop's own action (plan D6), never by refusing its dispatch.
    if (phase === 'submit') {
      const authority = this.authorityProblem(request);
      if (authority) return authority;
    }
    const retrievesByAccount = new Map<string, number>();
    // Read once per account rather than per member: a two-thousand-member batch must not run
    // two thousand joins to answer the same question.
    const pledged = new Map<string, ReturnType<TradeService['committedAssets']>>();
    const pledgedFor = (accountId: string): ReturnType<TradeService['committedAssets']> => {
      const found = pledged.get(accountId) ?? this.services.trades.committedAssets(accountId);
      pledged.set(accountId, found);
      return found;
    };
    // A move needs the account's Game Coordinator session, and is refused without it rather than
    // held for it (a product decision of 2026-10-16; bulk storage plan D4). Asked once per account.
    const sessions = new Map<string, boolean>();
    const gcUp = (accountId: string): boolean => {
      if (phase === 'dispatch') return true;
      const up = sessions.get(accountId) ?? this.context.ports.gc.connectionStatus(accountId).state === 'CONNECTED';
      sessions.set(accountId, up);
      return up;
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
        // An attempt for the item that no walk has explained yet is a mutation nobody can account
        // for, and a second one on top of it is how an item gets acted on twice (rule 1). An
        // explained attempt, or a request not yet sent, is not that: the hop's action gives way.
        if (database.unexplainedAttempt(member.accountId, `item:${member.localId}`)) return `Item ${member.localId} has an attempt no walk has explained yet`;
        // Moving or listing an item a counterparty has been offered would invalidate a real
        // person's trade. The app refuses instead, and never cancels the offer to make room
        // (TRD-06). Nothing here reaches the network: it reads the last observed offer book.
        const commitment = item.asset_id ? pledgedFor(member.accountId).get(item.asset_id) : undefined;
        if (commitment && !(request.kind === 'STORE' && member.consent?.includes('trade-pledged'))) return `Item ${member.localId} is pledged to trade offer ${commitment.offerId} (${commitment.status})`;
        if (this.movesThroughUnit(request.kind, item) && !gcUp(member.accountId)) return gcRefusal(member.accountId);
        const marketplace = this.marketplaceProblem(request.kind, member, item);
        if (marketplace) return marketplace;
      } else if (member.stackKey) {
        if (DELIST_FIRST.includes(request.kind)) return 'A stack has no listing of its own to reprice or delist; cancel the listing itself';
        if ((GC_COMMANDS.includes(request.kind) || (request.kind === 'LIST' && member.sourceCasketId)) && !gcUp(member.accountId)) return gcRefusal(member.accountId);
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
        // (`db/commitment.ts`), so a handle's location cannot answer this on its own.
        const listed = this.services.market.listedAssets(member.accountId);
        // Nor is a unit CSFloat holds for a listing or a sale (`csfloatClaimedAssets`).
        const claimed = csfloatClaimedAssets(database, member.accountId);
        const units = this.holdings.units(member.accountId, member.stackKey)
          .filter((unit) => unit.location === source && (unit.casket_id ?? '') === (casketId ?? '') && unit.asset_id
            && !unit.reserved_command && !committed.has(unit.asset_id) && !listed.has(unit.asset_id) && !claimed.has(unit.asset_id));
        if (request.kind === 'LIST' && units.length > 0 && units.every((unit) => this.marketableProblem(member.accountId, unit.asset_id!))) {
          return `${member.stackKey} is not marketable on Steam`;
        }
        const free = units
          .filter((unit) => request.kind !== 'LIST' || !this.marketableProblem(member.accountId, unit.asset_id!))
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
        const chain = this.delistChainProblem(request.kind, member, request.force ?? false);
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

  /**
   * Why a strategy may not send this command (strategy authority and confirmations plan D3), or
   * `null`; a person's command is never refused here. Isolated so a saboteur can let a strategy
   * act on whatever it names.
   */
  protected authorityProblem(request: CommandRequest): string | null {
    return strategyRefusal(this.context.database, { authority: request.authority, force: request.force, members: request.members ?? [] });
  }

  protected itemProblem(kind: CommandKind, member: CommandMemberInput, item: ItemRow): string | null {
    const untradable = this.untradableProblem(kind, { item });
    if (untradable) return untradable;
    if (kind === 'STORE') {
      if (item.location !== 'MAIN' || !item.asset_id) return `Item ${item.local_id} is not in main inventory`;
      if (item.trade_protected_until && new Date(item.trade_protected_until) > this.context.ports.clock.now()) {
        return 'Trade-protected items cannot be stored';
      }
      if (!member.destinationCasketId) return 'STORE requires destinationCasketId';
    }
    if (kind === 'RETRIEVE' || kind === 'TRANSFER') {
      if (item.location !== 'CASKET' || !item.asset_id) return `Item ${item.local_id} is not in the casket`;
    }
    if (kind === 'LIST' && item.location === 'MISSING') return `Item ${item.local_id} is missing`;
    if (kind === 'LIST' && item.asset_id) {
      const marketable = this.marketableProblem(item.account_id, item.asset_id);
      if (marketable) return `Item ${item.local_id} ${marketable}`;
    }
    // A reprice or a delist-to-store needs an open listing, which `delistChainProblem` asks of the
    // listing book. The item's location cannot answer it: a listed item is in main inventory.
    return null;
  }

  /**
   * Steam's `marketable` flag on the last Community read of this asset (holdings plan D7). No GC
   * attribute says whether a unit can be sold on the market at all — a viewer pass, a coin, a pet —
   * so without this the app offers it and Steam refuses it at send as unmarketable. Unread is
   * unknown, and unknown is allowed, as it always was.
   */
  protected marketableProblem(accountId: string, assetId: string): string | null {
    const eligibility = new AssetEvidenceStore(this.context.database).community(accountId, assetId);
    return eligibility?.marketable === 0 ? 'is not marketable on Steam' : null;
  }

  /**
   * A unit the Game Coordinator marks `cannot trade` (attribute 2), or an unsealed terminal
   * (quality 14, which carries no such mark), is held, not handled: it is
   * neither listed nor stored. Retrieving one that somehow sits in a unit stays allowed, so nothing
   * is ever trapped. An item is read off its row's own attributes, re-derived on every walk; a
   * group by its key, whose restriction field is `untradable` for exactly those units.
   */
  protected untradableProblem(kind: CommandKind, subject: { item?: ItemRow; stackKey?: string }): string | null {
    if (kind !== 'LIST' && kind !== 'STORE') return null;
    if (subject.item && storedCannotTrade(subject.item)) return `Item ${subject.item.local_id} is marked untradable by Steam`;
    if (subject.stackKey && isUntradableGroup(subject.stackKey)) return `${subject.stackKey} is marked untradable by Steam`;
    return null;
  }

  /** The asset ids of a group's units the last Community read holds unmarketable. */
  protected unmarketableAssets(accountId: string, stackKey: string): string[] {
    return this.holdings.units(accountId, stackKey)
      .filter((unit) => unit.asset_id && this.marketableProblem(accountId, unit.asset_id))
      .map((unit) => unit.asset_id!);
  }

  /**
   * Whether a group's units in main inventory are trade-protected: a store would time out on
   * the Game Coordinator (csgomarketv3, measured), so it is refused whole before anything is sent.
   * The lock is on each row, the same two columns a skin carries.
   */
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

  /**
   * Writes a member's hops and admits its first: one `work_step` row per hop of its chain
   * (`hopsFor`), frozen with the terms it was asked with, and the first hop's action, queued
   * through the surface that owns the mutation. A group member is expanded into one member per
   * reserved unit first (`allocate`), each named by the unit's local id, so a member always names
   * one holding (rule 3). Later hops get their action when the chain reaches them
   * (`advanceMember`). Returns the member rows to write; the hops are already written.
   */
  protected admitMember(commandId: string, kind: CommandKind, member: CommandMemberInput, _index: number): CommandMemberRow[] {
    const { database } = this.context;
    if (member.stackKey && !member.localId) {
      const location = kind === 'RETRIEVE' || kind === 'TRANSFER' ? 'CASKET' : 'MAIN';
      const casketId = kind === 'RETRIEVE' || kind === 'TRANSFER' ? member.sourceCasketId ?? null : null;
      // A unit on the Steam market is not the group's to hand out for anything, though the GC still
      // holds it in main inventory, and neither is one CSFloat holds for a listing or a sale. Nor,
      // for a listing, is one Steam's Community read says is unmarketable: preflight counted only
      // the marketable units as free, so allocation must hand out only those, not whichever sorts first.
      const exclude = new Set([
        ...this.services.market.listedAssets(member.accountId),
        ...(kind === 'LIST' ? this.unmarketableAssets(member.accountId, member.stackKey) : []),
        ...csfloatClaimedAssets(database, member.accountId)
      ]);
      const units = this.allocate(member.accountId, member.stackKey, location, casketId, member.quantity ?? 1, commandId, exclude);
      return units.map((unit) => {
        const synthetic: CommandMemberInput = {
          accountId: member.accountId,
          localId: unit.local_id,
          ...(member.destinationCasketId ? { destinationCasketId: member.destinationCasketId } : {}),
          ...(member.sourceCasketId ? { sourceCasketId: member.sourceCasketId } : {}),
          ...(member.priceReceiveCents ? { priceReceiveCents: member.priceReceiveCents } : {})
        };
        return this.admitUnit(commandId, kind, synthetic, unit, { stackKey: member.stackKey!, quantity: unit.quantity, input: member });
      });
    }
    const localId = required(member.localId, 'Each member needs a localId or a stackKey');
    const item = required(database.itemByLocalId(member.accountId, localId), `Unknown item ${localId}`);
    return [this.admitUnit(commandId, kind, member, item, { stackKey: null, quantity: member.quantity ?? 1, input: member })];
  }

  private admitUnit(commandId: string, kind: CommandKind, member: CommandMemberInput, item: ItemRow, terms: { stackKey: string | null; quantity: number; input: CommandMemberInput }): CommandMemberRow {
    const now = this.context.now();
    const row: CommandMemberRow = {
      command_id: commandId,
      account_id: member.accountId,
      local_id: item.local_id,
      stack_key: terms.stackKey,
      quantity: terms.quantity,
      destination: member.destinationCasketId ?? null,
      price_receive_cents: member.priceReceiveCents ?? null,
      state: 'QUEUED',
      input_json: JSON.stringify(terms.input)
    };
    const hops = this.hopsFor(kind, member, item).map((hopKind, ordinal) => this.work.insert({
      id: commandHopId(commandId, item.local_id, ordinal), commandId, accountId: member.accountId, ordinal, kind: hopKind,
      localId: item.local_id, params: this.hopParams(kind, hopKind, member, item), now
    }));
    this.admitHop(kind, row, hops[0]!);
    return row;
  }

  /** Isolated so a saboteur can allocate the whole group. */
  protected allocate(accountId: string, stackKey: string, location: ItemRow['location'], casketId: string | null, quantity: number, commandId: string, exclude?: ReadonlySet<string>): ItemRow[] {
    return this.holdings.allocateUnits(accountId, stackKey, location, casketId, quantity, commandId, exclude);
  }

  /**
   * The hops a member's chain is made of, in order. A listing from a unit is retrieved first and
   * listed from main inventory once a walk shows it there, as a unit's listing always was; a
   * loose item is listed in one hop. Isolated so a saboteur can list a crated item in place.
   */
  protected hopsFor(kind: CommandKind, _member: CommandMemberInput, item: ItemRow): WorkStepKind[] {
    switch (kind) {
      case 'STORE': return ['STORE'];
      case 'RETRIEVE': return ['RETRIEVE'];
      case 'TRANSFER': return ['RETRIEVE', 'STORE'];
      case 'REPRICE': return ['DELIST', 'LIST'];
      case 'DELIST_TO_STORE': return ['DELIST', 'STORE'];
      case 'LIST': return item.location === 'CASKET' ? ['RETRIEVE', 'LIST'] : ['LIST'];
    }
  }

  /** The terms a hop is frozen with at admission, so a restart sends what was asked and nothing newer. */
  protected hopParams(kind: CommandKind, hop: WorkStepKind, member: CommandMemberInput, item: ItemRow): CommandHopParams {
    switch (hop) {
      case 'STORE': return { ...(member.destinationCasketId ? { casketId: member.destinationCasketId } : {}), ...(kind === 'STORE' && member.consent?.length ? { consent: member.consent } : {}) };
      case 'RETRIEVE': {
        const casketId = member.sourceCasketId ?? item.casket_id ?? undefined;
        return { ...(casketId ? { casketId } : {}), ...(kind === 'LIST' || kind === 'REPRICE' ? { forListing: true } : {}) };
      }
      case 'LIST': return { ...(member.priceReceiveCents ? { priceReceiveCents: member.priceReceiveCents } : {}) };
      case 'DELIST': {
        const listingId = this.openListingFor(member.accountId, item.local_id);
        return { ...(listingId ? { listingId } : {}) };
      }
      default: return {};
    }
  }

  /**
   * Gives a hop its action, through the surface that owns the mutation: the same admission a hand
   * store, retrieve, listing or delist gets, on the hop's action rather than a goal's (D3). A
   * retrieve reserves its main-inventory slot here, as every retrieve does. Throws the surface's
   * refusal, which the caller records on the hop.
   */
  protected admitHop(_kind: CommandKind, member: CommandMemberRow, hop: WorkStepRow): ActionRow {
    const { database } = this.context;
    const accountId = member.account_id;
    const localId = member.local_id;
    const params = this.work.params<CommandHopParams | null>(hop) ?? {};
    let action: ActionRow;
    switch (hop.kind) {
      case 'STORE':
        action = this.services.storage.queueStoreStep(accountId, localId, required(member.destination ?? undefined, 'STORE requires destinationCasketId'), hop.id, params.consent ?? []);
        break;
      case 'RETRIEVE': {
        const casketId = params.casketId ?? database.itemByLocalId(accountId, localId)?.casket_id ?? undefined;
        action = this.services.storage.queueRetrieveStep(accountId, localId, required(casketId, 'RETRIEVE requires sourceCasketId'), hop.id, params.forListing === true);
        database.reserveMainSlot(accountId, action.id);
        break;
      }
      case 'LIST':
        action = this.services.market.queueSellListingStep(accountId, localId, required(member.price_receive_cents ?? undefined, 'LIST requires a positive seller-receives price'), hop.id);
        break;
      case 'DELIST': {
        // The listing to cancel is the one open now, which is the one frozen at admission unless
        // the book moved meanwhile; an item with no open listing has nothing to cancel.
        const listingId = this.openListingFor(accountId, localId) ?? params.listingId;
        if (!listingId) throw new Error(`Item ${localId} has no open listing`);
        action = this.services.market.queueDelistStep(accountId, listingId, hop.id);
        break;
      }
      default:
        throw new Error(`Not a hop of a Steam command: ${hop.kind}`);
    }
    this.work.attachAction(hop.id, action.id, this.context.now());
    return action;
  }

  protected async executeMember(kind: CommandKind, action: ActionRow): Promise<MutationOutcome> {
    if (action.kind === 'CREATE_SELL_LISTING') return this.services.market.executeSellListing(action.id);
    if (action.kind === 'REMOVE_SELL_LISTING') return this.services.market.executeDelist(action.id);
    return (await this.sendMember(kind, action)).answer;
  }

  /**
   * Continues every chain of the account that can move, from a walk the loop made rather than one
   * the chain asked for. Called from `wakeDrivers` after every settled market, inventory or unit
   * walk, so a reprice whose cancel a walk just proved takes its listing hop from that settle, and
   * a store whose walk just showed the item in its unit reads complete, with nobody pressing
   * anything (SM-23).
   *
   * It visits only members whose hop can move (`advanceMembers` in wake mode), so a settle that
   * proves nothing costs one `SELECT` per open command and makes no walk; a wake during a dispatch
   * finds the command in flight and leaves it.
   */
  advanceSteps(accountId: AccountId): void {
    const { database } = this.context;
    // The panel reads hops, and the settle that woke this has just moved actions: mirror them
    // now, before anything asynchronous, so a read made the moment the walk settles is current.
    this.reflectOpen(accountId);
    // `COMPLETE` too: `finish` says so once every hop has been sent, before any walk has proved one,
    // so a hop proved not applied after that belongs to a complete command and is still owed its
    // resend. Only a command with an open hop is read, so a settled one costs nothing here.
    const rows = database.raw().prepare(`SELECT DISTINCT c.id AS id, c.created_at AS created_at FROM command c JOIN work_step s ON s.command_id=c.id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND c.kind IN ${COMMAND_KINDS_SQL} AND c.state IN ('ADMITTED','RUNNING','PARTIAL','COMPLETE') AND c.preparing=0
      ORDER BY c.created_at`).all(accountId) as Array<{ id: string }>;
    for (const row of rows) {
      // A pass of this command is still running: a wake pass yields between pages, and a walk that
      // settles meanwhile is the proof its next hop needs. It is not lost: one more pass follows.
      if (this.inflight.has(row.id)) { this.rewake.set(row.id, accountId); continue; }
      this.track(row.id, this.context.locks.run(accountId, () => this.advanceMembers(row.id, accountId, { walk: false, locked: true }))
        .then(() => this.finish(row.id))
        .catch((error: unknown) => {
          try { database.setCommandState(row.id, 'PARTIAL', String(error)); } catch { /* closed under us */ }
        }));
    }
  }

  /**
   * Moves the account's members of a command stage by stage (bulk storage plan D6): every member's
   * hop at one ordinal is sent, through every round it earns, before any member's next hop is. A
   * listing from storage retrieves everything, then lists; a move between units retrieves
   * everything, then stores. A dispatch drives each stage through its rounds; a wake after a walk
   * makes one pass over the stage it finds and reads nothing. A command nothing has dispatched yet
   * is left to its dispatch.
   */
  protected async advanceMembers(commandId: string, accountId: AccountId, options: Advance): Promise<void> {
    for (let guard = 0; guard < 32; guard += 1) {
      const command = this.context.database.command(commandId);
      if (!command || command.state === 'STOPPED') return;
      const stage = this.openStage(commandId, accountId);
      if (stage === null) return;
      await this.runStage(command, accountId, stage, options);
      // A stage still open waits for the walks that settle it; each one wakes this again.
      if (this.openStage(commandId, accountId) === stage) return;
    }
  }

  /** The lowest ordinal at which one of the account's open members still has an open hop: the stage the command is at. */
  protected openStage(commandId: string, accountId: AccountId): number | null {
    const row = this.context.database.raw().prepare(`SELECT MIN(s.ordinal) AS stage FROM work_step s
      JOIN command_member m ON m.command_id=s.command_id AND m.account_id=s.account_id AND m.local_id=s.local_id
      WHERE s.command_id=? AND s.account_id=? AND m.state='QUEUED' AND s.state IN ${OPEN_STEP_STATES_SQL}`).get(commandId, accountId) as { stage: number | null };
    return row.stage;
  }

  /**
   * One stage, round by round (bulk storage plan D3). A round is a pass that sends every hop of the
   * stage that is due, then one proof read begun after the round's last answer: the inventory and
   * every unit the round touched for a move, the book for a listing or a cancel. That read is what
   * settles the round, and it is the "complete walk begun after the attempt" a resend needs (rule 1).
   * A hop it proves did not land goes again in the next round, after the gap its retry row gives,
   * and no sooner. A hop held back for a read nobody has made yet gets that read once, then the
   * pass is made again. A wake makes one pass and stops: the walk that woke it was its read.
   */
  protected async runStage(command: CommandRow, accountId: AccountId, stage: number, options: Advance): Promise<void> {
    const read = new Set<string>();
    let round = this.newRound();
    let provedInFlight = false;
    for (let turn = 0; turn < 24; turn += 1) {
      // The evidence every move of the stage is judged on, judged once (read broker plan D9): a
      // stale inventory or unit costs the pass one need, not every hop a visit.
      const stale = options.walk ? this.staleEvidence(command, accountId, stage).filter((ref) => !read.has(surfaceName(ref))) : [];
      if (stale.length) round.waiting.push(...stale);
      else await this.underLock(accountId, options, () => this.passOverStage(command, accountId, { ...options, stage, round }));
      if (!options.walk || this.context.database.command(command.id)?.state === 'STOPPED') return;
      const owed = this.owedReads(round.waiting, read);
      round.waiting = [];
      if (owed.length) {
        for (const ref of owed) {
          if (this.context.database.command(command.id)?.state === 'STOPPED') return;
          read.add(surfaceName(ref));
          const outcome = await this.need(accountId, ref, this.context.now(), options);
          // Refused, so nothing here can move the stage: the next settle that proves something wakes it.
          if (outcome.kind === 'refused') return;
        }
        this.services.settle.settleNow(accountId);
        continue;
      }
      const sent = round.sent;
      if (sent > 0 || (round.inFlight > 0 && !provedInFlight)) {
        // A read proves a move absent only if it began after the attempt returned, by the clock's
        // millisecond (`postAttempt`); one begun in the same millisecond as the last answer proves
        // nothing, and the move would wait minutes for the next walk instead of its next round.
        if (round.ambiguous && this.context.now() <= round.lastAnswerAt) await this.context.ports.clock.sleep(1);
        await this.proveStage(command, accountId, stage, round, options);
        provedInFlight = true;
      }
      round = this.newRound();
      if (this.openStage(command.id, accountId) !== stage) return;
      const due = this.nextRound(command.id, accountId, stage);
      if (due === null) return;
      const wait = Date.parse(due) - Date.parse(this.context.now());
      // Due now and nothing went out in the round just made: nothing here can move it.
      if (wait <= 0 && sent === 0) return;
      if (wait > 0) await this.context.ports.clock.sleep(wait);
    }
  }

  /**
   * The reads a pass left owed, one per surface however many hops wait on it, less those this stage
   * has made. Read per hop, a pass of 178 retrieves each waiting on the same inventory read it 178
   * times, five seconds apart, for a quarter of an hour (L-10, 2026-10-16).
   */
  protected owedReads(waiting: readonly SurfaceRef[], read: ReadonlySet<string>): SurfaceRef[] {
    return [...new Map(waiting.filter((ref) => !read.has(surfaceName(ref))).map((ref) => [surfaceName(ref), ref])).values()];
  }

  /**
   * The set evidence the stage's moves share, judged once per pass: the inventory for a store's
   * room and a retrieve's, and each unit a hop names for its room and its contents. A scope whose
   * latest complete walk has lapsed holds the whole pass for one need, and the pass visits no hop
   * until it lands (read broker plan D9). Judged per hop, a pass over a thousand held moves ran a
   * thousand precondition evaluations to learn one thing. Isolated so a saboteur can judge per hop.
   */
  protected staleEvidence(command: CommandRow, accountId: AccountId, stage: number): SurfaceRef[] {
    const { database } = this.context;
    const rows = database.raw().prepare(`SELECT DISTINCT s.kind AS kind, json_extract(s.params_json,'$.casketId') AS casketId FROM work_step s
      JOIN command_member m ON m.command_id=s.command_id AND m.account_id=s.account_id AND m.local_id=s.local_id
      WHERE s.command_id=? AND s.account_id=? AND s.ordinal=? AND m.state='QUEUED' AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind IN ('STORE','RETRIEVE')`)
      .all(command.id, accountId, stage) as Array<{ kind: string; casketId: string | null }>;
    if (!rows.length) return [];
    const refs: SurfaceRef[] = [ACCOUNT_INVENTORY];
    for (const casketId of new Set(rows.map((row) => row.casketId).filter((id): id is string => Boolean(id)))) refs.push({ surface: 'gc-casket', scope: { kind: 'casket', id: casketId } });
    const now = this.context.ports.clock.now();
    return refs.filter((ref) => surfaceEvidence(database, accountId, ref, now, true).grade === 'UNKNOWN');
  }

  /** The pass's sends under the account lock, unless the caller holds it already. */
  protected underLock<T>(accountId: AccountId, options: Advance, work: () => Promise<T>): Promise<T> {
    return options.locked ? work() : this.context.locks.run(accountId, work);
  }

  /** One read for the dispatch: a work need for a walk begun after the moment, withdrawn by Stop, never under the lock. */
  protected need(accountId: AccountId, ref: SurfaceRef, startedAfter: string, options?: Advance): ReturnType<Reading['need']> {
    const need: Need = { ref, startedAfter, priority: 'work' };
    return this.services.reads.need(accountId, need, options?.signal);
  }

  protected newRound(): StageRound {
    return { sent: 0, inFlight: 0, answers: [], units: new Set(), transits: new Set(), destinations: new Set(), listed: false, waiting: [], lastAnswerAt: '', ambiguous: false };
  }

  /**
   * One pass over the members whose hop at this stage is open. A dispatch visits every one; a wake
   * only those whose hop can move: an unreached hop whose predecessor is proved, a hop proved not
   * applied, a hop of a dispatched command still waiting for the read its send is judged on, or a
   * hop whose action a settle moved on. The answers of the moves it sent are awaited at its end, so
   * the round's proof read begins after the last of them.
   */
  protected async passOverStage(command: CommandRow, accountId: AccountId, options: Advance & { stage: number; round: StageRound }): Promise<void> {
    const { database } = this.context;
    const dispatched = database.command(command.id)?.state !== 'ADMITTED';
    const atStage = `AND EXISTS (SELECT 1 FROM work_step s LEFT JOIN action x ON x.id=s.action_id
        WHERE s.command_id=m.command_id AND s.account_id=m.account_id AND s.local_id=m.local_id AND s.ordinal=? AND s.state IN ${OPEN_STEP_STATES_SQL}${options.walk ? '' : ` AND (
          (s.action_id IS NULL AND NOT EXISTS (SELECT 1 FROM work_step p WHERE p.command_id=s.command_id AND p.account_id=s.account_id AND p.local_id=s.local_id AND p.ordinal<s.ordinal AND p.state<>'DONE'))
          OR (x.state='READY' AND x.resolution='OBSERVED_NOT_APPLIED')${dispatched ? `
          OR (x.state='READY' AND x.resolution IS NULL)` : ''}
          OR (x.state='DONE' AND s.state<>'DONE') OR (x.state='FAILED' AND s.state<>'FAILED')
          OR (x.state='RUNNING' AND s.state<>'SENT') OR (x.state='AWAITING_OBSERVATION' AND s.state NOT IN ('AWAITING_OBSERVATION','RETRYING'))
          OR (s.kind='DELIST' AND EXISTS (SELECT 1 FROM venue_order v WHERE v.account_id=s.account_id AND v.local_id=s.local_id AND v.side='SELL' AND v.state='ENDED_FILLED')))`})`;
    let after = '';
    try {
      while (true) {
        const page = database.raw().prepare(`SELECT m.* FROM command_member m WHERE m.command_id=? AND m.account_id=? AND m.state='QUEUED' AND m.local_id>?
          ${atStage} ORDER BY m.local_id LIMIT 100`).all(command.id, accountId, after, options.stage) as CommandMemberRow[];
        if (!page.length) return;
        after = page.at(-1)!.local_id;
        for (const member of page) {
          const current = database.command(command.id);
          if (!current || current.state === 'STOPPED') return;
          await this.advanceMember(current, member, options);
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally {
      await Promise.all(options.round.answers.splice(0));
    }
  }

  /**
   * Moves one member's hop at the pass's stage as far as the evidence allows, and no further.
   *
   * It reads the member's hops, brings each open one to the state its action implies, and looks at
   * the earliest still open, which is the stage's. A hop that was sent is left to observation (rule
   * 1). A hop with no action yet gets one only when the hop before it is `DONE` and its own gate
   * passes — the item observed in main inventory for a store or a listing, the cancel proved for a
   * relist — and is then sent. A hop proved not applied is sent again when its policy says
   * (`kernel/retry-policy.ts`), by this service for the kinds it owns. A store or a retrieve goes
   * out paced and is not waited for (`sendMove`); a listing or a cancel is sent and answered in
   * turn. A refusal fails the hop with the surface's words and stops the hops after it; a sale ends
   * the chain in the member's own word (`SOLD`).
   */
  protected async advanceMember(command: CommandRow, member: CommandMemberRow, options: Advance): Promise<void> {
    const { database } = this.context;
    const kind = command.kind as CommandKind;
    const round = options.round ?? this.newRound();
    for (let turn = 0; turn < 8; turn += 1) {
      if (database.command(command.id)?.state === 'STOPPED') return;
      const hops = this.work.hopsOf(command.id, member.account_id, member.local_id).map((hop) => this.reflect(hop));
      const current = hops.find((hop) => !isSettled(hop));
      if (!current || (options.stage !== undefined && current.ordinal !== options.stage)) return;
      const action = current.action_id ? database.action(current.action_id) : undefined;
      if (action && action.state !== 'READY') {
        // A cancel in flight whose listing a sale took: nothing is left to reprice or store, and
        // the cancel will never be proved, so the chain ends here rather than waiting for ever.
        if (current.kind === 'DELIST' && DELIST_FIRST.includes(kind)
          && !this.openListingFor(member.account_id, member.local_id) && this.saleEndedTheChain(member.account_id, member.local_id)) {
          this.endBySale(member, hops);
        }
        // Sent, and settled only by observation: the round's proof read, or a later walk.
        round.inFlight += 1;
        this.noteForProof(kind, member, current, action, round);
        return;
      }
      if (!action) {
        const previous = hops.find((hop) => hop.ordinal === current.ordinal - 1);
        const gate = previous ? this.hopGate(kind, member, current, previous) : 'ready';
        if (gate === 'sold') { this.endBySale(member, hops); return; }
        if (gate === 'done') {
          // A walk already showed this hop's effect: the item is where the hop would put it.
          const item = database.itemByLocalId(member.account_id, member.local_id);
          this.work.settle(current.id, 'DONE', item?.location_obs ?? null, this.context.now());
          continue;
        }
        if (gate === 'wait') return;
        try {
          this.admitHop(kind, member, current);
        } catch (error) {
          this.failHop(current, errorMessage(error));
          return;
        }
        continue;
      }
      // READY: never sent, or proved not applied and waiting its round.
      if (action.resolution === 'OBSERVED_NOT_APPLIED' && !this.resendDue(action)) return;
      if (MOVES.has(current.kind)) {
        await this.sendMove(kind, member, current, action, options.results, round);
        return;
      }
      const outcome = await this.send(kind, current, action, options.results);
      if (outcome.kind === 'WAITING') { round.waiting.push(outcome.want); return; }
      if (outcome.kind === 'DEFINITIVELY_REJECTED') return;
      round.sent += 1;
      this.noteForProof(kind, member, current, action, round);
      return;
    }
  }

  /**
   * Sends one store or retrieve and returns once it has gone out, leaving its answer to the round
   * (bulk storage plan D1): the next move is paced by the budget in `executeMutation`, not by this
   * one's answer, which the Game Coordinator gives about 350 ms later as the item's own SO event.
   * A session that is not up sends nothing and is not waited for: the hop fails with the reason
   * (D4). A read the send is judged on that no walk has made yet holds the hop back for the round's
   * read, as `send` does.
   */
  protected async sendMove(kind: CommandKind, member: CommandMemberRow, hop: WorkStepRow, action: ActionRow, results: MutationOutcome[] | undefined, round: StageRound): Promise<void> {
    const { database } = this.context;
    let sent: SentMutation;
    try {
      if (this.context.ports.gc.connectionStatus(hop.account_id).state !== 'CONNECTED') throw new Error(GC_NOT_CONNECTED);
      // A resend holds its main-inventory slot again: the proof that it did not land handed it back.
      if (action.kind === 'RETRIEVE_FROM_CASKET') database.reserveMainSlot(hop.account_id, action.id);
      sent = await this.sendMember(kind, action);
    } catch (error) {
      if (this.waitsForRead(error) && database.action(action.id)?.state === 'READY') { round.waiting.push(error.want); return; }
      const reason = refusalWords(error);
      if (database.action(action.id)?.state === 'READY') database.setActionState(action.id, 'FAILED', this.context.now(), reason);
      if (action.kind === 'RETRIEVE_FROM_CASKET') database.releaseSlot(hop.account_id, action.id, false);
      this.failHop(this.work.step(hop.id)!, reason);
      return;
    }
    round.sent += 1;
    this.noteForProof(kind, member, hop, action, round);
    this.reflect(this.work.step(hop.id)!);
    round.answers.push(sent.answer.then((outcome) => {
      results?.push(outcome);
      const now = this.context.now();
      if (now > round.lastAnswerAt) round.lastAnswerAt = now;
      if (outcome.kind === 'AMBIGUOUS') round.ambiguous = true;
      if (action.kind === 'RETRIEVE_FROM_CASKET') {
        if (outcome.kind === 'DEFINITIVELY_REJECTED') database.releaseSlot(hop.account_id, action.id, false);
        else database.markSlotSubmitted(hop.account_id, action.id);
      }
      this.reflect(this.work.step(hop.id)!);
    }, () => undefined));
  }

  /** What the round's proof read must cover for this hop: its unit, its transit, its listing, or the book its cancel is proved on. */
  private noteForProof(kind: CommandKind, member: CommandMemberRow, hop: WorkStepRow, action: ActionRow, round: StageRound): void {
    // A hop found in flight was answered before this pass: the round's read must postdate that answer.
    const attempt = this.context.database.latestAttempt(action.id);
    const answered = attempt?.finished_at ?? attempt?.started_at;
    if (answered && answered > round.lastAnswerAt) round.lastAnswerAt = answered;
    if (MOVES.has(hop.kind)) {
      const { casketId } = this.context.database.actionParams(action) as CasketParams;
      round.units.add(casketId);
      if (kind === 'TRANSFER' && hop.kind === 'RETRIEVE' && member.destination) round.transits.add(`${casketId}\u0000${member.destination}`);
    } else if (hop.kind === 'LIST') {
      round.listed = true;
    } else if (hop.kind === 'DELIST') {
      round.destinations.add(member.destination ?? '');
    }
  }

  /** A store or retrieve, sent through the surface that owns it; resolves once it has gone out. */
  protected sendMember(_kind: CommandKind, action: ActionRow): Promise<SentMutation> {
    return this.services.storage.send(action.id);
  }

  /**
   * The read that settles a round, begun after its last answer: for moves, the inventory and every
   * unit they touched (a transfer's retrieve through `observeTransferTransit`, which a store hop's
   * gate reads); for listings, the book; for cancels, the book, the inventory and the unit a
   * delist-to-store is bound for. One read for the round, however many it sent.
   */
  protected async proveStage(_command: CommandRow, accountId: AccountId, _stage: number, round: StageRound, options?: Advance): Promise<void> {
    // A stage can hold more than one kind of hop: a listing from storage retrieves its crated
    // members while its loose ones list. Each kind the round touched is read for.
    for (const destination of round.destinations) await this.observeDelistReturn(accountId, destination || undefined, options);
    if (round.listed) {
      await this.need(accountId, { surface: 'steam-market', scope: { kind: 'account' } }, this.context.now(), options);
      this.services.settle.settleNow(accountId);
    }
    if (round.transits.size) {
      for (const pair of round.transits) {
        const [source, destination] = pair.split('\u0000') as [string, string];
        await this.observeTransferTransit(accountId, source, destination, options);
      }
    } else if (round.units.size) {
      const startedAfter = this.proofMoment(round);
      await this.need(accountId, ACCOUNT_INVENTORY, startedAfter, options);
      for (const casketId of round.units) await this.need(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: casketId } }, startedAfter, options);
      this.services.settle.settleNow(accountId);
    }
    // What the settles proved, on the hops: the wake that mirrors them skips a command mid-dispatch,
    // and the round decides what comes next from the hops (BULK-06).
    this.reflectOpen(accountId);
  }

  /**
   * The moment the round's proof read must begin after: its last answer (bulk storage plan D3), so a
   * walk that already postdates every answer serves a wake that asks again for the same hops. Begun
   * after "now", every wake behind in-flight moves walked a thousand-item inventory once more (L-10,
   * 2026-10-16 evening: a walk on every event batch). Isolated so a saboteur can prove per wake.
   */
  protected proofMoment(round: StageRound): string {
    return round.lastAnswerAt || this.context.now();
  }

  /**
   * When the stage's next round is due: the earliest moment one of its hops proved not applied may
   * go again under its retry row. `null` when none may, because none is waiting a round or every
   * one has had its last send.
   */
  protected nextRound(commandId: string, accountId: AccountId, stage: number): string | null {
    const { database } = this.context;
    const waiting = database.raw().prepare(`SELECT x.* FROM work_step s JOIN action x ON x.id=s.action_id
      WHERE s.command_id=? AND s.account_id=? AND s.ordinal=? AND s.state IN ${OPEN_STEP_STATES_SQL}
        AND x.state='READY' AND x.resolution='OBSERVED_NOT_APPLIED'`).all(commandId, accountId, stage) as ActionRow[];
    let earliest: string | null = null;
    for (const action of waiting) {
      const policy = RETRY_POLICY[action.kind];
      if (!policy || policy.resend !== 'owner' || !RESENT_HERE.has(action.kind)) continue;
      const plan = retryPlan(policy, attemptsMade(database, action.id), action.updated_at);
      if (plan.kind === 'again' && (earliest === null || plan.retryAt < earliest)) earliest = plan.retryAt;
    }
    return earliest;
  }

  /**
   * Sends a hop's action and brings the hop to what the reply implies. A refusal before anything
   * went out fails the hop; a precondition only a walk not yet made can answer leaves it waiting.
   */
  protected async send(kind: CommandKind, hop: WorkStepRow, action: ActionRow, results?: MutationOutcome[]): Promise<MutationOutcome | Waiting> {
    const { database } = this.context;
    let outcome: MutationOutcome;
    try {
      outcome = await this.executeMember(kind, action);
    } catch (error) {
      if (this.waitsForRead(error) && database.action(action.id)?.state === 'READY') return { kind: 'WAITING', want: error.want };
      // Refused before anything went out: a precondition, a pledge, an open circuit. Nothing was
      // sent, so nothing is owed an observation; the reason is the hop's to show (OP-08).
      const reason = errorMessage(error);
      if (database.action(action.id)?.state === 'READY') database.setActionState(action.id, 'FAILED', this.context.now(), reason);
      this.failHop(this.work.step(hop.id)!, reason);
      return { kind: 'DEFINITIVELY_REJECTED', reason, raw: null };
    }
    results?.push(outcome);
    if (action.kind === 'RETRIEVE_FROM_CASKET' && outcome.kind !== 'DEFINITIVELY_REJECTED') database.markSlotSubmitted(hop.account_id, action.id);
    this.reflect(this.work.step(hop.id)!);
    return outcome;
  }

  /**
   * Whether a refusal before sending is a read the hop can wait for rather than a reason to fail
   * it. An incomplete or stale walk proves nothing either way (rule 5): the Game Coordinator
   * dropping its session for a moment failed a retrieve for good, though the next complete walk
   * came five seconds later (L-03, 2026-10-15). Isolated so a saboteur can fail on it instead.
   */
  protected waitsForRead(error: unknown): error is ObservationRequired {
    return error instanceof ObservationRequired;
  }

  /**
   * Whether a chain's next hop may be sent, given the hop before it. `previous` must be `DONE`,
   * which only an observation writes. A store or a listing then needs the item observed in main
   * inventory; a transfer whose walk already shows the item in its destination is `done` with
   * nothing to send. A relist or a store after a cancel needs more (SELL-09, N-SELL-02): the
   * listing gone from a complete walk, the cancel proved applied on an item still held, and no
   * order of ours left unexplained — relisting into that gap is how one item ends up with two
   * orders (SM-19). A sale during the chain is a different outcome, not a failure of the cancel.
   */
  protected hopGate(kind: CommandKind, member: CommandMemberRow, hop: WorkStepRow, previous: WorkStepRow): HopGate {
    const { database } = this.context;
    if (previous.state !== 'DONE') return 'wait';
    const accountId = member.account_id;
    const localId = member.local_id;
    if (DELIST_FIRST.includes(kind)) {
      // Order matters. Still listed means nothing was proved, so nothing may follow. A sale is
      // checked next and deliberately before the item row, because a sold item leaves the account:
      // asking "is it back in main inventory?" first turns the one outcome we can explain into the
      // one we cannot.
      if (this.openListingFor(accountId, localId)) return 'wait';
      if (this.saleEndedTheChain(accountId, localId)) return 'sold';
      if (kind === 'REPRICE' && this.unexplainedOrderFor(accountId, localId)) return 'wait';
      const cancel = previous.action_id ? database.action(previous.action_id) : undefined;
      if (cancel?.kind !== 'REMOVE_SELL_LISTING' || cancel.resolution !== 'OBSERVED_APPLIED') return 'wait';
    }
    const item = database.itemByLocalId(accountId, localId);
    if (!item || !item.asset_id) return 'wait';
    if (hop.kind === 'STORE' && item.location === 'CASKET' && item.casket_id === member.destination) return 'done';
    if (item.location !== 'MAIN') return 'wait';
    return 'ready';
  }

  /**
   * Whether a hop's action proved not applied is due again: at the proof, under its cap, for the
   * kinds this service re-sends. A listing hop is one; a casket move is the known gap of
   * `kernel/retry-policy.ts` and is left out, so it reads *Trying again* and nothing sends it.
   */
  protected resendDue(action: ActionRow): boolean {
    const policy = RETRY_POLICY[action.kind];
    if (!policy || policy.resend !== 'owner' || !RESENT_HERE.has(action.kind)) return false;
    const plan = retryPlan(policy, attemptsMade(this.context.database, action.id), action.updated_at);
    return plan.kind === 'again' && Date.parse(plan.retryAt) <= Date.parse(this.context.now());
  }

  /**
   * Brings every open hop of the account's commands whose action a settle moved to what the
   * action now says. Synchronous and lock-free on purpose: it writes nothing an action does not
   * already say, and the work panel must read a proved store as complete from the same settle
   * that proved it (N-WORK-01), not from a wake that runs after the next turn.
   */
  protected reflectOpen(accountId: AccountId): void {
    const now = this.context.now();
    const rows = this.context.database.raw().prepare(`SELECT s.* FROM work_step s JOIN command c ON c.id=s.command_id JOIN action x ON x.id=s.action_id
      WHERE s.account_id=? AND c.kind IN ${MIRRORED_KINDS_SQL} AND s.state IN ${OPEN_STEP_STATES_SQL} AND (
        (x.state='DONE' AND s.state<>'DONE') OR (x.state='FAILED' AND s.state<>'FAILED') OR (x.state='RUNNING' AND s.state<>'SENT')
        OR (x.state='AWAITING_OBSERVATION' AND s.state<>'AWAITING_OBSERVATION')
        OR (x.state='READY' AND x.resolution='OBSERVED_NOT_APPLIED' AND (s.state<>'RETRYING' OR c.state='STOPPED')))
      ORDER BY s.command_id, s.ordinal`).all(accountId) as WorkStepRow[];
    for (const hop of rows) {
      this.reflect(hop);
      // A command whose hops have all settled takes its outcome, whichever driver sent them.
      if (hop.action_id) this.work.mirror(hop.action_id, now);
    }
  }

  /**
   * Brings a hop to what its action implies; a hop that failed stops the hops after it, and one
   * proved not applied under a stopped command stops, because nothing will send it again.
   */
  protected reflect(hop: WorkStepRow): WorkStepRow {
    const before = hop.state;
    const after = this.work.reflectAction(hop, this.context.now());
    if (after.state === 'FAILED' && before !== 'FAILED') this.work.stopLater(after, this.context.now());
    if (after.state === 'RETRYING' && this.context.database.command(after.command_id)?.state === 'STOPPED') {
      this.stopNotApplied(after);
      return this.work.step(after.id)!;
    }
    return after;
  }

  /** Records a refusal on a hop, in the surface's words, and stops the hops after it. */
  protected failHop(hop: WorkStepRow, reason: string): void {
    this.work.failHop(hop, reason, this.context.now());
  }

  /**
   * Ends a chain whose item sold while its cancel was in flight. There is nothing left to reprice
   * or store: the delist hop is stopped with what happened to it and its action failed so nothing
   * sends it again, the hops after it were never reached, and the member keeps the one word no hop
   * can say for it.
   */
  protected endBySale(member: CommandMemberRow, hops: readonly WorkStepRow[]): void {
    const { database } = this.context;
    const now = this.context.now();
    database.transaction(() => {
      const delist = hops.find((hop) => hop.kind === 'DELIST');
      if (delist && !isSettled(delist)) {
        const action = delist.action_id ? database.action(delist.action_id) : undefined;
        if (action && action.state !== 'DONE' && action.state !== 'FAILED') database.setActionState(action.id, 'FAILED', now, SOLD_BEFORE_CANCEL);
        this.work.settle(delist.id, 'STOPPED', null, now, SOLD_BEFORE_CANCEL);
      }
      for (const hop of hops) {
        if (hop.id !== delist?.id && !isSettled(hop)) this.work.settle(hop.id, 'STOPPED', null, now, SOLD_BEFORE_REACHED);
      }
      database.setCommandMember(member.command_id, member.account_id, member.local_id, { state: 'SOLD' });
      database.addEvent(member.account_id, 'chain-stopped-by-sale', { commandId: member.command_id, localId: member.local_id }, now);
    });
  }

  /** Isolated so a saboteur can skip the observation that gates the store hop. */
  protected async observeTransferTransit(accountId: AccountId, sourceCasketId: string | undefined, destCasketId: string, options?: Advance): Promise<void> {
    // Proof after the hop's mutation: no walk that began before this moment can answer it.
    const startedAfter = this.context.now();
    await this.need(accountId, { surface: 'gc-inventory', scope: { kind: 'account' } }, startedAfter, options);
    if (sourceCasketId) await this.need(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: sourceCasketId } }, startedAfter, options);
    await this.need(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: destCasketId } }, startedAfter, options);
    this.services.settle.settleNow(accountId);
  }

  /**
   * The walks after a cancel. What proves the cancel rather than a sale is the cancel's own action
   * settling: `MarketService.reconcile` marks it done only when a complete walk shows the listing
   * gone and an inventory walk begun after the cancel still holds the item (the Game Coordinator
   * keeps a listed item in main inventory, so "it is in main inventory" proves nothing on its own).
   */
  protected async observeDelistReturn(accountId: AccountId, destinationCasketId?: string, options?: Advance): Promise<void> {
    const startedAfter = this.context.now();
    await this.need(accountId, { surface: 'steam-market', scope: { kind: 'account' } }, startedAfter, options);
    await this.need(accountId, { surface: 'gc-inventory', scope: { kind: 'account' } }, startedAfter, options);
    if (destinationCasketId) await this.need(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: destinationCasketId } }, startedAfter, options);
    this.services.settle.settleNow(accountId);
  }

  /** A sell order for this item that no observation has closed out yet. */
  protected unexplainedOrderFor(accountId: string, localId: string): boolean {
    return Boolean(this.context.database.raw().prepare(`SELECT 1 FROM venue_order
      WHERE account_id=? AND local_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%' LIMIT 1`).get(accountId, localId));
  }

  protected openListingFor(accountId: string, localId: string): string | undefined {
    return new OrderStore(this.context.database).openSteamListingFor(accountId, localId)?.venue_order_id ?? undefined;
  }

  /** A sell order for this item that ended as a fill, on evidence the order service graded. */
  protected saleEndedTheChain(accountId: string, localId: string): boolean {
    return Boolean(this.context.database.raw().prepare(`SELECT 1 FROM venue_order
      WHERE account_id=? AND local_id=? AND side='SELL' AND state='ENDED_FILLED' LIMIT 1`).get(accountId, localId));
  }

  /** Both chains need an open listing to cancel and their own second-hop input. */
  protected delistChainProblem(kind: CommandKind, member: CommandMemberInput, force: boolean): string | null {
    if (!member.localId) return `${kind} needs an individual item`;
    const listing = new OrderStore(this.context.database).openSteamListingFor(member.accountId, member.localId);
    if (!listing) return `Item ${member.localId} has no open listing`;
    if (kind === 'REPRICE' && !(member.priceReceiveCents && member.priceReceiveCents > 0)) {
      return 'REPRICE requires a positive seller-receives price';
    }
    if (kind === 'REPRICE') {
      const cadence = this.priceChangeProblem(listing, member.priceReceiveCents!, force);
      if (cadence) return cadence;
    }
    if (kind === 'DELIST_TO_STORE' && !member.destinationCasketId) return 'DELIST_TO_STORE requires destinationCasketId';
    return null;
  }

  /**
   * The price-change cadence on a Steam listing (`kernel/price-cadence.ts`). A reprice is a new
   * listing, so the open listing was last *changed* when its create attempt belonged to a `REPRICE`
   * command; a first listing set its price and changed nothing, and a listing this app did not
   * create has no attempt at all. The engine refuses only what it can date as a change.
   */
  protected priceChangeProblem(listing: SteamListingRow, priceReceiveCents: number, force: boolean): string | null {
    const { database } = this.context;
    const attempt = listing.action_id ? database.action(listing.action_id) : undefined;
    const step = attempt?.step_id ? this.work.step(attempt.step_id) : undefined;
    const relisted = step && database.command(step.command_id)?.kind === 'REPRICE';
    return priceChangeRefusal({ venue: 'steam', lastChangedAt: relisted ? attempt!.created_at : null, currentCents: listing.price_cents ?? 0,
      requestedCents: priceReceiveCents, now: this.context.now(), force });
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

  /**
   * The command's state from its members' hops. A refused member, or a hop that failed, makes the
   * command `PARTIAL`; every member sent, refused, stopped or sold makes it `COMPLETE`, which says
   * every send went out and nothing about effects, which the hops carry; anything still unsent
   * leaves it `RUNNING`.
   */
  protected finish(commandId: string): void {
    const { database } = this.context;
    const command = database.command(commandId);
    if (!command || command.state === 'STOPPED' || command.state === 'REJECTED') return;
    let rejected = false;
    let unsent = false;
    for (const member of database.commandMembers(commandId)) {
      if (member.state === 'REJECTED') { rejected = true; continue; }
      if (member.state === 'STOPPED' || member.state === 'SOLD') continue;
      if (member.state !== 'QUEUED') { unsent = true; continue; }
      const hops = this.work.hopsOf(commandId, member.account_id, member.local_id);
      if (hops.some((hop) => hop.state === 'FAILED')) rejected = true;
      else if (!hops.length || hops.some((hop) => hop.state === 'QUEUED' || hop.state === 'SENT')) unsent = true;
    }
    if (rejected) database.setCommandState(commandId, 'PARTIAL');
    else if (!unsent) database.setCommandState(commandId, 'COMPLETE');
  }
}
