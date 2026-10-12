import type { EngineDatabase } from '../../db/database.js';
import { assertAccountScope, bounded, queryPage, type PageEnvelope, type Param, type ScopedPageRequest } from './paging.js';

export type HistoryPageRequest = ScopedPageRequest;
export type HistoryPageRow = { accountId: string; sourceKey: string; listingId: string | null; occurredAt: string; eventType: number; amountCents: number | null; currency: number | null };
export type OrderPageRow = { accountId: string; orderId: string; state: string; side: string; openedAt: string; priceReceiveCents: number | null };
export type ActivityPageRow = { accountId: string; id: string; kind: string; at: string };
export type TradePageRow = { accountId: string; kind: 'trade' | 'offer'; rowId: string; offerId: string | null;
  counterparty: string; status: string; occurredAt: string; settledAt: string | null; lines: number };
export type TransferPageRow = { accountId: string; destinationAccountId: string; commandId: string; offerId: string | null;
  state: string; reason: string | null; quantity: number; occurredAt: string; needsConfirmation: boolean; complete: boolean };
/** `amountBasis` is the load-bearing field: `UNKNOWN` must never render as a number. */
export type LedgerPageRow = { accountId: string; sourceKey: string; kind: string; occurredAt: string;
  quantity: number; amountCents: number | null; feeCents: number | null; currency: number | null;
  amountBasis: 'EVIDENCED' | 'UNKNOWN'; attribution: string; localId: string | null; orderId: string | null;
  tradeId: string | null; listingId: string | null; correctsSourceKey: string | null };

export function pageTransfers(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<TransferPageRow> {
  const accounts = assertAccountScope(database,request.accountIds);
  const marks = accounts.map(() => '?').join(',');
  return queryPage(database,request,'transfers',`SELECT b.account_id AS accountId,b.destination_account_id AS destinationAccountId,
    b.command_id AS commandId,b.offer_id AS offerId,b.state,b.reason,c.created_at AS occurredAt,
    (SELECT SUM(CAST(json_extract(a.value,'$.quantity') AS INTEGER)) FROM json_each(b.assets_json) a) AS quantity,
    b.state='NEEDS_CONFIRMATION' AS needsConfirmation,b.state='DONE' AS complete
    FROM transfer_batch b JOIN command c ON c.id=b.command_id
    WHERE b.account_id IN (${marks}) OR b.destination_account_id IN (${marks})`,[...accounts,...accounts],['occurredAt','commandId','accountId']);
}

export function pageHistory(database: EngineDatabase, request: HistoryPageRequest): PageEnvelope<HistoryPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const params: Param[] = [...accounts];
  let where = `h.account_id IN (${accounts.map(() => '?')})`;
  if (request.filter?.eventType !== undefined) { where += ' AND h.event_type=?'; params.push(request.filter.eventType); }
  if (request.filter?.search) { where += ' AND (h.event_id=? OR h.listing_id=?)'; params.push(request.filter.search, request.filter.search); }
  const n = (database.raw().prepare(`SELECT COUNT(*) AS n FROM market_history h WHERE ${where}`).get(...params) as { n: number }).n;
  // Money comes from the ledger, not from the raw event. `economic_event` is where an amount was
  // graded EVIDENCED or UNKNOWN, and a history row carrying its own number would be a second
  // answer to the same question — the one that quietly prints an unknown price as a figure
  // (DATA-04). The CASE is what keeps an UNKNOWN posting null here rather than zero.
  return queryPage(database, request, 'history', `SELECT h.account_id AS accountId, h.event_id AS sourceKey,
    h.listing_id AS listingId, h.occurred_at AS occurredAt, h.event_type AS eventType,
    (SELECT CASE WHEN e.amount_basis='EVIDENCED' THEN e.amount_cents END FROM economic_event e
      WHERE e.account_id=h.account_id AND e.listing_id=h.listing_id AND e.kind='MARKET_SALE') AS amountCents,
    (SELECT e.currency FROM economic_event e
      WHERE e.account_id=h.account_id AND e.listing_id=h.listing_id AND e.kind='MARKET_SALE') AS currency
    FROM market_history h WHERE ${where}`,
    params, ['accountId', 'occurredAt', 'sourceKey'], { handles: n, quantity: n, groups: n, rows: n });
}
export function pageOrders(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<OrderPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const params: Param[] = [...accounts];
  let where = `account_id IN (${accounts.map(() => '?')})`;
  if (request.filter?.state) { where += ' AND state=?'; params.push(request.filter.state); }
  if (request.filter?.search) { where += ' AND order_id=?'; params.push(request.filter.search); }
  const n = (database.raw().prepare(`SELECT COUNT(*) AS n FROM venue_order WHERE ${where}`).get(...params) as { n: number }).n;
  return queryPage(database, request, 'orders', `SELECT account_id AS accountId, order_id AS orderId, state, side, opened_at AS openedAt,
    price_receive_cents AS priceReceiveCents FROM venue_order WHERE ${where}`, params, ['accountId', 'openedAt', 'orderId'],
    { handles: n, quantity: n, groups: n, rows: n });
}
export function pageActivity(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<ActivityPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  return queryPage(database, request, 'activity', `SELECT account_id AS accountId,id,kind,at FROM event WHERE account_id IN (${accounts.map(() => '?')})`, accounts, ['accountId', 'at', 'id']);
}

