import type { CsfloatListingItem, MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CsfloatStore, type CsfloatOperation } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { ActionRow, ObservationRow } from '../db/database.js';
import { TransferStore } from '../db/transfers.js';
import { attemptReturned, locationEvidence, postAttempt, type ProofNeed, type Surface } from '../kernel/evidence.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { HoldingsStore } from '../db/holdings.js';
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
import type { Observe } from './refresh.js';

export type CsfloatSellingServices = { listings: CsfloatListingService; inventory: CsfloatInventoryService; trades: CsfloatTradeService;
  csfloatAccount: CsfloatAccountService; steamInventory: InventoryService; steamMarket: MarketService; steamTrades: TradeService; policy: CsfloatSellingPolicy;
  /** Sends and resolves the retrieve a crated member starts with. */
  storage: StorageService;
  /** Settles on the caller's stack when a decision follows the driver's own read. */
  settle: Settling;
  /** The governed read (`RefreshService.observe`): the budget, the breaker, then the settle. */
  observe: Observe;
  /** `RefreshService.ensureFresh`: reads a surface only when its own window has lapsed, and waits for it. */
  ensureFresh: (accountId: string, surfaces: readonly Surface[]) => Promise<void>;
  /** `RefreshService.readNow`: one read now, through the read budget and the breaker, fresh or not. */
  readNow: (accountId: string, surface: Surface) => Promise<boolean> };

/** The shortest sleep of the wait for CSFloat, so a refused read can never spin. */
const MIN_TURN_MS = 5_000;

