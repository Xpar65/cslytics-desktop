import type { EngineDatabase } from './database.js';
import { OPEN_STEP_STATES_SQL } from './work.js';

export type TradeOfferRow = {
  account_id: string; offer_id: string; trade_id: string | null; counterparty_steam_id64: string;
  direction: 'SENT' | 'RECEIVED'; state_code: number; status: string; confirmation_method: number | null;
  escrow_until: string | null; expires_at: string | null; created_at: string; updated_at: string;
  first_seen_obs: number; last_seen_obs: number;
  /** Steam's `settlement_date`: for a trade-protected trade, when its reversal period ends. */
  settlement_date: string | null;
};

export type ExecutedTradeRow = {
  account_id: string; trade_id: string; offer_id: string | null; counterparty_steam_id64: string;
  status_code: number; status: string; initiated_at: string; updated_at: string | null;
  settled_at: string | null; reverses_trade_id: string | null; first_seen_obs: number; last_seen_obs: number;
};

/**
 * What the record holds of an account's executed trades: one segment, contiguous from the newest
 * trade down to a boundary, kept in `surface_state` as the `steam-trade-history` cursor.
 *
 * `afterTimeSeconds` and `afterTradeId` name the newest trade, the shape the checkpoint has carried
 * since the surface was built, so `covered_through` is still that trade's time. `boundary*` name
 * the oldest, the keyset an older page is read after. `total` is Steam's own count when it named
 * one, `reachedEnd` whether a page past the boundary said there was nothing older, and `stopped`
 * why a backfill gave up when it did (history backfill plan D1).
 */
