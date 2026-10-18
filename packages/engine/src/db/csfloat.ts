import type { CsfloatBuyOrder, CsfloatListing, CsfloatListingItem, CsfloatTrade } from '@cslytics/ports';
import type { EngineDatabase, ObservationRow } from './database.js';
import { MarketplaceStore } from './marketplace.js';
import { isSettled, type WorkStepRow } from './work.js';
import type { OrderConfidence, OrderState } from './alphabets.js';
import type { VenueOrderRow } from './orders.js';

/**
 * CSFloat prices in US dollars, expressed as Steam's `ECurrencyCode` so one currency vocabulary
 * covers both venues and the host needs one formatter rather than one per venue.
 */
export const CSFLOAT_CURRENCY = 1;

/** The CSFloat words for a listing that is no longer an advertisement, and no longer commits its item. */
export const CSFLOAT_ENDED_WORDS = ['delisted', 'cancelled', 'refunded'] as const;
const CSFLOAT_ENDED_SQL = "('delisted', 'cancelled', 'refunded')";

/**
 * One of the account's own CSFloat buy orders as the last complete walk of the book showed it: the
 * `BUY` row of `venue_order` joined to `csfloat_order`. `bought` is `null` when the venue did not say.
 */
export type CsfloatBuyOrderRow = { account_id: string; order_id: string; hash_name: string; price_cents: number;
  quantity: number; bought: number | null; properties_json: string | null; created_at: string | null; first_seen_obs: number; last_seen_obs: number };
/**
 * One CSFloat advertisement as the record keeps it: the `SELL` row of `venue_order` joined to
 * `csfloat_order`. `state` is the venue's own word, `observation_id` the read that last stated it.
 */
export type CsfloatContract = { account_id: string; order_id: string; listing_id: string; asset_id: string; local_id: string | null;
  state: string; price_cents: number; item_json: string; type: string; observation_id: number };
export type CsfloatTradeRow = { account_id: string; trade_id: string; listing_id: string; asset_id: string; local_id: string | null;
  state_word: string; seller_steam_id: string; data_json: string; observation_id: number; offer_id: string | null };
export type StoredCsfloatTrade = Omit<CsfloatTrade, 'tradeToken'>;

/** The command kind of a delivery, and its hops: the steps a sale to a CSFloat buyer is made of. */
export const CSFLOAT_DELIVER = 'CSFLOAT_DELIVER';
export const CSFLOAT_DELIVERY_HOPS = ['CSFLOAT_ACCEPT', 'CSFLOAT_SEND', 'CSFLOAT_NOTIFY', 'CSFLOAT_CANNOT_DELIVER'] as const;
export type CsfloatDeliveryHop = (typeof CSFLOAT_DELIVERY_HOPS)[number];

/** The frozen terms of a delivery, on every hop of it alike. */
export type CsfloatDeliveryStepParams = {
  operationId: string; tradeId: string; listingId: string; assetId: string; generation: number; policyVersion: number;
};

/**
 * A delivery as one thing, read from its hops and from the venue rows those hops are about.
 *
 * The record keeps a step per hop (consolidation plan D2); what the person asks is "where is this
 * sale", and that is answered here rather than stored: the trade's own state ends it, the hop
 * with the person's attention says what it waits on, and the Steam offer the send hop put up says
 * what Steam is waiting for. `state` is in the words the work panel speaks.
 */
export type CsfloatDeliveryView = {
  id: string; account_id: string; trade_id: string; listing_id: string; local_id: string | null; asset_id: string;
  offer_id: string | null; action_id: string | null; state: string; error: string | null; updated_at: string;
};

