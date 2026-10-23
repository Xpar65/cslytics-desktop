import type { MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CsfloatStore, type CsfloatContract } from '../db/csfloat.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { ActionRow, ObservationRow } from '../db/database.js';
import { WorkStore, type WorkStepRow } from '../db/work.js';
import { attemptReturned, locationEvidence, postAttempt, type ProofNeed, type Surface, type SurfaceRef } from '../kernel/evidence.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { HoldingsStore } from '../db/holdings.js';
import { STEAM_LISTED_SQL } from '../db/commitment.js';
import {
  CSFLOAT_LIST_EVIDENCE, CSFLOAT_LIST_LIMIT, CSFLOAT_VISIBILITY_TIMEOUT_REASON, CsfloatSellingPolicy, VISIBILITY_DEADLINE_MS, VISIBILITY_READ_OFFSETS_MS,
  type CsfloatSellGroupMember, type CsfloatSellMember, type CsfloatSellRequest
} from '../policy/csfloat-selling.js';
import type { CsfloatListingService } from '../surfaces/csfloat-listings.js';
import type { CsfloatInventoryService } from '../surfaces/csfloat-inventory.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { CsfloatAccountService } from '../surfaces/csfloat-account.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { MarketService } from '../surfaces/market.js';
import type { TradeService } from '../surfaces/trades.js';
import { MAIN_INVENTORY_HARD_CAP, type StorageService } from '../surfaces/storage.js';
import type { Settling } from './settle.js';
import type { Reading } from './reads.js';

export type CsfloatSellingServices = { listings: CsfloatListingService; inventory: CsfloatInventoryService; trades: CsfloatTradeService;
  csfloatAccount: CsfloatAccountService; steamInventory: InventoryService; steamMarket: MarketService; steamTrades: TradeService; policy: CsfloatSellingPolicy;
  /** Sends and resolves the retrieve a crated member starts with. */
  storage: StorageService;
  /** Settles on the caller's stack when a decision follows the driver's own read. */
  settle: Settling;
  /** The read broker: every read here is a need it answers. */
  reads: Reading };

/**
 * The three kinds of CSFloat listing work. Each is a command kind, the kind of the step that
 * sends it, and the kind of that step's action: one name, so a read of any of the three says the
 * same thing (consolidation plan D2).
 */
export const CSFLOAT_CREATE = 'CSFLOAT_CREATE' as const;
export const CSFLOAT_REPRICE = 'CSFLOAT_REPRICE' as const;
export const CSFLOAT_CANCEL = 'CSFLOAT_CANCEL' as const;
export const CSFLOAT_LISTING_KINDS = [CSFLOAT_CREATE, CSFLOAT_REPRICE, CSFLOAT_CANCEL] as const;
export type CsfloatListingKind = (typeof CSFLOAT_LISTING_KINDS)[number];

/**
 * The frozen terms of a listing hop, on the step and on its action alike. `operationId` is the id
 * of the hop that sends to CSFloat (`<command id>:<member index>` for a create, the command id for
 * an edit); a crated member's retrieve and wait hops carry the same id, suffixed, so the three are
 * found from any one of them.
 */
export type CsfloatListingStepParams = {
  operationId: string;
  assetId: string | null;
  listingId: string | null;
  priceCents: number | null;
  /** The storage unit a crated member leaves first; on its retrieve hop only. */
  casketId?: string;
  /** The CSFloat connection the terms were admitted under; a walk of another generation proves nothing about them. */
  generation: number;
  policyVersion: number;
};

/** The shortest sleep of the wait for CSFloat, so a refused read can never spin. */
const MIN_TURN_MS = 5_000;

/** The id of a crated member's retrieve or wait hop, beside the id of its listing hop. */
export function listingHopId(operationId: string, hop: 'retrieve' | 'await'): string {
  return `${operationId}:${hop}`;
}

