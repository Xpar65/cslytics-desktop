import type { MarketBuyOrder, MarketListing } from '@cslytics/ports';
import type { OrderConfidence, OrderSide, OrderState, OrderVenue, SteamListingBucket } from './alphabets.js';
import type { ActionRow, EngineDatabase } from './database.js';
import { COMMITTED_SQL, STEAM_LISTED_SQL } from './commitment.js';

/**
 * The orders of an account on every venue and either side, and the only writer of a binding
 * between a holding and a venue object (consolidation plan D4).
 *
 * One row of `venue_order` per order, ours or the account owner's: a sell listing or a buy order,
 * from the request that opened it (`SUBMITTED`, with the attempt in `action_id`) to the
 * observation that explained its end. What only one venue has sits beside it in a satellite,
 * keyed like the parent: `steam_order` carries the buyer price Steam shows and the bucket of
 * `mylistings` the listing was last seen in.
 *
 * The walk is the truth about what is on the book (rule 1). It binds a listing it sees to the
 * holding by asset id, re-deriving `local_id` every time so a listing walked before its item was
 * is bound as soon as the inventory knows the asset; it adopts a listing it has never seen as the
 * account owner's; and it marks a listing it no longer shows with `gone_obs`, the first complete
 * walk that did not show it, while the order keeps its state until `OrderService` explains the
 * ending. "Is this holding committed?" and "is it listed?" are `db/commitment.ts`.
 */
export type VenueOrderRow = {
  account_id: string;
  order_id: string;
  venue: OrderVenue;
  side: OrderSide;
  local_id: string | null;
  asset_id: string | null;
  hash_name: string | null;
  venue_order_id: string | null;
  /** The price the order was placed at, in the venue's terms: Steam a seller-receives figure (rule 4), CSFloat the listing price. */
  price_cents: number | null;
  /** The currency the venue states for the order. A Steam listing states none it can be held to: it is priced in the account's wallet currency, which the reads take from the wallet (XLIST-21). */
  currency: number | null;
  quantity: number;
  filled: number;
  state: OrderState;
  confidence: OrderConfidence;
  transactable_after: string | null;
  opened_at: string;
  first_seen_obs: number | null;
  last_seen_obs: number | null;
  /** The first complete walk that no longer showed the order, once one has; the order's state is decided after it. */
  gone_obs: number | null;
  ended_at: string | null;
  end_reason: string | null;
  end_evidence: number | null;
  /** The attempt that created it, when it is ours; a hop's or a goal's action, so the hop or goal is read through it. */
  action_id: string | null;
};

export type SteamOrderRow = {
  buyer_price_cents: number | null;
  raw_bucket: SteamListingBucket | null;
};

/** A Steam sell listing: the parent joined to its satellite. */
export type SteamListingRow = VenueOrderRow & SteamOrderRow;

/** Steam's three buckets of `mylistings`, each the venue's word for one open state. */
export const STEAM_BUCKET_STATE: Readonly<Record<SteamListingBucket, OrderState>> = {
  ACTIVE: 'OPEN',
  ON_HOLD: 'OPEN_UNTRANSACTABLE',
  PENDING_CONFIRMATION: 'PENDING_EXTERNAL'
};

export type SeenSteamListing = { listing: MarketListing; bucket: SteamListingBucket };

/** How an order ended, as the order service graded it. */
export type OrderEnding = { orderId: string; state: OrderState; confidence: OrderConfidence; reason: string; evidence: number };

const STEAM_LISTING_SELECT = `SELECT v.*, s.buyer_price_cents, s.raw_bucket FROM venue_order v
    JOIN steam_order s ON s.account_id=v.account_id AND s.order_id=v.order_id`;

export class OrderStore {
  constructor(private readonly db: EngineDatabase) {}

  private get sqlite() {
    return this.db.raw();
  }