export function csfloatDeliveryView(db: EngineDatabase, commandId: string): CsfloatDeliveryView | undefined {
  const steps = db.raw().prepare(`SELECT s.* FROM work_step s JOIN command c ON c.id=s.command_id WHERE s.command_id=? AND c.kind=? ORDER BY s.ordinal`)
    .all(commandId, CSFLOAT_DELIVER) as WorkStepRow[];
  const first = steps[0];
  if (!first) return undefined;
  const params = JSON.parse(first.params_json ?? '{}') as CsfloatDeliveryStepParams;
  const trade = db.raw().prepare('SELECT state_word AS state FROM csfloat_trade WHERE account_id=? AND trade_id=?').get(first.account_id, params.tradeId) as { state: string } | undefined;
  const send = steps.find((step) => step.kind === 'CSFLOAT_SEND');
  const decision = steps.find((step) => step.kind === 'CSFLOAT_CANNOT_DELIVER');
  const failed = [...steps].reverse().find((step) => step.state === 'FAILED');
  // The hop with the person's attention: a decision they made, a hop that failed, the send while
  // the sale is open, else whatever happened last.
  const current = decision && (!isSettled(decision) || decision.state === 'FAILED') ? decision
    : failed ?? (send && !isSettled(send) ? send : steps[steps.length - 1]!);
  const base = {
    id: commandId, account_id: first.account_id, trade_id: params.tradeId, listing_id: params.listingId, local_id: first.local_id,
    asset_id: params.assetId, offer_id: send?.offer_id ?? null, action_id: current.action_id,
    updated_at: steps.map((step) => step.updated_at).sort().at(-1)!
  };
  if (trade?.state === 'verified') return { ...base, state: 'DONE', error: null };
  if (trade && ['failed', 'cancelled'].includes(trade.state)) return { ...base, state: 'CANCELLED', error: `CSFloat trade ${trade.state}` };
  if (current.state === 'FAILED') return { ...base, state: 'BLOCKED', error: current.reason };
  if (current.state === 'QUEUED') return { ...base, state: current.reason ? 'BLOCKED' : 'QUEUED', error: current.reason };
  if (current.state === 'SENT') return { ...base, state: 'RUNNING', error: null };
  if (current.state === 'RETRYING') return { ...base, state: 'RETRYING', error: current.reason };
  if (current.state === 'AWAITING_OBSERVATION') {
    const offer = current.kind === 'CSFLOAT_SEND' && current.offer_id
      ? db.raw().prepare('SELECT state_code FROM trade_offer WHERE account_id=? AND offer_id=?').get(first.account_id, current.offer_id) as { state_code: number } | undefined
      : undefined;
    const state = !offer ? 'AWAITING_OBSERVATION' : offer.state_code === 9 ? 'AWAITING_CONFIRMATION' : offer.state_code === 3 ? 'AWAITING_VERIFICATION' : 'AWAITING_BUYER';
    return { ...base, state, error: current.reason };
  }
  // Every hop settled and the venue has not ended the sale: the next hop has not been reached.
  return { ...base, state: 'QUEUED', error: null };
}

const CONTRACT_SELECT = `SELECT v.account_id, v.order_id, v.venue_order_id AS listing_id, v.asset_id, v.local_id, s.state_word AS state,
    v.price_cents, s.item_json, s.type, s.observation_id
  FROM venue_order v JOIN csfloat_order s ON s.account_id=v.account_id AND s.order_id=v.order_id`;
const BUY_ORDER_SELECT = `SELECT v.account_id, v.order_id, v.hash_name, v.price_cents, v.quantity, v.filled AS bought, s.properties_json, s.created_at,
    v.first_seen_obs, v.last_seen_obs
  FROM venue_order v JOIN csfloat_order s ON s.account_id=v.account_id AND s.order_id=v.order_id`;
/** A CSFloat row the last complete walk of its book showed. */
const IN_BOOK = 'v.first_seen_obs IS NOT NULL AND v.gone_obs IS NULL';

/**
 * The CSFloat side of the one order table (consolidation plan D4): every advertisement and buy
 * order of the account as `venue_order` rows with `csfloat_order` beside them, written here and
 * nowhere else. A listing's row is written by whichever read last stated it — the stall walk, its
 * own read, or a trade that carries it — and the venue's word is kept beside the parent's state;
 * only the stall walk, the one complete book, says what is still on the book (`first_seen_obs`,
 * `last_seen_obs`, `gone_obs`). A buy order's row is the walk's alone.
 */
