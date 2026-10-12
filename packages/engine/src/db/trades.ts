import type { EngineDatabase } from './database.js';

export type TradeOfferRow = {
  account_id: string; offer_id: string; trade_id: string | null; counterparty_id: string;
  direction: 'SENT' | 'RECEIVED'; raw_state: number; status: string; confirmation_method: number | null;
  escrow_until: string | null; expires_at: string | null; created_at: string; updated_at: string;
  first_seen_obs: number; last_seen_obs: number;
  /** Steam's `settlement_date`: for a trade-protected trade, when its reversal period ends. */
  settlement_date: string | null;
};

export type ExecutedTradeRow = {
  account_id: string; trade_id: string; offer_id: string | null; counterparty_steam_id64: string;
  raw_status: number; status: string; initiated_at: string; updated_at: string | null;
  settled_at: string | null; reverses_trade_id: string | null; first_seen_obs: number; last_seen_obs: number;
};

export type TradeLineRow = {
  account_id: string; line_key: string; trade_id: string | null; offer_id: string | null;
  side: 'GIVE' | 'RECEIVE'; app_id: number; context_id: string; asset_id: string; new_asset_id: string | null;
  class_id: string; instance_id: string; quantity: number; market_hash_name: string | null;
  attributes_json: string; local_id: string | null; candidates_json: string; observation_id: number;
};

/**
 * The trade record: offers, executed trades, their lines and the status journal, over the one
 * writer. Every statement that decides what a trade row is lives here (holdings plan §10.1); the
 * trades surface decides when to write one, and the preflights read what is pledged.
 */