  order(accountId: string, orderId: string): VenueOrderRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND order_id=?`).get(accountId, orderId) as VenueOrderRow | undefined;
  }

  /** The order a venue knows by its own id, through `order_venue_id`. */
  byVenueId(accountId: string, venue: OrderVenue, venueOrderId: string): VenueOrderRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue=? AND venue_order_id=?`)
      .get(accountId, venue, venueOrderId) as VenueOrderRow | undefined;
  }

  /** A Steam listing by Steam's listing id, with its satellite. */
  steamListing(accountId: string, listingId: string): SteamListingRow | undefined {
    return this.sqlite.prepare(`${STEAM_LISTING_SELECT} WHERE v.account_id=? AND v.venue='steam' AND v.venue_order_id=?`)
      .get(accountId, listingId) as SteamListingRow | undefined;
  }

  /** Every listing the last complete market walk showed, in any bucket. */
  openSteamListings(accountId: string): SteamListingRow[] {
    return this.sqlite.prepare(`${STEAM_LISTING_SELECT} WHERE v.account_id=? AND v.venue='steam' AND v.side='SELL'
      AND v.first_seen_obs IS NOT NULL AND v.gone_obs IS NULL ORDER BY v.venue_order_id`).all(accountId) as SteamListingRow[];
  }

  /** The open Steam listing bound to a holding's row, if one is. */
  openSteamListingFor(accountId: string, localId: string): SteamListingRow | undefined {
    return this.sqlite.prepare(`${STEAM_LISTING_SELECT} WHERE v.account_id=? AND v.local_id=? AND v.venue='steam' AND v.side='SELL'
      AND v.first_seen_obs IS NOT NULL AND v.gone_obs IS NULL LIMIT 1`).get(accountId, localId) as SteamListingRow | undefined;
  }

  /** The open Steam listing of a holding at a price, as a create's settle looks its own listing up. */
  openSteamListingAt(accountId: string, localId: string, priceCents: number): SteamListingRow | undefined {
    return this.sqlite.prepare(`${STEAM_LISTING_SELECT} WHERE v.account_id=? AND v.local_id=? AND v.price_cents=? AND v.venue='steam' AND v.side='SELL'
      AND v.first_seen_obs IS NOT NULL AND v.gone_obs IS NULL LIMIT 1`).get(accountId, localId, priceCents) as SteamListingRow | undefined;
  }

  /** Orders on a venue that no observation has closed out: open, submitted and unseen, or unexplained. */
  standingOrders(accountId: string, venue: OrderVenue): VenueOrderRow[] {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue=? AND state NOT LIKE 'ENDED_%' ORDER BY opened_at, order_id`)
      .all(accountId, venue) as VenueOrderRow[];
  }

  /**
   * Sell orders of a holding that a complete walk stopped showing and nothing has graded yet, each
   * with the walk that first missed it. Still in an open word, so no reconciler has said why it went.
   */
  goneUngraded(accountId: string, venue: OrderVenue): Array<{ order_id: string; gone_started_at: string; gone_finished_at: string }> {
    return this.sqlite.prepare(`SELECT v.order_id, o.started_at AS gone_started_at, o.finished_at AS gone_finished_at
      FROM venue_order v INDEXED BY order_state_page CROSS JOIN observation o ON o.id=v.gone_obs
      WHERE v.account_id=? AND v.state IN ('OPEN','OPEN_UNTRANSACTABLE','PENDING_EXTERNAL') AND v.venue=? AND v.side='SELL' AND v.local_id IS NOT NULL`)
      .all(accountId, venue) as Array<{ order_id: string; gone_started_at: string; gone_finished_at: string }>;
  }

  /**
   * The sell order that commits a holding, by its row or by its asset id, on any venue
   * (`committedSql` for a caller that has the holding rather than an `item` row to join). An open
   * listing is preferred to an unseen or unexplained order, so a refusal can name the listing.
   */
  commitment(accountId: string, localId: string, assetId: string | null, venue?: OrderVenue): VenueOrderRow | undefined {
    const on = venue ? `o.venue='${venue}' AND ` : '';
    return this.sqlite.prepare(`SELECT * FROM (
        SELECT o.* FROM venue_order o WHERE o.account_id=? AND o.local_id=? AND ${on}${COMMITTED_SQL}
        UNION SELECT o.* FROM venue_order o WHERE o.account_id=? AND o.asset_id=? AND ${on}${COMMITTED_SQL})
      ORDER BY (first_seen_obs IS NOT NULL AND gone_obs IS NULL) DESC, opened_at LIMIT 1`)
      .get(accountId, localId, accountId, assetId ?? '') as VenueOrderRow | undefined;
  }

  /** Asset ids this account has committed to a sell order on any venue: on the book, or sent there and not yet placed by a walk. */
  committedAssets(accountId: string): Set<string> {
    const rows = this.sqlite.prepare(`SELECT asset_id FROM venue_order WHERE account_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%' AND asset_id IS NOT NULL`)
      .all(accountId) as Array<{ asset_id: string }>;
    return new Set(rows.map((row) => row.asset_id));
  }

  /**
   * Our own order, written as the create attempt starts: `SUBMITTED` until a walk shows it, naming
   * the holding by row and by the asset id the request sends so the walk can bind the listing it
   * creates (rule 3). A second attempt of the same action reopens its row; a second order for a
   * holding that already has one standing on this venue is refused. Another venue's claim is the
   * cross-venue policy's, applied before the attempt starts (`kernel/marketplace-commitments.ts`).
   */
  open(action: ActionRow, venue: OrderVenue, now: string): string {
    const existing = this.sqlite.prepare(`SELECT order_id FROM venue_order WHERE account_id=? AND action_id=?`).get(action.account_id, action.id) as { order_id: string } | undefined;
    const conflict = this.sqlite.prepare(`SELECT 1 FROM venue_order WHERE account_id=? AND local_id=? AND venue=? AND side='SELL'
          AND state NOT LIKE 'ENDED_%' AND order_id<>?`).get(action.account_id, action.target_id, venue, existing?.order_id ?? '');
    if (conflict) throw new Error('Item already has an open or unexplained order');
    if (existing) {
      this.sqlite.prepare(`UPDATE venue_order SET state='SUBMITTED', ended_at=NULL, end_reason=NULL, end_evidence=NULL WHERE account_id=? AND order_id=?`).run(action.account_id, existing.order_id);
      this.db.touch(action.account_id, 'venue_order');
      return existing.order_id;
    }
    const orderId = action.id;
    const item = this.db.itemByLocalId(action.account_id, action.target_id);
    this.sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, local_id, asset_id, hash_name, price_cents, opened_at, action_id, state, confidence)
      VALUES (?, ?, ?, 'SELL', ?, ?, NULL, ?, ?, ?, 'SUBMITTED', 'unknown')`)
      .run(action.account_id, orderId, venue, action.target_id, item?.asset_id ?? null,
        (this.db.actionParams(action) as { priceReceiveCents?: number }).priceReceiveCents ?? null, now, action.id);
    this.db.touch(action.account_id, 'venue_order');
    return orderId;
  }

  /** A request a complete walk proved absent never made an order: its row ends `ENDED_NOT_APPLIED` if no walk ever showed it. */
  endNotApplied(action: ActionRow, observationId: number, now: string): void {
    this.sqlite.prepare(`UPDATE venue_order SET state='ENDED_NOT_APPLIED', ended_at=?, end_evidence=?, confidence='proven',
      end_reason='Complete observation proved request absent' WHERE account_id=? AND action_id=? AND first_seen_obs IS NULL`)
      .run(now, observationId, action.account_id, action.id);
    this.db.touch(action.account_id, 'venue_order');
  }

  /**
   * A person's exit from `UNEXPLAINED` (consolidation plan D7): the order ends as they say, with
   * confidence `asserted`, and nothing the record observed is rewritten. The ledger row that says
   * so is `OrderService.close`'s. Never a timeout (order lifecycle D6).
   */
  close(accountId: string, orderId: string, as: 'cancelled' | 'sold', now: string): VenueOrderRow {
    const order = this.order(accountId, orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (order.state !== 'UNEXPLAINED') throw new Error(`Only an unexplained order can be closed by hand; this one is ${order.state}`);
    const state: OrderState = as === 'sold' ? 'ENDED_FILLED' : 'ENDED_CANCELLED_EXTERNALLY';
    this.sqlite.prepare(`UPDATE venue_order SET state=?, confidence='asserted', end_reason=?, ended_at=? WHERE account_id=? AND order_id=?`)
      .run(state, `Closed by a person as ${as}`, now, accountId, orderId);
    this.db.touch(accountId, 'venue_order');
    return this.order(accountId, orderId)!;
  }

  /** The order service's verdict on how an order ended, or that it cannot yet say. */
  end(accountId: string, ending: OrderEnding, now: string): void {
    this.sqlite.prepare(`UPDATE venue_order SET state=?, confidence=?, end_reason=?, end_evidence=?, ended_at=? WHERE account_id=? AND order_id=?`)
      .run(ending.state, ending.confidence, ending.reason, ending.evidence, ending.state.startsWith('ENDED_') ? now : null, accountId, ending.orderId);
    this.db.touch(accountId, 'venue_order');
  }

  /**
   * One complete market walk's listings, in Steam's three buckets, written in the caller's
   * transaction. Only this writes a Steam binding.
   *
   * A listing not shown is gone (`gone_obs`), and where its item is stays the Game Coordinator's
   * to say: a cancelled listing's item never left the inventory and a sold one's leaves it, so
   * this walk moves no item (rule 5). A listing seen is bound by its id, else to the one unseen
   * order of ours that sent its asset, else adopted as the account owner's own, with the listing
   * id for its order id. The holding is re-derived from the asset id every walk. Two open
   * listings naming one holding is the world contradicting itself: both are quarantined and the
   * holding's goal suspended until a person looks. The phone-confirmation event is emitted on
   * the transition only, so an unconfirmed listing does not append one per walk.
   */
  observeSteamListings(accountId: string, observationId: number, seen: readonly SeenSteamListing[], now: string): void {
    const seenIds = new Set(seen.map((row) => row.listing.listingId));
    for (const row of this.openSteamListings(accountId)) {
      if (!seenIds.has(row.venue_order_id!)) {
        this.sqlite.prepare(`UPDATE venue_order SET gone_obs=? WHERE account_id=? AND order_id=?`).run(observationId, accountId, row.order_id);
      }
    }
    const satellite = this.sqlite.prepare(`INSERT INTO steam_order(account_id, order_id, buyer_price_cents, raw_bucket) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET buyer_price_cents=excluded.buyer_price_cents, raw_bucket=excluded.raw_bucket`);
    for (const { listing, bucket } of seen) {
      const assetId = listing.asset.assetId;
      const state = STEAM_BUCKET_STATE[bucket];
      const existing = this.steamListing(accountId, listing.listingId);
      const own = existing ?? this.unseenOwnOrder(accountId, 'steam', assetId);
      const item = this.db.itemByAssetId(accountId, assetId) ?? (own?.local_id ? this.db.itemByLocalId(accountId, own.local_id) : undefined);
      const localId = item?.local_id ?? null;
      const wasPending = existing !== undefined && existing.gone_obs === null && existing.raw_bucket === 'PENDING_CONFIRMATION';
      let orderId: string;
      if (own) {
        orderId = own.order_id;
        this.sqlite.prepare(`UPDATE venue_order SET venue_order_id=?, local_id=?, asset_id=?, hash_name=?, price_cents=?, state=?, confidence='proven',
            first_seen_obs=COALESCE(first_seen_obs, ?), last_seen_obs=?, gone_obs=NULL, transactable_after=?, ended_at=NULL, end_reason=NULL, end_evidence=NULL
          WHERE account_id=? AND order_id=?`)
          .run(listing.listingId, localId, assetId, listing.asset.marketHashName, listing.priceReceiveCents, state,
            observationId, observationId, listing.holdUntil ?? null, accountId, orderId);
      } else {
        orderId = listing.listingId;
        this.sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, local_id, asset_id, hash_name, venue_order_id, price_cents,
            state, confidence, transactable_after, opened_at, first_seen_obs, last_seen_obs)
          VALUES (?, ?, 'steam', 'SELL', ?, ?, ?, ?, ?, ?, 'proven', ?, ?, ?, ?)`)
          .run(accountId, orderId, localId, assetId, listing.asset.marketHashName, listing.listingId, listing.priceReceiveCents,
            state, listing.holdUntil ?? null, now, observationId, observationId);
      }
      satellite.run(accountId, orderId, listing.buyerPriceCents, bucket);
      if (bucket === 'PENDING_CONFIRMATION' && !wasPending) {
        this.db.addEvent(accountId, 'listing-awaiting-phone-confirmation', { listingId: listing.listingId, localId, hashName: listing.asset.marketHashName }, now);
      }
    }
    const duplicates = this.sqlite.prepare(`SELECT local_id FROM venue_order o WHERE o.account_id=? AND o.local_id IS NOT NULL AND ${STEAM_LISTED_SQL}
      GROUP BY local_id HAVING COUNT(*)>1`).all(accountId) as Array<{ local_id: string }>;
    for (const duplicate of duplicates) {
      this.sqlite.prepare(`UPDATE venue_order SET state='QUARANTINED', confidence='unknown' WHERE account_id=? AND local_id=? AND state NOT LIKE 'ENDED_%'`)
        .run(accountId, duplicate.local_id);
      const goal = this.db.currentDesiredState(accountId, 'sell-listing', duplicate.local_id);
      if (goal) this.db.suspendGoal(accountId, goal.id, 'Conflicting open listings require review', now);
    }
    this.db.touch(accountId, 'venue_order');
  }

  /** The order an attempt of ours created, through `order_attempt`. */
  byAction(accountId: string, actionId: string): VenueOrderRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND action_id=?`).get(accountId, actionId) as VenueOrderRow | undefined;
  }

  /** A Steam buy order by Steam's id. */
  steamBuyOrder(accountId: string, buyOrderId: string): VenueOrderRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND side='BUY' AND venue_order_id=?`)
      .get(accountId, buyOrderId) as VenueOrderRow | undefined;
  }

  /** Every Steam buy order a walk has shown, open or ended, oldest first. */
  steamBuyOrders(accountId: string): VenueOrderRow[] {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND side='BUY' AND venue_order_id IS NOT NULL ORDER BY opened_at, order_id`)
      .all(accountId) as VenueOrderRow[];
  }

  /** The Steam buy orders still open: shown by a walk and not ended by a walk or a status read. */
  openSteamBuyOrders(accountId: string): VenueOrderRow[] {
    return this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND side='BUY' AND first_seen_obs IS NOT NULL
      AND state NOT LIKE 'ENDED_%' ORDER BY opened_at, order_id`).all(accountId) as VenueOrderRow[];
  }

  /**
   * Our own buy order, written as the request is admitted: `SUBMITTED` until a walk shows an
   * order with its terms and binds it. The price is the limit for one unit, which is what the book
   * reports and what a fill is attributed against.
   */
  openBuy(action: ActionRow, request: { marketHashName: string; priceTotalCents: number; quantity: number }, now: string): string {
    const existing = this.byAction(action.account_id, action.id);
    if (existing) return existing.order_id;
    this.sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, hash_name, price_cents, quantity, filled, opened_at, action_id, state, confidence)
      VALUES (?, ?, 'steam', 'BUY', ?, ?, ?, 0, ?, ?, 'SUBMITTED', 'unknown')`)
      .run(action.account_id, action.id, request.marketHashName, Math.floor(request.priceTotalCents / request.quantity), request.quantity, now, action.id);
    this.db.touch(action.account_id, 'venue_order');
    return action.id;
  }

  /**
   * One complete market walk's buy orders, written in the caller's transaction. An order seen is
   * bound by Steam's id, else to the one unseen request of ours with its terms when no other
   * unknown order on the book shares them, else adopted as the account owner's own, with Steam's
   * id for its order id. An order no longer shown is gone (`gone_obs`) and ended on what the book
   * said: filled when its count reached its quantity, cancelled by us when a cancel of ours names
   * it, else cancelled at the venue, provisionally, because the book is the only oracle Steam
   * gives a buy order and it reports counts, not reasons.
   */
  observeSteamBuyOrders(accountId: string, observationId: number, seen: readonly MarketBuyOrder[], now: string): void {
    const seenIds = new Set(seen.map((order) => order.buyOrderId));
    for (const row of this.openSteamBuyOrders(accountId)) {
      if (seenIds.has(row.venue_order_id!)) continue;
      this.sqlite.prepare(`UPDATE venue_order SET gone_obs=? WHERE account_id=? AND order_id=?`).run(observationId, accountId, row.order_id);
      this.endSteamBuyOrder(accountId, { ...row, gone_obs: observationId }, row.filled, observationId, now);
    }
    const unknown = seen.filter((order) => !this.byVenueId(accountId, 'steam', order.buyOrderId));
    const terms = (order: MarketBuyOrder): string => `${order.hashName}\u0000${order.priceCents}\u0000${order.quantity}`;
    const sharedTerms = new Set([...unknown].map(terms).filter((key, index, keys) => keys.indexOf(key) !== index));
    for (const order of seen) {
      const filled = order.quantity - order.quantityRemaining;
      const existing = this.byVenueId(accountId, 'steam', order.buyOrderId);
      const own = existing ?? (sharedTerms.has(terms(order)) ? undefined : this.unseenOwnBuy(accountId, order));
      if (own) {
        this.sqlite.prepare(`UPDATE venue_order SET venue_order_id=?, hash_name=?, price_cents=?, quantity=?, filled=?, state='OPEN', confidence='proven',
            first_seen_obs=COALESCE(first_seen_obs, ?), last_seen_obs=?, gone_obs=NULL, ended_at=NULL, end_reason=NULL, end_evidence=NULL
          WHERE account_id=? AND order_id=?`)
          .run(order.buyOrderId, order.hashName, order.priceCents, order.quantity, filled, observationId, observationId, accountId, own.order_id);
      } else {
        this.sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, hash_name, venue_order_id, price_cents, quantity, filled,
            state, confidence, opened_at, first_seen_obs, last_seen_obs)
          VALUES (?, ?, 'steam', 'BUY', ?, ?, ?, ?, ?, 'OPEN', 'proven', ?, ?, ?)`)
          .run(accountId, order.buyOrderId, order.hashName, order.buyOrderId, order.priceCents, order.quantity, filled, now, observationId, observationId);
      }
    }
    this.db.touch(accountId, 'venue_order');
  }

  /** What `getbuyorderstatus` said about one order: its count so far, and whether Steam still holds it open. */
  recordSteamBuyOrderStatus(accountId: string, order: VenueOrderRow, status: { active: boolean; purchased: number }, observationId: number, now: string): void {
    this.sqlite.prepare(`UPDATE venue_order SET filled=? WHERE account_id=? AND order_id=?`).run(status.purchased, accountId, order.order_id);
    if (!status.active && !order.state.startsWith('ENDED_')) this.endSteamBuyOrder(accountId, order, status.purchased, observationId, now);
    this.db.touch(accountId, 'venue_order');
  }

  private endSteamBuyOrder(accountId: string, order: VenueOrderRow, filled: number, evidence: number, now: string): void {
    const cancelled = this.sqlite.prepare(`SELECT 1 FROM action a JOIN attempt t ON t.action_id=a.id
      WHERE a.account_id=? AND a.kind='CANCEL_BUY_ORDER' AND json_extract(a.params_json,'$.buyOrderId')=? LIMIT 1`).get(accountId, order.venue_order_id);
    const ending: OrderEnding = filled >= order.quantity
      ? { orderId: order.order_id, state: 'ENDED_FILLED', confidence: 'proven', reason: 'The book reports every unit bought', evidence }
      : cancelled
        ? { orderId: order.order_id, state: 'ENDED_CANCELLED_BY_US', confidence: 'proven', reason: 'Gone from the book after a cancel of ours', evidence }
        : { orderId: order.order_id, state: 'ENDED_CANCELLED_EXTERNALLY', confidence: 'probable', reason: 'Gone from the book with units left to buy; cancellation is provisional', evidence };
    this.end(accountId, ending, now);
  }

  /** The one unseen request of ours with these terms, or none when there is not exactly one. */
  private unseenOwnBuy(accountId: string, order: MarketBuyOrder): VenueOrderRow | undefined {
    const candidates = this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND side='BUY' AND venue_order_id IS NULL
      AND state='SUBMITTED' AND hash_name=? AND price_cents=? AND quantity=?`).all(accountId, order.hashName, order.priceCents, order.quantity) as VenueOrderRow[];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** The one order of ours on a venue that sent this asset and no walk has yet placed; none when there is not exactly one. */
  private unseenOwnOrder(accountId: string, venue: OrderVenue, assetId: string): VenueOrderRow | undefined {
    const candidates = this.sqlite.prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue=? AND side='SELL' AND venue_order_id IS NULL AND asset_id=?`)
      .all(accountId, venue, assetId) as VenueOrderRow[];
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}
