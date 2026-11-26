import { csfloatListingInEffect, type CsfloatStatedListing, type MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CSFLOAT_LISTING_SURFACE, CsfloatStore, isAnswerObservation, type CsfloatContract } from '../db/csfloat.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { ActionRow, ObservationRow } from '../db/database.js';
import { WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { attemptReturned, attemptWatermark, locationEvidence, postAttempt, type ProofNeed, type Surface, type SurfaceRef } from '../kernel/evidence.js';

/** The listing id a create's answer named, as CSFloat writes one (a digit string); null when the answer named none. */
function namedListingId(answer: Record<string, unknown>): string | null {
  return typeof answer['id'] === 'string' && /^\d+$/.test(answer['id']) ? answer['id'] : null;
}
import { AccountLock, errorMessage } from '../kernel/support.js';
import { priceChangeRefusal } from '../kernel/price-cadence.js';
import { HoldingsStore } from '../db/holdings.js';
import { TransferStore } from '../db/transfers.js';
import { STEAM_LISTED_SQL } from '../db/commitment.js';
import type { CommandAuthority } from '../db/alphabets.js';
import { claimForPerson, strategyRefusal, type AuthorityMember } from '../policy/authority.js';
import {
  CREATE_CLOCK_TOLERANCE_MS, CSFLOAT_INVENTORY_WAIT_REASON, CSFLOAT_LIST_EVIDENCE, CSFLOAT_LIST_LIMIT, CSFLOAT_PERSON_LIST_EVIDENCE, EDIT_EVIDENCE_MARGIN_MS,
  CSFLOAT_VISIBILITY_TIMEOUT_REASON, CsfloatSellingPolicy, INVENTORY_WAIT, isInventoryLag, type InventoryWait,
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
  reads: Reading;
  /**
   * Tells whoever watches the record that a surface changed with no walk of the broker's behind it:
   * a reprice settled on its answer, which no read follows. Absent, nobody is told.
   */
  announce?: (accountId: string, surfaces: readonly string[]) => void;
  /**
   * Has the read loop look again, now, at what this account's waiting work needs read: for a
   * reprice that came out of its send unsettled after the loop had already looked. Absent, the
   * loop finds it on its next turn.
   */
  reconsider?: (accountId: string) => void };

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
  /** A reprice a person asked for inside the price-change interval (`kernel/price-cadence.ts`): recorded as the decision it was. */
  force?: true;
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
  /** Each account's one timer for its wait on CSFloat: when it fires, and which arming set it. */
  private readonly waits = new Map<string, { at: number; generation: number }>();
  private waitGeneration = 0;
  /** The reprices whose answer this run is still judging: nothing reads for one meanwhile (`needs`). */
  private readonly judging = new Set<string>();
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
      // A person's list reads past the holds, as their Refresh does, and reads CSFloat's own copy of
      // the inventory too when the last complete read is older than its window, so an item CSFloat
      // stopped holding is refused while they look (CSF-23). A strategy's waits the holds out like
      // any other work and never reads that copy, whose reads are 120 a day (CSF-58).
      const strategy = request.authority === 'STRATEGY';
      for (const accountId of new Set(request.members.map(member => member.accountId))) {
        await this.services.reads.ensureFresh(accountId, strategy ? CSFLOAT_LIST_EVIDENCE : CSFLOAT_PERSON_LIST_EVIDENCE, strategy ? 'work' : 'person');
      }
    }
    const steps = this.queue(request);
    for (const accountId of new Set(steps.map(step => step.account_id))) this.schedule(accountId);
    return steps;
  }

  /**
   * A reprice or a cancel, the same way: `validateEdit` judges the contract's own observation and
   * refuses one older than its window, so the listing is read again first unless the record already
   * holds a read young enough for the send too (`editEvidenceFresh`, CSF-57); then it is queued and
   * sent behind the reply.
   */
  async submitEdit(accountId: string, commandId: string, listingId: string, priceCents?: number, force = false, authority: CommandAuthority = 'HUMAN'): Promise<WorkStepRow> {
    if (!this.work.step(commandId) && !this.editEvidenceFresh(accountId, listingId)) await this.listing(accountId, listingId, 'person');
    const step = this.queueEdit(accountId,commandId,listingId,priceCents,force,authority);
    this.schedule(accountId);
    return step;
  }

  /**
   * Whether the record already holds what admission and the send judge a reprice or delist on: the
   * listing up at a fixed price, in a contract a complete read of the current connection wrote,
   * begun no more than `EDIT_EVIDENCE_MARGIN_MS` ago. A stall walk writes every listing's contract
   * under its own observation, so an edit decided on a fresh walk needs no read of its own before
   * it is admitted. Before CSF-57 every edit read its listing first: a pass of many reprices
   * each waited for one, a CSFloat listing read every five seconds, minutes ahead of every
   * delivery's reads (measured 2026-11-02). Isolated so a saboteur can read every time.
   */
  protected editEvidenceFresh(accountId: string, listingId: string): boolean {
    const listing = this.store.contract(accountId, listingId);
    const observation = listing && this.context.database.observation(accountId, listing.observation_id);
    const connection = new MarketplaceStore(this.context.database).connection(accountId, 'csfloat');
    if (!listing || listing.type !== 'buy_now' || listing.state !== 'listed' || !observation?.complete || observation.error
      || connection?.status !== 'CONNECTED' || observation.generation !== connection.generation) return false;
    const age = Date.parse(this.context.now()) - Date.parse(observation.started_at);
    return age >= 0 && age <= EDIT_EVIDENCE_MARGIN_MS;
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
   * and settles its retrieve, and `awaitVisibility` makes its listing hop an ordinary queued create
   * once the item is loose. A listing CSFloat refused because its copy of the inventory lags waits
   * as `RETRYING`, and `resumeVenueWaits` gives it a fresh action when its moment comes; it is sent
   * here like any queued one.
   */
  async advance(accountId: string): Promise<void> {
    const work = this.advancing.run(accountId,async () => {
      const db = this.context.database;
      if (!new MarketplaceStore(db).connection(accountId,'csfloat')?.credential_ref || !this.context.ports.csfloat) return;
      for (const stage of [() => this.advanceRetrievals(accountId), () => this.awaitVisibility(accountId), () => this.resumeVenueWaits(accountId)]) {
        if (this.stopped) return;
        try { await stage(); } catch (error) {
          if (this.stopped) return;
          try { db.addEvent(accountId,'csfloat-dispatch-error',{ message: errorMessage(error) },this.context.now()); } catch { /* closed under us */ }
        }
      }
      const queued = this.work.openOf(accountId, CSFLOAT_LISTING_KINDS, CSFLOAT_LISTING_KINDS)
        .filter(step => (step.state === 'QUEUED' || step.state === 'RETRYING') && step.action_id !== null && db.action(step.action_id)?.state === 'READY');
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
        // The listing the hop is about, read again, so it can be proved: for a cancel the stall no
        // longer holds it, and only the listing's own read says whether that is because it was
        // delisted; for a create, the listing the answer named. This is the first such read, not
        // the only one: until one settles an edit the refresh loop keeps reading (`needs`), and a
        // create is also proved by the stall walk `mutation-settled` asks for, which its cadence repeats.
        // A reprice its answer settled is read for by nothing: the answer was the observation.
        const step = this.work.step(id);
        if (step?.target_id && !this.settledOnAnswer(step)) await this.listing(accountId, step.target_id, 'work');
      }
    });
    this.running.set(accountId,work);
    try { await work; } finally { if (this.running.get(accountId) === work) this.running.delete(accountId); }
  }

  /** One listing's own read, begun now: the proof a delist needs, and a reprice whose answer settled nothing (CSF-45, CSF-72). */
  private async listing(accountId: string, listingId: string, priority: 'person' | 'work'): Promise<void> {
    await this.services.reads.need(accountId, { ref: { surface: CSFLOAT_LISTING_SURFACE, scope: { kind: 'item', id: listingId } }, startedAfter: this.context.now(), priority });
  }

  /**
   * Whether a hop was settled on its send's own answer: the observation it carries is one no read
   * made (`isAnswerObservation`). Such a hop is read for by nothing. Isolated so a saboteur can
   * read the listing after every reprice all the same, as the send did before CSF-70.
   */
  protected settledOnAnswer(step: WorkStepRow): boolean {
    return isSettled(step) && isAnswerObservation(this.context.database.observation(step.account_id, step.observation_id));
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
      const refusal = this.authorityProblem(request.authority, false, request.members.map(member => 'localId' in member
        ? { accountId: member.accountId, localId: member.localId } : { accountId: member.accountId, stackKey: member.stackKey }));
      if (refusal) throw new Error(refusal);
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
      this.work.adoptCommand(request.commandId, CSFLOAT_CREATE, this.context.now(), request.authority ?? 'HUMAN');
      const steps = frozen.map((member,i) => this.insert({ id: `${request.commandId}:${i}`, commandId: request.commandId, accountId: member.accountId,
        localId: member.localId, assetId: member.assetId, priceCents: member.priceCents, kind: CSFLOAT_CREATE,
        ...(member.casketId ? { casketId: member.casketId } : {}) }));
      claimForPerson(db, request.authority, request.commandId, frozen, this.context.now());
      return steps;
    });
  }

  /**
   * Why a strategy may not send this listing work (strategy authority and confirmations plan D3), or
   * `null`; a person's is never refused here. Isolated so a saboteur can let a strategy act on a
   * listing a person made.
   */
  protected authorityProblem(authority: CommandAuthority | undefined, force: boolean, members: readonly AuthorityMember[]): string | null {
    return strategyRefusal(this.context.database, { authority, force, members });
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

  queueEdit(accountId: string, commandId: string, listingId: string, priceCents?: number, force = false, authority: CommandAuthority = 'HUMAN'): WorkStepRow {
    const kind = priceCents === undefined ? CSFLOAT_CANCEL : CSFLOAT_REPRICE;
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        const params = this.paramsOf(existing);
        if (existing.account_id !== accountId || existing.target_id !== listingId || existing.kind !== kind || params.priceCents !== (priceCents ?? null)) throw new Error('Command id was already used for different terms');
        return existing;
      }
      // Whose the listing's holding is comes first: a strategy refused here is refused whatever the listing's read says.
      const refusal = this.authorityProblem(authority, force, [{ accountId, localId: this.store.contract(accountId,listingId)?.local_id ?? undefined }]);
      if (refusal) throw new Error(refusal);
      this.validateEdit(accountId,listingId,priceCents,force);
      const listing = this.store.contract(accountId,listingId)!;
      this.work.adoptCommand(commandId, kind, this.context.now(), authority);
      const step = this.insert({ id: commandId, commandId, accountId, localId: listing.local_id, assetId: listing.asset_id, listingId,
        priceCents: priceCents ?? null, kind, ...(kind === CSFLOAT_REPRICE && force ? { force: true as const } : {}) });
      claimForPerson(this.context.database, authority, commandId, [{ accountId, localId: listing.local_id ?? undefined }], this.context.now());
      return step;
    });
  }

  protected validateEdit(accountId: string, listingId: string, priceCents?: number, force = false): void {
    const listing = this.store.contract(accountId,listingId);
    const observation = listing && this.context.database.observation(accountId,listing.observation_id);
    const connection = new MarketplaceStore(this.context.database).connection(accountId,'csfloat');
    const age = observation ? Date.parse(this.context.now())-Date.parse(observation.started_at) : NaN;
    if (connection?.status !== 'CONNECTED' || !listing || listing.type !== 'buy_now' || listing.state !== 'listed'
      || !observation?.complete || observation.generation !== connection.generation || !(age >= 0 && age <= 300_000)) throw new Error('Refresh this active fixed-price CSFloat listing first');
    // A listing must have been in the authenticated own book; public known-id lookup cannot confer authority.
    if (!this.store.inStall(accountId,listingId)) throw new Error('Listing is no longer in the authenticated own book');
    if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 3)) throw new Error('CSFloat listing price must be at least 3 USD cents');
    // The price-change cadence (`kernel/price-cadence.ts`): the last change is the last reprice of
    // this listing that ended done, and a listing never repriced may change now.
    if (priceCents !== undefined) {
      const cadence = priceChangeRefusal({ venue: 'csfloat', lastChangedAt: this.store.lastPriceChangeAt(accountId,listingId), currentCents: listing.price_cents,
        requestedCents: priceCents, now: this.context.now(), force });
      if (cadence) throw new Error(cadence);
    }
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
    listingId?: string; priceCents: number | null; kind: CsfloatListingKind; casketId?: string; force?: true }): WorkStepRow {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(input.accountId,'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    const params: CsfloatListingStepParams = { operationId: input.id, assetId: input.assetId, listingId: input.listingId ?? null, priceCents: input.priceCents,
      generation: connection.generation, policyVersion: this.store.policy().version, ...(input.force ? { force: true as const } : {}) };
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
      // `RETRYING` with a `READY` action is a listing waiting on CSFloat whose moment came (`resumeVenueWaits`).
      if (!action || action.state !== 'READY' || !['QUEUED','RETRYING'].includes(step.state) || !(CSFLOAT_LISTING_KINDS as readonly string[]).includes(step.kind)) return null;
      const params = this.paramsOf(step);
      const connection = new MarketplaceStore(db).connection(step.account_id,'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const validate = () => {
        const current = new MarketplaceStore(db).connection(step.account_id,'csfloat');
        if (current?.generation !== params.generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the listing command');
        if (step.kind === CSFLOAT_CREATE) {
          const asset = this.services.policy.validate({ accountId: step.account_id,localId: step.local_id!,priceCents: params.priceCents! },step.id);
          if (asset !== params.assetId) throw new Error('Item asset changed; submit a new selection');
        } else this.validateEdit(step.account_id,step.target_id!,step.kind === CSFLOAT_REPRICE ? params.priceCents! : undefined,params.force ?? false);
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      let outcome: MutationOutcome;
      // From the moment a reprice's answer is recorded until it is judged below, its action awaits
      // observation in the record. Nothing may read the listing for it in between (`needs`).
      if (step.kind === CSFLOAT_REPRICE) this.judging.add(action.id);
      try {
        outcome = await executeMutation(this.context,action, async () => step.kind === CSFLOAT_CREATE
          ? this.inventoryWait(step, await ports.listings.create(step.account_id,connection.credential_ref!,params.assetId!,params.priceCents!))
          : step.kind === CSFLOAT_REPRICE ? ports.listings.reprice(step.account_id,connection.credential_ref!,step.target_id!,params.priceCents!)
            : ports.listings.cancel(step.account_id,connection.credential_ref!,step.target_id!),admit);
        if (step.kind === CSFLOAT_REPRICE) this.settleOnAnswer(step, action, outcome);
      } catch (error) {
        // Admission refused before any call: the command is over, durably (XLIST-11). Nothing
        // re-queues it when the setting, the connection or the network changes.
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id,'FAILED',this.context.now(),rejected.message);
          this.work.settle(step.id,'FAILED',null,this.context.now(),rejected.message);
        });
        throw error;
      } finally {
        this.judging.delete(action.id);
        if (step.kind === CSFLOAT_REPRICE) this.lookAgain(step.account_id, action.id);
      }
      // A read can prove the hop while the send's answer is still on its way back here: the refresh
      // loop reads for a hop the moment its action awaits observation, and `reconcile` settles both
      // together. The answer never takes back what a read already settled; before this a reprice
      // proved in the same second as its send was set waiting again for good, its action already
      // done (CSF-47, once an edit no longer read its listing before admission, CSF-57). A reprice
      // its own answer settled a few lines up is settled the same way: nothing below touches it.
      const settledMeanwhile = ['DONE','FAILED','STOPPED'].includes(this.work.step(step.id)?.state ?? '');
      if (!settledMeanwhile) {
        const now = this.context.now();
        const waits = step.kind === CSFLOAT_CREATE && outcome.kind === 'DEFINITIVELY_REJECTED' && outcome.retryAfterMs !== undefined;
        if (waits && isInventoryLag(outcome)) {
          // CSFloat's copy has not caught up. The hop waits, with the moment of the next send on the
          // attempt, and its deadline set once, at the first refusal (CSF-58).
          this.work.update(step.id,{ state: 'RETRYING', reason: CSFLOAT_INVENTORY_WAIT_REASON,
            deadline_at: step.deadline_at ?? new Date(Date.parse(now)+this.waitOf(step).deadlineMs).toISOString() },now);
          this.armVisibility(step.account_id);
        } else if (waits) {
          // A 429: nothing was processed, and the venue named when the same request may go again.
          this.work.update(step.id,{ state: 'RETRYING', reason: outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null },now);
          this.armVisibility(step.account_id);
        } else if (step.kind === CSFLOAT_CREATE && isInventoryLag(outcome)) {
          // The last send the schedule allows, refused like the rest.
          this.timeOut(this.work.step(step.id)!);
        } else {
          this.work.setState(step.id,outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION',now,outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
        }
      }
      if (step.kind === CSFLOAT_CREATE && outcome.kind === 'SUBMITTED') this.noteNamedListing(step,action);
      return outcome;
    });
  }

  /**
   * A reprice CSFloat answered with the listing as it now is, settled on that answer (CSF-70).
   *
   * An answer that returns the object as it now is, is an observation of it (rule 1). So the
   * listing's price and state as the answer stated them are recorded as the listing's own read is,
   * under an observation whose source is the answer (`CsfloatStore.recordAnswer`), and the hop is
   * judged on it at once by the very rules a read is judged by (`judge`): listed at the price sent,
   * it is done; sold in the same call, it ends as a listing read as sold ends it. Both writes and
   * the verdict are one transaction, and no read of the listing is asked for.
   *
   * Every other answer settles nothing here, and the listing's own read decides as it always did:
   * no answer, a bare acknowledgement, another listing, another price, a state that is neither
   * `listed` nor `sold`, a connection that changed while the call was out. So does a run that died
   * before this line: the action it left recovers awaiting observation (rule 6), and its read is
   * the proof.
   */
  private settleOnAnswer(step: WorkStepRow, action: ActionRow, outcome: MutationOutcome): void {
    const db = this.context.database, accountId = step.account_id;
    const stated = this.answered(step, outcome);
    const attempt = db.latestAttempt(action.id);
    const generation = this.paramsOf(step).generation;
    if (!stated || !attempt?.finished_at || new MarketplaceStore(db).connection(accountId,'csfloat')?.generation !== generation) return;
    const observationId = db.transaction(() => {
      const current = this.work.step(step.id);
      // A read may have settled it while the answer was on its way back; then the read stands.
      if (!current || isSettled(current)) return null;
      const id = this.store.recordAnswer(accountId, stated, generation, attempt.started_at, attempt.finished_at!);
      if (id !== null) this.judge(current);
      return id;
    });
    if (observationId === null) return;
    // After the commit, as every observation is announced: the settler owes the account a settle,
    // and whoever watches the record learns the listing changed, though no walk will say so.
    this.context.signals.emit({ kind: 'observed', accountId, surface: CSFLOAT_LISTING_SURFACE, scopeId: stated.listingId, complete: true, observationId });
    this.services.announce?.(accountId, [CSFLOAT_LISTING_SURFACE]);
  }

  /**
   * A reprice that came out of its send still awaiting observation is owed its listing's read, and
   * the loop that would raise it was woken by the answer while the reprice was being judged, when
   * it asked for nothing (`needs`). So the loop is asked to look again here, once the judging is
   * over: after an answer that settled nothing, and after a settle that threw. Otherwise the read
   * would wait for the loop's next idle turn, up to half a minute.
   */
  private lookAgain(accountId: string, actionId: string): void {
    try {
      if (this.context.database.action(actionId)?.state === 'AWAITING_OBSERVATION') this.services.reconsider?.(accountId);
    } catch { /* the record closed under a send that was still out */ }
  }

  /**
   * The listing a reprice's answer stated, when that answer may settle the hop: the venue answered
   * with the listing's id, price and state (`csfloatListingInEffect`), it is the hop's own listing
   * at the very price the hop sent, and its state is one a reprice can leave it in, `listed` or
   * `sold`. The port already promises the id and the price; they are compared here again because
   * the hop is settled on them. Isolated so a saboteur can take whatever listing an answer named.
   */
  protected answered(step: WorkStepRow, outcome: MutationOutcome): CsfloatStatedListing | null {
    const stated = csfloatListingInEffect(outcome);
    if (!stated || stated.listingId !== step.target_id || stated.priceCents !== this.paramsOf(step).priceCents) return null;
    return ['listed','sold'].includes(stated.state) ? stated : null;
  }

  /**
   * A create CSFloat refused because its copy of the inventory does not hold the item yet, given
   * the wait until its next send: the next of its wait's `retryAtMs` (`INVENTORY_WAIT`, by whose
   * listing it is) after the first refusal that has not passed. Written onto the attempt as the venue's wait (`venueRetryAt`), so the
   * work panel counts down to the same instant the resend waits for and a restart keeps it. None
   * left, the answer goes through as it came, and `execute` fails the hop. Isolated so a saboteur can fail
   * a lagging copy at once, as every listing did before CSF-58.
   */
  protected inventoryWait(step: WorkStepRow, outcome: MutationOutcome): MutationOutcome {
    if (!isInventoryLag(outcome) || outcome.kind !== 'DEFINITIVELY_REJECTED' || outcome.retryAfterMs !== undefined) return outcome;
    const nowMs = Date.parse(this.context.now()), wait = this.waitOf(step);
    const firstRefusal = this.waitingSince(step) ?? nowMs;
    const next = wait.retryAtMs.map(offset => firstRefusal+offset).find(at => at > nowMs);
    return next === undefined ? outcome : { ...outcome, retryAfterMs: next-nowMs };
  }

  /**
   * How this listing waits for CSFloat's copy of the inventory: a person's fast, a strategy's lean
   * (`INVENTORY_WAIT`, CSF-33, CSF-62). Whose it is is the command's authority. Isolated so a
   * saboteur can give one the other's wait.
   */
  protected waitOf(step: WorkStepRow): InventoryWait {
    return INVENTORY_WAIT[this.context.database.command(step.command_id)?.authority ?? 'HUMAN'];
  }

  /** When the listing's wait began, its first refusal: its deadline less its wait's length, so nothing more is stored. */
  private waitingSince(step: WorkStepRow): number | null {
    return step.deadline_at ? Date.parse(step.deadline_at)-this.waitOf(step).deadlineMs : null;
  }

  /**
   * Every listing hop of this account that waits on CSFloat (`RETRYING`, its last action refused
   * with a wait) and whose moment has come gets a fresh action for the same terms, which `advance`
   * then sends. Its moment is the wait the attempt carries, or, for one waiting for CSFloat's copy
   * of the inventory, a complete read of that copy begun after the refusal that shows the item. A
   * listing that waited for CSFloat past its deadline fails, and the item stays in main inventory.
   *
   * A refusal is definitive: nothing was created, so a new send is a new attempt, not a retry of an
   * ambiguous one (rule 1). The send's own admission judges everything again first, so what it
   * refuses on age is read again before any resend, as `submit` does: a listing that waited eight
   * minutes was otherwise refused for a five-minute-old Steam inventory.
   */
  protected async resumeVenueWaits(accountId: string): Promise<void> {
    const db = this.context.database, now = this.context.now();
    let waiting = false;
    const due: WorkStepRow[] = [];
    for (const { id } of this.work.openOf(accountId, [CSFLOAT_CREATE], [CSFLOAT_CREATE])) {
      if (this.stopped) return;
      const step = this.work.step(id)!;
      if (step.state !== 'RETRYING') continue;
      const prior = step.action_id ? db.action(step.action_id) : undefined;
      // A resend already admitted or out: `advance` sends it, `reconcile` proves it.
      if (prior?.state !== 'FAILED') continue;
      const lag = step.reason === CSFLOAT_INVENTORY_WAIT_REASON;
      // Past the deadline only: the last retry falls on it, and is sent before the wait gives up.
      if (lag && step.deadline_at && now > step.deadline_at) { this.timeOut(step); continue; }
      const retryAt = db.latestAttempt(prior.id)?.retry_after ?? null;
      if (!(retryAt !== null && retryAt <= now) && !(lag && this.venueShows(step, prior))) { waiting = true; continue; }
      due.push(step);
    }
    if (due.length) {
      await this.services.reads.ensureFresh(accountId, CSFLOAT_LIST_EVIDENCE);
      const at = this.context.now();
      for (const step of due) db.transaction(() => {
        const current = this.work.step(step.id);
        if (current?.state !== 'RETRYING' || current.action_id !== step.action_id) return;
        const action = db.enqueueAction({ accountId, stepId: step.id, actionKind: CSFLOAT_CREATE,
          targetId: step.local_id!, resourceKey: `item:${step.local_id}`, params: this.paramsOf(step), now: at });
        this.work.attachAction(step.id,action.id,at);
      });
    }
    if (waiting) this.armVisibility(accountId);
  }

  /**
   * Whether CSFloat's latest complete read of its copy of the inventory, begun after the refusal
   * and under the same connection, shows this exact item tradable. Isolated so a saboteur can
   * trust a read from before the refusal.
   */
  protected venueShows(step: WorkStepRow, refused: ActionRow): boolean {
    const db = this.context.database, params = this.paramsOf(step);
    const read = db.latestCompleteObservation(step.account_id,'csfloat-inventory');
    const answered = db.latestAttempt(refused.id)?.finished_at ?? null;
    // Strictly after: a read begun the same instant the refusal came back may have been answered from the same copy.
    if (!read || !answered || read.generation !== params.generation || read.started_at <= answered || !params.assetId) return false;
    const row = new AssetEvidenceStore(db).csfloat(step.account_id,params.assetId);
    return row?.last_seen_obs === read.id && row.eligible === 1 && this.store.associate(step.account_id,row.item) === step.local_id;
  }

  /**
   * Keeps the listing id the create's answer named on the hop, as the id the read must show
   * (delivery retries plan D6). Nothing trusts it until a complete read does: `reconcile` judges
   * that one contract and still checks it names the hop's asset. Until this, a create learned its
   * id only when the record held exactly one contract for the holding, which a holding with any
   * earlier contract (refunded, delisted, sold) never did again: the relist's hop stayed open for
   * good, blocking its sale's delivery and a person's delist (captured 2026-10-26). Isolated
   * so a saboteur can ignore the answer as before.
   */
  protected noteNamedListing(step: WorkStepRow, action: ActionRow): void {
    const named = this.namedListing(action);
    if (named && this.work.step(step.id)?.target_id === null) this.work.update(step.id,{ target_id: named },this.context.now());
  }

  /** The listing id the create's answer named, read from its attempt; a seam for a saboteur that ignores the answer. */
  protected namedListing(action: ActionRow): string | null {
    return namedListingId(new TransferStore(this.context.database).attemptResponse(action.id));
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
   * The retrieve was proved: the item is loose. The wait hop goes from queued to waiting, with a
   * deadline on the row so a restart judges the same instant; `awaitVisibility` hands it on to the
   * listing at once, and CSFloat's own answer to the send says whether its copy has caught up (CSF-58).
   */
  protected startWaiting(retrieve: WorkStepRow, loose: ObservationRow): void {
    const db = this.context.database, now = this.context.now();
    const waiting = this.awaitHop(retrieve);
    if (!waiting || waiting.state !== 'QUEUED') return;
    const params = this.paramsOf(retrieve);
    const deadline = new Date(Date.parse(loose.started_at)+this.waitOf(retrieve).deadlineMs).toISOString();
    db.transaction(() => {
      this.work.update(waiting.id, { state: 'AWAITING_OBSERVATION', deadline_at: deadline, reason: 'Waiting for CSFloat to see the retrieved item' }, now);
      db.addEvent(retrieve.account_id,'csfloat-visibility-wait',{ operationId: params.operationId, localId: retrieve.local_id, assetId: params.assetId, looseAt: loose.started_at, deadline },now);
    });
  }

  /**
   * Every wait hop of this account: a unit that is loose and not yet listed.
   *
   * The deadline is judged first, from the stored column, so a wait from before CSF-58 that ran
   * out while the app was closed fails without a send. Otherwise the listing hop gets its action
   * at once and joins the ordinary path: no read of CSFloat's copy first, because the send itself
   * says whether the copy has caught up, and one that has not waits (`resumeVenueWaits`).
   */
  protected async awaitVisibility(accountId: string): Promise<void> {
    const db = this.context.database;
    for (const { id } of this.work.openOf(accountId, [CSFLOAT_CREATE], ['CSFLOAT_AWAIT_VENUE'])) {
      if (this.stopped) return;
      const step = this.work.step(id)!;
      // Queued: the retrieve before it is still in flight.
      if (step.state !== 'AWAITING_OBSERVATION') continue;
      const params = this.paramsOf(step);
      const loose = this.looseOf(step);
      if (!loose || !step.deadline_at) { this.failHop(step,'The retrieve\'s observation is missing; review the listing'); continue; }
      if (this.context.now() >= step.deadline_at) { this.timeOut(step); continue; }
      if (db.itemByLocalId(accountId,step.local_id!)?.asset_id !== params.assetId) { this.failHop(step,'Item asset changed; submit a new selection'); continue; }
      await this.attachCreate(step,loose);
    }
  }

  /**
   * The item is loose: the wait hop is settled on the walk that proved it, and the listing hop gets
   * its action and is an ordinary queued create.
   *
   * Everything `validate` refuses on age is read again first where it may have lapsed during the
   * retrieve, and Steam's trade inventory is read again if the walk on record predates the
   * retrieve, because that walk could not see the item at all.
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
        const action = db.enqueueAction({ accountId, stepId: listing.id, actionKind: CSFLOAT_CREATE,
          targetId: step.local_id!, resourceKey: `item:${step.local_id}`, params: this.paramsOf(listing), now });
        this.work.attachAction(listing.id,action.id,now);
        this.work.settle(step.id,'DONE',loose.id,now);
      });
    } catch (error) {
      this.failHop(step,errorMessage(error));
    }
  }

  /**
   * CSFloat never showed the item by the deadline: the listing fails, and the item stays loose,
   * nothing stored back. The event counts the reads of CSFloat's copy made while it waited.
   */
  private timeOut(step: WorkStepRow): void {
    const db = this.context.database, params = this.paramsOf(step);
    const began = this.waitingSince(step);
    const since = began === null ? this.context.now() : new Date(began).toISOString();
    const reads = db.observationsSince(step.account_id,'csfloat-inventory',since).count;
    db.transaction(() => {
      this.failHop(step,CSFLOAT_VISIBILITY_TIMEOUT_REASON);
      db.addEvent(step.account_id,'csfloat-visibility-timeout',{ operationId: params.operationId, localId: step.local_id, assetId: params.assetId,
        waitingSince: since, deadline: step.deadline_at, readsMade: reads },this.context.now());
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

  /**
   * Sets this account's one timer for its wait on CSFloat at the soonest resend, deadline or read,
   * unless one is already set no later. One timer per account, however many listings wait: they
   * share its reads, each one of about 120 a day. Every refusal and every pass of `advance` that
   * leaves a listing waiting asks again, so a moment sooner than the one being slept to moves the
   * timer forward rather than being slept past; a timer that a later one replaced does nothing
   * when it fires.
   */
  protected armVisibility(accountId: string): void {
    if (this.stopped) return;
    const clock = this.context.ports.clock;
    const turn = this.visibilityTurn(accountId);
    if (!turn) return;
    const nowMs = clock.now().getTime();
    const at = Math.max(turn.wakeAt, nowMs + MIN_TURN_MS);
    const current = this.waits.get(accountId);
    if (current && current.at <= at) return;
    const generation = ++this.waitGeneration;
    this.waits.set(accountId,{ at, generation });
    void clock.sleep(at-nowMs).then(async () => {
      if (this.stopped || this.waits.get(accountId)?.generation !== generation) return;
      this.waits.delete(accountId);
      const due = this.visibilityTurn(accountId);
      if (due?.readAt !== null && due?.readAt !== undefined && due.readAt <= clock.now().getTime()) {
        await this.readVenue(accountId, due.readFor).catch(() => undefined);
      }
      // `advance` sends what came due, and arms the next moment for what still waits.
      this.schedule(accountId);
    }).catch(() => undefined);
  }

  /**
   * One read of CSFloat's copy of this account's inventory, begun now, for everything waiting on it:
   * a person's need when a person's listing is the one due a read, so it is not held to the spacing
   * the day's budget keeps between reads nobody asked for (`kernel/read-budget.ts`); never past the cap.
   */
  protected async readVenue(accountId: string, priority: 'person' | 'work' = 'work'): Promise<void> {
    await this.services.reads.need(accountId, { ref: { surface: 'csfloat-inventory', scope: { kind: 'account' } }, startedAfter: this.context.now(), priority });
  }

  /**
   * When this account's wait next has something to do: the soonest resend a refusal named, the
   * soonest deadline, and the next read of CSFloat's copy of the inventory, and for whom.
   *
   * Each listing waiting for that copy asks for reads its own wait's way (`INVENTORY_WAIT`): a
   * person's at its offsets from its first refusal, each the first after the account's latest read
   * of any kind (a failed read still spent the budget, and a read someone else asked for counts
   * too); a strategy's every `readEveryMs` after both its first refusal and the latest read, so a
   * listing CSFloat catches up with in two minutes, as most do, costs no read at all. No read is
   * asked for at or past a listing's deadline: its last send falls there. The soonest asked-for
   * read wins, as a person's when a person's listing asked for it. Isolated so a saboteur can read
   * for every listing.
   */
  protected visibilityTurn(accountId: string): { wakeAt: number; readAt: number | null; readFor: 'person' | 'work' } | null {
    const db = this.context.database;
    const steps = this.work.openOf(accountId, [CSFLOAT_CREATE], [CSFLOAT_CREATE]).filter(step => step.state === 'RETRYING');
    const last = db.latestObservation(accountId,'csfloat-inventory');
    const lastRead = last ? Date.parse(last.started_at) : -Infinity;
    const moments: number[] = [];
    let read: { at: number; readFor: 'person' | 'work' } | null = null;
    for (const step of steps) {
      const action = step.action_id ? db.action(step.action_id) : undefined;
      const retryAt = action?.state === 'FAILED' ? db.latestAttempt(action.id)?.retry_after ?? null : null;
      if (retryAt !== null) moments.push(Date.parse(retryAt));
      const began = this.waitingSince(step);
      if (step.reason !== CSFLOAT_INVENTORY_WAIT_REASON || began === null) continue;
      const deadline = Date.parse(step.deadline_at!), wait = this.waitOf(step);
      moments.push(deadline);
      const at = wait.readAtMs ? wait.readAtMs.map(offset => began+offset).find(moment => moment > lastRead)
        : wait.readEveryMs !== undefined ? Math.max(began, lastRead) + wait.readEveryMs : undefined;
      if (at === undefined || at >= deadline) continue;
      if (!read || at < read.at) read = { at, readFor: wait.readAtMs ? 'person' : 'work' };
    }
    if (!moments.length) return null;
    return { wakeAt: Math.min(...moments, read?.at ?? Infinity), readAt: read?.at ?? null, readFor: read?.readFor ?? 'work' };
  }

  /**
   * Called after reads and on restart. It never sends, even when absence is proven.
   *
   * A create is judged on the one contract its answer named, written to the hop at the send and
   * re-derived from the attempt here when a restart lost that write. With no id (a lost answer),
   * its candidates are the contracts that could be its product: created by the venue at or after
   * the attempt began, allowing for the venue's clock, and shown by no stall walk before it. A
   * listing that existed before the attempt is never the one it made, however many the holding
   * has had (delivery retries plan D6).
   */
  reconcile(accountId: string): void {
    for (const step of this.work.openOf(accountId, CSFLOAT_LISTING_KINDS, CSFLOAT_LISTING_KINDS)) this.judge(step);
  }

  /**
   * One listing hop judged on what the record holds about its listing: the contract under the
   * observation that last stated it, a read's or, for a reprice, its own answer's (`settleOnAnswer`).
   * The observation must be complete, of the hop's connection, and not older than the attempt.
   */
  private judge(step: WorkStepRow): void {
    const db = this.context.database, accountId = step.account_id;
    if (!['QUEUED','AWAITING_OBSERVATION'].includes(step.state) || !step.action_id) return;
    const action = db.action(step.action_id);
    if (!action || !['RUNNING','AWAITING_OBSERVATION'].includes(action.state)) return;
    if (step.state !== 'AWAITING_OBSERVATION') this.work.setState(step.id,'AWAITING_OBSERVATION',this.context.now());
    const params = this.paramsOf(step);
    const named = step.target_id ?? (step.kind === CSFLOAT_CREATE ? this.namedListing(action) : null);
    if (named && !step.target_id) this.work.update(step.id,{ target_id: named },this.context.now());
    const attempt = db.latestAttempt(action.id);
    const candidates = named ? [this.store.contract(accountId,named)].filter((row): row is CsfloatContract => row !== undefined)
      : this.store.contractsFor(accountId,step.local_id,params.assetId,attempt ? {
        createdAfter: new Date(Date.parse(attempt.started_at) - CREATE_CLOCK_TOLERANCE_MS).toISOString(), knownBefore: attemptWatermark(attempt) } : undefined);
    const listing = candidates.length === 1 ? candidates[0] : undefined;
    if (!listing) return;
    // A listing the answer named that is not about the hop's asset is not this create's, whatever the venue said.
    if (step.kind === CSFLOAT_CREATE && listing.asset_id !== params.assetId) return;
    const obs = db.observation(accountId,listing.observation_id);
    if (!obs?.complete || obs.error || obs.generation !== params.generation || !postAttempt(db,action,obs,false)) return;
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
   * What proves a delist CSFloat accepted, and a reprice whose answer settled nothing: that
   * listing's own read, begun after the send returned (CSF-45). The stall cannot prove it, because
   * a listing the stall no longer holds may have sold. The refresh loop reads the listing for as
   * long as the hop waits — at once, then on the proof intervals, then on the listing's own cadence
   * — so a read that fails is followed by another rather than by nothing, and a restart reads for
   * it from the record. A create is proved by the stall walk its send nudges, which the stall's
   * cadence repeats.
   *
   * A reprice whose answer returned the listing is settled on that answer and never waits, so it
   * needs nothing (CSF-70). Its action does await observation in the record for the few turns
   * between the answer being recorded and being judged, and the signal that follows the answer
   * wakes the refresh loop in those same turns. A reprice this run is still judging therefore asks
   * for nothing, so that no listing read rests on which of the two runs first.
   */
  needs(action: ActionRow): ProofNeed {
    const { listingId } = this.context.database.actionParams(action) as { listingId?: string | null };
    if (!['CSFLOAT_CANCEL','CSFLOAT_REPRICE'].includes(action.kind) || !listingId || this.judging.has(action.id)) return { kind: 'none' };
    return { kind: 'walks', walks: [{ ref: { surface: CSFLOAT_LISTING_SURFACE, scope: { kind: 'item', id: listingId } }, startedAfter: attemptReturned(this.context.database,action) }] };
  }

  /**
   * One durable conflict per foreign duplicate (XLIST-09, XLIST-14). Raised only while
   * protection is on; resolved only when the latest complete Steam and CSFloat walks no longer
   * show both advertisements. An incomplete walk changes nothing in either direction, and no
   * refresh ever raises a second row for the same unit. Judged after every read that could show one.
   */
  observeConflicts(accountId: string): void {
    const db = this.context.database, now = this.context.now();
    // Two joins, one per identity, each on its own index (`order_resource`, `order_asset`): one join on
    // `local_id OR asset_id` used neither and read every order of the account for every open CSFloat
    // listing, after every CSFloat walk, 40 % of a pass's CPU on a large record (measured 2026-11-03).
    const conflicts = db.raw().prepare(`SELECT c.venue_order_id AS listing_id FROM venue_order c JOIN venue_order o ON o.account_id=c.account_id AND o.local_id=c.local_id
        WHERE c.account_id=? AND c.venue='csfloat' AND c.side='SELL' AND c.state='OPEN' AND ${STEAM_LISTED_SQL}
      UNION SELECT c.venue_order_id AS listing_id FROM venue_order c JOIN venue_order o ON o.account_id=c.account_id AND o.asset_id=c.asset_id
        WHERE c.account_id=? AND c.venue='csfloat' AND c.side='SELL' AND c.state='OPEN' AND ${STEAM_LISTED_SQL}`).all(accountId, accountId) as Array<{ listing_id: string }>;
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