export class CsfloatStore {
  constructor(readonly db: EngineDatabase) {}
  /** The duplicate-protection switch: this desktop's preference, held by the engine and persisted nowhere in the record (D13). */
  policy(): { preventDuplicates: boolean; version: number } { return this.db.marketplaceProtection(); }
  setPolicy(enabled: boolean): void { this.db.setMarketplaceProtection(enabled); }
  fresh(accountId: string, surface: string, now: string, maxAgeMs = 300_000): ObservationRow | undefined {
    const connection = new MarketplaceStore(this.db).connection(accountId,'csfloat');
    const obs = this.db.latestObservation(accountId,surface);
    const age = obs ? Date.parse(now)-Date.parse(obs.started_at) : NaN;
    return connection?.status === 'CONNECTED' && obs?.complete && !obs.error && obs.generation === connection.generation
      && age >= 0 && age <= maxAgeMs ? obs : undefined;
  }
  /**
   * Exact attributes establish identity; an asset id alone never repairs a contradictory tuple.
   *
   * A unit with no paint tuple on either side — an agent, a sticker, a patch, a pin, a charm, a
   * music kit — has nothing an asset id could contradict, and the asset id names the holding
   * (rule 3), so it is the row under that id. Neither kind nor quality is compared for one: CSFloat
   * sends no `quality` on any of them, and files every music kit under its own def 58 — the Void kit,
   * def 1314 here, is `def_index` 58 there (the storage test account's read of 2026-09-22;
   * `fixtures/csfloat/INDEX.md`). Asking for either made every one of them unresolved, so none
   * could be listed.
   */
  associate(accountId: string, item: CsfloatListingItem): string | null {
    if (item.paintIndex !== undefined && item.floatValue !== undefined && item.paintSeed !== undefined && item.quality !== undefined) {
      const rows = this.db.raw().prepare(`SELECT local_id FROM item WHERE account_id=? AND def_index=? AND paint_index=? AND paint_wear=? AND paint_seed=? AND quality=?`)
        .all(accountId,item.defIndex,item.paintIndex,item.floatValue,item.paintSeed,item.quality) as Array<{ local_id: string }>;
      if (rows.length === 1) return rows[0]!.local_id;
      if (rows.length > 1) return null;
    }
    const unit = this.db.itemByAssetId(accountId,item.assetId);
    if (!unit) return null;
    if (unit.paint_index === null && item.paintIndex === undefined && item.floatValue === undefined) return unit.local_id;
    // A skin CSFloat sent without its whole tuple: the row under the asset id, if it is the same kind.
    return unit.def_index === item.defIndex && item.quality !== undefined && unit.quality === item.quality ? unit.local_id : null;
  }

  /**
   * What the venue's word for a listing means in the one alphabet. `listed` is open; `sold` is a
   * fill the venue itself reports; `delisted` and `cancelled` are a cancel, ours when a cancel hop
   * of ours was sent for it; `refunded` is a sale the venue voided. A word this app has never
   * seen ends nothing and is kept beside the row for a person to read.
   */
  private listingState(accountId: string, listingId: string, word: string): { state: OrderState; confidence: OrderConfidence } {
    if (word === 'listed') return { state: 'OPEN', confidence: 'proven' };
    if (word === 'sold') return { state: 'ENDED_FILLED', confidence: 'proven' };
    if (word === 'refunded') return { state: 'ENDED_VOIDED_BY_VENUE', confidence: 'proven' };
    if (word === 'delisted' || word === 'cancelled') {
      const ours = this.db.raw().prepare(`SELECT 1 FROM work_step WHERE account_id=? AND kind='CSFLOAT_CANCEL' AND target_id=? AND action_id IS NOT NULL LIMIT 1`).get(accountId, listingId);
      return { state: ours ? 'ENDED_CANCELLED_BY_US' : 'ENDED_CANCELLED_EXTERNALLY', confidence: 'proven' };
    }
    return { state: 'UNEXPLAINED', confidence: 'unknown' };
  }

