import { buyerPaysFor, listingPriceChangeAnswer, listingPriceInEffect, type AccountId, type BuyOrderStatus, type MarketBuyOrder, type MarketListing, type MutationOutcome } from '@cslytics/ports';
import { INTERRUPTED_BEFORE_OUTCOME, type ActionRow, type ObservationRow } from '../db/database.js';
import { type EngineContext, executeMutation } from '../kernel/context.js';
import { errorMessage, required } from '../kernel/support.js';
import { ACCOUNT_HISTORY, ACCOUNT_MARKET, ACCOUNT_INVENTORY, attemptReturned, surfaceEvidence, postAttempt, locationEvidence, evaluatePreconditions, PRECONDITIONS, requirePreconditions, type ProofNeed } from '../kernel/evidence.js';
import { LISTING_REVERSED, reconcileDivergence } from '../policy/divergence.js';
import { attemptsMade, sendsThatCouldLand, settleNotApplied } from '../kernel/not-applied.js';
import { NEVER_RETRY, RETRY_POLICY, type RetryPolicy } from '../kernel/retry-policy.js';
import { DISCARD_SELL_LISTING_PRICE_CHANGE, PRICE_CHANGE_DISCARD_SENT, PRICE_CHANGE_LISTING_GONE, PRICE_CHANGE_LISTING_NOT_LIVE, PRICE_CHANGE_LISTING_OFF_MARKET, PRICE_CHANGE_NOT_CONFIRMED, PRICE_CHANGE_UNANSWERED, PRICE_COOLDOWN_REFUSALS,
  PRICE_COOLDOWN_REFUSED, PRICE_DISCARD_SENDS, PRICE_DISCARD_UNAVAILABLE, PRICE_DISCARD_UNHEARD, PRICE_EDIT_UNAVAILABLE, PRICE_WITHDRAWAL_UNHEARD, discardAttemptHeard, discardHeard, SOLD_DURING_PRICE_CHANGE, UPDATE_SELL_LISTING_PRICE, VENUE_CODE_PRICE_NOT_EDITABLE, cooldownEnd, neitherPrice, priceChangeConfirmer, priceChangeInEffect,
  priceChangeVenueCode, priceDiscardId, type PriceDiscardParams, type PriceDiscardReason } from '../kernel/listing-price.js';
import { PRICE_DISCARD_LANDING_MARGIN_MS, PRICE_DISCARD_LATE_LANDING_MS, priceChangeDeadline, priceDiscardBackoffMs } from '../policy/price-change.js';
import { OrderService } from './orders.js';
import { HoldingsStore } from '../db/holdings.js';
import { LedgerStore } from '../db/ledger.js';
import { WorkStore, isSettled } from '../db/work.js';
import { BUY_ORDER_STATUS_SURFACE, OrderStore, type PriceContradiction, type SeenSteamListing, type SteamListingRow, type SteamWalkTimes, type VanishedStatuses } from '../db/orders.js';
import { committedSql } from '../db/commitment.js';
import { CsfloatStore } from '../db/csfloat.js';
import { PRICE_ANSWER_CONTRADICTED, PRICE_ANSWER_GUARD_MS } from '../kernel/price-answer.js';
import { feeTermsNow, latestWalletStatement, statedMinimum } from '../kernel/wallet-terms.js';
import { csfloatClaim } from '../kernel/marketplace-commitments.js';
import type { SteamListingBucket } from '../db/alphabets.js';

export type MarketSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  totalExpected: number | null;
  error?: string;
};

export type SellParams = { priceReceiveCents: number };
export type DelistParams = { listingId: string };
/**
 * The frozen terms of a price change in place: the listing, the seller price asked for, the seller
 * price the listing had when the change was admitted, and the wallet's currency as Steam numbers it.
 */
export type PriceUpdateParams = { listingId: string; priceReceiveCents: number; fromPriceCents: number; currency: number };

/** The reason on a price change a person stopped, and on its action: the word every stopped hop carries. */
export const COMMAND_STOPPED = 'command-stopped';

/** The reason on a discard a walk showed was too late: the lower price had been confirmed meanwhile. */
const DISCARD_TOO_LATE = 'The lower price was confirmed before it was discarded';

/** The reason on a discard never sent because the price change it would withdraw ended first, as by a sale. */
export const DISCARD_NOT_NEEDED = 'The price change ended before its discard was sent';


function mergeListings(into: MarketListing[], incoming: readonly MarketListing[]): void {
  for (const listing of incoming) {
    if (!into.some((row) => row.listingId === listing.listingId)) into.push(listing);
  }
}

/** Steam Market observation and the sell-listing lifecycle. */
export class MarketService {
  /** Buy orders whose purchased count rose during the walk currently being persisted. */
  private filledSinceWalk = 0;

  constructor(protected readonly context: EngineContext, readonly orders = new OrderService(context)) {}

  /**
   * Walks every page of `mylistings`.
   *
   * Absence is concluded only from a clean, fully-walked result (CLAUDE.md rule 5). Two
   * guards matter beyond the obvious loop:
   *
   * - `page.start !== start` means the server ignored our offset; the walk is not ours to trust.
   * - a successful `total_count: 0` against a book we have seen before is treated as an error
   *   unless every listing it would end is accounted for (`emptyIsCorroborated`). A stale
   *   session returns exactly that shape, and believing it would delist a real portfolio.
   */
  async sync(accountId: AccountId, pageSize = 500): Promise<MarketSyncResult> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const listings: MarketListing[] = [];
    const holds: MarketListing[] = [];
    const confirmations: MarketListing[] = [];
    let buyOrders: MarketBuyOrder[] = [];
    let start = 0;
    let pagesWalked = 0;
    let totalExpected: number | null = null;
    let error: string | undefined;