export class CsfloatSellingService {
  protected readonly store: CsfloatStore;
  /** One `advance` per account at a time; a second asked for meanwhile waits and re-reads. */
  private readonly advancing = new AccountLock();
  private readonly scheduled = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  /** At most one wait for CSFloat per account, however many operations are waiting. */
  private readonly waits = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatSellingServices) { this.store = new CsfloatStore(context.database); }

  async refresh(accountId: string, eligibility = false): Promise<void> {
    // Account-wide books through the read budget (plan D4). A single listing's own read below is
    // not a loop surface and stays direct.
    const read = (surface: Surface) => this.services.observe(accountId, { surface, scope: { kind: 'account' } });
    await read('csfloat-account-status');
    await read('csfloat-stall');
    await read('csfloat-trades');
    const missing = this.context.database.raw().prepare(`SELECT c.listing_id FROM csfloat_contract c WHERE c.account_id=?
      AND c.state NOT IN ('delisted','cancelled','refunded') AND NOT EXISTS (SELECT 1 FROM csfloat_listing l WHERE l.account_id=c.account_id AND l.listing_id=c.listing_id) LIMIT 250`)
      .all(accountId) as Array<{ listing_id: string }>;
    for (const row of missing) await this.services.listings.syncListing(accountId,row.listing_id);
    if (eligibility) {
      for (const surface of ['gc-inventory', 'steam-market', 'steam-trade-inventory', 'steam-trade-offers', 'csfloat-inventory'] as const) await read(surface);
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
   * journal without reading anything.
   *
   * **The reply is the admission, not the send.** What comes back is the durable record — every
   * member `QUEUED`, its action `READY` — and the send happens behind it, through `advance`. The
   * desktop used to hold its request open through the send and a stall walk after it, which for
   * CSFloat meant the Game Coordinator, the post and the walk before a person saw anything move;
   * a listing now shows on the work panel as queued the moment this returns, the way a Steam
   * command does through `CommandService.prepare`. A refusal still comes back here, because
   * admission is still here.
   */
  async submit(request: CsfloatSellRequest): Promise<CsfloatOperation[]> {
    const admitted = this.context.database.raw().prepare('SELECT 1 FROM csfloat_operation WHERE command_id=? LIMIT 1').get(request.commandId);
    if (!admitted) {
      for (const accountId of new Set(request.members.map(member => member.accountId))) {
        await this.services.ensureFresh(accountId, CSFLOAT_LIST_EVIDENCE);
      }
    }
    const operations = this.queue(request);
    for (const accountId of new Set(operations.map(op => op.account_id))) this.schedule(accountId);
    return operations;
  }

  /**
   * A reprice or a cancel, the same way: the listing is read again first, because `validateEdit`
   * judges the contract's own observation and refuses one older than its window, then it is
   * queued and sent behind the reply.
   */
  async submitEdit(accountId: string, commandId: string, listingId: string, priceCents?: number): Promise<CsfloatOperation> {
    if (!this.store.operation(commandId)) await this.services.listings.syncListing(accountId,listingId);
    const op = this.queueEdit(accountId,commandId,listingId,priceCents);
    this.schedule(accountId);
    return op;
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
   * Every operation of this account that was admitted and never sent, sent once each, in order.
   *
   * This is `CommandService.resume` for a CSFloat operation, and holds to the same rule: it
   * resumes by *identity*, never by retry. `QUEUED` with a `READY` action means no mutation has
   * ever been attempted for it, so sending is safe; anything past that is `execute`'s own guard
   * and is settled by observation alone (rule 1, `CSF-17`). Nothing here re-sends.
   *
   * It is what `submit` hands the send to, and what a reattaching session runs, so an operation
   * queued in a run that died before it got to the send is sent by the next one — the gap the
   * desktop's inline send used to leave open, since nothing but that one call ever looked at a
   * queued operation.
   *
   * A venue with no credential on this account is not an error: the operation waits, and the
   * next connection schedules it. A refusal at the send is `execute`'s to record, durably, on the
   * operation itself. Anything else thrown reaches Activity and leaves the operation queued, still
   * never sent, for the next pass.
   *
   * A member admitted from a storage unit gets here twice more first: `advanceRetrievals` sends
   * and settles its retrieve, and `awaitVisibility` holds it until CSFloat's own read shows the
   * item, at which point it is an ordinary queued create.
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
      const queued = db.raw().prepare(`SELECT o.id AS id FROM csfloat_operation o JOIN action a ON a.id=o.action_id
        WHERE o.account_id=? AND o.state='QUEUED' AND a.state='READY' AND o.kind IN ('CREATE','REPRICE','CANCEL') ORDER BY o.id`).all(accountId) as Array<{ id: string }>;
      for (const { id } of queued) {
        if (this.stopped) return;
        try {
          await this.execute(id);
        } catch (error) {
          if (this.stopped) return;
          // A refusal at admission is already on the operation; a second copy would be noise.
          if (this.store.operation(id)?.state === 'FAILED') continue;
          try { db.addEvent(accountId,'csfloat-dispatch-error',{ operationId: id, message: errorMessage(error) },this.context.now()); } catch { /* closed under us */ }
          continue;
        }
        // The listing the edit was about, read again, so a cancel can be proved: the stall no
        // longer holds it, and only the listing's own read says whether that is because it was
        // delisted. This is the first such read, not the only one: until one settles it the
        // refresh loop keeps reading (`needs`). A create is proved by the stall walk
        // `mutation-settled` asks for.
        const op = this.store.operation(id);
        if (op?.listing_id && op.kind !== 'CREATE') await this.services.listings.syncListing(accountId,op.listing_id).catch(() => undefined);
      }
    });
    this.running.set(accountId,work);
    try { await work; } finally { if (this.running.get(accountId) === work) this.running.delete(accountId); }
  }

  /**
   * Every send this command asked for, as something a caller can wait for.
   *
   * The desktop never does — the operation is a durable receipt and the window reads `work.open`
   * — but a scenario has to, and sleeping asserts nothing. `CommandService.settled` is the
   * precedent, for the same reason.
   */
  async settled(commandId: string): Promise<void> {
    const accounts = (this.context.database.raw().prepare('SELECT DISTINCT account_id FROM csfloat_operation WHERE command_id=?').all(commandId) as Array<{ account_id: string }>)
      .map(row => row.account_id);
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
   * Admission: one operation per unit, all of them or none.
   *
   * A group member becomes that many operations, one per unit the engine picks (`pickUnits`), so
   * a replay is judged against the terms asked for — account, price, and the item or the group —
   * never against which units were picked, which the first admission itself changed.
   */
  queue(request: CsfloatSellRequest): CsfloatOperation[] {
    const { database: db } = this.context;
    for (const member of request.members) {
      if ('stackKey' in member && (!Number.isSafeInteger(member.quantity) || member.quantity < 1)) throw new Error('A group member needs a positive whole quantity');
    }
    const terms = request.members.flatMap((member): Array<CsfloatSellMember | CsfloatSellGroupMember> =>
      'stackKey' in member ? Array.from({ length: member.quantity }, () => member) : [member]);
    if (!request.members.length || terms.length > CSFLOAT_LIST_LIMIT) throw new Error(`Select between 1 and ${CSFLOAT_LIST_LIMIT} items`);
    return db.transaction(() => {
      const existing = db.raw().prepare('SELECT * FROM csfloat_operation WHERE command_id=? ORDER BY id').all(request.commandId) as CsfloatOperation[];
      if (existing.length) {
        if (existing.length !== terms.length || terms.some((m,i) => {
          const op = existing.find(o => o.id === `${request.commandId}:${i}`);
          return !op || op.kind !== 'CREATE' || op.account_id !== m.accountId || op.price_cents !== m.priceCents
            || ('stackKey' in m ? db.itemByLocalId(op.account_id,op.local_id ?? '')?.group_key !== m.stackKey : op.local_id !== m.localId);
        })) throw new Error('Command id was already used for different terms');
        return existing;
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
      return frozen.map((member,i) => this.insert({ id: `${request.commandId}:${i}`, commandId: request.commandId, accountId: member.accountId,
        localId: member.localId, assetId: member.assetId, priceCents: member.priceCents, kind: 'CREATE',
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
      .filter(unit => unit.location === 'MAIN' && unit.current_asset_id && !unit.reserved_command && !excluded(unit.local_id));
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

  queueEdit(accountId: string, commandId: string, listingId: string, priceCents?: number): CsfloatOperation {
    const kind = priceCents === undefined ? 'CANCEL' : 'REPRICE';
    return this.context.database.transaction(() => {
      const existing = this.store.operation(commandId);
      if (existing) {
        if (existing.account_id !== accountId || existing.listing_id !== listingId || existing.kind !== kind || existing.price_cents !== (priceCents ?? null)) throw new Error('Command id was already used for different terms');
        return existing;
      }
      this.validateEdit(accountId,listingId,priceCents);
      const listing = this.store.contract(accountId,listingId)!;
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
    if (!this.context.database.raw().prepare('SELECT 1 FROM csfloat_listing WHERE account_id=? AND listing_id=?').get(accountId,listingId)) throw new Error('Listing is no longer in the authenticated own book');
    if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 3)) throw new Error('CSFloat listing price must be at least 3 USD cents');
  }

  private insert(input: { id: string; commandId: string; accountId: string; localId: string | null; assetId: string | null;
    listingId?: string; priceCents: number | null; kind: string; casketId?: string }): CsfloatOperation {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(input.accountId,'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    const goal = db.upsertDesired({ accountId: input.accountId, targetKind: 'csfloat-operation', targetId: input.id,
      intent: input.kind, params: { venue: 'csfloat', priceCents: input.priceCents }, basis: 'manual', now });
    if (input.casketId) {
      // The retrieve is a hop of this goal, as the Steam chain's is of its listing goal: an
      // `item-location` goal of its own would read the later sale as someone moving the item.
      // No create action yet — it would hold `item:<localId>` against the retrieve — so
      // `action_id` stays empty until CSFloat has seen the item (`awaitVisibility`).
      const retrieve = db.enqueueAction({ accountId: input.accountId, desiredId: goal.id, desiredVersion: goal.version,
        actionKind: 'RETRIEVE_FROM_CASKET', targetId: input.localId!, resourceKey: `item:${input.localId}`,
        params: { casketId: input.casketId, assetId: input.assetId }, now });
      db.reserveMainSlot(input.accountId,retrieve.id);
      db.raw().prepare(`INSERT INTO csfloat_operation(id,command_id,account_id,kind,local_id,asset_id,listing_id,price_cents,generation,policy_version,state,action_id,created_at,updated_at,retrieve_action_id)
        VALUES (?,?,?,?,?,?,NULL,?,?,?,'RETRIEVING',NULL,?,?,?)`).run(input.id,input.commandId,input.accountId,input.kind,input.localId,input.assetId,
        input.priceCents,connection.generation,this.store.policy().version,now,now,retrieve.id);
      return this.store.operation(input.id)!;
    }
    const action = db.enqueueAction({ accountId: input.accountId, desiredId: goal.id, desiredVersion: goal.version,
      actionKind: `CSFLOAT_${input.kind}`, targetId: input.localId ?? `csfloat-listing:${input.listingId}`,
      resourceKey: input.localId ? `item:${input.localId}` : `csfloat-listing:${input.listingId}`,
      params: { operationId: input.id, assetId: input.assetId, listingId: input.listingId ?? null, priceCents: input.priceCents }, now });
    db.raw().prepare(`INSERT INTO csfloat_operation(id,command_id,account_id,kind,local_id,asset_id,listing_id,price_cents,generation,policy_version,state,action_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?)`).run(input.id,input.commandId,input.accountId,input.kind,input.localId,input.assetId,input.listingId ?? null,
      input.priceCents,connection.generation,this.store.policy().version,action.id,now,now);
    return this.store.operation(input.id)!;
  }

  async execute(id: string): Promise<MutationOutcome | null> {
    const initial = this.store.operation(id);
    if (!initial) throw new Error('Unknown CSFloat operation');
    return this.context.locks.run(initial.account_id,async () => {
      const op = this.store.operation(id)!, db = this.context.database, action = op.action_id ? db.action(op.action_id) : undefined;
      if (!action || action.state !== 'READY' || op.state !== 'QUEUED') return null;
      const connection = new MarketplaceStore(db).connection(op.account_id,'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const validate = () => {
        const current = new MarketplaceStore(db).connection(op.account_id,'csfloat');
        if (current?.generation !== op.generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the listing command');
        if (op.kind === 'CREATE') {
          const asset = this.services.policy.validate({ accountId: op.account_id,localId: op.local_id!,priceCents: op.price_cents! },op.id);
          if (asset !== op.asset_id) throw new Error('Item asset changed; submit a new selection');
        } else this.validateEdit(op.account_id,op.listing_id!,op.kind === 'REPRICE' ? op.price_cents! : undefined);
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      let outcome: MutationOutcome;
      try {
        outcome = await executeMutation(this.context,action, () => op.kind === 'CREATE'
          ? ports.listings.create(op.account_id,connection.credential_ref!,op.asset_id!,op.price_cents!)
          : op.kind === 'REPRICE' ? ports.listings.reprice(op.account_id,connection.credential_ref!,op.listing_id!,op.price_cents!)
            : ports.listings.cancel(op.account_id,connection.credential_ref!,op.listing_id!),admit);
      } catch (error) {
        // Admission refused before any call: the command is over, durably (XLIST-11). Nothing
        // re-queues it when the setting, the connection or the network changes.
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),rejected.message);
          this.store.update(op.id,'FAILED',this.context.now(),rejected.message);
        });
        throw error;
      }
      this.store.update(op.id,outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION',this.context.now(),outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
      return outcome;
    });
  }

  // --- listing from a storage unit ------------------------------------------------------------

  /**
   * The retrieve stage of every crated member on this account.
   *
   * A `READY` retrieve is sent. One in flight is resolved only by the storage reconciler, from a
   * complete walk that started after the attempt (rule 1). A `DONE` one moves the operation to
   * waiting for CSFloat, anchored on the observation that resolved it. Isolated so a saboteur can
   * skip the observation.
   */
  protected async advanceRetrievals(accountId: string): Promise<void> {
    const db = this.context.database;
    const ops = this.operationsIn(accountId,'RETRIEVING');
    if (!ops.length) return;
    if (ops.some(op => op.retrieve_action_id && db.action(op.retrieve_action_id)?.state === 'AWAITING_OBSERVATION')) this.services.settle.settleNow(accountId);
    for (const { id } of ops) {
      if (this.stopped) return;
      const op = this.store.operation(id)!;
      const retrieve = op.retrieve_action_id ? db.action(op.retrieve_action_id) : undefined;
      if (!retrieve) { this.failOperation(op,'Retrieve action is missing; review the listing'); continue; }
      if (retrieve.state === 'FAILED') { this.failRetrieve(op,retrieve.error ?? 'no reason given'); continue; }
      if (retrieve.state === 'READY') { await this.sendRetrieve(op,retrieve); continue; }
      if (retrieve.state === 'DONE') this.startWaiting(op,retrieve);
      // RUNNING or AWAITING_OBSERVATION: the next complete walk schedules another pass.
    }
  }

  private async sendRetrieve(op: CsfloatOperation, retrieve: ActionRow): Promise<void> {
    const db = this.context.database, accountId = op.account_id;
    // No session, no send; the session coming up schedules the next pass.
    if (this.context.ports.gc.connectionStatus(accountId).state !== 'CONNECTED') return;
    // The retrieve's own admission wants the unit and main inventory freshly walked. Admission read
    // them moments ago; a restart may not have.
    const { casketId } = db.actionParams(retrieve) as { casketId: string };
    if (locationEvidence(db,accountId,op.local_id!,'CASKET',this.context.ports.clock.now()).grade !== 'SATISFIED') {
      await this.services.observe(accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: casketId } });
    }
    await this.services.ensureFresh(accountId,['gc-inventory']);
    let outcome: MutationOutcome;
    try {
      outcome = await this.context.locks.run(accountId,() => this.services.storage.execute(retrieve.id));
    } catch (error) {
      // Refused before any call: nothing was sent, so the listing is over (XLIST-11's rule).
      if (db.action(retrieve.id)?.state === 'READY') this.failRetrieve(op,errorMessage(error));
      return;
    }
    if (outcome.kind === 'DEFINITIVELY_REJECTED') { this.failRetrieve(op,outcome.reason); return; }
    db.markSlotSubmitted(accountId,retrieve.id);
  }

  /** The retrieve was proved: the item is loose, and the ten minutes start from that proof. */
  private startWaiting(op: CsfloatOperation, retrieve: ActionRow): void {
    const db = this.context.database, now = this.context.now();
    const loose = db.observation(op.account_id,retrieve.resolved_by_obs);
    if (!loose) { this.failOperation(op,'Retrieve was resolved without an observation; review the listing'); return; }
    const deadline = new Date(Date.parse(loose.started_at)+VISIBILITY_DEADLINE_MS).toISOString();
    db.transaction(() => {
      this.store.stampLoose(op.id,loose.id,deadline,now);
      db.addEvent(op.account_id,'csfloat-visibility-wait',{ operationId: op.id, localId: op.local_id, assetId: op.asset_id, looseAt: loose.started_at, deadline },now);
    });
  }

  /**
   * Every operation of this account whose item is loose and not yet seen by CSFloat.
   *
   * The deadline is judged first, from the stored column, so a restart judges the same instant
   * and a wait that ran out while the app was closed fails without a read. Then the latest
   * CSFloat read: only one that started after the item was proved loose can say anything about it
   * (`venueSees`). Seen, the operation gets its create and joins the ordinary path; not yet, the
   * account's one wait loop is armed.
   */
  protected async awaitVisibility(accountId: string): Promise<void> {
    const db = this.context.database;
    let waiting = false;
    for (const { id } of this.operationsIn(accountId,'AWAITING_VENUE')) {
      if (this.stopped) return;
      const op = this.store.operation(id)!;
      const loose = db.observation(accountId,op.loose_obs);
      if (!loose || !op.visibility_deadline_at) { this.failOperation(op,'The retrieve\'s observation is missing; review the listing'); continue; }
      if (this.context.now() >= op.visibility_deadline_at) { this.timeOut(op,loose); continue; }
      if (db.itemByLocalId(accountId,op.local_id!)?.current_asset_id !== op.asset_id) { this.failOperation(op,'Item asset changed; submit a new selection'); continue; }
      if (!this.venueSees(op,loose)) { waiting = true; continue; }
      await this.attachCreate(op,loose);
    }
    if (waiting) this.armVisibility(accountId);
  }

  /** CSFloat's latest complete read, taken after the item was proved loose, shows this exact item tradable. */
  protected venueSees(op: CsfloatOperation, loose: ObservationRow): boolean {
    const db = this.context.database;
    const latest = db.latestObservation(op.account_id,'csfloat-inventory');
    if (!latest?.complete || latest.error || latest.generation !== op.generation || latest.id <= loose.id || latest.started_at < loose.started_at) return false;
    const row = db.raw().prepare('SELECT item_json,observation_id FROM csfloat_inventory WHERE account_id=? AND asset_id=?').get(op.account_id,op.asset_id) as { item_json: string; observation_id: number } | undefined;
    if (!row || row.observation_id !== latest.id) return false;
    const item = JSON.parse(row.item_json) as CsfloatListingItem;
    return item.tradable === 1 && this.store.associate(op.account_id,item) === op.local_id;
  }

  /**
   * CSFloat has seen it: the create action, and the operation is an ordinary queued create.
   *
   * Everything `validate` judges is read again first where it may have lapsed during the wait —
   * otherwise the send's admission turns a ten-minute-old read into a permanent refusal — and
   * Steam's trade inventory is read again if the walk on record predates the retrieve, because
   * that walk could not see the item at all.
   */
  private async attachCreate(op: CsfloatOperation, loose: ObservationRow): Promise<void> {
    const db = this.context.database, accountId = op.account_id;
    const steam = new TransferStore(db).fresh(accountId,'steam-trade-inventory',this.context.now());
    if (!steam || steam.id <= loose.id || steam.started_at < loose.started_at) await this.services.steamTrades.syncEligibility(accountId);
    await this.services.ensureFresh(accountId,CSFLOAT_LIST_EVIDENCE);
    try {
      db.transaction(() => {
        const current = this.store.operation(op.id);
        if (current?.state !== 'AWAITING_VENUE') return;
        const goal = db.currentDesiredState(accountId,'csfloat-operation',op.id);
        if (!goal) throw new Error('The listing goal was replaced; review the listing');
        const now = this.context.now();
        const action = db.enqueueAction({ accountId, desiredId: goal.id, desiredVersion: goal.version, actionKind: 'CSFLOAT_CREATE',
          targetId: op.local_id!, resourceKey: `item:${op.local_id}`,
          params: { operationId: op.id, assetId: op.asset_id, listingId: null, priceCents: op.price_cents }, now });
        this.store.attachAction(op.id,action.id,now);
      });
    } catch (error) {
      this.failOperation(op,errorMessage(error));
    }
  }

  /** Ten minutes and CSFloat never showed it. The item stays loose: nothing is stored back. */
  private timeOut(op: CsfloatOperation, loose: ObservationRow): void {
    const db = this.context.database;
    const reads = (db.raw().prepare("SELECT COUNT(*) AS n FROM observation WHERE account_id=? AND surface='csfloat-inventory' AND id>?")
      .get(op.account_id,loose.id) as { n: number }).n;
    db.transaction(() => {
      this.failOperation(op,CSFLOAT_VISIBILITY_TIMEOUT_REASON);
      db.addEvent(op.account_id,'csfloat-visibility-timeout',{ operationId: op.id, localId: op.local_id, assetId: op.asset_id,
        looseAt: loose.started_at, deadline: op.visibility_deadline_at, readsMade: reads },this.context.now());
    });
  }

  private failRetrieve(op: CsfloatOperation, reason: string): void {
    const db = this.context.database;
    db.transaction(() => {
      this.failOperation(op,`Retrieve refused: ${reason}`);
      db.addEvent(op.account_id,'csfloat-retrieve-failed',{ operationId: op.id, localId: op.local_id, assetId: op.asset_id, reason },this.context.now());
    });
  }

  /**
   * An operation that cannot reach its create: failed with the reason, and a retrieve that never
   * moved the item is failed too and gives its slot back. A retrieve that did move it keeps its
   * `DONE`: the item is in main inventory, and that is where it stays.
   */
  private failOperation(op: CsfloatOperation, reason: string): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      const retrieve = op.retrieve_action_id ? db.action(op.retrieve_action_id) : undefined;
      if (retrieve?.state === 'READY') db.setActionState(retrieve.id,'FAILED',now,reason);
      if (retrieve && ['READY','FAILED'].includes(retrieve.state)) db.releaseSlot(op.account_id,retrieve.id,false);
      this.store.update(op.id,'FAILED',now,reason);
    });
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

  /** One read of CSFloat's copy of this account's inventory, for everything waiting on it. */
  protected async readVenue(accountId: string): Promise<void> {
    await this.services.readNow(accountId,'csfloat-inventory');
  }

  /**
   * When this account next reads CSFloat and next hits a deadline. Offsets count from the earliest
   * waiting operation's loose observation, and the next one is the first strictly after the latest
   * CSFloat read of any kind — a failed read still spent the budget, and a read someone else asked
   * for counts too.
   */
  private visibilityTurn(accountId: string): { readAt: number | null; deadline: number } | null {
    const db = this.context.database;
    const ops = this.operationsIn(accountId,'AWAITING_VENUE').filter(op => op.loose_obs !== null && op.visibility_deadline_at !== null);
    if (!ops.length) return null;
    const anchor = Math.min(...ops.map(op => Date.parse(db.observation(accountId,op.loose_obs)?.started_at ?? op.visibility_deadline_at!)));
    const last = db.latestObservation(accountId,'csfloat-inventory');
    const lastRead = last ? Date.parse(last.started_at) : -Infinity;
    const readAt = VISIBILITY_READ_OFFSETS_MS.map(offset => anchor+offset).find(at => at > lastRead) ?? null;
    return { readAt, deadline: Math.min(...ops.map(op => Date.parse(op.visibility_deadline_at!))) };
  }

  private operationsIn(accountId: string, state: 'RETRIEVING' | 'AWAITING_VENUE'): CsfloatOperation[] {
    return this.context.database.raw().prepare("SELECT * FROM csfloat_operation WHERE account_id=? AND state=? AND kind='CREATE' ORDER BY id")
      .all(accountId,state) as CsfloatOperation[];
  }

  /** Called after reads and on restart. It never sends, even when absence is proven. */
  reconcile(accountId: string): void {
    const db = this.context.database;
    for (const op of this.store.operations(accountId)) {
      if (!['CREATE','REPRICE','CANCEL'].includes(op.kind)) continue;
      if (!['QUEUED','AWAITING_OBSERVATION'].includes(op.state) || !op.action_id) continue;
      const action = db.action(op.action_id);
      if (!action || !['RUNNING','AWAITING_OBSERVATION'].includes(action.state)) continue;
      this.store.update(op.id,'AWAITING_OBSERVATION',this.context.now());
      const candidates = op.listing_id ? [this.store.contract(accountId,op.listing_id)].filter(Boolean)
        : db.raw().prepare('SELECT * FROM csfloat_contract WHERE account_id=? AND (local_id=? OR asset_id=?)').all(accountId,op.local_id,op.asset_id) as ReturnType<CsfloatStore['contract']>[];
      const listing = candidates.length === 1 ? candidates[0] : undefined;
      if (!listing) continue;
      const obs = db.observation(accountId,listing.observation_id);
      if (!obs?.complete || obs.error || obs.generation !== op.generation || !postAttempt(db,action,obs,false)) continue;
      const applied = op.kind === 'CANCEL' ? ['delisted','cancelled'].includes(listing.state)
        : op.kind === 'CREATE' ? ['listed','sold'].includes(listing.state) && listing.price_cents === op.price_cents
          : listing.state === 'listed' && listing.price_cents === op.price_cents;
      if (applied) {
        db.transaction(() => {
          db.resolveAction(action,obs.id,true,this.context.now());
          db.raw().prepare('UPDATE csfloat_operation SET listing_id=? WHERE id=?').run(listing.listing_id,op.id);
          this.store.update(op.id,'DONE',this.context.now());
        });
      } else if (['sold','refunded','delisted','cancelled'].includes(listing.state)) {
        db.setActionState(action.id,'FAILED',this.context.now(),`Observed ${listing.state}; requested operation did not complete`);
        this.store.update(op.id,'FAILED',this.context.now(),`CSFloat listing is ${listing.state}; check sales before using the item`);
      } else if (this.editProvedNotApplied(op,listing,action,obs)) {
        // Failed, never `READY`: `resolveAction` would hand a current goal back to be sent again.
        db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),'complete-observation-proved-not-applied');
          this.store.update(op.id,'FAILED',this.context.now(),op.kind === 'CANCEL'
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
  protected editProvedNotApplied(op: CsfloatOperation, listing: NonNullable<ReturnType<CsfloatStore['contract']>>, action: ActionRow, obs: ObservationRow): boolean {
    if (op.kind === 'CREATE' || listing.state !== 'listed') return false;
    return postAttempt(this.context.database,action,obs,true);
  }

  /**
   * What proves a delist or reprice CSFloat accepted: that listing's own read, begun after the
   * send returned (CSF-45). The stall cannot prove it, because a listing the stall no longer holds
   * may have sold. The refresh loop reads the listing for as long as the operation waits — at
   * once, then on the proof intervals, then on the listing's own cadence — so a read that fails
   * is followed by another rather than by nothing, and a restart reads for it from the record.
   * A create is proved by the stall walk its send nudges, which the stall's cadence repeats.
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
   * refresh ever raises a second row for the same unit.
   */
  /** A foreign duplicate is one durable conflict (XLIST-09). Judged after every read that could show one. */
  observeConflicts(accountId: string): void {
    const db = this.context.database, now = this.context.now();
    const conflicts = db.raw().prepare(`SELECT c.listing_id FROM csfloat_contract c JOIN market_listing s ON s.account_id=c.account_id
      AND (s.local_id=c.local_id OR s.asset_id=c.asset_id) WHERE c.account_id=? AND c.state='listed'
      AND s.status IN ('ACTIVE','ON_HOLD','PENDING_CONFIRMATION')`).all(accountId) as Array<{ listing_id: string }>;
    if (this.store.policy().preventDuplicates) {
      for (const row of conflicts) db.raw().prepare(`INSERT INTO marketplace_conflict(account_id,conflict_key,reason,observed_at) VALUES (?,?,?,?)
        ON CONFLICT(account_id,conflict_key) DO UPDATE SET resolved_at=NULL`).run(accountId,`duplicate:${row.listing_id}`,`Item advertised on Steam and CSFloat (${row.listing_id})`,now);
    }
    const stall = db.latestObservation(accountId,'csfloat-stall'), market = db.latestObservation(accountId,'steam-market');
    if (!stall?.complete || stall.error || !market?.complete || market.error) return;
    const current = new Set(conflicts.map(row => `duplicate:${row.listing_id}`));
    const open = db.raw().prepare(`SELECT conflict_key FROM marketplace_conflict WHERE account_id=? AND resolved_at IS NULL AND conflict_key LIKE 'duplicate:%'`).all(accountId) as Array<{ conflict_key: string }>;
    for (const row of open) if (!current.has(row.conflict_key)) db.raw().prepare('UPDATE marketplace_conflict SET resolved_at=? WHERE account_id=? AND conflict_key=?').run(now,accountId,row.conflict_key);
  }
}