/**
 * Executed trades and the offers that are still open, newest boundary last.
 *
 * Offers and executed trades are one list on purpose: what a person wants from a trading screen
 * is "what happened, and what is pending", and splitting them into two pages makes the reader
 * join them by eye. They stay distinguishable by `kind`, and an offer never claims a delivery.
 */
export function pageTrades(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<TradePageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const marks = accounts.map(() => '?').join(',');
  const params: Param[] = [...accounts, ...accounts];
  const state = request.filter?.state;
  const search = request.filter?.search;
  const sql = `SELECT account_id AS accountId, 'trade' AS kind, trade_id AS rowId, offer_id AS offerId,
      counterparty_steam_id64 AS counterparty, status, initiated_at AS occurredAt, settled_at AS settledAt,
      (SELECT COUNT(*) FROM trade_line l WHERE l.account_id=t.account_id AND l.trade_id=t.trade_id) AS lines
    FROM executed_trade t WHERE account_id IN (${marks})
    UNION ALL
    SELECT account_id AS accountId, 'offer' AS kind, offer_id AS rowId, offer_id AS offerId,
      counterparty_id AS counterparty, status, updated_at AS occurredAt, NULL AS settledAt,
      (SELECT COUNT(*) FROM trade_line l WHERE l.account_id=o.account_id AND l.offer_id=o.offer_id) AS lines
    FROM trade_offer o WHERE account_id IN (${marks})`;
  let filtered = `SELECT * FROM (${sql})`;
  const where: string[] = [];
  if (state) { where.push('status=?'); params.push(state); }
  if (search) { where.push('(rowId=? OR counterparty=?)'); params.push(search, search); }
  if (where.length) filtered += ` WHERE ${where.join(' AND ')}`;
  const n = (database.raw().prepare(`SELECT COUNT(*) AS n FROM (${filtered})`).get(...params) as { n: number }).n;
  return queryPage(database, request, 'trades', filtered, params, ['accountId', 'occurredAt', 'rowId'],
    { handles: n, quantity: n, groups: n, rows: n });
}

/**
 * The ledger.
 *
 * `amountBasis` travels with every row because `amountCents` is nullable and a renderer that
 * prints `0` for an unknown trade price has invented revenue (DATA-04). Filtering by `state`
 * filters by ledger `kind`, which is the vocabulary UX-06 asks for.
 */