    try {
      for (;;) {
        const page = await this.context.ports.market.getMyListingsPage(accountId, start, pageSize);
        pagesWalked += 1;
        if (page.start !== start) throw new Error(`page-start-mismatch:${page.start}:${start}`);
        if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || (totalExpected !== null && totalExpected !== page.totalCount)) throw new Error('market-total-changed-or-invalid');
        totalExpected = page.totalCount;
        listings.push(...page.listings);
        mergeListings(holds, page.listingsOnHold);
        mergeListings(confirmations, page.listingsToConfirm);
        buyOrders = page.buyOrders;
        // total_count covers listings[] only. Confirm/hold buckets are extra and may be
        // nonempty while total_count is 0 (live 2026-09-09, mylistings-confirm-bucket-live).
        if (start + page.listings.length >= page.totalCount) break;
        if (page.listings.length === 0) throw new Error('empty-page-before-total');
        start += page.listings.length;
      }
    } catch (caught) {
      error = errorMessage(caught);
    }

    const previousOpen = new OrderStore(database).openSteamListings(accountId);
    const bucketsEmpty = listings.length === 0 && holds.length === 0 && confirmations.length === 0;
    if (!error && totalExpected === 0 && bucketsEmpty && previousOpen.length > 0 && !this.emptyIsCorroborated(accountId, previousOpen)
      && !(await this.emptyFromSignedInSession(accountId, pageSize))) {
      error = 'suspicious-successful-empty-session';
    }
    const complete = !error && totalExpected !== null && this.listingWalkIsComplete({
      listings, holds, confirmations, totalExpected
    });
    // Only a complete walk may conclude an order is gone (rule 5), and only Steam's own counter
    // can say how a buy order that left the book ended. Asked now, before the transaction.
    const statuses = complete ? await this.vanishedBuyOrderStatuses(accountId, buyOrders) : new Map<string, BuyOrderStatus | null>();

    const observationId = database.transaction(() => {
      const obs = database.insertObservation({
        accountId,
        surface: 'steam-market',
        startedAt,
        finishedAt: this.context.now(),
        complete,
        pagesWalked,
        ...(totalExpected === null ? {} : { totalExpected }),
        ...(error === undefined ? {} : { error })
      });
      // The walk's counts and its error are the observation's; no notice is written (D10).
      if (complete) this.persist(accountId, obs, listings, holds, confirmations, buyOrders, statuses);
      return obs;
    });

    this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-market', complete, observationId });
    // A fill spent wallet money and delivered an item. Both are reads for the scheduler to do;
    // neither is derived here. Emitted after the walk's transaction commits, like every other
    // signal a database-reading listener may subscribe to.
    for (let index = 0; index < this.filledSinceWalk; index += 1) {
      this.context.signals.emit({ kind: 'order-changed', accountId, side: 'BUY', state: 'FILLED' });
    }
    this.filledSinceWalk = 0;
    return error === undefined
      ? { observationId, complete, pagesWalked, totalExpected }
      : { observationId, complete, pagesWalked, totalExpected, error };
  }

  /**
   * Steam's per-order counter for each open buy order this walk no longer shows with units left to
   * buy, or `null` where the read failed (standing buy orders plan D8, N-BUY-18). An order that
   * fills its last unit leaves the book exactly as a cancelled one does; without this read a fill
   * between two walks was recorded as a cancellation at the venue, and its item and its money were
   * nobody's. One request per order, under the venue's read budget, as the status poll makes it.
   */
  protected async vanishedBuyOrderStatuses(accountId: AccountId, seen: readonly MarketBuyOrder[]): Promise<Map<string, BuyOrderStatus | null>> {
    const statuses = new Map<string, BuyOrderStatus | null>();
    const missing = new OrderStore(this.context.database).buyOrdersMissingFrom(accountId, new Set(seen.map((order) => order.buyOrderId)));
    for (const row of missing) {
      const buyOrderId = row.venue_order_id!;
      try {
        await this.context.governors.admitRead(accountId, 'steam-web', BUY_ORDER_STATUS_SURFACE);
        statuses.set(buyOrderId, await this.context.ports.market.getBuyOrderStatus(accountId, buyOrderId));
      } catch {
        // Unread is not "cancelled": the order stays unexplained and the next walk asks again.
        statuses.set(buyOrderId, null);
      }
    }
    return statuses;
  }

  /**
   * Steam's `total_count` is the active `listings[]` walk. Pending confirmation and hold
   * rows are extra buckets. Treating `observedCount === total_count` as completeness drops
   * a confirm-only book (total_count 0, listings_to_confirm nonempty).
   */
  protected listingWalkIsComplete(input: {
    listings: MarketListing[];
    holds: MarketListing[];
    confirmations: MarketListing[];
    totalExpected: number;
  }): boolean {
    void input.holds;
    void input.confirmations;
    return input.listings.length === input.totalExpected;
  }

  async syncWallet(accountId: AccountId): Promise<number> {
    const { database } = this.context;
    const startedAt = this.context.now();
    try {
      const wallet = await this.context.ports.market.getWallet(accountId);
      const observationId = database.transaction(() => {
        const observationId = database.insertObservation({
          accountId,
          surface: 'steam-wallet',
          startedAt,
          finishedAt: this.context.now(),
          complete: true,
          totalExpected: 1
        });
        database.raw().prepare(`
          INSERT INTO wallet_snapshot(account_id, observation_id, observed_at, balance_cents, delayed_balance_cents, currency, market_minimum_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(accountId, observationId, wallet.observedAt, wallet.balanceCents, wallet.delayedBalanceCents, wallet.currency, statedMinimum(wallet.marketMinimumCents));
        return observationId;
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-wallet', complete: true, observationId });
      return observationId;
    } catch (error) {
      const failed = database.insertObservation({
        accountId,
        surface: 'steam-wallet',
        startedAt,
        finishedAt: this.context.now(),
        complete: false,
        error: errorMessage(error)
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-wallet', complete: false, observationId: failed });
      return failed;
    }
  }

  queueSellListing(accountId: AccountId, localId: string, priceReceiveCents: number, commandId: string | null = null): ActionRow {
    const params = this.sellParams(accountId, localId, priceReceiveCents);
    return this.context.database.createDesiredAction({
      accountId,
      targetKind: 'sell-listing',
      targetId: localId,
      intent: 'LISTED_AT',
      params,
      commandId,
      actionKind: 'CREATE_SELL_LISTING',
      resourceKey: `item:${localId}`,
      now: this.context.now()
    });
  }

  /** The listing hop of a command: the same admission as `queueSellListing`, on the hop's action rather than a goal's (D3). */
  queueSellListingStep(accountId: AccountId, localId: string, priceReceiveCents: number, stepId: string): ActionRow {
    const params = this.sellParams(accountId, localId, priceReceiveCents);
    return this.context.database.enqueueAction({ accountId, stepId, actionKind: 'CREATE_SELL_LISTING', targetId: localId, resourceKey: `item:${localId}`, params, now: this.context.now() });
  }

  private sellParams(accountId: AccountId, localId: string, priceReceiveCents: number): SellParams {
    const { database } = this.context;
    // sellitem takes integer cents the seller receives, not the buyer price (CLAUDE.md rule 4).
    if (!Number.isInteger(priceReceiveCents) || priceReceiveCents <= 0) {
      throw new Error('Seller-receives price must be positive integer cents');
    }
    const item = required(database.itemByLocalId(accountId, localId), `Unknown item ${localId}`);
    if (item.location !== 'MAIN' || !item.asset_id) throw new Error('Item is not available in main inventory');
    // Exclusivity is per item, not per venue (order-lifecycle.md D16): CSFloat's claim on the unit
    // in its own words, then one question over the one table every venue's orders live in, by the
    // holding's row and by its asset id (D5). With cross-venue protection switched off the question
    // is Steam's own, and another venue's advertisement is left to the person who switched it off
    // (XLIST-03). The venue's evidence being fresh is the send's question, not this one's (XLIST-04).
    const claim = csfloatClaim(database, accountId, localId, 'steam-list');
    if (claim) throw new Error(claim);
    const everyVenue = new CsfloatStore(database).policy().preventDuplicates;
    const active = database.raw()
      .prepare(`SELECT 1 FROM item i WHERE i.account_id=? AND i.local_id=? AND ${committedSql('i', everyVenue ? undefined : 'steam')}`)
      .get(accountId, localId);
    if (active) throw new Error('Item already has an open sell order');
    return { priceReceiveCents };
  }

  /**
   * Asset ids this account has on the market, or has sent there and no walk has yet placed.
   * The Game Coordinator keeps a listed item in the inventory (`steam/interactions.md`), so a
   * handle's location cannot answer this on its own.
   */
  listedAssets(accountId: AccountId): Set<string> {
    return new OrderStore(this.context.database).committedAssets(accountId);
  }

  async executeSellListing(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.actionParams(action) as SellParams;
    const item = required(database.itemByLocalId(action.account_id, action.target_id), `Unknown item ${action.target_id}`);
    if (item.location !== 'MAIN' || !item.asset_id) throw new Error('Item is not available in main inventory');
    const assetId = required(item.asset_id ?? undefined, 'Item has no current Steam asset id');
    return executeMutation(this.context, action, () =>
      this.context.ports.market.createSellListing(action.account_id, assetId, params.priceReceiveCents), () => {
        requirePreconditions(evaluatePreconditions(database, action.account_id, action.target_id, PRECONDITIONS.CREATE_SELL_LISTING, this.context.ports.clock.now()));
        if (database.itemByLocalId(action.account_id, action.target_id)?.asset_id !== assetId) throw new Error('Item asset changed before listing');
      });
  }

  /**
   * A delist asked for by hand: a command of one hop (`DELIST`), admitted with its own id, whose
   * action is the hop's (D3). The work panel reads it as any other hop; a relist's own delist is
   * its member's hop and never a command of its own.
   */
  queueDelist(accountId: AccountId, listingId: string): ActionRow {
    const listing = this.listingToDelist(accountId, listingId);
    const now = this.context.now();
    const work = new WorkStore(this.context.database);
    return this.context.database.transaction(() => {
      const hop = work.lone('DELIST', { accountId, kind: 'DELIST', localId: listing.local_id, targetId: listingId, params: { listingId } satisfies DelistParams, now });
      const action = this.queueDelistStep(accountId, listingId, hop.id);
      work.attachAction(hop.id, action.id, now);
      return action;
    });
  }

  /**
   * The delist hop of a relist or a delist-to-storage: the same admission as `queueDelist`, on the
   * hop's action rather than a goal's (D3). A hand delist keeps its goal, and the work read tells
   * the two apart by that: a chain's delist is reported through its member, never twice.
   */
  queueDelistStep(accountId: AccountId, listingId: string, stepId: string): ActionRow {
    const listing = this.listingToDelist(accountId, listingId);
    return this.context.database.enqueueAction({ accountId, stepId, actionKind: 'REMOVE_SELL_LISTING', targetId: listing.local_id ?? listingId,
      resourceKey: listing.local_id ? `item:${listing.local_id}` : `listing:${listingId}`, params: { listingId } satisfies DelistParams, now: this.context.now() });
  }

  private listingToDelist(accountId: AccountId, listingId: string): { local_id: string | null } {
    const listing = new OrderStore(this.context.database).steamListing(accountId, listingId);
    if (!listing) throw new Error(`Unknown listing ${listingId}`);
    return listing;
  }

  async executeDelist(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.desiredParams(action) as DelistParams;
    return new WorkStore(database).send(action.id, () => executeMutation(this.context, action, () =>
      this.context.ports.market.removeListing(action.account_id, params.listingId)), () => this.context.now());
  }

  /**
   * The hop of a `REPRICE`: the price of an open listing changed in place, on the same listing.
   * The same admission as `queueDelistStep`, on the hop's action. The holding is the resource, so
   * a removal asked for while the change is still unsent takes its place.
   */
  queuePriceUpdateStep(accountId: AccountId, localId: string, params: PriceUpdateParams, stepId: string): ActionRow {
    return this.context.database.enqueueAction({ accountId, stepId, actionKind: 'UPDATE_SELL_LISTING_PRICE', targetId: localId,
      resourceKey: `item:${localId}`, params, now: this.context.now() });
  }

  /**
   * Sends a price change and records what its answer may be taken to say, in the turn the answer
   * arrives (`recordPriceAnswer`). Refused before anything goes out when the composed market port
   * has no price change, or the listing is no longer live on the book: Steam changes the price of
   * a live listing only.
   */
  async executePriceUpdate(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.actionParams(action) as PriceUpdateParams;
    const market = this.context.ports.market;
    return executeMutation(this.context, action,
      () => market.updateListingPrice!(action.account_id, params.listingId, params.priceReceiveCents, params.currency),
      () => {
        if (!market.updateListingPrice) throw new Error(PRICE_EDIT_UNAVAILABLE);
        const listing = new OrderStore(database).steamListing(action.account_id, params.listingId);
        if (!listing || listing.first_seen_obs === null || listing.gone_obs !== null) throw new Error(PRICE_CHANGE_LISTING_OFF_MARKET);
        if (listing.raw_bucket !== 'ACTIVE') throw new Error(PRICE_CHANGE_LISTING_NOT_LIVE);
      },
      (outcome, at) => {
        this.recordPriceAnswer(action, params, outcome, at);
        // The hop follows its action in the same write, so no read finds one done and the other not.
        new WorkStore(database).mirror(action.id, at);
      }).then((outcome) => {
      // A record that failed to write leaves the answer on the attempt: what it would have written is derived from it now.
      this.repairPriceAnswer(action.id);
      return outcome;
    });
  }

  /**
   * Re-derives what a price change's answer writes from the answer stored on its attempt, when the
   * action carries none of it (in-place reprice plan D15). Two answers matter,
   * because without their record the change would be decided wrongly: one asking for a confirmation,
   * without which the next walk showing the old price would fail a lower price Steam is holding; and
   * a refusal for the cooldown, without which the change would read failed with the bare word and
   * never be sent again. The attempt and its record are one transaction (`kernel/context.ts`), so
   * this finds work only where that record threw, or in a record an earlier build wrote. Asked after
   * every send, by every settle for the changes it decides, and for the whole account on a restart.
   */
  repairPriceAnswer(actionId: string): void {
    const { database } = this.context;
    const action = database.action(actionId);
    if (!action || action.kind !== UPDATE_SELL_LISTING_PRICE) return;
    const awaiting = action.state === 'AWAITING_OBSERVATION' && action.resolution === null;
    const refused = action.state === 'FAILED' && action.error === 'cooldown';
    if (!awaiting && !refused) return;
    const attempt = database.latestAttempt(action.id);
    if (!attempt?.finished_at || !attempt.outcome) return;
    let raw: unknown;
    try { raw = JSON.parse(attempt.response_ref ?? 'null') as unknown; } catch { return; }
    const answer = listingPriceChangeAnswer(raw);
    const outcome: MutationOutcome | null = awaiting && attempt.outcome === 'SUBMITTED' && answer.confirmation !== null
      ? { kind: 'SUBMITTED', evidence: 'price-change-awaiting-confirmation', raw }
      : refused && attempt.outcome === 'DEFINITIVELY_REJECTED' && attempt.retry_after
        ? { kind: 'DEFINITIVELY_REJECTED', reason: 'cooldown', retryAfterMs: Math.max(0, Date.parse(attempt.retry_after) - Date.parse(attempt.finished_at)), raw }
        : null;
    if (!outcome) return;
    const params = database.actionParams(action) as PriceUpdateParams;
    const work = new WorkStore(database);
    database.transaction(() => {
      this.recordPriceAnswer(action, params, outcome, attempt.finished_at!);
      // A refusal the record never revived may have failed its hop already; revived, the hop waits to be sent again.
      const hop = action.step_id ? work.step(action.step_id) : undefined;
      if (refused && hop?.state === 'FAILED' && database.action(action.id)?.state === 'READY') {
        work.update(hop.id, { state: 'QUEUED', reason: null, observation_id: null }, this.context.now());
      }
      work.mirror(action.id, this.context.now());
    });
    database.addEvent(action.account_id, 'price-answer-repaired', { actionId: action.id, answer: outcome.kind === 'SUBMITTED' ? 'awaiting-confirmation' : 'cooldown' }, this.context.now());
  }

  /** `repairPriceAnswer` for every change of the account that may need it: what a restart runs before anything else looks. */
  repairPriceAnswers(accountId: AccountId): void {
    const rows = this.context.database.raw().prepare(`SELECT id FROM action INDEXED BY action_ready WHERE account_id=? AND state IN ('AWAITING_OBSERVATION','FAILED')
      AND kind='${UPDATE_SELL_LISTING_PRICE}' AND ((state='AWAITING_OBSERVATION' AND resolution IS NULL) OR (state='FAILED' AND error='cooldown'))`).all(accountId) as Array<{ id: string }>;
    for (const { id } of rows) this.repairPriceAnswer(id);
  }

  /**
   * Queues the one discard a waiting lower price may send, and marks the change as being withdrawn
   * (in-place reprice plan D15): from here nothing presses it, and a complete walk begun after the
   * discard returns decides how it ends. `why` is what that walk's verdict will be read against;
   * `provedBy`, for a lower price whose answer never came, the walk that showed the old price. The
   * discard is a recorded action carrying the change's own hop, so its attempt is evidence like any
   * other; its id is the change's, so a second can never be queued. In the caller's transaction.
   */
  queuePriceDiscard(change: ActionRow, why: PriceDiscardReason, provedBy?: number): ActionRow {
    const { database } = this.context;
    const params = database.actionParams(change) as PriceUpdateParams;
    const now = this.context.now();
    return database.transaction(() => {
      const existing = database.action(priceDiscardId(change.id));
      if (existing) return existing;
      const discard = database.enqueueAction({ id: priceDiscardId(change.id), accountId: change.account_id, stepId: required(change.step_id ?? undefined, 'A price change without a hop'),
        actionKind: DISCARD_SELL_LISTING_PRICE_CHANGE, targetId: change.target_id, resourceKey: `price-discard:${change.step_id}`,
        params: { listingId: params.listingId, why, ...(provedBy === undefined ? {} : { provedBy }) } satisfies PriceDiscardParams, now });
      database.markDiscardSent(change.id, now);
      database.addEvent(change.account_id, 'price-change-withdrawn', { actionId: change.id, listingId: params.listingId, why }, now);
      return discard;
    });
  }

  /**
   * Sends a discard (`discardListingPriceChange`). Its answer is a bare acknowledgement and proves
   * nothing (rule 1): whatever it answers, the walk its proof need asks for, begun after it, decides
   * the change, a lower price whose own answer never came included. Refused before anything goes
   * out when the composed market port has no discard; the caller asks that first
   * (`discardUnavailable`), because then the walk decides with no discard at all. An answer Steam
   * gave is no failure of the kind's breaker, however unreadable (`discardTripsBreaker`).
   */
  async executePriceDiscard(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.actionParams(action) as PriceDiscardParams;
    const market = this.context.ports.market;
    return executeMutation(this.context, action,
      () => market.discardListingPriceChange!(action.account_id, params.listingId),
      () => { if (!market.discardListingPriceChange) throw new Error(PRICE_DISCARD_UNAVAILABLE); },
      (outcome, at) => this.recordDiscardAnswer(action, params, outcome, at),
      (outcome) => this.discardTripsBreaker(outcome));
  }

  /**
   * Whether a discard's answer counts against the discard's circuit breaker: one Steam never heard
   * (`discardUnheard`). One Steam answered, with any code, says the route is up. A discard sent
   * again after a timeout that had in fact landed is answered with Steam's word that nothing waits,
   * which the port calls ambiguous; counted as a failure, five of those opened the breaker and held
   * back a discard that was still owed. Isolated so a saboteur can count every ambiguous answer, as
   * every other kind does.
   */
  protected discardTripsBreaker(outcome: MutationOutcome): boolean {
    return outcome.kind === 'AMBIGUOUS' && this.discardUnheard(outcome);
  }

  /**
   * A discard the composed market cannot send, because it has no such call: recorded as refused,
   * with nothing sent (in-place reprice plan D15, D20). The change it would have withdrawn stays
   * being withdrawn, and the walk its proof need asks for, begun after this refusal and so after the
   * deadline or the Stop that asked for it, decides it exactly as after a discard: the new price
   * shown, the person confirmed it and it is done; the old one, it ends as it was withdrawn.
   */
  discardUnavailable(discard: ActionRow): void {
    const { database } = this.context;
    const now = this.context.now();
    database.transaction(() => {
      if (database.action(discard.id)?.state !== 'READY') return;
      database.setActionState(discard.id, 'FAILED', now, PRICE_DISCARD_UNAVAILABLE);
      const change = this.changeOf(discard);
      // Its proof need is counted from this refusal, the moment there was no discard to send.
      if (change) database.markDiscardSent(change.id, now);
    });
  }

  /** The change a discard withdraws: the action of the hop it carries. */
  private changeOf(discard: ActionRow): ActionRow | undefined {
    const hop = discard.step_id ? new WorkStore(this.context.database).step(discard.step_id) : undefined;
    return hop?.action_id ? this.context.database.action(hop.action_id) : undefined;
  }

  /**
   * What a discard's answer writes, in the transaction that finishes its attempt (in-place reprice
   * plan D15, D19, D27). One Steam never heard (`discardUnheard`) leaves the discard owed: it goes
   * back to `READY`, to be sent again after the wait `priceDiscardBackoffMs` names
   * (`discardDueAt`), `PRICE_DISCARD_SENDS` sends in all, because a discard of nothing changes
   * nothing and Steam may still hold the lower price. When the last send goes unheard too, the
   * discard fails with words that say so (`exhaustUnheardDiscard`). An answer Steam gave is the
   * moment the walk that decides the change is counted from. Whatever the discard answered, it
   * settles nothing: the walk does. Isolated so a saboteur can settle on the answer instead.
   */
  protected recordDiscardAnswer(discard: ActionRow, _params: PriceDiscardParams, outcome: MutationOutcome, at: string): void {
    const { database } = this.context;
    const change = this.changeOf(discard);
    if (!change || change.state !== 'AWAITING_OBSERVATION') return;
    if (!this.discardUnheard(outcome)) {
      // The proof need is counted from the answer, not from when the discard was queued.
      database.markDiscardSent(change.id, at);
      return;
    }
    if (attemptsMade(database, discard.id) < this.discardSendLimit()) {
      database.reviveUnheardDiscard(discard.id, at);
      return;
    }
    this.exhaustUnheardDiscard(discard, change, at);
  }

  /**
   * The last send of a discard went unheard, as every one before it did: nothing says Steam dropped
   * the lower price. The discard fails with `PRICE_DISCARD_UNHEARD`, never done, and the walk the
   * change's proof need asks for decides it: the price asked for shown, it was confirmed and is done;
   * the listing sold, the sale ends it; otherwise it fails `withdrawal-unheard`
   * (`decideWithdrawn`). In the caller's transaction. Isolated so a saboteur can take the last send
   * for an answer, as the build before this did.
   */
  protected exhaustUnheardDiscard(discard: ActionRow, change: ActionRow, at: string): void {
    const { database } = this.context;
    database.setActionState(discard.id, 'FAILED', at, PRICE_DISCARD_UNHEARD);
    database.markDiscardSent(change.id, at);
  }

  /**
   * Whether Steam never heard a discard (`discardHeard`): no HTTP 200 answer of Steam's own came
   * back, whatever the outcome's cause. A failure before any request left this machine (a web
   * session that could not be made) is unheard too: classified `unclassified`, it was once taken for
   * Steam's answer, and the change ended while Steam still held the lower price. An answer Steam
   * gave, even one nobody can read, is heard: it is the answer a second send would get. Isolated so
   * a saboteur can judge by the cause.
   */
  protected discardUnheard(outcome: MutationOutcome): boolean {
    return !discardHeard(outcome);
  }

  /**
   * When an owed discard may next go out, in milliseconds on the engine's clock: at once when it
   * has never been sent; otherwise the backoff its count of unheard sends earns
   * (`priceDiscardBackoffMs`), after the last of them came back unheard. Every send of a discard
   * still owed went unheard: a heard one is never sent again. Read from its attempts, so a restart
   * keeps the same moment.
   */
  discardDueAt(discard: ActionRow): number {
    const { database } = this.context;
    const sends = attemptsMade(database, discard.id);
    const last = sends > 0 ? database.latestAttempt(discard.id) : undefined;
    if (!last) return Number.NEGATIVE_INFINITY;
    return Date.parse(last.finished_at ?? last.started_at) + this.discardBackoffMs(sends);
  }

  /** How long after its last unheard send a discard waits before the next. Isolated so a saboteur can send it again at once. */
  protected discardBackoffMs(unheardSends: number): number {
    return priceDiscardBackoffMs(unheardSends);
  }

  /**
   * How long after an unheard send of a discard began a walk must begin before it may decide the
   * change (`PRICE_DISCARD_LATE_LANDING_MS`): a request given up on can still land. Isolated so a
   * saboteur can decide at once.
   */
  protected discardLateLandingMs(): number {
    return PRICE_DISCARD_LATE_LANDING_MS;
  }

  /**
   * The moment after which no unheard send of a discard can still land, or `null` when Steam heard
   * every send: the latest unheard send's start and `discardLateLandingMs` more, and never sooner
   * than the landing margin after it came back.
   */
  private lateLandingEnds(discard: ActionRow): string | null {
    const attempts = this.context.database.raw().prepare('SELECT started_at, finished_at, outcome, response_ref FROM attempt WHERE action_id=? ORDER BY rowid')
      .all(discard.id) as Array<{ started_at: string; finished_at: string | null; outcome: string | null; response_ref: string | null }>;
    const unheard = attempts.filter((attempt) => !discardAttemptHeard(attempt)).at(-1);
    if (!unheard) return null;
    const late = this.discardLateLandingMs();
    const back = Date.parse(unheard.finished_at ?? unheard.started_at);
    return new Date(Math.max(Date.parse(unheard.started_at) + late, back + Math.min(late, PRICE_DISCARD_LANDING_MARGIN_MS))).toISOString();
  }

  /**
   * Whether every send of a change's discard went unheard: the discard failed with
   * `PRICE_DISCARD_UNHEARD`, and Steam may still hold the lower price.
   */
  private withdrawalUnheard(discard: ActionRow | undefined): boolean {
    return discard?.state === 'FAILED' && discard.error === PRICE_DISCARD_UNHEARD;
  }

  /**
   * A discard a dead process left on the wire: recovered to observation with an attempt that never
   * finished (rule 6). Nothing came back from Steam, so it is an unheard send like any other, and
   * the discard is owed again on the same schedule (in-place reprice plan D27): its attempt is
   * finished, ambiguous, with the recovery's words, at this moment, and its answer is recorded as
   * one Steam never heard. A discard whose change ended meanwhile is left to close on the next walk.
   * What a restart runs before it sends the account's owed discards.
   */
  reviveInterruptedDiscards(accountId: AccountId): void {
    const { database } = this.context;
    const rows = database.raw().prepare(`SELECT * FROM action INDEXED BY action_ready WHERE account_id=? AND state='AWAITING_OBSERVATION'
      AND kind='${DISCARD_SELL_LISTING_PRICE_CHANGE}' AND error=?`).all(accountId, INTERRUPTED_BEFORE_OUTCOME) as ActionRow[];
    for (const discard of rows) {
      const attempt = database.latestAttempt(discard.id);
      if (!attempt || attempt.finished_at !== null) continue;
      const outcome: MutationOutcome = { kind: 'AMBIGUOUS', cause: 'unclassified', raw: INTERRUPTED_BEFORE_OUTCOME };
      const at = this.context.now();
      database.transaction(() => {
        database.finishAttempt(discard.id, attempt.id, outcome.kind, outcome.raw, at);
        this.recordDiscardAnswer(discard, database.actionParams(discard) as PriceDiscardParams, outcome, at);
      });
      database.addEvent(accountId, 'price-discard-recovered', { actionId: discard.id }, at);
    }
  }

  /** How many times one discard may be sent. Isolated so a saboteur can send it once, or for ever. */
  protected discardSendLimit(): number {
    return PRICE_DISCARD_SENDS;
  }

  /**
   * When the discard of a change returned, or `null` while it has not: owed a send, or on the wire
   * (`discardReturned`). After an unheard send, no sooner than that send can still land
   * (`lateLandingEnds`): only a walk begun after this moment decides the change.
   */
  discardReturnedAt(change: ActionRow): string | null {
    const discard = this.context.database.action(priceDiscardId(change.id));
    return discard ? this.discardSettlesAfter(discard) : null;
  }

  /** `discardReturned`, held back to `lateLandingEnds` when that is later. */
  private discardSettlesAfter(discard: ActionRow): string | null {
    const back = this.discardReturned(discard);
    if (back === null) return null;
    const landing = this.lateLandingEnds(discard);
    return landing !== null && landing > back ? landing : back;
  }

  /**
   * When a price change's answer returned, for the walk its proof asks for: the attempt's finish,
   * or for a call a dead process never saw return, the moment the record opened again and
   * recovered it. A walk made before the crash cannot be the proof.
   */
  private priceAnswerReturned(action: ActionRow): string {
    const attempt = this.context.database.latestAttempt(action.id);
    if (attempt && attempt.finished_at === null && action.error === INTERRUPTED_BEFORE_OUTCOME) return action.updated_at;
    return attemptReturned(this.context.database, action);
  }

  /**
   * Whether an answer settles the price change it answers. One answer does: the venue accepted
   * the change, asked for no confirmation, and named the listing's price as the very price sent,
   * which is the venue stating the listing's price as it now is. The outcome's kind and evidence
   * say so, never the venue's code alone: an accepted code beside another price, or beside none,
   * states nothing about the price asked for. Isolated so a saboteur can settle on the code.
   */
  protected priceAnswerSettles(params: PriceUpdateParams, outcome: MutationOutcome): boolean {
    return outcome.kind === 'SUBMITTED' && outcome.evidence === 'price-updated' && listingPriceInEffect(outcome) === params.priceReceiveCents;
  }

  /**
   * Whether the command a price change's hop belongs to was stopped while its update was on the
   * wire. Stop withdraws a lower price that waits for its confirmation; one still unanswered at the
   * Stop is withdrawn the moment its answer says it waits, because nothing drives a stopped
   * command's hops to its deadline. Isolated so a saboteur can leave it waiting.
   */
  protected stoppedWhileSent(action: ActionRow): boolean {
    const hop = action.step_id ? new WorkStore(this.context.database).step(action.step_id) : undefined;
    return hop !== undefined && this.context.database.command(hop.command_id)?.state === 'STOPPED';
  }

  /**
   * Whether a change Steam refused for its cooldown may wait to be sent again: not under a stopped
   * command, which halts every send not yet made and whose hops nothing drives, so a change revived
   * there would read as held for ever. Isolated so a saboteur can revive it anyway.
   */
  protected mayResend(action: ActionRow): boolean {
    const hop = action.step_id ? new WorkStore(this.context.database).step(action.step_id) : undefined;
    return hop === undefined || this.context.database.command(hop.command_id)?.state !== 'STOPPED';
  }

  /**
   * A refused change under a stopped command, which sent nothing that can still land: stopped in the
   * person's word, as Stop stops every unsent hop, and its member closed with it once nothing of it
   * is open. In the caller's transaction.
   */
  private stopUnsentChange(action: ActionRow, at: string): void {
    const { database } = this.context;
    const work = new WorkStore(database);
    database.setActionState(action.id, 'FAILED', at, COMMAND_STOPPED);
    const hop = action.step_id ? work.step(action.step_id) : undefined;
    if (!hop || (isSettled(hop) && hop.state !== 'FAILED')) return;
    work.settle(hop.id, 'STOPPED', null, at, COMMAND_STOPPED);
    work.stopLater(hop, at, COMMAND_STOPPED);
    if (hop.local_id && work.hopsOf(hop.command_id, hop.account_id, hop.local_id).every((step) => step.state === 'STOPPED')) {
      database.setCommandMember(hop.command_id, hop.account_id, hop.local_id, { state: 'STOPPED' });
    }
  }

  /** How many cooldown refusals end a price change. Isolated so a saboteur can send for ever. */
  protected cooldownRefusalLimit(): number {
    return PRICE_COOLDOWN_REFUSALS;
  }

  /**
   * What a price change's answer writes, in one transaction with the hop that follows it, the
   * moment its attempt is finished.
   *
   * - **The listing's price stated back, with no confirmation asked.** The change is done on the
   *   answer and no walk is asked for: the row takes the stated seller price, a buyer price by the
   *   fee rule until the next walk reads Steam's own, when the answer said so, and the cooldown
   *   the change starts. This is the one answer that is taken as the state it describes, because
   *   it describes it: every other answer is evidence about an attempt (rule 1).
   * - **A lower price the venue holds until it is confirmed.** Whatever the record held, for the
   *   answer is what says the price is lower: the listing may have moved since the walk the change
   *   was admitted on. The cooldown starts, the listing keeps its price in the record as it does on
   *   the market, the action waits for the walk that shows the new one, and its hop takes the
   *   deadline past which the change is withdrawn (`PRICE_CHANGE_CONFIRM_DEADLINE_MS`).
   * - **Refused for the cooldown.** The wait Steam named replaces whatever the record held, up or
   *   down, and the change goes back to waiting for it. A second such refusal fails it.
   * - **Anything else** writes nothing: a complete walk begun after the answer decides.
   */
  protected recordPriceAnswer(action: ActionRow, params: PriceUpdateParams, outcome: MutationOutcome, at: string): void {
    const { database } = this.context;
    const store = new OrderStore(database);
    if (this.priceAnswerSettles(params, outcome)) {
      const buyerCents = buyerPaysFor('steam', params.priceReceiveCents, feeTermsNow(latestWalletStatement(database, action.account_id), at, params.currency));
      store.stateSteamPrice(action.account_id, params.listingId, { receiveCents: params.priceReceiveCents, buyerCents }, at, cooldownEnd(at));
      database.resolveActionOnAnswer(action.id, at);
      return;
    }
    if (outcome.kind === 'SUBMITTED' && outcome.evidence === 'price-change-awaiting-confirmation') {
      store.setRepriceReadyAt(action.account_id, params.listingId, cooldownEnd(at));
      database.awaitConfirmationOf(action.id, at);
      // Nothing walks while it waits on a person, so a time is what ends it (D15).
      if (action.step_id) new WorkStore(database).update(action.step_id, { deadline_at: priceChangeDeadline(at) }, at);
      // Stopped while the change was on the wire: what Stop would have withdrawn, had it been waiting
      // then, is withdrawn now, before anything can press it (D16, D21).
      if (this.stoppedWhileSent(action)) this.queuePriceDiscard(database.action(action.id)!, 'stopped');
      return;
    }
    if (outcome.kind === 'DEFINITIVELY_REJECTED' && outcome.reason === 'cooldown' && outcome.retryAfterMs !== undefined) {
      store.setRepriceReadyAt(action.account_id, params.listingId, cooldownEnd(at, outcome.retryAfterMs));
      // Nothing changed and nothing is in flight: the same request waits for the time Steam named,
      // unless its command was stopped meanwhile, which halts every send not yet made (D24).
      if (database.definiteRefusals(action.id) >= this.cooldownRefusalLimit()) database.setActionState(action.id, 'FAILED', at, PRICE_COOLDOWN_REFUSED);
      else if (this.mayResend(action)) database.reviveRefusedAction(action.id, at);
      else this.stopUnsentChange(action, at);
    }
  }

  /** Resolves sell-listing actions against one complete market observation. */
  /**
   * What a waiting listing action needs walked before `reconcile` can settle it (settling and
   * read path plan D5). A listing Steam shows as awaiting confirmation waits on the phone: no
   * walk hurries that, and polling the book while the phone is in a drawer only spends budget.
   * A lower price Steam holds until it is confirmed waits on a person the same way; a price
   * change whose answer said nothing usable needs the book walked after it, and one being withdrawn
   * needs it walked after its discard returned, as the discard itself does.
   */
  needs(action: ActionRow): ProofNeed {
    const { database } = this.context;
    const after = attemptReturned(database, action);
    if (action.kind === UPDATE_SELL_LISTING_PRICE) {
      if (action.resolution === 'AWAITING_CONFIRMATION') {
        const byEmail = priceChangeConfirmer(database.latestAttempt(action.id)?.response_ref) === 'email';
        return { kind: 'person', reason: byEmail ? 'Confirm the price change with the link Steam sent by e-mail' : 'Confirm the price change in the Steam mobile app' };
      }
      if (action.resolution === PRICE_CHANGE_DISCARD_SENT) {
        // Nothing to read for until the discard is back, and until an unheard send of it can no longer land.
        const back = this.discardReturnedAt(action);
        return back === null || back > this.context.now() ? { kind: 'none' } : { kind: 'walks', walks: [{ ref: ACCOUNT_MARKET, startedAfter: back }] };
      }
      return { kind: 'walks', walks: [{ ref: ACCOUNT_MARKET, startedAfter: this.priceAnswerReturned(action) }] };
    }
    if (action.kind === DISCARD_SELL_LISTING_PRICE_CHANGE) {
      const back = this.discardSettlesAfter(action);
      return back === null || back > this.context.now() ? { kind: 'none' } : { kind: 'walks', walks: [{ ref: ACCOUNT_MARKET, startedAfter: back }] };
    }
    if (action.kind === 'CREATE_SELL_LISTING') {
      const pending = new OrderStore(database).openSteamListingAt(action.account_id, action.target_id, (database.actionParams(action) as SellParams).priceReceiveCents);
      if (pending?.raw_bucket === 'PENDING_CONFIRMATION') return { kind: 'person', reason: 'Confirm the listing in the Steam mobile app' };
      // The book, and the inventory: a request the book never showed is proved not to have landed
      // only by the item still held, and once the item is gone it is the history that says *sold*.
      const item = database.itemByLocalId(action.account_id, action.target_id);
      const walks = [{ ref: ACCOUNT_MARKET, startedAfter: after }, { ref: ACCOUNT_INVENTORY, startedAfter: after }];
      return { kind: 'walks', walks: item && item.location !== 'MAIN' ? [...walks, { ref: ACCOUNT_HISTORY, startedAfter: after }] : walks };
    }
    if (action.kind === 'REMOVE_SELL_LISTING') {
      // Gone from the book is half of it; back in inventory is what tells a cancel from a sale.
      return { kind: 'walks', walks: [{ ref: ACCOUNT_MARKET, startedAfter: after }, { ref: ACCOUNT_INVENTORY, startedAfter: after }] };
    }
    return { kind: 'none' };
  }

  /** The kind's row in `RETRY_POLICY`. Isolated so a saboteur can retry without end; nothing shipped overrides it. */
  protected retryPolicyFor(action: ActionRow): RetryPolicy {
    return RETRY_POLICY[action.kind] ?? NEVER_RETRY;
  }

  /**
   * Whether a listing request absent from a complete market walk begun after the attempt is
   * proved not to have landed: `proved` when a complete inventory walk begun after that market
   * walk still holds the item in main inventory, `gone` when such a walk no longer holds it, which
   * is what a sale before the first walk looks like, and `unknown` until one has been made. The
   * inventory walk must begin after the market walk, not merely after the attempt: a sale between
   * the two would leave an older walk holding an item the book had already sold. Isolated so a
   * saboteur can read the empty book alone as proof, which is the belief that sent ten sold
   * listings again.
   */
  protected listingRequestProvedNotApplied(action: ActionRow, market: ObservationRow): 'proved' | 'gone' | 'unknown' {
    const { database } = this.context;
    const held = locationEvidence(database, action.account_id, action.target_id, 'MAIN', this.context.ports.clock.now(), action);
    if (held.grade === 'UNKNOWN') return 'unknown';
    const proof = database.observation(action.account_id, held.observationId);
    if (!proof || proof.started_at < market.started_at) return 'unknown';
    return held.grade === 'SATISFIED' ? 'proved' : 'gone';
  }

  /**
   * Whether a complete walk that still shows the listing proves a cancel did not take: it is open
   * in this very walk, and the caller has already required the walk to have begun after the
   * attempt returned (`postAttempt`, absence). The buy-order reconciler's twin; isolated so a
   * saboteur can read it as "Steam has not caught up yet", which is the belief that left a delist
   * waiting for ever.
   */
  protected delistProvedNotApplied(listing: { gone_obs: number | null; last_seen_obs: number | null }, obs: ObservationRow): boolean {
    return listing.gone_obs === null && listing.last_seen_obs === obs.id;
  }

  reconcile(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    for (const action of database.awaitingActionsOfKinds(accountId, ['CREATE_SELL_LISTING', 'REMOVE_SELL_LISTING'])) {
      const obs = database.latestObservation(accountId, 'steam-market');
      const evidence = surfaceEvidence(database, accountId, ACCOUNT_MARKET, this.context.ports.clock.now());
      if (!obs || evidence.grade !== 'SATISFIED' || obs.id !== observationId) continue;

      if (action.kind === 'CREATE_SELL_LISTING') {
        // The walk binds a listing to the row holding its asset id — for a case exactly as for a
        // skin, since a round-trip keeps the id (rule 3) — so the action's target is the match.
        const row = new OrderStore(database).openSteamListingAt(accountId, action.target_id, (database.actionParams(action) as SellParams).priceReceiveCents);
        if (row && (row.last_seen_obs !== obs.id || !postAttempt(database, action, obs, false))) continue;
        if (row?.raw_bucket === 'ACTIVE' || row?.raw_bucket === 'ON_HOLD') {
          database.resolveAction(action, obs.id, true, this.context.now());
        } else if (row?.raw_bucket === 'PENDING_CONFIRMATION') {
          database.raw().prepare(`UPDATE action SET resolved_by_obs=?, resolution='OBSERVED_APPLIED' WHERE id=?`).run(obs.id, action.id);
          // Still waiting on the user's phone. The transition event is emitted once, by
          // persist(); re-emitting here would grow the timeline on every sync.
          continue;
        } else {
          if (!postAttempt(database, action, obs, true)) continue;
          const attempt = database.latestAttempt(action.id)!;
          const everSeen = database.raw().prepare(`SELECT 1 FROM venue_order v JOIN observation o ON o.id=v.first_seen_obs
            WHERE v.account_id=? AND v.local_id=? AND v.venue='steam' AND v.side='SELL' AND o.finished_at>=?`).get(accountId, action.target_id, attempt.started_at);
          if (everSeen || action.resolution === 'OBSERVED_APPLIED') {
            // A goal is parked so nothing relists; a hop's listing is the hop's outcome, and the order lifecycle explains what ended it.
            if (action.desired_id !== null) database.suspendGoal(accountId, action.desired_id, LISTING_REVERSED, this.context.now());
            database.resolveAction(action, obs.id, true, this.context.now());
          } else {
            // Never on the book in a complete walk begun after the attempt. That alone is not
            // proof the request did not land: a listing can sell before the first walk after it,
            // and then the book never showed it and the item is gone. Ten did on 2026-10-14, were
            // read as never sent, and were sent again against an inventory that no longer held
            // them. The request did not land only when the item is still held (order-lifecycle
            // A1); gone, it waits for the history to say sold (`OrderService.bindSales`).
            const held = this.listingRequestProvedNotApplied(action, obs);
            if (held === 'unknown') continue;
            if (held === 'gone') {
              database.addEventOnce(accountId, 'listing-unresolved-sale-race', { actionId: action.id, localId: action.target_id }, this.context.now());
              continue;
            }
            // Convergence sends the `READY` action once more, and the cap, like every kind's, is `kernel/retry-policy.ts`.
            settleNotApplied(this.context, action, obs.id, 'Steam never showed the listing', { policy: this.retryPolicyFor(action) });
          }
        }
      } else {
        if (!postAttempt(database, action, obs, true)) continue;
        const params = database.desiredParams(action) as DelistParams;
        const listing = new OrderStore(database).steamListing(accountId, params.listingId);
        if (listing && this.delistProvedNotApplied(listing, obs)) {
          // Still on the book in a complete walk begun after the cancel returned: the cancel did
          // not take (order-lifecycle B1). This branch was missing, so a cancel whose request died
          // in transport waited for ever, *Sent, waiting for Steam to show it*, on a listing
          // nothing was removing. Now it is sent again on the cancel schedule and fails with the
          // reason after the last; `RetryService` sends, `kernel/retry-policy.ts` says when.
          settleNotApplied(this.context, action, obs.id, 'Steam still shows the listing', { policy: this.retryPolicyFor(action) });
          continue;
        }
        if (!listing || listing.gone_obs === null) continue;
        const item = listing.local_id ? database.itemByLocalId(accountId, listing.local_id)
          : listing.asset_id ? database.itemByAssetId(accountId, listing.asset_id) : undefined;
        const returned = item
          ? locationEvidence(database, accountId, item.local_id, 'MAIN', this.context.ports.clock.now(), action)
          : undefined;
        if (returned?.grade === 'SATISFIED') {
          // The asset came back, so the listing was cancelled rather than sold.
          database.resolveAction(action, obs.id, true, this.context.now());
        } else {
          // Gone from the market and not back in inventory: this may have been a sale. Never
          // report a successful cancel here.
          database.addEventOnce(accountId, 'delist-unresolved-sale-race', { listingId: params.listingId }, this.context.now());
        }
      }
    }
    new HoldingsStore(database).releaseSettledListingReservations(accountId);
    reconcileDivergence(this.context, accountId);
    this.orders.decideOrders(accountId, this.orders.classifyOrders(accountId, observationId));
    // After the orders are graded: a price change on a listing that left the book is decided by how it left.
    this.reconcilePriceChanges(accountId, observationId);
    this.reconcileDiscards(accountId, observationId);
  }

  /**
   * When a discard returned, from its own attempt; `null` while it is owed a send (never sent,
   * refused for the moment, or owed again after an answer that never came) or on the wire. One
   * refused because the market has no discard returned at that refusal (`discardUnavailable`). One a
   * dead process sent and never heard back from has not returned: it is owed again
   * (`reviveInterruptedDiscards`), and no walk decides its change meanwhile.
   */
  private discardReturned(discard: ActionRow): string | null {
    if (discard.state === 'READY' || discard.state === 'RUNNING') return null;
    const attempt = this.context.database.latestAttempt(discard.id);
    if (!attempt) return discard.state === 'FAILED' ? discard.updated_at : null;
    return attempt.finished_at;
  }

  /**
   * Closes each discard once the change it withdraws has ended. What a walk says about the change
   * is the change's (`reconcilePriceChanges`), and the change ends first; what is left for the
   * discard is whether it was in time. The walk begun after it returned showing the new price says
   * it was not: the lower price had been confirmed. Anything else closes it done, on this walk: no
   * walk can show a price change that waits, so done means only that nothing of ours is left
   * waiting on the listing. A change can end before its discard has gone out or come back, by a
   * sale: a discard still owed is then failed unsent, and one on the wire is closed once it returns.
   */
  protected reconcileDiscards(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    const obs = database.observation(accountId, observationId);
    if (!obs?.complete || obs.surface !== 'steam-market') return;
    const now = this.context.now();
    const discards = database.raw().prepare(`SELECT * FROM action INDEXED BY action_ready WHERE account_id=? AND state IN ('READY','AWAITING_OBSERVATION')
      AND kind='${DISCARD_SELL_LISTING_PRICE_CHANGE}' ORDER BY created_at, id`).all(accountId) as ActionRow[];
    for (const discard of discards) {
      const change = this.changeOf(discard);
      if (change?.state === 'AWAITING_OBSERVATION') continue;
      if (discard.state === 'READY') {
        database.setActionState(discard.id, 'FAILED', now, DISCARD_NOT_NEEDED);
        continue;
      }
      const back = this.discardReturned(discard);
      if (back === null) continue;
      if (change?.state === 'DONE' && change.resolved_by_obs === obs.id && obs.started_at > back) database.failActionOnObservation(discard.id, obs.id, DISCARD_TOO_LATE, now);
      else database.resolveAction(discard, obs.id, true, now);
    }
  }

  /**
   * Whether a price change waits for its confirmation: what Steam's answer said, never what the
   * prices it was admitted with imply. The listing may have moved since the walk it was admitted
   * on, and a change that looked like a raise is a lower price to Steam. Isolated
   * so a saboteur can read the direction off the frozen prices.
   */
  protected waitsForConfirmation(action: ActionRow, _params: PriceUpdateParams): boolean {
    return action.resolution === 'AWAITING_CONFIRMATION';
  }

  /**
   * Whether a price change's listing sold, as the order service graded it on its own evidence: then
   * nothing is left to price, whether the change waited for a walk, for its confirmation or for its
   * discard's walk, and whatever its command's state. Isolated so a saboteur can leave a sale to the
   * command's own pass, which a stopped command never gets.
   */
  protected endedBySale(listing: SteamListingRow): boolean {
    return listing.state === 'ENDED_FILLED';
  }

  /**
   * The price a waiting change's listing is still on sale at: what Steam's answer said it was as it
   * held the lower price, which is what a walk shows while it waits; the price the change was
   * admitted with when the answer named none. Isolated so a saboteur can judge by the frozen price.
   */
  protected priceInEffect(action: ActionRow, params: PriceUpdateParams): number {
    return priceChangeInEffect(this.context.database.latestAttempt(action.id)?.response_ref) ?? params.fromPriceCents;
  }

  /**
   * Decides the price changes a walk is the proof of: one whose answer said nothing usable, and a
   * lower price waiting for its confirmation. The price asked for, shown by a complete walk made
   * since the attempt began, is the change seen applied. Everything else is a conclusion from what
   * the walk does not show, and only a complete walk begun after the answer returned may draw it
   * (rule 1); for a call a dead process never saw return, after the record opened again and
   * recovered it (rule 6). What the walk shows is read against the two prices the change was
   * admitted with:
   *
   * - the price asked for: applied, and done on this walk;
   * - the price it had: a waiting lower price goes on waiting. After an answer that said nothing,
   *   a raise is proved not applied and is sent once more (`kernel/retry-policy.ts`), unless the
   *   answer carried the venue's code for a listing it will not edit, which fails it as
   *   `price-edit-unavailable`; a lower price fails as `unanswered` and is never sent again,
   *   because Steam may be holding it for a confirmation and the book would look the same;
   * - any other price, or the listing gone and not sold: failed, with what was seen.
   *
   * A sale ends the change before any of that, wherever it is found and whatever the change was
   * waiting for or its command's state (`endedBySale`): a stopped command has no pass of its own to
   * end it, and a sale the order service graded waits for no walk. The hop is the command service's
   * to close in the sale's word (`CommandService.reflect`).
   */
  protected reconcilePriceChanges(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    const store = new OrderStore(database);
    for (const found of database.awaitingActionsOfKinds(accountId, [UPDATE_SELL_LISTING_PRICE])) {
      // An answer whose record never wrote is re-derived from the answer itself before it is judged.
      this.repairPriceAnswer(found.id);
      const action = database.action(found.id);
      if (!action || action.state !== 'AWAITING_OBSERVATION') continue;
      const params = database.actionParams(action) as PriceUpdateParams;
      const listing = store.steamListing(accountId, params.listingId);
      if (!listing) continue;
      const now = this.context.now();
      if (this.endedBySale(listing)) {
        database.failActionOnObservation(action.id, listing.end_evidence, SOLD_DURING_PRICE_CHANGE, now);
        continue;
      }
      const obs = database.latestObservation(accountId, 'steam-market');
      const evidence = surfaceEvidence(database, accountId, ACCOUNT_MARKET, this.context.ports.clock.now());
      if (!obs || evidence.grade !== 'SATISFIED' || obs.id !== observationId) continue;
      if (!postAttempt(database, action, obs, false)) continue;
      if (action.resolution === PRICE_CHANGE_DISCARD_SENT) {
        this.decideWithdrawn(action, params, listing, obs);
        continue;
      }
      const after = this.begunAfterPriceAnswer(action, obs);
      if (listing.gone_obs !== null || listing.state.startsWith('ENDED_')) {
        // Sold was ended above; gone and not yet explained waits for the walk that explains it.
        if (!after || listing.state === 'ENDED_FILLED' || !listing.state.startsWith('ENDED_')) continue;
        database.failActionOnObservation(action.id, obs.id, PRICE_CHANGE_LISTING_GONE, now);
        continue;
      }
      if (listing.last_seen_obs !== obs.id || listing.price_cents === null) continue;
      const waiting = this.waitsForConfirmation(action, params);
      if (listing.price_cents === params.priceReceiveCents) {
        // A change the engine sent and timed starts its cooldown at the answer; a confirmation it
        // did not time is bounded by the walks, which the walk's own write has already done.
        if (!waiting) store.setRepriceReadyAt(accountId, params.listingId, cooldownEnd(attemptReturned(database, action)));
        database.resolveAction(action, obs.id, true, now);
        continue;
      }
      // Steam holds the lower price whatever this walk shows: it waits on the person until its deadline (D15).
      if (waiting) continue;
      if (!after) continue;
      // Steam's code for a listing it will not edit, in either direction: nothing is held, and the caller may relist.
      const code = priceChangeVenueCode(database.latestAttempt(action.id)?.response_ref);
      if (code === VENUE_CODE_PRICE_NOT_EDITABLE) {
        database.failActionOnObservation(action.id, obs.id, PRICE_EDIT_UNAVAILABLE, now);
        continue;
      }
      if (listing.price_cents !== params.fromPriceCents) {
        database.failActionOnObservation(action.id, obs.id, neitherPrice(listing.price_cents), now);
        continue;
      }
      if (params.priceReceiveCents < params.fromPriceCents) {
        // Steam may be holding it, and the book would look the same: withdraw it first, then fail it, and never send it again.
        this.withdrawUnanswered(action, obs.id);
        continue;
      }
      const what = code === null ? 'Steam still shows the listing at its old price' : `Steam did not change the price (it answered with code ${code})`;
      settleNotApplied(this.context, action, obs.id, what, { policy: this.retryPolicyFor(action), attempts: sendsThatCouldLand(database, action.id) });
    }
  }

  /**
   * A lower price whose answer never came, and which a walk begun after it shows at the old price.
   * A discard goes first, because Steam may be holding the change unseen and a person could still
   * confirm it; then the walk begun after the discard returned decides it, as every withdrawn change
   * is decided: the price asked for shown, it had been held and was confirmed just before, and is
   * done; otherwise it fails as `unanswered` (`decideWithdrawn`). With no discard on the composed
   * market the walk begun after the refusal decides it the same way. Isolated so a saboteur can fail
   * it on this walk.
   */
  protected withdrawUnanswered(action: ActionRow, observationId: number): void {
    this.queuePriceDiscard(action, 'unanswered', observationId);
  }

  /**
   * Decides a change being withdrawn, on the first complete walk begun after its discard returned,
   * and after any unheard send of it could still land (in-place reprice plan D15, D27). The price
   * asked for shown: it was confirmed before the discard, and is done. Otherwise, when Steam heard
   * none of the discard's sends, it fails `withdrawal-unheard` whatever asked for the withdrawal,
   * because the lower price may still be waiting there (`CommandService.reflect` stops a stopped
   * command's hop with that reason). Otherwise it ends as it was withdrawn: stopped in the person's
   * word; past its deadline, not confirmed when the walk shows the price Steam said the listing was
   * still on sale at, and failed with what was seen when it shows a third; unanswered. A sale has
   * ended it already (`reconcilePriceChanges`), and a listing gone and not yet explained waits for the
   * walk that explains it; one gone and not sold has nothing left waiting on it, unheard or not.
   */
  protected decideWithdrawn(action: ActionRow, params: PriceUpdateParams, listing: SteamListingRow, obs: ObservationRow): void {
    const { database } = this.context;
    const back = this.discardReturnedAt(action);
    if (back === null || !(obs.started_at > back)) return;
    const discard = database.action(priceDiscardId(action.id));
    const why = discard ? (database.actionParams(discard) as PriceDiscardParams).why : 'deadline';
    const now = this.context.now();
    if (listing.gone_obs !== null || listing.state.startsWith('ENDED_')) {
      if (listing.state === 'ENDED_FILLED' || !listing.state.startsWith('ENDED_')) return;
      database.failActionOnObservation(action.id, obs.id, why === 'stopped' ? COMMAND_STOPPED : PRICE_CHANGE_LISTING_GONE, now);
      if (why !== 'stopped') new WorkStore(database).mirror(action.id, now);
      return;
    }
    if (listing.last_seen_obs !== obs.id || listing.price_cents === null) return;
    if (listing.price_cents === params.priceReceiveCents) {
      database.resolveAction(action, obs.id, true, now);
      return;
    }
    if (this.withdrawalUnheard(discard)) {
      database.failActionOnObservation(action.id, obs.id, PRICE_WITHDRAWAL_UNHEARD, now);
      return;
    }
    if (why === 'stopped') {
      // The command service stops the hop in the person's word (`CommandService.reflect`).
      database.failActionOnObservation(action.id, obs.id, COMMAND_STOPPED, now);
      return;
    }
    const reason = why === 'unanswered' ? PRICE_CHANGE_UNANSWERED
      : listing.price_cents === this.priceInEffect(action, params) ? PRICE_CHANGE_NOT_CONFIRMED : neitherPrice(listing.price_cents);
    database.failActionOnObservation(action.id, obs.id, reason, now);
  }

  private persist(
    accountId: string,
    observationId: number,
    listings: MarketListing[],
    holds: MarketListing[],
    confirmations: MarketListing[],
    buyOrders: MarketBuyOrder[],
    statuses: VanishedStatuses = new Map()
  ): void {
    const { database } = this.context;
    // Explicit bucket precedence: a pending confirmation is the most restrictive evidence.
    const buckets = new Map<string, SeenSteamListing>();
    const bucket = (rows: readonly MarketListing[], name: SteamListingBucket): void => {
      for (const listing of rows) buckets.set(listing.listingId, { listing, bucket: name });
    };
    bucket(listings, 'ACTIVE');
    bucket(holds, 'ON_HOLD');
    bucket(confirmations, 'PENDING_CONFIRMATION');
    this.observeListings(accountId, observationId, [...buckets.values()]);

    const store = new OrderStore(database);
    const purchasedBefore = new Map(store.steamBuyOrders(accountId).map((row) => [row.venue_order_id!, row.filled]));
    const filled: string[] = [];
    for (const order of buyOrders) {
      const purchased = order.quantity - order.quantityRemaining;
      const before = purchasedBefore.get(order.buyOrderId) ?? 0;
      if (purchased > before) {
        filled.push(order.buyOrderId);
        // The walk and the status poll are two ways of seeing the same fill. Both go through
        // one writer keyed by the cumulative count, so whichever observes it first posts and
        // the other is a no-op — that is what "exactly once across polling, history and
        // restart" means (BUY-04, N-BUY-01).
        new LedgerStore(database).recordBuyOrderFill({
          accountId, buyOrderId: order.buyOrderId, purchasedTotal: purchased, delta: purchased - before,
          unitPriceCents: order.priceCents, observationId, now: this.context.now(), hashName: order.hashName
        });
      }
    }
    // An order the book no longer shows, whose counter this walk read: what it bought since the
    // last look is posted here, before the order's ending settles what is left of its reservation.
    for (const row of store.buyOrdersMissingFrom(accountId, new Set(buyOrders.map((order) => order.buyOrderId)))) {
      const status = statuses.get(row.venue_order_id!);
      if (!status || status.purchased <= row.filled) continue;
      filled.push(row.venue_order_id!);
      new LedgerStore(database).recordBuyOrderFill({
        accountId, buyOrderId: row.venue_order_id!, purchasedTotal: status.purchased, delta: status.purchased - row.filled,
        unitPriceCents: row.price_cents ?? 0, observationId, now: this.context.now(), hashName: row.hash_name
      });
    }
    this.filledSinceWalk = filled.length;
    store.observeSteamBuyOrders(accountId, observationId, buyOrders, this.context.now(), statuses);
  }

  /**
   * The walk's write of what the book shows: every listing seen, bound to its holding by asset id,
   * and every listing no longer shown marked gone (`OrderStore.observeSteamListings`). The listing
   * names its row, and the row stays where the Game Coordinator holds it: listed is this open
   * listing, not a location (`db/commitment.ts`), and the id survives a cancel (rule 3). Where a
   * gone listing's item is stays the GC's to say, so this walk moves no item (rule 5).
   */
  /**
   * Whether a walk began after a price change's answer returned, which is what lets it say the
   * change did not apply: after the attempt finished, or, for a call a dead process never saw
   * return, after the record opened again and recovered it.
   */
  private begunAfterPriceAnswer(action: ActionRow, obs: ObservationRow): boolean {
    const { database } = this.context;
    if (postAttempt(database, action, obs, true)) return true;
    const attempt = database.latestAttempt(action.id);
    return attempt !== undefined && attempt.finished_at === null && action.error === INTERRUPTED_BEFORE_OUTCOME && obs.started_at > action.updated_at;
  }

  protected observeListings(accountId: AccountId, observationId: number, seen: readonly SeenSteamListing[]): void {
    const store = new OrderStore(this.context.database);
    const contradicted = store.observeSteamListings(accountId, observationId, seen, this.context.now(), this.walkTimes(accountId, observationId), this.priceAnswerGuardMs());
    for (const contradiction of contradicted) {
      if (!this.ownLaterChangeExplains(accountId, contradiction)) this.priceAnswerContradicted(accountId, contradiction, observationId);
    }
  }

  /**
   * How long before an answer a walk may have begun and still be kept from undoing it
   * (`PRICE_ANSWER_GUARD_MS`). Isolated so a saboteur can guard for ever.
   */
  protected priceAnswerGuardMs(): number {
    return PRICE_ANSWER_GUARD_MS;
  }

  /**
   * Whether a later price change of this app's own on the listing explains a walk showing another
   * price than an answer stated: one sent after that answer, asking for the very price the walk
   * shows, may have landed whatever its own answer said, and the walk is then showing ours. One that
   * asked for another price explains nothing about this one. Isolated so a saboteur can count it as
   * a contradiction, or let any later change explain any price.
   */
  protected ownLaterChangeExplains(accountId: AccountId, contradiction: PriceContradiction): boolean {
    return new OrderStore(this.context.database).priceChangeSentSince(accountId, contradiction.listingId, contradiction.statedAt, contradiction.observedCents);
  }

  /**
   * When this walk of the book began, and when the complete walk before it did: what decides
   * whether the walk can have seen a price an answer stated, and whether two walks bound an event
   * neither timed (`OrderStore.observeSteamListings`). Isolated so a saboteur can misread either.
   */
  protected walkTimes(accountId: AccountId, observationId: number): SteamWalkTimes {
    return new OrderStore(this.context.database).steamWalkTimes(accountId, observationId);
  }

  /**
   * The first walk begun after an answer stated a listing's price shows the listing at another,
   * and nothing this app sent since explains it. The walk has already replaced the price, as every
   * walk does; this is the one record that the answer and the book disagreed, which is how anyone
   * learns whether trusting the answer is safe. Written once: the stated price the walk was
   * compared with is cleared by that walk. The event carries the venue, the listing, the seller
   * price stated and the one observed, and the walk that showed it: the same fields a CSFloat
   * reprice's contradiction carries, so one reader counts both. Isolated so a saboteur can say nothing.
   */
  protected priceAnswerContradicted(accountId: AccountId, contradiction: PriceContradiction, observationId: number): void {
    this.context.database.addEvent(accountId, PRICE_ANSWER_CONTRADICTED, {
      venue: 'steam', listingId: contradiction.listingId, statedCents: contradiction.statedCents, observedCents: contradiction.observedCents, observationId
    }, this.context.now());
  }

  /**
   * An empty market is believable when every listing it would end is accounted for: market
   * history names it cancelled or sold, or this app sent a cancel for it that Steam did not refuse.
   * Failing that, it is believable when the session that read it is shown to be signed in
   * (`emptyFromSignedInSession`).
   *
   * The inventory cannot vouch for it. The Game Coordinator keeps a listed item in main inventory
   * (`db/commitment.ts`), so a live listing and a cancelled one look the same from there, and a
   * stale session's empty answer is exactly the shape that would make every one of them look
   * cancelled. A cancel of our own is different: it is a reason, recorded before the walk, for the
   * book to be empty, and the delist it belongs to is still graded by `reconcile` on its own proof.
   */
  /**
   * The empty book that nothing in the record explains, read again by a session shown to be signed in.
   *
   * The guard above exists for one failure: a stale session answering `success` with every bucket
   * empty, which believed would end a whole book. History cannot tell that apart from a real
   * ending, because Steam's history names sales and purchases and never a cancellation (corpus
   * `steamcommunity.market.myhistory`). So a book the person emptied on the website — their last
   * listing cancelled there, or one never confirmed and withdrawn — read as stale for ever, and the
   * account's market walk never completed again (L-04 and M-04, 2026-10-15).
   *
   * What does tell them apart is the session. The wallet comes from the market page, which carries
   * it only for a signed-in session (corpus `steamcommunity.market.wallet-info`): a stale session
   * fails the read and the walk stays suspicious (OBS-EMPTY). Read first and the book after it, so
   * the empty answer believed is one given to a session already shown to be live. Believing the
   * walk concludes nothing about why each listing went: `OrderService.reconcile` still ends one only
   * on history, or on an inventory walk that still holds its item, and waits otherwise (OBS-EMPTY-02).
   */
  protected async emptyFromSignedInSession(accountId: AccountId, pageSize: number): Promise<boolean> {
    const proof = this.context.database.observation(accountId, await this.syncWallet(accountId));
    if (!proof?.complete) return false;
    try {
      const again = await this.context.ports.market.getMyListingsPage(accountId, 0, pageSize);
      return again.start === 0 && again.totalCount === 0
        && again.listings.length === 0 && again.listingsOnHold.length === 0 && again.listingsToConfirm.length === 0;
    } catch {
      return false;
    }
  }

  private emptyIsCorroborated(accountId: string, open: readonly SteamListingRow[]): boolean {
    const { database } = this.context;
    // A cancel we sent for it, by hand (a goal's action) or as a chain's hop (a step's): both carry
    // the listing id in the action's own params.
    const cancelled = database.raw().prepare(`SELECT 1 FROM action a JOIN attempt t ON t.action_id=a.id
      WHERE a.account_id=? AND a.kind='REMOVE_SELL_LISTING' AND json_extract(a.params_json,'$.listingId')=?
        AND IFNULL(t.outcome,'')<>'DEFINITIVELY_REJECTED' LIMIT 1`);
    return open.every((listing) => this.orders.historyExplainsEmpty(accountId, listing.venue_order_id!)
      || Boolean(cancelled.get(accountId, listing.venue_order_id)));
  }
}