export class TradeStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * Writes one offer's current row and journals the transition when its state changed.
   *
   * Steam sends no transition feed: it sends the row as it is now. The journal key is
   * `(offer, raw state, updated_at)`, so re-reading the same page cannot append a second copy
   * (TRD-05, DATA-02) while a genuine change always gets one.
   */
  upsertTradeOffer(row: Omit<TradeOfferRow, 'first_seen_obs' | 'last_seen_obs' | 'settlement_date'> & { observation_id: number; settlement_date?: string | null }): { changed: boolean } {
    const previous = this.db.raw().prepare(`SELECT raw_state, updated_at FROM trade_offer WHERE account_id=? AND offer_id=?`)
      .get(row.account_id, row.offer_id) as { raw_state: number; updated_at: string } | undefined;
    this.db.raw().prepare(`
      INSERT INTO trade_offer(account_id, offer_id, trade_id, counterparty_id, direction, raw_state, status,
        confirmation_method, escrow_until, expires_at, created_at, updated_at, first_seen_obs, last_seen_obs, settlement_date)
      VALUES (@account, @offer, @trade, @counterparty, @direction, @rawState, @status,
        @confirmation, @escrow, @expires, @created, @updated, @obs, @obs, @settlement)
      ON CONFLICT(account_id, offer_id) DO UPDATE SET
        trade_id=COALESCE(excluded.trade_id, trade_offer.trade_id), counterparty_id=excluded.counterparty_id,
        direction=excluded.direction, raw_state=excluded.raw_state, status=excluded.status,
        confirmation_method=excluded.confirmation_method, escrow_until=excluded.escrow_until,
        expires_at=excluded.expires_at, updated_at=excluded.updated_at, last_seen_obs=excluded.last_seen_obs,
        settlement_date=COALESCE(excluded.settlement_date, trade_offer.settlement_date)
    `).run({
      account: row.account_id, offer: row.offer_id, trade: row.trade_id, counterparty: row.counterparty_id,
      direction: row.direction, rawState: row.raw_state, status: row.status,
      confirmation: row.confirmation_method, escrow: row.escrow_until, expires: row.expires_at,
      created: row.created_at, updated: row.updated_at, obs: row.observation_id, settlement: row.settlement_date ?? null
    });
    const changed = !previous || previous.raw_state !== row.raw_state || previous.updated_at !== row.updated_at;
    if (changed) {
      this.db.raw().prepare(`
        INSERT INTO trade_status_event(account_id, event_key, offer_id, trade_id, raw_state, status, occurred_at, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, event_key) DO NOTHING
      `).run(row.account_id, `offer:${row.offer_id}:${row.raw_state}:${row.updated_at}`, row.offer_id, row.trade_id,
        row.raw_state, row.status, row.updated_at, row.observation_id);
    }
    return { changed };
  }

  /** Same shape for an executed trade: the row, plus one journal entry per observed status. */
  upsertExecutedTrade(row: Omit<ExecutedTradeRow, 'first_seen_obs' | 'last_seen_obs'> & { observation_id: number }): { changed: boolean } {
    const previous = this.db.raw().prepare(`SELECT raw_status FROM executed_trade WHERE account_id=? AND trade_id=?`)
      .get(row.account_id, row.trade_id) as { raw_status: number } | undefined;
    this.db.raw().prepare(`
      INSERT INTO executed_trade(account_id, trade_id, offer_id, counterparty_steam_id64, raw_status, status,
        initiated_at, updated_at, settled_at, reverses_trade_id, first_seen_obs, last_seen_obs)
      VALUES (@account, @trade, @offer, @counterparty, @rawStatus, @status, @initiated, @updated, @settled, @reverses, @obs, @obs)
      ON CONFLICT(account_id, trade_id) DO UPDATE SET
        offer_id=COALESCE(excluded.offer_id, executed_trade.offer_id), raw_status=excluded.raw_status,
        status=excluded.status, updated_at=COALESCE(excluded.updated_at, executed_trade.updated_at),
        settled_at=COALESCE(excluded.settled_at, executed_trade.settled_at),
        reverses_trade_id=COALESCE(excluded.reverses_trade_id, executed_trade.reverses_trade_id),
        last_seen_obs=excluded.last_seen_obs
    `).run({
      account: row.account_id, trade: row.trade_id, offer: row.offer_id, counterparty: row.counterparty_steam_id64,
      rawStatus: row.raw_status, status: row.status, initiated: row.initiated_at, updated: row.updated_at,
      settled: row.settled_at, reverses: row.reverses_trade_id, obs: row.observation_id
    });
    const changed = !previous || previous.raw_status !== row.raw_status;
    if (changed) {
      this.db.raw().prepare(`
        INSERT INTO trade_status_event(account_id, event_key, offer_id, trade_id, raw_state, status, occurred_at, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, event_key) DO NOTHING
      `).run(row.account_id, `trade:${row.trade_id}:${row.raw_status}`, row.offer_id, row.trade_id,
        row.raw_status, row.status, row.updated_at ?? row.initiated_at, row.observation_id);
    }
    return { changed };
  }

  upsertTradeLine(row: TradeLineRow): void {
    this.db.raw().prepare(`
      INSERT INTO trade_line(account_id, line_key, trade_id, offer_id, side, app_id, context_id, asset_id,
        new_asset_id, class_id, instance_id, quantity, market_hash_name, attributes_json, local_id, candidates_json, observation_id)
      VALUES (@account, @key, @trade, @offer, @side, @app, @context, @asset, @newAsset, @classId, @instance,
        @quantity, @hash, @attributes, @local, @candidates, @obs)
      ON CONFLICT(account_id, line_key) DO UPDATE SET
        trade_id=COALESCE(excluded.trade_id, trade_line.trade_id),
        new_asset_id=COALESCE(excluded.new_asset_id, trade_line.new_asset_id),
        market_hash_name=COALESCE(excluded.market_hash_name, trade_line.market_hash_name),
        attributes_json=excluded.attributes_json, local_id=COALESCE(excluded.local_id, trade_line.local_id),
        candidates_json=excluded.candidates_json, observation_id=excluded.observation_id
    `).run({
      account: row.account_id, key: row.line_key, trade: row.trade_id, offer: row.offer_id, side: row.side,
      app: row.app_id, context: row.context_id, asset: row.asset_id, newAsset: row.new_asset_id,
      classId: row.class_id, instance: row.instance_id, quantity: row.quantity, hash: row.market_hash_name,
      attributes: row.attributes_json, local: row.local_id, candidates: row.candidates_json, obs: row.observation_id
    });
  }

  tradeOffer(accountId: string, offerId: string): TradeOfferRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM trade_offer WHERE account_id=? AND offer_id=?`)
      .get(accountId, offerId) as TradeOfferRow | undefined;
  }

  tradeOffers(accountId: string): TradeOfferRow[] {
    return this.db.raw().prepare(`SELECT * FROM trade_offer WHERE account_id=? ORDER BY updated_at, offer_id`)
      .all(accountId) as TradeOfferRow[];
  }

  executedTrade(accountId: string, tradeId: string): ExecutedTradeRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM executed_trade WHERE account_id=? AND trade_id=?`)
      .get(accountId, tradeId) as ExecutedTradeRow | undefined;
  }

  executedTrades(accountId: string): ExecutedTradeRow[] {
    return this.db.raw().prepare(`SELECT * FROM executed_trade WHERE account_id=? ORDER BY initiated_at, trade_id`)
      .all(accountId) as ExecutedTradeRow[];
  }

  tradeLines(accountId: string, key: { tradeId?: string; offerId?: string }): TradeLineRow[] {
    if (key.tradeId !== undefined) {
      return this.db.raw().prepare(`SELECT * FROM trade_line WHERE account_id=? AND trade_id=? ORDER BY side, line_key`)
        .all(accountId, key.tradeId) as TradeLineRow[];
    }
    return this.db.raw().prepare(`SELECT * FROM trade_line WHERE account_id=? AND offer_id=? ORDER BY side, line_key`)
      .all(accountId, key.offerId ?? '') as TradeLineRow[];
  }

  tradeStatusEvents(accountId: string): Array<{ event_key: string; offer_id: string | null; trade_id: string | null; status: string; occurred_at: string }> {
    return this.db.raw().prepare(`SELECT event_key, offer_id, trade_id, status, occurred_at FROM trade_status_event
      WHERE account_id=? ORDER BY occurred_at, event_key`).all(accountId) as Array<{
        event_key: string; offer_id: string | null; trade_id: string | null; status: string; occurred_at: string;
      }>;
  }

  /**
   * Asset ids currently pledged by an offer this account has not seen end.
   *
   * The store/list preflight asks this (TRD-06). It reads `GIVE` lines only: an item this
   * account expects to *receive* is not yet ours to move.
   */
  committedTradeAssets(accountId: string, openStatuses: readonly string[]): Array<{ asset_id: string; offer_id: string; status: string }> {
    if (!openStatuses.length) return [];
    const observed = this.db.raw().prepare(`
      SELECT line.asset_id, offer.offer_id, offer.status FROM trade_line line
      JOIN trade_offer offer ON offer.account_id=line.account_id AND offer.offer_id=line.offer_id
      WHERE line.account_id=? AND line.side='GIVE' AND offer.status IN (${openStatuses.map(() => '?').join(',')})
      AND NOT EXISTS (SELECT 1 FROM transfer_batch b WHERE b.account_id=offer.account_id AND b.offer_id=offer.offer_id AND b.state='DONE')
    `).all(accountId, ...openStatuses) as Array<{ asset_id: string; offer_id: string; status: string }>;
    // Before Steam supplies an offer id, the durable command is the pledge. An ambiguous
    // send must still exclude these assets from every other mutation, including after restart.
    const pending = this.db.raw().prepare(`SELECT json_extract(asset.value,'$.assetId') AS asset_id,
      'command:' || batch.command_id AS offer_id, batch.state AS status
      FROM transfer_batch batch, json_each(batch.assets_json) asset
      WHERE batch.account_id=? AND batch.state NOT IN ('DONE','ENDED','FAILED')`).all(accountId) as typeof observed;
    return [...observed,...pending];
  }
}