export function pageLedger(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<LedgerPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const params: Param[] = [...accounts];
  let where = `account_id IN (${accounts.map(() => '?')})`;
  if (request.filter?.state) { where += ' AND kind=?'; params.push(request.filter.state); }
  if (request.filter?.search) { where += ' AND (source_key=? OR order_id=? OR trade_id=? OR listing_id=?)'; params.push(request.filter.search, request.filter.search, request.filter.search, request.filter.search); }
  const n = (database.raw().prepare(`SELECT COUNT(*) AS n FROM economic_event WHERE ${where}`).get(...params) as { n: number }).n;
  return queryPage(database, request, 'ledger', `SELECT account_id AS accountId, source_key AS sourceKey, kind,
    occurred_at AS occurredAt, quantity, amount_cents AS amountCents, fee_cents AS feeCents, currency,
    amount_basis AS amountBasis, attribution, local_id AS localId, order_id AS orderId, trade_id AS tradeId,
    listing_id AS listingId, corrects_source_key AS correctsSourceKey FROM economic_event WHERE ${where}`,
    params, ['accountId', 'occurredAt', 'sourceKey'], { handles: n, quantity: n, groups: n, rows: n });
}

export type DetailDomain = 'inventory' | 'orders' | 'history' | 'activity' | 'trades' | 'ledger';

export function readDetail(database: EngineDatabase, domain: DetailDomain, accountId: string, id: string): unknown {
  assertAccountScope(database, [accountId]);
  if (domain === 'trades') {
    const trade = database.raw().prepare(`
      SELECT account_id AS accountId, trade_id AS tradeId, offer_id AS offerId, counterparty_steam_id64 AS counterparty,
        status, initiated_at AS initiatedAt, settled_at AS settledAt
      FROM executed_trade WHERE account_id=? AND trade_id=?
    `).get(accountId, id);
    if (trade) {
      const lines = database.raw().prepare(`
        SELECT side, asset_id AS assetId, new_asset_id AS newAssetId, quantity, market_hash_name AS marketHashName
        FROM trade_line WHERE account_id=? AND trade_id=? ORDER BY side, line_key
      `).all(accountId, id);
      return bounded({ kind: 'trade', ...trade, lines });
    }
    const offer = database.raw().prepare(`
      SELECT account_id AS accountId, offer_id AS offerId, trade_id AS tradeId, counterparty_id AS counterparty,
        direction, status, created_at AS createdAt, updated_at AS updatedAt, escrow_until AS escrowUntil
      FROM trade_offer WHERE account_id=? AND offer_id=?
    `).get(accountId, id);
    if (!offer) return null;
    const lines = database.raw().prepare(`
      SELECT side, asset_id AS assetId, new_asset_id AS newAssetId, quantity, market_hash_name AS marketHashName
      FROM trade_line WHERE account_id=? AND offer_id=? ORDER BY side, line_key
    `).all(accountId, id);
    return bounded({ kind: 'offer', ...offer, lines });
  }
  if (domain === 'ledger') {
    return bounded(database.raw().prepare(`
      SELECT account_id AS accountId, source_key AS sourceKey, kind, occurred_at AS occurredAt, quantity,
        amount_cents AS amountCents, fee_cents AS feeCents, currency, amount_basis AS amountBasis,
        attribution, local_id AS localId, order_id AS orderId, trade_id AS tradeId, listing_id AS listingId,
        corrects_source_key AS correctsSourceKey
      FROM economic_event WHERE account_id=? AND source_key=?
    `).get(accountId, id) ?? null);
  }
  const shapes = {
    inventory: ['item', 'local_id', 'local_id,account_id,def_index,paint_index,paint_wear,paint_seed,quality,location,casket_id,tradable_after,trade_protected_until'],
    orders: ['venue_order', 'order_id', 'account_id,order_id,state,side,opened_at,price_receive_cents,local_id,action_id,venue_order_id'],
    history: ['market_history', 'event_id', 'account_id,event_id,listing_id,purchase_id,event_type,occurred_at,observation_id'],
    activity: ['event', 'id', 'account_id,id,kind,at']
  } as const;
  const [table, key, fields] = shapes[domain];
  return bounded(database.raw().prepare(`SELECT ${fields} FROM ${table} WHERE account_id=? AND ${key}=?`).get(accountId, id) ?? null);
}
