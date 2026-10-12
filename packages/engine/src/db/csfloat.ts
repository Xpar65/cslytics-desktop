import type { CsfloatListing, CsfloatListingItem, CsfloatTrade } from '@cslytics/ports';
import type { EngineDatabase, ObservationRow } from './database.js';
import { MarketplaceStore } from './marketplace.js';

export type CsfloatOperation = {
  id: string; command_id: string; account_id: string; kind: string; local_id: string | null; asset_id: string | null;
  listing_id: string | null; trade_id: string | null; price_cents: number | null; generation: number; policy_version: number;
  state: string; action_id: string | null; offer_id: string | null; created_at: string; updated_at: string; error: string | null;
  /** A crated member's RETRIEVE_FROM_CASKET; null when the item was admitted from main inventory. */
  retrieve_action_id: string | null;
  /** The observation that proved the retrieved item loose: the anchor of the CSFloat wait. */
  loose_obs: number | null;
  visibility_deadline_at: string | null;
  /** The venue's buy-order id, for a BUY_ORDER_EDIT or BUY_ORDER_CANCEL; null on listing and delivery work. */
  order_id: string | null;
  /** The quantity a BUY_ORDER_EDIT asks for, frozen at admission beside `price_cents`. */
  quantity: number | null;
};
/** One of the account's own CSFloat buy orders as the last complete walk of the book showed it. */
export type CsfloatBuyOrderRow = { account_id: string; order_id: string; generation: number; hash_name: string; price_cents: number;
  quantity: number; bought: number | null; properties_json: string | null; created_at: string | null; first_seen_obs: number; last_seen_obs: number };
export type CsfloatContract = { account_id: string; listing_id: string; asset_id: string; local_id: string | null;
  state: string; price_cents: number; item_json: string; type: string; observation_id: number };
export type CsfloatTradeRow = { account_id: string; trade_id: string; listing_id: string; asset_id: string; local_id: string | null;
  state: string; seller_steam_id: string; data_json: string; observation_id: number };
export type StoredCsfloatTrade = Omit<CsfloatTrade, 'tradeToken'>;

export class CsfloatStore {
  constructor(readonly db: EngineDatabase) {}
  policy(): { preventDuplicates: boolean; version: number } {
    const row = this.db.raw().prepare('SELECT * FROM marketplace_policy WHERE singleton=1').get() as { prevent_duplicates: number; version: number } | undefined;
    return { preventDuplicates: row?.prevent_duplicates !== 0, version: row?.version ?? 1 };
  }
  setPolicy(enabled: boolean): void {
    if (this.policy().preventDuplicates === enabled) return;
    this.db.raw().prepare(`INSERT INTO marketplace_policy(singleton,prevent_duplicates,version) VALUES (1,?,2)
      ON CONFLICT(singleton) DO UPDATE SET prevent_duplicates=excluded.prevent_duplicates,version=marketplace_policy.version+1`).run(Number(enabled));
  }
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
  publishContract(accountId: string, listing: CsfloatListing, observationId: number): void {
    this.db.raw().prepare(`INSERT INTO csfloat_contract(account_id,listing_id,asset_id,local_id,state,price_cents,item_json,type,observation_id)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,listing_id) DO UPDATE SET asset_id=excluded.asset_id,
      local_id=COALESCE(excluded.local_id,csfloat_contract.local_id),state=excluded.state,price_cents=excluded.price_cents,
      item_json=excluded.item_json,type=excluded.type,observation_id=excluded.observation_id`)
      .run(accountId,listing.listingId,listing.item.assetId,this.associate(accountId,listing.item),listing.state,listing.priceCents,JSON.stringify(listing.item),listing.type,observationId);
  }
  publishTrade(accountId: string, trade: CsfloatTrade, observationId: number): void {
    const { tradeToken: _token, listing, ...fields } = trade;
    const safe: StoredCsfloatTrade = { ...fields, listing: { ...listing, raw: null } };
    this.db.raw().prepare(`INSERT INTO csfloat_trade(account_id,trade_id,listing_id,asset_id,local_id,state,seller_steam_id,data_json,observation_id)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,trade_id) DO UPDATE SET local_id=COALESCE(excluded.local_id,csfloat_trade.local_id),
      state=excluded.state,data_json=excluded.data_json,observation_id=excluded.observation_id`)
      .run(accountId,trade.tradeId,trade.listingId,listing.item.assetId,this.associate(accountId,listing.item),trade.state,trade.sellerSteamId,JSON.stringify(safe),observationId);
    if (this.db.account(accountId)?.steam_id64 === trade.sellerSteamId) this.publishContract(accountId,listing,observationId);
  }
  buyOrder(accountId: string, orderId: string): CsfloatBuyOrderRow | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_buy_order WHERE account_id=? AND order_id=?').get(accountId, orderId) as CsfloatBuyOrderRow | undefined;
  }
  contract(accountId: string, listingId: string): CsfloatContract | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_contract WHERE account_id=? AND listing_id=?').get(accountId,listingId) as CsfloatContract | undefined;
  }
  trade(accountId: string, tradeId: string): CsfloatTradeRow | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_trade WHERE account_id=? AND trade_id=?').get(accountId,tradeId) as CsfloatTradeRow | undefined;
  }
  operation(id: string): CsfloatOperation | undefined { return this.db.raw().prepare('SELECT * FROM csfloat_operation WHERE id=?').get(id) as CsfloatOperation | undefined; }
  operations(accountId: string): CsfloatOperation[] { return this.db.raw().prepare('SELECT * FROM csfloat_operation WHERE account_id=? ORDER BY created_at,id').all(accountId) as CsfloatOperation[]; }
  update(id: string, state: string, now: string, error: string | null = null): void {
    this.db.raw().prepare('UPDATE csfloat_operation SET state=?,updated_at=?,error=? WHERE id=?').run(state,now,error,id);
  }
  /** The retrieve was observed: the operation now waits for CSFloat to see the item, until `deadline`. */
  stampLoose(id: string, looseObs: number, deadline: string, now: string): void {
    this.db.raw().prepare("UPDATE csfloat_operation SET state='AWAITING_VENUE',loose_obs=?,visibility_deadline_at=?,updated_at=? WHERE id=?").run(looseObs,deadline,now,id);
  }
  /** CSFloat saw the item: the create action exists and the operation joins the ordinary path. */
  attachAction(id: string, actionId: string, now: string): void {
    this.db.raw().prepare("UPDATE csfloat_operation SET state='QUEUED',action_id=?,updated_at=? WHERE id=?").run(actionId,now,id);
  }
}