export class CsfloatSellingService {
  protected readonly store: CsfloatStore;
  protected readonly work: WorkStore;
  /** One `advance` per account at a time; a second asked for meanwhile waits and re-reads. */
  private readonly advancing = new AccountLock();
  private readonly scheduled = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  /** At most one wait for CSFloat per account, however many listings are waiting. */
  private readonly waits = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatSellingServices) {
    this.store = new CsfloatStore(context.database);
    this.work = new WorkStore(context.database);
  }

  async refresh(accountId: string, eligibility = false): Promise<void> {
    // The person's reads: every book as a person need, and each listing nothing explains by its own scope.
    const startedAfter = this.context.now();
    const read = (ref: SurfaceRef) => this.services.reads.need(accountId, { ref, startedAfter, priority: 'person' });
    const account = (surface: Surface): SurfaceRef => ({ surface, scope: { kind: 'account' } });
    await read(account('csfloat-account-status'));
    await read(account('csfloat-stall'));
    await read(account('csfloat-trades'));
    for (const listingId of this.unexplained(accountId)) await read({ surface: 'csfloat-listing', scope: { kind: 'item', id: listingId } });
    if (eligibility) {
      for (const surface of ['gc-inventory', 'steam-market', 'steam-trade-inventory', 'steam-trade-offers', 'csfloat-inventory'] as const) await read(account(surface));
    }
    this.services.settle.settleNow(accountId);
    this.observeConflicts(accountId);
  }

  /**
   * A new CSFloat list, admitted against current evidence.
   *
   * `queue` judges only what is already recorded, and it is synchronous so that admission is one
   * short transaction (rule 6). Reading happens here, before it, one account at a time: whatever
   * `validate` would refuse on age alone is read again first, and nothing is read that is still
   * inside its window. A request already admitted under this command id is answered from the
   * record without reading anything.
   *
   * **The reply is the admission, not the send.** What comes back is the durable record — one
   * `QUEUED` listing step per unit, its action `READY` — and the send happens behind it, through
   * `advance`. The desktop used to hold its request open through the send and a stall walk after
   * it, which for CSFloat meant the Game Coordinator, the post and the walk before a person saw
   * anything move; a listing now shows on the work panel as queued the moment this returns, the
   * way a Steam command does through `CommandService.prepare`. A refusal still comes back here,
   * because admission is still here.
   */
  /** The listings a refresh reads one by one: those nothing in the record explains (`CsfloatStore.unexplainedListings`). */
  protected unexplained(accountId: string): string[] {
    return this.store.unexplainedListings(accountId);
  }

  async submit(request: CsfloatSellRequest): Promise<WorkStepRow[]> {
    const admitted = this.work.steps(request.commandId).length > 0;
    if (!admitted) {
      for (const accountId of new Set(request.members.map(member => member.accountId))) {
        await this.services.reads.ensureFresh(accountId, CSFLOAT_LIST_EVIDENCE, 'person');
      }
    }
    const steps = this.queue(request);
    for (const accountId of new Set(steps.map(step => step.account_id))) this.schedule(accountId);
    return steps;
  }

  /**
   * A reprice or a cancel, the same way: the listing is read again first, because `validateEdit`
   * judges the contract's own observation and refuses one older than its window, then it is
   * queued and sent behind the reply.
   */
  async submitEdit(accountId: string, commandId: string, listingId: string, priceCents?: number): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.listing(accountId, listingId, 'person');
    const step = this.queueEdit(accountId,commandId,listingId,priceCents);
    this.schedule(accountId);
    return step;
  }

  /**
   * Send what is queued, soon, outside whichever transaction or call stack asked.
   *
   * Coalesced per account, and a microtask short of immediate: `submit` calls this after its
   * admission transaction has committed, and a signal calls it from a publisher's stack, and in
   * neither place may the send begin (rule 6, and `signals.ts` on what a listener may do).
   */
  schedule(accountId: string): void {
    if (this.stopped || this.scheduled.has(accountId)) return;
    this.scheduled.add(accountId);
    setImmediate(() => {
      this.scheduled.delete(accountId);
      if (this.stopped) return;
      void this.advance(accountId).catch(() => undefined);
    });
  }

  /**
   * Every listing hop of this account that was admitted and never sent, sent once each, in order.
   *
   * This is `CommandService.resume` for CSFloat work, and holds to the same rule: it resumes by
   * *identity*, never by retry. `QUEUED` with a `READY` action means no mutation has ever been
   * attempted for it, so sending is safe; anything past that is `execute`'s own guard and is
   * settled by observation alone (rule 1, `CSF-17`). Nothing here re-sends.
   *
   * It is what `submit` hands the send to, and what a reattaching session runs, so a hop queued in
   * a run that died before it got to the send is sent by the next one — the gap the desktop's
   * inline send used to leave open, since nothing but that one call ever looked at a queued one.
   *
   * A venue with no credential on this account is not an error: the hop waits, and the next
   * connection schedules it. A refusal at the send is `execute`'s to record, durably, on the hop
   * itself. Anything else thrown reaches Activity and leaves the hop queued, still never sent,
   * for the next pass.
   *
   * A member admitted from a storage unit gets here twice more first: `advanceRetrievals` sends
   * and settles its retrieve, and `awaitVisibility` holds it until CSFloat's own read shows the
   * item, at which point its listing hop is an ordinary queued create.
   */
  async advance(accountId: string): Promise<void> {
    const work = this.advancing.run(accountId,async () => {
      const db = this.context.database;
      if (!new MarketplaceStore(db).connection(accountId,'csfloat')?.credential_ref || !this.context.ports.csfloat) return;
      for (const stage of [() => this.advanceRetrievals(accountId), () => this.awaitVisibility(accountId)]) {
        if (this.stopped) return;
        try { await stage(); } catch (error) {
          if (this.stopped) return;
          try { db.addEvent(accountId,'csfloat-dispatch-error',{ message: errorMessage(error) },this.context.now()); } catch { /* closed under us */ }
        }
      }
      const queued = this.work.openOf(accountId, CSFLOAT_LISTING_KINDS, CSFLOAT_LISTING_KINDS)
        .filter(step => step.state === 'QUEUED' && step.action_id !== null && db.action(step.action_id)?.state === 'READY');
      for (const { id } of queued) {
        if (this.stopped) return;
        try {
          await this.execute(id);
        } catch (error) {
          if (this.stopped) return;
          // A refusal at admission is already on the hop; a second copy would be noise.
          if (this.work.step(id)?.state === 'FAILED') continue;
          try { db.addEvent(accountId,'csfloat-dispatch-error',{ operationId: id, message: errorMessage(error) },this.context.now()); } catch { /* closed under us */ }
          continue;
        }
        // The listing the edit was about, read again, so a cancel can be proved: the stall no
        // longer holds it, and only the listing's own read says whether that is because it was
        // delisted. This is the first such read, not the only one: until one settles it the
        // refresh loop keeps reading (`needs`). A create is proved by the stall walk
        // `mutation-settled` asks for.
        const step = this.work.step(id);
        if (step?.target_id && step.kind !== CSFLOAT_CREATE) await this.listing(accountId, step.target_id, 'work');
      }
    });
    this.running.set(accountId,work);
    try { await work; } finally { if (this.running.get(accountId) === work) this.running.delete(accountId); }
  }

  /** One listing's own read, begun now: the proof a delist or reprice needs (CSF-45). */
  private async listing(accountId: string, listingId: string, priority: 'person' | 'work'): Promise<void> {
    await this.services.reads.need(accountId, { ref: { surface: 'csfloat-listing', scope: { kind: 'item', id: listingId } }, startedAfter: this.context.now(), priority });
  }

  /**
   * Every send this command asked for, as something a caller can wait for.
   *
   * The desktop never does — the step is a durable receipt and the window reads `work.open` — but
   * a scenario has to, and sleeping asserts nothing. `CommandService.settled` is the precedent,
   * for the same reason.
   */
  async settled(commandId: string): Promise<void> {
    const accounts = [...new Set(this.work.steps(commandId).map(step => step.account_id))];
    for (;;) {
      if (accounts.some(accountId => this.scheduled.has(accountId))) { await new Promise<void>(resolve => setImmediate(resolve)); continue; }
      const running = accounts.map(accountId => this.running.get(accountId)).filter((work): work is Promise<void> => work !== undefined);
      if (!running.length) return;
      await Promise.all(running.map(work => work.catch(() => undefined)));
    }
  }

  stop(): void {
    this.stopped = true;
    this.scheduled.clear();
  }

  /**
   * Admission: one listing hop per unit, all of them or none.
   *
   * A group member becomes that many hops, one per unit the engine picks (`pickUnits`), so a
   * replay is judged against the terms asked for — account, price, and the item or the group —
   * never against which units were picked, which the first admission itself changed. What comes
   * back is each unit's listing hop; a crated unit's retrieve and wait hops sit before it under
   * the same command.
   */
  queue(request: CsfloatSellRequest): WorkStepRow[] {
    const { database: db } = this.context;
    for (const member of request.members) {
      if ('stackKey' in member && (!Number.isSafeInteger(member.quantity) || member.quantity < 1)) throw new Error('A group member needs a positive whole quantity');
    }
    const terms = request.members.flatMap((member): Array<CsfloatSellMember | CsfloatSellGroupMember> =>
      'stackKey' in member ? Array.from({ length: member.quantity }, () => member) : [member]);
    if (!request.members.length || terms.length > CSFLOAT_LIST_LIMIT) throw new Error(`Select between 1 and ${CSFLOAT_LIST_LIMIT} items`);
    return db.transaction(() => {
      const existing = this.work.steps(request.commandId).filter(step => step.kind === CSFLOAT_CREATE);
      if (existing.length) {
        if (existing.length !== terms.length || terms.some((m,i) => {
          const step = existing.find(s => s.id === `${request.commandId}:${i}`);
          const params = step ? this.paramsOf(step) : undefined;
          return !step || step.account_id !== m.accountId || params?.priceCents !== m.priceCents
            || ('stackKey' in m ? db.itemByLocalId(step.account_id,step.local_id ?? '')?.group_key !== m.stackKey : step.local_id !== m.localId);
        })) throw new Error('Command id was already used for different terms');
        return existing.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
      }
      const selected = new Set<string>();
      const slots = new Map<string, number>();
      const frozen = this.unitsOf(request).map(member => {
        // A crated item is admitted as a retrieve first (`validateForRetrieve`), and judged in full
        // at the send, once it is loose and CSFloat has seen it. One free slot each, counted here
        // across the batch, because none of them has reserved one yet.
        const crated = db.itemByLocalId(member.accountId,member.localId)?.location === 'CASKET';
        const { assetId, casketId } = crated ? this.services.policy.validateForRetrieve(member) : { assetId: this.services.policy.validate(member), casketId: undefined };
        if (crated) {
          const wanted = (slots.get(member.accountId) ?? 0) + 1;
          if (db.countMainItems(member.accountId) + db.reservedMainSlots(member.accountId) + wanted > MAIN_INVENTORY_HARD_CAP) throw new Error('Main inventory is full; free a slot before listing from storage');
          slots.set(member.accountId,wanted);
        }
        const key = `${member.accountId}:${assetId}`;
        if (selected.has(key)) throw new Error('Item selected more than once');
        selected.add(key); return { ...member,assetId,casketId };
      });
      this.work.adoptCommand(request.commandId, CSFLOAT_CREATE, this.context.now());
      return frozen.map((member,i) => this.insert({ id: `${request.commandId}:${i}`, commandId: request.commandId, accountId: member.accountId,
        localId: member.localId, assetId: member.assetId, priceCents: member.priceCents, kind: CSFLOAT_CREATE,
        ...(member.casketId ? { casketId: member.casketId } : {}) }));
    });
  }

  /** The request as units, in its own order: an item as named, a group as the units picked for it. */
  private unitsOf(request: CsfloatSellRequest): CsfloatSellMember[] {
    const named = new Set(request.members.flatMap(member => 'localId' in member ? [`${member.accountId}:${member.localId}`] : []));
    const taken = new Set<string>();
    return request.members.flatMap(member => {
      if ('localId' in member) return [member];
      const picked = this.pickUnits(member, localId => named.has(`${member.accountId}:${localId}`) || taken.has(`${member.accountId}:${localId}`));
      for (const unit of picked) taken.add(`${member.accountId}:${unit.localId}`);
      return picked;
    });
  }

  /**
   * Which of a group's units a listing of `quantity` of it takes: the first, by asset id, that
   * `validate` would admit on their own. So a unit CSFloat's read does not hold or calls
   * untradable, one Steam lists or a command has reserved, one a CSFloat listing or sale already
   * names, or one Steam called unmarketable is passed over for the next, rather than refusing a
   * group that has enough units that can go. Only loose units: a group in a storage unit has no
   * retrieve hop to chain, as on Steam. Isolated so a saboteur can take the group's first units
   * whatever the venue said.
   */
  protected pickUnits(member: CsfloatSellGroupMember, excluded: (localId: string) => boolean): CsfloatSellMember[] {
    const candidates = new HoldingsStore(this.context.database).units(member.accountId,member.stackKey)
      .filter(unit => unit.location === 'MAIN' && unit.asset_id && !unit.reserved_command && !excluded(unit.local_id));
    if (candidates.length === 0) throw new Error('No unit of this group is in main inventory and free to list');
    const picked: CsfloatSellMember[] = [];
    let refusal: string | null = null;
    for (const unit of candidates) {
      if (picked.length === member.quantity) break;
      const candidate = { accountId: member.accountId, localId: unit.local_id, priceCents: member.priceCents };
      try { this.services.policy.validate(candidate); picked.push(candidate); } catch (error) { refusal ??= errorMessage(error); }
    }
    if (picked.length === member.quantity) return picked;
    // None could go: the reason is the first unit's, verbatim, and it is usually the account's.
    if (picked.length === 0 && refusal) throw new Error(refusal);
    throw new Error(`Only ${picked.length} of the ${member.quantity} asked for from this group can be listed on CSFloat now${refusal ? `; the rest: ${refusal}` : ''}`);
  }

  queueEdit(accountId: string, commandId: string, listingId: string, priceCents?: number): WorkStepRow {
    const kind = priceCents === undefined ? CSFLOAT_CANCEL : CSFLOAT_REPRICE;
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        const params = this.paramsOf(existing);
        if (existing.account_id !== accountId || existing.target_id !== listingId || existing.kind !== kind || params.priceCents !== (priceCents ?? null)) throw new Error('Command id was already used for different terms');
        return existing;
      }
      this.validateEdit(accountId,listingId,priceCents);
      const listing = this.store.contract(accountId,listingId)!;
      this.work.adoptCommand(commandId, kind, this.context.now());
      return this.insert({ id: commandId, commandId, accountId, localId: listing.local_id, assetId: listing.asset_id, listingId,
        priceCents: priceCents ?? null, kind });
    });
  }

  protected validateEdit(accountId: string, listingId: string, priceCents?: number): void {
    const listing = this.store.contract(accountId,listingId);
    const observation = listing && this.context.database.observation(accountId,listing.observation_id);
    const connection = new MarketplaceStore(this.context.database).connection(accountId,'csfloat');
    const age = observation ? Date.parse(this.context.now())-Date.parse(observation.started_at) : NaN;
    if (connection?.status !== 'CONNECTED' || !listing || listing.type !== 'buy_now' || listing.state !== 'listed'
      || !observation?.complete || observation.generation !== connection.generation || !(age >= 0 && age <= 300_000)) throw new Error('Refresh this active fixed-price CSFloat listing first');
    // A listing must have been in the authenticated own book; public known-id lookup cannot confer authority.
    if (!this.store.inStall(accountId,listingId)) throw new Error('Listing is no longer in the authenticated own book');
    if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 3)) throw new Error('CSFloat listing price must be at least 3 USD cents');
  }

  protected paramsOf(step: WorkStepRow): CsfloatListingStepParams {
    return this.work.params<CsfloatListingStepParams>(step);
  }

  /**
   * The hops of one admitted unit. A loose unit is one listing hop with its action. A crated unit
   * is three: the retrieve, whose action the storage service sends and the Game Coordinator walk
   * proves; the wait for CSFloat's own read to show the item, which has no action and a deadline;
   * and the listing hop, which gets its action only once CSFloat has seen the item, because an
   * action on `item:<localId>` would hold the resource against the retrieve.
   */
  private insert(input: { id: string; commandId: string; accountId: string; localId: string | null; assetId: string | null;
    listingId?: string; priceCents: number | null; kind: CsfloatListingKind; casketId?: string }): WorkStepRow {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(input.accountId,'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    const params: CsfloatListingStepParams = { operationId: input.id, assetId: input.assetId, listingId: input.listingId ?? null, priceCents: input.priceCents,
      generation: connection.generation, policyVersion: this.store.policy().version };
    const common = { commandId: input.commandId, accountId: input.accountId, localId: input.localId, now };
    if (input.casketId) {
      const retrieve = this.work.insert({ ...common, id: listingHopId(input.id, 'retrieve'), ordinal: 0, kind: 'RETRIEVE', params: { ...params, casketId: input.casketId } });
      const action = db.enqueueAction({ accountId: input.accountId, stepId: retrieve.id, actionKind: 'RETRIEVE_FROM_CASKET',
        targetId: input.localId!, resourceKey: `item:${input.localId}`, params: { casketId: input.casketId, assetId: input.assetId }, now });
      db.reserveMainSlot(input.accountId,action.id);
      this.work.attachAction(retrieve.id, action.id, now);
      this.work.insert({ ...common, id: listingHopId(input.id, 'await'), ordinal: 1, kind: 'CSFLOAT_AWAIT_VENUE', params });
      return this.work.insert({ ...common, id: input.id, ordinal: 2, kind: CSFLOAT_CREATE, params });
    }
    const step = this.work.insert({ ...common, id: input.id, ordinal: 0, kind: input.kind, targetId: input.listingId ?? null, params });
    const action = db.enqueueAction({ accountId: input.accountId, stepId: step.id, actionKind: input.kind,
      targetId: input.localId ?? `csfloat-listing:${input.listingId}`, resourceKey: input.localId ? `item:${input.localId}` : `csfloat-listing:${input.listingId}`,
      params, now });
    this.work.attachAction(step.id, action.id, now);
    return this.work.step(step.id)!;
  }

  async execute(id: string): Promise<MutationOutcome | null> {
    const initial = this.work.step(id);
    if (!initial) throw new Error('Unknown CSFloat operation');
    return this.context.locks.run(initial.account_id,async () => {
      const step = this.work.step(id)!, db = this.context.database, action = step.action_id ? db.action(step.action_id) : undefined;
      if (!action || action.state !== 'READY' || step.state !== 'QUEUED' || !(CSFLOAT_LISTING_KINDS as readonly string[]).includes(step.kind)) return null;
      const params = this.paramsOf(step);
      const connection = new MarketplaceStore(db).connection(step.account_id,'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const validate = () => {
        const current = new MarketplaceStore(db).connection(step.account_id,'csfloat');
        if (current?.generation !== params.generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the listing command');
        if (step.kind === CSFLOAT_CREATE) {
          const asset = this.services.policy.validate({ accountId: step.account_id,localId: step.local_id!,priceCents: params.priceCents! },step.id);
          if (asset !== params.assetId) throw new Error('Item asset changed; submit a new selection');
        } else this.validateEdit(step.account_id,step.target_id!,step.kind === CSFLOAT_REPRICE ? params.priceCents! : undefined);
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      let outcome: MutationOutcome;
      try {
        outcome = await executeMutation(this.context,action, () => step.kind === CSFLOAT_CREATE
          ? ports.listings.create(step.account_id,connection.credential_ref!,params.assetId!,params.priceCents!)
          : step.kind === CSFLOAT_REPRICE ? ports.listings.reprice(step.account_id,connection.credential_ref!,step.target_id!,params.priceCents!)
            : ports.listings.cancel(step.account_id,connection.credential_ref!,step.target_id!),admit);
      } catch (error) {
        // Admission refused before any call: the command is over, durably (XLIST-11). Nothing
        // re-queues it when the setting, the connection or the network changes.
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),rejected.message);
          this.work.settle(step.id,'FAILED',null,this.context.now(),rejected.message);
        });
        throw error;
      }
      this.work.setState(step.id,outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION',this.context.now(),outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
      return outcome;
    });
  }

  // --- listing from a storage unit ------------------------------------------------------------

  /**
   * The retrieve hop of every crated member on this account.
   *
   * A `READY` retrieve is sent. One in flight is resolved only by the storage reconciler, from a
   * complete walk that started after the attempt (rule 1); the hop reflects its action's state.
   * A `DONE` one starts the wait for CSFloat, anchored on the observation that resolved it.
   * Isolated so a saboteur can skip the observation.
   */
  protected async advanceRetrievals(accountId: string): Promise<void> {
    const db = this.context.database;
    const hops = this.work.openOf(accountId, [CSFLOAT_CREATE], ['RETRIEVE']);
    if (!hops.length) return;
    if (hops.some(hop => hop.action_id && db.action(hop.action_id)?.state === 'AWAITING_OBSERVATION')) this.services.settle.settleNow(accountId);
    for (const { id } of hops) {
      if (this.stopped) return;
      const step = this.work.reflectAction(this.work.step(id)!, this.context.now());
      const retrieve = step.action_id ? db.action(step.action_id) : undefined;
      if (!retrieve) { this.failHop(step,'Retrieve action is missing; review the listing'); continue; }
      if (step.state === 'FAILED') { this.failRetrieve(step,retrieve.error ?? 'no reason given'); continue; }
      if (retrieve.state === 'READY') { await this.sendRetrieve(step,retrieve); continue; }
      if (step.state === 'DONE') {
        const loose = db.observation(accountId, step.observation_id ?? retrieve.resolved_by_obs);
        if (loose) this.startWaiting(step, loose);
        else this.failHop(this.awaitHop(step) ?? step,'Retrieve was resolved without an observation; review the listing');
      }
      // RUNNING or AWAITING_OBSERVATION: the next complete walk schedules another pass.
    }
  }

  private async sendRetrieve(step: WorkStepRow, retrieve: ActionRow): Promise<void> {
    const db = this.context.database, accountId = step.account_id;
    // No session, no send; the session coming up schedules the next pass.
    if (this.context.ports.gc.connectionStatus(accountId).state !== 'CONNECTED') return;
    // The retrieve's own admission wants the unit and main inventory freshly walked. Admission read
    // them moments ago; a restart may not have.
    const { casketId } = db.actionParams(retrieve) as { casketId: string };
    if (locationEvidence(db,accountId,step.local_id!,'CASKET',this.context.ports.clock.now()).grade !== 'SATISFIED') {
      await this.services.reads.need(accountId, { ref: { surface: 'gc-casket', scope: { kind: 'casket', id: casketId } }, startedAfter: this.context.now(), priority: 'work' });
    }
    await this.services.reads.ensureFresh(accountId,['gc-inventory']);
    let outcome: MutationOutcome;
    try {
      outcome = await this.context.locks.run(accountId,() => this.services.storage.execute(retrieve.id));
    } catch (error) {
      // Refused before any call: nothing was sent, so the listing is over (XLIST-11's rule).
      if (db.action(retrieve.id)?.state === 'READY') this.failRetrieve(step,errorMessage(error));
      return;
    }
    if (outcome.kind === 'DEFINITIVELY_REJECTED') { this.failRetrieve(step,outcome.reason); return; }
    db.markSlotSubmitted(accountId,retrieve.id);
    this.work.reflectAction(this.work.step(step.id)!, this.context.now());
  }

  /**
   * The retrieve was proved: the item is loose, and the ten minutes start from that proof. The
   * wait hop goes from queued to waiting on CSFloat's read, with its deadline on the row so a
   * restart judges the same instant.
   */
  protected startWaiting(retrieve: WorkStepRow, loose: ObservationRow): void {
    const db = this.context.database, now = this.context.now();
    const waiting = this.awaitHop(retrieve);
    if (!waiting || waiting.state !== 'QUEUED') return;
    const params = this.paramsOf(retrieve);
    const deadline = new Date(Date.parse(loose.started_at)+VISIBILITY_DEADLINE_MS).toISOString();
    db.transaction(() => {
      this.work.update(waiting.id, { state: 'AWAITING_OBSERVATION', deadline_at: deadline, reason: 'Waiting for CSFloat to see the retrieved item' }, now);
      db.addEvent(retrieve.account_id,'csfloat-visibility-wait',{ operationId: params.operationId, localId: retrieve.local_id, assetId: params.assetId, looseAt: loose.started_at, deadline },now);
    });
  }

  /**
   * Every wait hop of this account: a unit that is loose and not yet seen by CSFloat.
   *
   * The deadline is judged first, from the stored column, so a restart judges the same instant
   * and a wait that ran out while the app was closed fails without a read. Then the latest
   * CSFloat read: only one that started after the item was proved loose can say anything about it
   * (`venueSees`). Seen, the listing hop gets its action and joins the ordinary path; not yet, the
   * account's one wait loop is armed.
   */
  protected async awaitVisibility(accountId: string): Promise<void> {
    const db = this.context.database;
    let waiting = false;
    for (const { id } of this.work.openOf(accountId, [CSFLOAT_CREATE], ['CSFLOAT_AWAIT_VENUE'])) {
      if (this.stopped) return;
      const step = this.work.step(id)!;
      // Queued: the retrieve before it is still in flight.
      if (step.state !== 'AWAITING_OBSERVATION') continue;
      const params = this.paramsOf(step);
      const loose = this.looseOf(step);
      if (!loose || !step.deadline_at) { this.failHop(step,'The retrieve\'s observation is missing; review the listing'); continue; }
      if (this.context.now() >= step.deadline_at) { this.timeOut(step,loose); continue; }
      if (db.itemByLocalId(accountId,step.local_id!)?.asset_id !== params.assetId) { this.failHop(step,'Item asset changed; submit a new selection'); continue; }
      if (!this.venueSees(step,loose)) { waiting = true; continue; }
      await this.attachCreate(step,loose);
    }
    if (waiting) this.armVisibility(accountId);
  }

  /** CSFloat's latest complete read, taken after the item was proved loose, shows this exact item tradable. */
  protected venueSees(step: WorkStepRow, loose: ObservationRow): boolean {
    const db = this.context.database, params = this.paramsOf(step);
    const latest = db.latestObservation(step.account_id,'csfloat-inventory');
    if (!latest?.complete || latest.error || latest.generation !== params.generation || latest.id <= loose.id || latest.started_at < loose.started_at) return false;
    const row = params.assetId ? new AssetEvidenceStore(db).csfloat(step.account_id,params.assetId) : undefined;
    if (!row || row.last_seen_obs !== latest.id) return false;
    return row.eligible === 1 && this.store.associate(step.account_id,row.item) === step.local_id;
  }

  /**
   * CSFloat has seen it: the wait hop is settled on that read, and the listing hop gets its
   * action and is an ordinary queued create.
   *
   * Everything `validate` judges is read again first where it may have lapsed during the wait —
   * otherwise the send's admission turns a ten-minute-old read into a permanent refusal — and
   * Steam's trade inventory is read again if the walk on record predates the retrieve, because
   * that walk could not see the item at all.
   */
  private async attachCreate(step: WorkStepRow, loose: ObservationRow): Promise<void> {
    const db = this.context.database, accountId = step.account_id, params = this.paramsOf(step);
    // Steam's trade inventory from a walk begun after the item was loose: an earlier one could not see it.
    await this.services.reads.need(accountId, { ref: { surface: 'steam-trade-inventory', scope: { kind: 'account' } }, startedAfter: loose.started_at, priority: 'work' });
    await this.services.reads.ensureFresh(accountId,CSFLOAT_LIST_EVIDENCE);
    try {
      db.transaction(() => {
        const current = this.work.step(step.id);
        if (current?.state !== 'AWAITING_OBSERVATION') return;
        const listing = this.work.step(params.operationId);
        if (!listing || listing.state !== 'QUEUED' || listing.action_id) throw new Error('The listing hop was replaced; review the listing');
        const now = this.context.now();
        const read = db.latestObservation(accountId,'csfloat-inventory')!;
        const action = db.enqueueAction({ accountId, stepId: listing.id, actionKind: CSFLOAT_CREATE,
          targetId: step.local_id!, resourceKey: `item:${step.local_id}`, params: this.paramsOf(listing), now });
        this.work.attachAction(listing.id,action.id,now);
        this.work.settle(step.id,'DONE',read.id,now);
      });
    } catch (error) {
      this.failHop(step,errorMessage(error));
    }
  }

  /** Ten minutes and CSFloat never showed it. The item stays loose: nothing is stored back. */
  private timeOut(step: WorkStepRow, loose: ObservationRow): void {
    const db = this.context.database, params = this.paramsOf(step);
    const reads = (db.raw().prepare("SELECT COUNT(*) AS n FROM observation WHERE account_id=? AND surface='csfloat-inventory' AND id>?")
      .get(step.account_id,loose.id) as { n: number }).n;
    db.transaction(() => {
      this.failHop(step,CSFLOAT_VISIBILITY_TIMEOUT_REASON);
      db.addEvent(step.account_id,'csfloat-visibility-timeout',{ operationId: params.operationId, localId: step.local_id, assetId: params.assetId,
        looseAt: loose.started_at, deadline: step.deadline_at, readsMade: reads },this.context.now());
    });
  }

  private failRetrieve(step: WorkStepRow, reason: string): void {
    const db = this.context.database, params = this.paramsOf(step);
    db.transaction(() => {
      this.failHop(step,`Retrieve refused: ${reason}`);
      db.addEvent(step.account_id,'csfloat-retrieve-failed',{ operationId: params.operationId, localId: step.local_id, assetId: params.assetId, reason },this.context.now());
    });
  }

  /**
   * A member that cannot reach its listing: the hop that stopped it is failed with the reason and
   * the hops after it are never reached. A retrieve that never moved the item is failed too and
   * gives its slot back. A retrieve that did move it keeps its `DONE`: the item is in main
   * inventory, and that is where it stays.
   */
  private failHop(step: WorkStepRow, reason: string): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      const retrieve = step.kind === 'RETRIEVE' ? step : this.retrieveHop(step);
      const action = retrieve?.action_id ? db.action(retrieve.action_id) : undefined;
      if (action?.state === 'READY') db.setActionState(action.id,'FAILED',now,reason);
      if (action && ['READY','FAILED'].includes(action.state)) db.releaseSlot(step.account_id,action.id,false);
      this.work.failHop(step,reason,now);
    });
  }

  /** The wait hop of a crated member, from any of its hops. */
  private awaitHop(step: WorkStepRow): WorkStepRow | undefined {
    return this.work.step(listingHopId(this.paramsOf(step).operationId, 'await'));
  }

  /** The retrieve hop of a crated member, from any of its hops. */
  private retrieveHop(step: WorkStepRow): WorkStepRow | undefined {
    return this.work.step(listingHopId(this.paramsOf(step).operationId, 'retrieve'));
  }

  /** The observation that proved a crated member loose: the one that settled its retrieve hop. */
  private looseOf(step: WorkStepRow): ObservationRow | undefined {
    const retrieve = this.retrieveHop(step);
    const observationId = retrieve?.observation_id ?? (retrieve?.action_id ? this.context.database.action(retrieve.action_id)?.resolved_by_obs : null);
    return this.context.database.observation(step.account_id, observationId ?? null);
  }

  /** Starts this account's wait for CSFloat, unless one is already running. */
  protected armVisibility(accountId: string): void {
    if (this.stopped || this.waits.has(accountId)) return;
    const wait: Promise<void> = this.visibilityLoop(accountId).catch(() => undefined)
      .finally(() => { if (this.waits.get(accountId) === wait) this.waits.delete(accountId); });
    this.waits.set(accountId,wait);
  }

  /**
   * Sleeps to the next read or the next deadline, whichever is sooner, reads if a read is due,
   * and hands the verdict to `advance`. One loop per account: a batch retrieved by one walk shares
   * one anchor and at most five reads, and one that joins later takes the reads still ahead.
   */
  private async visibilityLoop(accountId: string): Promise<void> {
    const clock = this.context.ports.clock;
    while (!this.stopped) {
      const turn = this.visibilityTurn(accountId);
      // Deleted here, not after: a wait armed between this check and the loop's end must start.
      if (!turn) { this.waits.delete(accountId); return; }
      const wakeAt = Math.min(turn.readAt ?? Infinity,turn.deadline);
      await clock.sleep(Math.max(MIN_TURN_MS,wakeAt-clock.now().getTime()));
      if (this.stopped) return;
      const due = this.visibilityTurn(accountId);
      if (due?.readAt !== undefined && due.readAt !== null && due.readAt <= clock.now().getTime()) {
        await this.readVenue(accountId).catch(() => undefined);
      }
      this.schedule(accountId);
    }
  }

  /** One read of CSFloat's copy of this account's inventory, begun now, for everything waiting on it. */
  protected async readVenue(accountId: string): Promise<void> {
    await this.services.reads.need(accountId, { ref: { surface: 'csfloat-inventory', scope: { kind: 'account' } }, startedAfter: this.context.now(), priority: 'work' });
  }

  /**
   * When this account next reads CSFloat and next hits a deadline. Offsets count from the earliest
   * waiting member's loose observation, and the next one is the first strictly after the latest
   * CSFloat read of any kind — a failed read still spent the budget, and a read someone else asked
   * for counts too.
   */
  private visibilityTurn(accountId: string): { readAt: number | null; deadline: number } | null {
    const db = this.context.database;
    const waiting = this.work.openOf(accountId, [CSFLOAT_CREATE], ['CSFLOAT_AWAIT_VENUE'])
      .filter(step => step.state === 'AWAITING_OBSERVATION' && step.deadline_at !== null);
    if (!waiting.length) return null;
    const anchor = Math.min(...waiting.map(step => Date.parse(this.looseOf(step)?.started_at ?? step.deadline_at!)));
    const last = db.latestObservation(accountId,'csfloat-inventory');
    const lastRead = last ? Date.parse(last.started_at) : -Infinity;
    const readAt = VISIBILITY_READ_OFFSETS_MS.map(offset => anchor+offset).find(at => at > lastRead) ?? null;
    return { readAt, deadline: Math.min(...waiting.map(step => Date.parse(step.deadline_at!))) };
  }

  /** Called after reads and on restart. It never sends, even when absence is proven. */
  reconcile(accountId: string): void {
    const db = this.context.database;
    for (const step of this.work.openOf(accountId, CSFLOAT_LISTING_KINDS, CSFLOAT_LISTING_KINDS)) {
      if (!['QUEUED','AWAITING_OBSERVATION'].includes(step.state) || !step.action_id) continue;
      const action = db.action(step.action_id);
      if (!action || !['RUNNING','AWAITING_OBSERVATION'].includes(action.state)) continue;
      if (step.state !== 'AWAITING_OBSERVATION') this.work.setState(step.id,'AWAITING_OBSERVATION',this.context.now());
      const params = this.paramsOf(step);
      const candidates = step.target_id ? [this.store.contract(accountId,step.target_id)].filter((row): row is CsfloatContract => row !== undefined)
        : this.store.contractsFor(accountId,step.local_id,params.assetId);
      const listing = candidates.length === 1 ? candidates[0] : undefined;
      if (!listing) continue;
      const obs = db.observation(accountId,listing.observation_id);
      if (!obs?.complete || obs.error || obs.generation !== params.generation || !postAttempt(db,action,obs,false)) continue;
      const applied = step.kind === CSFLOAT_CANCEL ? ['delisted','cancelled'].includes(listing.state)
        : step.kind === CSFLOAT_CREATE ? ['listed','sold'].includes(listing.state) && listing.price_cents === params.priceCents
          : listing.state === 'listed' && listing.price_cents === params.priceCents;
      if (applied) {
        db.transaction(() => {
          db.resolveAction(action,obs.id,true,this.context.now());
          this.work.update(step.id, { state: 'DONE', target_id: listing.listing_id, observation_id: obs.id, reason: null }, this.context.now());
        });
      } else if (['sold','refunded','delisted','cancelled'].includes(listing.state)) {
        db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),`Observed ${listing.state}; requested operation did not complete`);
          this.work.settle(step.id,'FAILED',obs.id,this.context.now(),`CSFloat listing is ${listing.state}; check sales before using the item`);
        });
      } else if (this.editProvedNotApplied(step,listing,action,obs)) {
        // Failed, never `READY`: `resolveAction` would hand a current goal back to be sent again.
        db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),'complete-observation-proved-not-applied');
          this.work.settle(step.id,'FAILED',obs.id,this.context.now(),step.kind === CSFLOAT_CANCEL
            ? 'A CSFloat read after the delist still showed the listing up, so nothing was delisted'
            : `A CSFloat read after the reprice still showed it at $${(listing.price_cents/100).toFixed(2)}, so the price did not change`);
        });
      }
    }
  }

  /**
   * Whether a read proves CSFloat did not apply this delist or reprice: the listing still up, at
   * a price other than the one sent, on a read begun after the send returned. A read begun during
   * the call could have read the listing before the change landed, so it proves nothing (CSF-46,
   * the buy-order cancel's rule in CSF-39). Isolated so a saboteur can wait instead.
   */
  protected editProvedNotApplied(step: WorkStepRow, listing: CsfloatContract, action: ActionRow, obs: ObservationRow): boolean {
    if (step.kind === CSFLOAT_CREATE || listing.state !== 'listed') return false;
    return postAttempt(this.context.database,action,obs,true);
  }

  /**
   * What proves a delist or reprice CSFloat accepted: that listing's own read, begun after the
   * send returned (CSF-45). The stall cannot prove it, because a listing the stall no longer holds
   * may have sold. The refresh loop reads the listing for as long as the hop waits — at once, then
   * on the proof intervals, then on the listing's own cadence — so a read that fails is followed
   * by another rather than by nothing, and a restart reads for it from the record. A create is
   * proved by the stall walk its send nudges, which the stall's cadence repeats.
   */
  needs(action: ActionRow): ProofNeed {
    const { listingId } = this.context.database.actionParams(action) as { listingId?: string | null };
    if (!['CSFLOAT_CANCEL','CSFLOAT_REPRICE'].includes(action.kind) || !listingId) return { kind: 'none' };
    return { kind: 'walks', walks: [{ ref: { surface: 'csfloat-listing', scope: { kind: 'item', id: listingId } }, startedAfter: attemptReturned(this.context.database,action) }] };
  }

  /**
   * One durable conflict per foreign duplicate (XLIST-09, XLIST-14). Raised only while
   * protection is on; resolved only when the latest complete Steam and CSFloat walks no longer
   * show both advertisements. An incomplete walk changes nothing in either direction, and no
   * refresh ever raises a second row for the same unit. Judged after every read that could show one.
   */
  observeConflicts(accountId: string): void {
    const db = this.context.database, now = this.context.now();
    const conflicts = db.raw().prepare(`SELECT c.venue_order_id AS listing_id FROM venue_order c JOIN venue_order o ON o.account_id=c.account_id
      AND (o.local_id=c.local_id OR o.asset_id=c.asset_id) WHERE c.account_id=? AND c.venue='csfloat' AND c.side='SELL' AND c.state='OPEN' AND ${STEAM_LISTED_SQL}`).all(accountId) as Array<{ listing_id: string }>;
    if (this.store.policy().preventDuplicates) {
      for (const row of conflicts) db.raw().prepare(`INSERT INTO venue_conflict(account_id,conflict_key,reason,observed_at) VALUES (?,?,?,?)
        ON CONFLICT(account_id,conflict_key) DO UPDATE SET resolved_at=NULL`).run(accountId,`duplicate:${row.listing_id}`,`Item advertised on Steam and CSFloat (${row.listing_id})`,now);
    }
    const stall = db.latestObservation(accountId,'csfloat-stall'), market = db.latestObservation(accountId,'steam-market');
    if (!stall?.complete || stall.error || !market?.complete || market.error) return;
    const current = new Set(conflicts.map(row => `duplicate:${row.listing_id}`));
    const open = db.raw().prepare(`SELECT conflict_key FROM venue_conflict WHERE account_id=? AND resolved_at IS NULL AND conflict_key LIKE 'duplicate:%'`).all(accountId) as Array<{ conflict_key: string }>;
    for (const row of open) if (!current.has(row.conflict_key)) db.raw().prepare('UPDATE venue_conflict SET resolved_at=? WHERE account_id=? AND conflict_key=?').run(now,accountId,row.conflict_key);
  }
}