export type TradeHistoryCoverage = {
  afterTimeSeconds: number;
  afterTradeId: string;
  boundaryTimeSeconds: number;
  boundaryTradeId: string;
  coveredCount: number;
  total: number | null;
  reachedEnd: boolean;
  stopped?: string;
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
    const previous = this.db.raw().prepare(`SELECT state_code, updated_at FROM trade_offer WHERE account_id=? AND offer_id=?`)
      .get(row.account_id, row.offer_id) as { state_code: number; updated_at: string } | undefined;
    this.db.raw().prepare(`
      INSERT INTO trade_offer(account_id, offer_id, trade_id, counterparty_steam_id64, direction, state_code, status,
        confirmation_method, escrow_until, expires_at, created_at, updated_at, first_seen_obs, last_seen_obs, settlement_date)
      VALUES (@account, @offer, @trade, @counterparty, @direction, @stateCode, @status,
        @confirmation, @escrow, @expires, @created, @updated, @obs, @obs, @settlement)
      ON CONFLICT(account_id, offer_id) DO UPDATE SET
        trade_id=COALESCE(excluded.trade_id, trade_offer.trade_id), counterparty_steam_id64=excluded.counterparty_steam_id64,
        direction=excluded.direction, state_code=excluded.state_code, status=excluded.status,
        confirmation_method=excluded.confirmation_method, escrow_until=excluded.escrow_until,
        expires_at=excluded.expires_at, updated_at=excluded.updated_at, last_seen_obs=excluded.last_seen_obs,
        settlement_date=COALESCE(excluded.settlement_date, trade_offer.settlement_date)
    `).run({
      account: row.account_id, offer: row.offer_id, trade: row.trade_id, counterparty: row.counterparty_steam_id64,
      direction: row.direction, stateCode: row.state_code, status: row.status,
      confirmation: row.confirmation_method, escrow: row.escrow_until, expires: row.expires_at,
      created: row.created_at, updated: row.updated_at, obs: row.observation_id, settlement: row.settlement_date ?? null
    });
    this.db.touch(row.account_id, 'trade_offer');
    const changed = !previous || previous.state_code !== row.state_code || previous.updated_at !== row.updated_at;
    if (changed) {
      this.db.raw().prepare(`
        INSERT INTO trade_status_event(account_id, event_key, offer_id, trade_id, state_code, status, occurred_at, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, event_key) DO NOTHING
      `).run(row.account_id, `offer:${row.offer_id}:${row.state_code}:${row.updated_at}`, row.offer_id, row.trade_id,
        row.state_code, row.status, row.updated_at, row.observation_id);
    }
    return { changed };
  }

  /** Same shape for an executed trade: the row, plus one journal entry per observed status. */
  upsertExecutedTrade(row: Omit<ExecutedTradeRow, 'first_seen_obs' | 'last_seen_obs'> & { observation_id: number }): { changed: boolean } {
    const previous = this.db.raw().prepare(`SELECT status_code FROM executed_trade WHERE account_id=? AND trade_id=?`)
      .get(row.account_id, row.trade_id) as { status_code: number } | undefined;
    this.db.raw().prepare(`
      INSERT INTO executed_trade(account_id, trade_id, offer_id, counterparty_steam_id64, status_code, status,
        initiated_at, updated_at, settled_at, reverses_trade_id, first_seen_obs, last_seen_obs)
      VALUES (@account, @trade, @offer, @counterparty, @statusCode, @status, @initiated, @updated, @settled, @reverses, @obs, @obs)
      ON CONFLICT(account_id, trade_id) DO UPDATE SET
        offer_id=COALESCE(excluded.offer_id, executed_trade.offer_id), status_code=excluded.status_code,
        status=excluded.status, updated_at=COALESCE(excluded.updated_at, executed_trade.updated_at),
        settled_at=COALESCE(excluded.settled_at, executed_trade.settled_at),
        reverses_trade_id=COALESCE(excluded.reverses_trade_id, executed_trade.reverses_trade_id),
        last_seen_obs=excluded.last_seen_obs
    `).run({
      account: row.account_id, trade: row.trade_id, offer: row.offer_id, counterparty: row.counterparty_steam_id64,
      statusCode: row.status_code, status: row.status, initiated: row.initiated_at, updated: row.updated_at,
      settled: row.settled_at, reverses: row.reverses_trade_id, obs: row.observation_id
    });
    this.db.touch(row.account_id, 'executed_trade');
    const changed = !previous || previous.status_code !== row.status_code;
    if (changed) {
      this.db.raw().prepare(`
        INSERT INTO trade_status_event(account_id, event_key, offer_id, trade_id, state_code, status, occurred_at, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, event_key) DO NOTHING
      `).run(row.account_id, `trade:${row.trade_id}:${row.status_code}`, row.offer_id, row.trade_id,
        row.status_code, row.status, row.updated_at ?? row.initiated_at, row.observation_id);
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

  /**
   * The committed coverage of the account's executed trades, or undefined before a walk committed
   * one. A checkpoint written before the backfill existed carried the newest trade alone, and moved
   * only on a walk that had read to the end of the log, so it is read as one segment holding every
   * trade the record has: the oldest row is its boundary and nothing is owed below it.
   */
  historyCoverage(accountId: string): TradeHistoryCoverage | undefined {
    const row = this.db.checkpoint(accountId, 'steam-trade-history');
    if (!row) return undefined;
    const cursor = JSON.parse(row.cursor_json) as Partial<TradeHistoryCoverage>;
    const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
    if (typeof cursor.afterTradeId !== 'string' || !integer(cursor.afterTimeSeconds)) return undefined;
    if (typeof cursor.boundaryTradeId === 'string' && integer(cursor.boundaryTimeSeconds) && integer(cursor.coveredCount)) {
      return {
        afterTimeSeconds: cursor.afterTimeSeconds, afterTradeId: cursor.afterTradeId,
        boundaryTimeSeconds: cursor.boundaryTimeSeconds, boundaryTradeId: cursor.boundaryTradeId,
        coveredCount: cursor.coveredCount, total: integer(cursor.total) ? cursor.total : null,
        reachedEnd: cursor.reachedEnd === true, ...(typeof cursor.stopped === 'string' ? { stopped: cursor.stopped } : {})
      };
    }
    const oldest = this.db.raw().prepare(`SELECT trade_id, initiated_at FROM executed_trade WHERE account_id=? ORDER BY initiated_at, trade_id LIMIT 1`)
      .get(accountId) as { trade_id: string; initiated_at: string } | undefined;
    const held = (this.db.raw().prepare(`SELECT COUNT(*) AS n FROM executed_trade WHERE account_id=?`).get(accountId) as { n: number }).n;
    return {
      afterTimeSeconds: cursor.afterTimeSeconds, afterTradeId: cursor.afterTradeId,
      boundaryTimeSeconds: oldest ? Math.floor(Date.parse(oldest.initiated_at) / 1000) : 0, boundaryTradeId: oldest?.trade_id ?? '',
      coveredCount: held, total: held, reachedEnd: true
    };
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
   * account expects to *receive* is not yet ours to move. An accepted offer pledges its assets
   * until Steam's history says what became of them (delivery retries plan D8): complete, and they
   * moved; reversed or rolled back, and they came back by a trade of their own; failed, and they
   * never moved. Steam leaves the offer at `ACCEPTED` for ever in every one of those, so the offer
   * alone would keep an item that came back pledged to the trade that gave it away.
   */
  committedTradeAssets(accountId: string, openStatuses: readonly string[]): Array<{ asset_id: string; offer_id: string; status: string }> {
    if (!openStatuses.length) return [];
    const observed = this.db.raw().prepare(`
      SELECT line.asset_id, offer.offer_id, offer.status FROM trade_line line
      JOIN trade_offer offer ON offer.account_id=line.account_id AND offer.offer_id=line.offer_id
      WHERE line.account_id=? AND line.side='GIVE' AND offer.status IN (${openStatuses.map(() => '?').join(',')})
      AND NOT EXISTS (SELECT 1 FROM work_step s WHERE s.account_id=offer.account_id AND s.kind='SEND' AND s.offer_id=offer.offer_id AND s.state='DONE')
      AND NOT EXISTS (SELECT 1 FROM executed_trade t WHERE t.account_id=offer.account_id AND t.trade_id=offer.trade_id
        AND t.status IN ('COMPLETE','REVERSED','ROLLED_BACK','FAILED'))
    `).all(accountId, ...openStatuses) as Array<{ asset_id: string; offer_id: string; status: string }>;
    // Before Steam supplies an offer id, the durable command is the pledge. An ambiguous
    // send must still exclude these assets from every other mutation, including after restart.
    const pending = this.db.raw().prepare(`SELECT json_extract(m.input_json,'$.assetId') AS asset_id,
      'command:' || s.command_id AS offer_id, s.state AS status
      FROM work_step s JOIN command_member m ON m.command_id=s.command_id AND m.account_id=s.account_id
      WHERE s.account_id=? AND s.kind='SEND' AND s.state IN ${OPEN_STEP_STATES_SQL}`).all(accountId) as typeof observed;
    return [...observed,...pending];
  }
}
