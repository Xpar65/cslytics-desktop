import type { AccountId, MarketBuyOrder, MarketListing, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, ObservationRow } from '../db/database.js';
import { type EngineContext, executeMutation } from '../kernel/context.js';
import { errorMessage, required } from '../kernel/support.js';
import { ACCOUNT_MARKET, ACCOUNT_INVENTORY, attemptReturned, surfaceEvidence, postAttempt, locationEvidence, evaluatePreconditions, PRECONDITIONS, requirePreconditions, type ProofNeed } from '../kernel/evidence.js';
import { LISTING_REVERSED, reconcileDivergence } from '../policy/divergence.js';
import { settleNotApplied } from '../kernel/not-applied.js';
import { NEVER_RETRY, RETRY_POLICY, type RetryPolicy } from '../kernel/retry-policy.js';
import { OrderService } from './orders.js';
import { HoldingsStore } from '../db/holdings.js';
import { LedgerStore } from '../db/ledger.js';
import { WorkStore } from '../db/work.js';
import { OrderStore, type SeenSteamListing, type SteamListingRow } from '../db/orders.js';
import { committedSql } from '../db/commitment.js';
import { CsfloatStore } from '../db/csfloat.js';
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
      if (complete) this.persist(accountId, obs, listings, holds, confirmations, buyOrders);
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
          INSERT INTO wallet_snapshot(account_id, observation_id, observed_at, balance_cents, delayed_balance_cents, currency)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(accountId, observationId, wallet.observedAt, wallet.balanceCents, wallet.delayedBalanceCents, wallet.currency);
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
   * action is the hop's (D3). The work panel reads it as any other hop; a reprice's own delist is
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
   * The delist hop of a reprice or a delist-to-storage: the same admission as `queueDelist`, on the
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

  /** Resolves sell-listing actions against one complete market observation. */
  /**
   * What a waiting listing action needs walked before `reconcile` can settle it (settling and
   * read path plan D5). A listing Steam shows as awaiting confirmation waits on the phone: no
   * walk hurries that, and polling the book while the phone is in a drawer only spends budget.
   */
  needs(action: ActionRow): ProofNeed {
    const { database } = this.context;
    const after = attemptReturned(database, action);
    if (action.kind === 'CREATE_SELL_LISTING') {
      const pending = new OrderStore(database).openSteamListingAt(action.account_id, action.target_id, (database.actionParams(action) as SellParams).priceReceiveCents);
      if (pending?.raw_bucket === 'PENDING_CONFIRMATION') return { kind: 'person', reason: 'Confirm the listing in the Steam mobile app' };
      return { kind: 'walks', walks: [{ ref: ACCOUNT_MARKET, startedAfter: after }] };
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
            // Never on the book in a complete walk begun after the attempt: the request did not
            // land (order-lifecycle A1). Convergence sends the `READY` action once more, and the
            // cap, like every kind's, is `kernel/retry-policy.ts`.
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
  }

  private persist(
    accountId: string,
    observationId: number,
    listings: MarketListing[],
    holds: MarketListing[],
    confirmations: MarketListing[],
    buyOrders: MarketBuyOrder[]
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
          unitPriceCents: order.priceCents, observationId, now: this.context.now()
        });
      }
    }
    this.filledSinceWalk = filled.length;
    store.observeSteamBuyOrders(accountId, observationId, buyOrders, this.context.now());
  }

  /**
   * The walk's write of what the book shows: every listing seen, bound to its holding by asset id,
   * and every listing no longer shown marked gone (`OrderStore.observeSteamListings`). The listing
   * names its row, and the row stays where the Game Coordinator holds it: listed is this open
   * listing, not a location (`db/commitment.ts`), and the id survives a cancel (rule 3). Where a
   * gone listing's item is stays the GC's to say, so this walk moves no item (rule 5).
   */
  protected observeListings(accountId: AccountId, observationId: number, seen: readonly SeenSteamListing[]): void {
    new OrderStore(this.context.database).observeSteamListings(accountId, observationId, seen, this.context.now());
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