  /**
   * One listing as a read stated it: the parent's binding re-derived from the venue's item, its
   * state from the venue's word, the venue's own body beside it. What is on the book is not this
   * read's to say unless it is the stall walk (`observeStall`).
   */
  publishContract(accountId: string, listing: CsfloatListing, observationId: number): void {
    const { state, confidence } = this.listingState(accountId, listing.listingId, listing.state);
    const localId = this.associate(accountId, listing.item);
    const ended = state.startsWith('ENDED_');
    this.db.raw().prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, local_id, asset_id, hash_name, venue_order_id, price_cents, currency,
        state, confidence, opened_at, ended_at, end_reason, end_evidence)
      VALUES (?, ?, 'csfloat', 'SELL', ?, ?, ?, ?, ?, ${CSFLOAT_CURRENCY}, ?, ?, COALESCE(NULLIF(?, ''), (SELECT finished_at FROM observation WHERE id=?)), ?, ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET local_id=COALESCE(excluded.local_id, venue_order.local_id), asset_id=excluded.asset_id,
        hash_name=excluded.hash_name, price_cents=excluded.price_cents, state=excluded.state, confidence=excluded.confidence,
        ended_at=excluded.ended_at, end_reason=excluded.end_reason, end_evidence=excluded.end_evidence`)
      .run(accountId, listing.listingId, localId, listing.item.assetId, listing.item.marketHashName, listing.listingId, listing.priceCents,
        state, confidence, listing.createdAt, observationId,
        ended ? this.db.observation(accountId, observationId)?.finished_at ?? null : null, ended ? `CSFloat reports the listing ${listing.state}` : null, ended ? observationId : null);
    this.db.raw().prepare(`INSERT INTO csfloat_order(account_id, order_id, type, state_word, item_json, created_at, observation_id) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET type=excluded.type, state_word=excluded.state_word, item_json=excluded.item_json,
        created_at=COALESCE(excluded.created_at, csfloat_order.created_at), observation_id=excluded.observation_id`)
      .run(accountId, listing.listingId, listing.type, listing.state, JSON.stringify(listing.item), listing.createdAt || null, observationId);
    this.db.touch(accountId, 'venue_order');
  }
  /**
   * One complete stall walk: every listing it showed, stated and marked on the book, and every
   * listing it no longer shows marked gone, its state left to the read that explains it (rule 5).
   */
  observeStall(accountId: string, observationId: number, listings: readonly CsfloatListing[]): void {
    const seen = new Set(listings.map((listing) => listing.listingId));
    for (const row of this.db.raw().prepare(`SELECT order_id, venue_order_id FROM venue_order v WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND ${IN_BOOK}`)
      .all(accountId) as Array<{ order_id: string; venue_order_id: string }>) {
      if (!seen.has(row.venue_order_id)) this.db.raw().prepare('UPDATE venue_order SET gone_obs=? WHERE account_id=? AND order_id=?').run(observationId, accountId, row.order_id);
    }
    for (const listing of listings) {
      this.publishContract(accountId, listing, observationId);
      this.db.raw().prepare(`UPDATE venue_order SET first_seen_obs=COALESCE(first_seen_obs, ?), last_seen_obs=?, gone_obs=NULL WHERE account_id=? AND order_id=?`)
        .run(observationId, observationId, accountId, listing.listingId);
    }
    this.db.touch(accountId, 'venue_order');
  }
  /**
   * One complete walk of the buy-order book: every order it showed, and every order it no longer
   * shows ended on what the book said, because the book is the only oracle CSFloat gives one: our
   * cancel when a cancel hop of ours was sent for it, a fill when every unit was bought, else a
   * cancel at the venue, provisionally.
   */
  observeBuyOrders(accountId: string, observationId: number, orders: readonly CsfloatBuyOrder[], now: string): void {
    const seen = new Set(orders.map((order) => order.orderId));
    const open = this.db.raw().prepare(`SELECT * FROM venue_order v WHERE v.account_id=? AND v.venue='csfloat' AND v.side='BUY' AND ${IN_BOOK}`).all(accountId) as VenueOrderRow[];
    for (const row of open) {
      if (seen.has(row.venue_order_id!)) continue;
      const ours = this.db.raw().prepare(`SELECT 1 FROM work_step WHERE account_id=? AND kind='CSFLOAT_BUY_ORDER_CANCEL' AND target_id=? AND action_id IS NOT NULL LIMIT 1`).get(accountId, row.venue_order_id);
      const filled = row.filled !== null && row.filled >= row.quantity;
      const [state, confidence, reason]: [OrderState, OrderConfidence, string] = ours ? ['ENDED_CANCELLED_BY_US', 'proven', 'Gone from the book after a cancel of ours']
        : filled ? ['ENDED_FILLED', 'proven', 'The book reports every unit bought']
          : ['ENDED_CANCELLED_EXTERNALLY', 'probable', 'Gone from the book with units left to buy; cancellation is provisional'];
      this.db.raw().prepare(`UPDATE venue_order SET gone_obs=?, state=?, confidence=?, end_reason=?, end_evidence=?, ended_at=? WHERE account_id=? AND order_id=?`)
        .run(observationId, state, confidence, reason, observationId, now, accountId, row.order_id);
    }
    const parent = this.db.raw().prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, hash_name, venue_order_id, price_cents, currency, quantity, filled,
        state, confidence, opened_at, first_seen_obs, last_seen_obs)
      VALUES (?, ?, 'csfloat', 'BUY', ?, ?, ?, ${CSFLOAT_CURRENCY}, ?, ?, 'OPEN', 'proven', COALESCE(NULLIF(?, ''), ?), ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET hash_name=excluded.hash_name, price_cents=excluded.price_cents, quantity=excluded.quantity, filled=excluded.filled,
        state='OPEN', confidence='proven', first_seen_obs=COALESCE(venue_order.first_seen_obs, excluded.first_seen_obs), last_seen_obs=excluded.last_seen_obs, gone_obs=NULL,
        ended_at=NULL, end_reason=NULL, end_evidence=NULL`);
    const satellite = this.db.raw().prepare(`INSERT INTO csfloat_order(account_id, order_id, properties_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET properties_json=excluded.properties_json, created_at=excluded.created_at`);
    for (const order of orders) {
      parent.run(accountId, order.orderId, order.marketHashName, order.orderId, order.priceCents, order.quantity, order.bought, order.createdAt, now, observationId, observationId);
      satellite.run(accountId, order.orderId, order.properties === null ? null : JSON.stringify(order.properties), order.createdAt || null);
    }
    this.db.touch(accountId, 'venue_order');
  }
  publishTrade(accountId: string, trade: CsfloatTrade, observationId: number): void {
    const { tradeToken: _token, listing, ...fields } = trade;
    const safe: StoredCsfloatTrade = { ...fields, listing: { ...listing, raw: null } };
    this.db.raw().prepare(`INSERT INTO csfloat_trade(account_id,trade_id,listing_id,asset_id,local_id,state_word,seller_steam_id,data_json,observation_id,offer_id)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,trade_id) DO UPDATE SET local_id=COALESCE(excluded.local_id,csfloat_trade.local_id),
      state_word=excluded.state_word,data_json=excluded.data_json,observation_id=excluded.observation_id,offer_id=excluded.offer_id`)
      .run(accountId,trade.tradeId,trade.listingId,listing.item.assetId,this.associate(accountId,listing.item),trade.state,trade.sellerSteamId,JSON.stringify(safe),observationId,trade.offerId);
    if (this.db.account(accountId)?.steam_id64 === trade.sellerSteamId) this.publishContract(accountId,listing,observationId);
  }
  /** A buy order the last complete walk of the book showed, by the venue's id. */
  buyOrder(accountId: string, orderId: string): CsfloatBuyOrderRow | undefined {
    return this.db.raw().prepare(`${BUY_ORDER_SELECT} WHERE v.account_id=? AND v.venue='csfloat' AND v.side='BUY' AND v.venue_order_id=? AND ${IN_BOOK}`)
      .get(accountId, orderId) as CsfloatBuyOrderRow | undefined;
  }
  /** Every buy order the last complete walk of the book showed. */
  buyOrders(accountId: string): CsfloatBuyOrderRow[] {
    return this.db.raw().prepare(`${BUY_ORDER_SELECT} WHERE v.account_id=? AND v.venue='csfloat' AND v.side='BUY' AND ${IN_BOOK} ORDER BY v.venue_order_id`)
      .all(accountId) as CsfloatBuyOrderRow[];
  }
  contract(accountId: string, listingId: string): CsfloatContract | undefined {
    return this.db.raw().prepare(`${CONTRACT_SELECT} WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND v.venue_order_id=?`)
      .get(accountId,listingId) as CsfloatContract | undefined;
  }
  /** The advertisements that name a holding, by its row or by its asset id, in any state. */
  contractsFor(accountId: string, localId: string | null, assetId: string | null): CsfloatContract[] {
    return this.db.raw().prepare(`${CONTRACT_SELECT} WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND (v.local_id=? OR v.asset_id=?)`)
      .all(accountId, localId, assetId) as CsfloatContract[];
  }
  /**
   * The advertisements still standing against a holding, by its row or by its asset id, and, when
   * asked, those bound to no holding at all, which could be about any unit of the account.
   */
  standingContracts(accountId: string, localId: string, assetId: string, includeUnresolved: boolean): CsfloatContract[] {
    return this.db.raw().prepare(`${CONTRACT_SELECT} WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND s.state_word NOT IN ${CSFLOAT_ENDED_SQL}
      AND (v.local_id=? OR v.asset_id=?${includeUnresolved ? ' OR v.local_id IS NULL' : ''})`).all(accountId, localId, assetId) as CsfloatContract[];
  }
  /** Whether the last complete stall walk showed this listing: the one book that confers authority over it. */
  inStall(accountId: string, listingId: string): boolean {
    return Boolean(this.db.raw().prepare(`SELECT 1 FROM venue_order v WHERE v.account_id=? AND v.venue='csfloat' AND v.venue_order_id=? AND ${IN_BOOK}`).get(accountId, listingId));
  }
  /** Listings the stall no longer shows, or never has, whose word is not yet an ending: each is owed its own read. */
  unexplainedListings(accountId: string, limit = 250): string[] {
    return (this.db.raw().prepare(`SELECT v.venue_order_id AS listing_id FROM venue_order v JOIN csfloat_order s ON s.account_id=v.account_id AND s.order_id=v.order_id
      WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND s.state_word NOT IN ${CSFLOAT_ENDED_SQL} AND NOT (${IN_BOOK}) LIMIT ?`)
      .all(accountId, limit) as Array<{ listing_id: string }>).map((row) => row.listing_id);
  }
  trade(accountId: string, tradeId: string): CsfloatTradeRow | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_trade WHERE account_id=? AND trade_id=?').get(accountId,tradeId) as CsfloatTradeRow | undefined;
  }
}
