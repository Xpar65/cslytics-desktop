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

export type MarketSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  totalExpected: number | null;
  error?: string;
};

export type SellParams = { priceReceiveCents: number };
export type DelistParams = { listingId: string };

const OPEN_STATUSES = "('ACTIVE','ON_HOLD','PENDING_CONFIRMATION')";

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
  sync(accountId: AccountId, pageSize = 500): Promise<MarketSyncResult> {
    return this.context.reads.run(`${accountId}:steam-market`, () => this.walk(accountId, pageSize));
  }

  private async walk(accountId: AccountId, pageSize: number): Promise<MarketSyncResult> {
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

    const previousOpen = database.raw()
      .prepare(`SELECT COUNT(*) AS count FROM market_listing WHERE account_id=? AND status IN ${OPEN_STATUSES}`)
      .get(accountId) as { count: number };
    const observedCount = listings.length + holds.length + confirmations.length;
    const bucketsEmpty = listings.length === 0 && holds.length === 0 && confirmations.length === 0;
    if (!error && totalExpected === 0 && bucketsEmpty && previousOpen.count > 0 && !this.emptyIsCorroborated(accountId)) {
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
      if (complete) this.persist(accountId, obs, listings, holds, confirmations, buyOrders);
      database.addEvent(accountId, complete ? 'market-snapshot' : 'market-snapshot-incomplete', {
        observationId: obs,
        pagesWalked,
        totalExpected,
        observedCount,
        error
      }, this.context.now());
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

  syncWallet(accountId: AccountId): Promise<number> {
    return this.context.reads.run(`${accountId}:steam-wallet`, () => this.readWallet(accountId));
  }

  private async readWallet(accountId: AccountId): Promise<number> {
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

  queueSellListing(accountId: AccountId, localId: string, priceReceiveCents: number, basis = 'manual'): ActionRow {
    const { database } = this.context;
    // sellitem takes integer cents the seller receives, not the buyer price (CLAUDE.md rule 4).
    if (!Number.isInteger(priceReceiveCents) || priceReceiveCents <= 0) {
      throw new Error('Seller-receives price must be positive integer cents');
    }
    const item = required(database.itemByLocalId(accountId, localId), `Unknown item ${localId}`);
    if (item.location !== 'MAIN' || !item.current_asset_id) throw new Error('Item is not available in main inventory');
    // Exclusivity is per item, not per venue (order-lifecycle.md D16). Asking `market_listing`
    // asks only whether *Steam* holds it, which is the question that stops being sufficient
    // the moment a second venue lists out of the same inventory.
    const active = database.raw()
      .prepare(`SELECT 1 FROM venue_order WHERE account_id=? AND local_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%'
        UNION ALL SELECT 1 FROM market_listing WHERE account_id=? AND local_id=? AND status IN ${OPEN_STATUSES}`)
      .get(accountId, localId, accountId, localId);
    if (active) throw new Error('Item already has an open sell order');

    return database.createDesiredAction({
      accountId,
      targetKind: 'sell-listing',
      targetId: localId,
      intent: 'LISTED_AT',
      params: { priceReceiveCents } satisfies SellParams,
      basis,
      actionKind: 'CREATE_SELL_LISTING',
      resourceKey: `item:${localId}`,
      now: this.context.now()
    });
  }

  /**
   * Asset ids this account has on the market, or has sent there and no walk has yet placed.
   * The Game Coordinator keeps a listed item in the inventory (`steam/interactions.md`), so a
   * handle's location cannot answer this on its own.
   */
  listedAssets(accountId: AccountId): Set<string> {
    const rows = this.context.database.raw().prepare(`
      SELECT asset_id AS assetId FROM market_listing WHERE account_id=? AND status IN ${OPEN_STATUSES}
      UNION SELECT json_extract(venue_detail_json,'$.assetId') FROM venue_order
        WHERE account_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%'`).all(accountId, accountId) as Array<{ assetId: string | null }>;
    return new Set(rows.map((row) => row.assetId).filter((id): id is string => typeof id === 'string' && id.length > 0));
  }

  async executeSellListing(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.actionParams(action) as SellParams;
    const item = required(database.itemByLocalId(action.account_id, action.target_id), `Unknown item ${action.target_id}`);
    if (item.location !== 'MAIN' || !item.current_asset_id) throw new Error('Item is not available in main inventory');
    const assetId = required(item.current_asset_id ?? undefined, 'Item has no current Steam asset id');
    return executeMutation(this.context, action, () =>
      this.context.ports.market.createSellListing(action.account_id, assetId, params.priceReceiveCents), () => {
        requirePreconditions(evaluatePreconditions(database, action.account_id, action.target_id, PRECONDITIONS.CREATE_SELL_LISTING, this.context.ports.clock.now()));
        if (database.itemByLocalId(action.account_id, action.target_id)?.current_asset_id !== assetId) throw new Error('Item asset changed before listing');
      });
  }

  queueDelist(accountId: AccountId, listingId: string, basis = 'manual'): ActionRow {
    const { database } = this.context;
    const listing = database.raw()
      .prepare(`SELECT local_id FROM market_listing WHERE account_id=? AND listing_id=?`)
      .get(accountId, listingId) as { local_id: string | null } | undefined;
    if (!listing) throw new Error(`Unknown listing ${listingId}`);
    return database.createDesiredAction({
      accountId,
      targetKind: 'sell-listing',
      targetId: listing.local_id ?? listingId,
      intent: 'DELISTED',
      params: { listingId } satisfies DelistParams,
      basis,
      actionKind: 'REMOVE_SELL_LISTING',
      resourceKey: listing.local_id ? `item:${listing.local_id}` : `listing:${listingId}`,
      now: this.context.now()
    });
  }

  async executeDelist(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.desiredParams(action) as DelistParams;
    return executeMutation(this.context, action, () =>
      this.context.ports.market.removeListing(action.account_id, params.listingId));
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
      const pending = database.raw().prepare(`SELECT 1 FROM market_listing WHERE account_id=? AND local_id=? AND price_receive_cents=? AND status='PENDING_CONFIRMATION'`)
        .get(action.account_id, action.target_id, (database.actionParams(action) as SellParams).priceReceiveCents);
      if (pending) return { kind: 'person', reason: 'Confirm the listing in the Steam mobile app' };
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
  protected delistProvedNotApplied(listing: { status: string; last_seen_obs: number }, obs: ObservationRow): boolean {
    return listing.status !== 'ABSENT' && listing.last_seen_obs === obs.id;
  }

  reconcile(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    for (const action of database.actions(accountId, 'AWAITING_OBSERVATION')) {
      if (!['CREATE_SELL_LISTING', 'REMOVE_SELL_LISTING'].includes(action.kind)) continue;
      const obs = database.latestObservation(accountId, 'steam-market');
      const evidence = surfaceEvidence(database, accountId, ACCOUNT_MARKET, this.context.ports.clock.now());
      if (!obs || evidence.grade !== 'SATISFIED' || obs.id !== observationId) continue;

      if (action.kind === 'CREATE_SELL_LISTING') {
        // The walk binds a listing to the row holding its asset id — for a case exactly as for a
        // skin, since a round-trip keeps the id (rule 3) — so the action's target is the match.
        const row = database.raw()
          .prepare(`SELECT status, last_seen_obs FROM market_listing WHERE account_id=? AND local_id=? AND price_receive_cents=? AND status IN ${OPEN_STATUSES}`)
          .get(accountId, action.target_id, (database.actionParams(action) as SellParams).priceReceiveCents) as { status: string; last_seen_obs: number } | undefined;
        if (row && (row.last_seen_obs !== obs.id || !postAttempt(database, action, obs, false))) continue;
        if (row?.status === 'ACTIVE' || row?.status === 'ON_HOLD') {
          database.resolveAction(action, obs.id, true, this.context.now());
        } else if (row?.status === 'PENDING_CONFIRMATION') {
          database.raw().prepare(`UPDATE action SET resolved_by_obs=?, resolution='OBSERVED_APPLIED' WHERE id=?`).run(obs.id, action.id);
          // Still waiting on the user's phone. The transition event is emitted once, by
          // persist(); re-emitting here would grow the timeline on every sync.
          continue;
        } else {
          if (!postAttempt(database, action, obs, true)) continue;
          const attempt = database.latestAttempt(action.id)!;
          const everSeen = database.raw().prepare(`SELECT 1 FROM market_listing m JOIN observation o ON o.id=m.first_seen_obs
            WHERE m.account_id=? AND m.local_id=? AND o.finished_at>=?`).get(accountId, action.target_id, attempt.started_at);
          if (everSeen || action.resolution === 'OBSERVED_APPLIED') {
            database.suspendGoal(accountId, action.desired_id, LISTING_REVERSED, this.context.now());
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
        const listing = database.raw()
          .prepare(`SELECT status, local_id, asset_id, last_seen_obs FROM market_listing WHERE account_id=? AND listing_id=?`)
          .get(accountId, params.listingId) as { status: string; local_id: string | null; asset_id: string; last_seen_obs: number } | undefined;
        if (listing && this.delistProvedNotApplied(listing, obs)) {
          // Still on the book in a complete walk begun after the cancel returned: the cancel did
          // not take (order-lifecycle B1). This branch was missing, so a cancel whose request died
          // in transport waited for ever, *Sent, waiting for Steam to show it*, on a listing
          // nothing was removing. Now it is sent again on the cancel schedule and fails with the
          // reason after the last; `RetryService` sends, `kernel/retry-policy.ts` says when.
          settleNotApplied(this.context, action, obs.id, 'Steam still shows the listing', { policy: this.retryPolicyFor(action) });
          continue;
        }
        if (listing?.status !== 'ABSENT') continue;
        const item = listing.local_id ? database.itemByLocalId(accountId, listing.local_id) : database.itemByAssetId(accountId, listing.asset_id);
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
    // Retire only unseen rows before inserting replacements: a reprice must retain its walk.
    const seenIds = new Set([...listings, ...holds, ...confirmations].map((listing) => listing.listingId));
    const previous = database.raw().prepare(`SELECT listing_id FROM market_listing WHERE account_id=? AND status IN ${OPEN_STATUSES}`).all(accountId) as { listing_id: string }[];
    for (const row of previous) {
      if (seenIds.has(row.listing_id)) continue;
      // The listing ended; where its item is stays the Game Coordinator's to say. A cancelled
      // listing's item never left the inventory and a sold one's leaves it, and only the GC can
      // tell those apart (`db/steam-listing.ts`), so this walk moves no item (rule 5).
      database.raw().prepare(`UPDATE market_listing SET status='ABSENT', last_seen_obs=? WHERE account_id=? AND listing_id=?`).run(observationId, accountId, row.listing_id);
    }
    const priorStatus = database.raw().prepare(`SELECT status FROM market_listing WHERE account_id=? AND listing_id=?`);
    const statement = database.raw().prepare(`
      INSERT INTO market_listing(account_id, listing_id, local_id, asset_id, hash_name,
        price_receive_cents, buyer_price_cents, status, hold_until, awaiting_confirmation, first_seen_obs, last_seen_obs)
      VALUES (@accountId, @listingId, @localId, @assetId, @hashName,
        @receive, @buyer, @status, @holdUntil, @confirm, @obs, @obs)
      ON CONFLICT(account_id, listing_id) DO UPDATE SET
        local_id=COALESCE(excluded.local_id, market_listing.local_id), asset_id=excluded.asset_id,
        hash_name=excluded.hash_name, price_receive_cents=excluded.price_receive_cents,
        buyer_price_cents=excluded.buyer_price_cents, status=excluded.status,
        hold_until=excluded.hold_until, awaiting_confirmation=excluded.awaiting_confirmation,
        last_seen_obs=excluded.last_seen_obs
    `);

    const write = (listing: MarketListing, status: string, confirm: boolean): void => {
      const linked = database.raw().prepare(`SELECT local_id FROM venue_order WHERE account_id=? AND venue='steam'
        AND json_extract(venue_detail_json,'$.assetId')=? AND state NOT LIKE 'ENDED_%'`).get(accountId, listing.asset.assetId) as { local_id: string | null } | undefined;
      const item = database.itemByAssetId(accountId, listing.asset.assetId) ?? (linked?.local_id ? database.itemByLocalId(accountId, linked.local_id) : undefined);
      const before = priorStatus.get(accountId, listing.listingId) as { status: string } | undefined;
      statement.run({
        accountId,
        listingId: listing.listingId,
        localId: item?.local_id ?? null,
        assetId: listing.asset.assetId,
        hashName: listing.asset.marketHashName,
        receive: listing.priceReceiveCents,
        buyer: listing.buyerPriceCents,
        status,
        holdUntil: listing.holdUntil ?? null,
        confirm: confirm ? 1 : 0,
        obs: observationId
      });
      // The listing names its row, and the row stays where the Game Coordinator holds it: listed
      // is this open listing, not a location, so no allocation hands the unit out while it is
      // open (`db/steam-listing.ts`). The id survives a cancel (rule 3).
      // Emit on the transition only, so an unconfirmed listing does not append an event per sync.
      if (status === 'PENDING_CONFIRMATION' && before?.status !== 'PENDING_CONFIRMATION') {
        database.addEvent(accountId, 'listing-awaiting-phone-confirmation', {
          listingId: listing.listingId,
          localId: item?.local_id ?? null,
          hashName: listing.asset.marketHashName
        }, this.context.now());
      }
    };

    // Explicit bucket precedence: a pending confirmation is the most restrictive evidence.
    const buckets = new Map<string, { listing: MarketListing; status: string; confirm: boolean }>();
    for (const listing of listings) buckets.set(listing.listingId, { listing, status: 'ACTIVE', confirm: false });
    for (const listing of holds) buckets.set(listing.listingId, { listing, status: 'ON_HOLD', confirm: false });
    for (const listing of confirmations) buckets.set(listing.listingId, { listing, status: 'PENDING_CONFIRMATION', confirm: true });
    for (const { listing, status, confirm } of buckets.values()) write(listing, status, confirm);

    const orderStatement = database.raw().prepare(`
      INSERT INTO buy_order(account_id, buy_order_id, hash_name, price_cents, quantity,
        quantity_remaining, purchased, active, first_seen_obs, last_seen_obs)
      VALUES (@accountId, @id, @hash, @price, @quantity, @remaining, @purchased, 1, @obs, @obs)
      ON CONFLICT(account_id, buy_order_id) DO UPDATE SET quantity_remaining=excluded.quantity_remaining,
        purchased=excluded.purchased, active=1, last_seen_obs=excluded.last_seen_obs
    `);
    const purchasedBefore = new Map((database.raw()
      .prepare(`SELECT buy_order_id, purchased FROM buy_order WHERE account_id=?`)
      .all(accountId) as Array<{ buy_order_id: string; purchased: number }>)
      .map((row) => [row.buy_order_id, row.purchased]));
    const filled: string[] = [];
    const mainItems = database.items(accountId).filter((item) => item.location === 'MAIN').map((item) => item.local_id);
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
          unitPriceCents: order.priceCents, candidates: mainItems, observationId, now: this.context.now()
        });
      }
      orderStatement.run({
        accountId,
        id: order.buyOrderId,
        hash: order.hashName,
        price: order.priceCents,
        quantity: order.quantity,
        remaining: order.quantityRemaining,
        purchased,
        obs: observationId
      });
    }
    this.filledSinceWalk = filled.length;
    database.raw().prepare(`UPDATE buy_order SET active=0 WHERE account_id=? AND last_seen_obs<>? AND active=1`)
      .run(accountId, observationId);
    this.orders.observeMarket(accountId, observationId);
  }

  /**
   * An empty market is believable only when every listing it would end is accounted for: market
   * history names it cancelled or sold, or this app sent a cancel for it that Steam did not refuse.
   *
   * The inventory cannot vouch for it. The Game Coordinator keeps a listed item in main inventory
   * (`db/steam-listing.ts`), so a live listing and a cancelled one look the same from there, and a
   * stale session's empty answer is exactly the shape that would make every one of them look
   * cancelled. A cancel of our own is different: it is a reason, recorded before the walk, for the
   * book to be empty, and the delist it belongs to is still graded by `reconcile` on its own proof.
   */
  private emptyIsCorroborated(accountId: string): boolean {
    const { database } = this.context;
    const open = database.raw().prepare(`SELECT listing_id FROM market_listing WHERE account_id=? AND status IN ${OPEN_STATUSES}`).all(accountId) as { listing_id: string }[];
    const cancelled = database.raw().prepare(`SELECT 1 FROM action a JOIN desired_state d ON d.id=a.desired_id JOIN attempt t ON t.action_id=a.id
      WHERE a.account_id=? AND a.kind='REMOVE_SELL_LISTING' AND json_extract(d.params_json,'$.listingId')=?
        AND IFNULL(t.outcome,'')<>'DEFINITIVELY_REJECTED' LIMIT 1`);
    return open.every((listing) => this.orders.historyExplainsEmpty(accountId, listing.listing_id)
      || Boolean(cancelled.get(accountId, listing.listing_id)));
  }
}
