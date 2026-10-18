import type { EngineDatabase } from '../../db/database.js';
import { MarketplaceStore } from '../../db/marketplace.js';
import type { BuyOrderFilter } from '../../kernel/buy-order-filters.js';
import { constraintsAsProperties, csfloatBuyOrderFilters, describeBuyOrderConstraints, preservableConstraints, sameBuyOrderConstraints } from '../../kernel/csfloat-buy-orders.js';
import type { CsfloatBuyOrderConstraints } from '@cslytics/ports';
import { CSFLOAT_CURRENCY } from './listings.js';
import { OPEN_STEP_STATES_SQL } from '../../db/work.js';
import { assertAccountScope, bounded } from './paging.js';

/**
 * Every buy order a venue is showing as open, across a scope and both venues, in one answer.
 *
 * Two books, one list. Steam's is the `BUY` side of `venue_order`, written by the market walk:
 * `mylistings` returns every open order on its first page, and a *complete* walk ends an order it
 * no longer shows. CSFloat's is the `BUY` side of the same table on its venue, written by the
 * own-book walk, which marks a row gone only when a complete walk no longer shows it. So this read
 * is "open, or still in the book" and nothing else — it never decides an order is open or gone on
 * its own.
 *
 * Three refusals, each because the alternative is a plausible lie:
 *
 *  - **A receipt is not an outcome (rule 1).** A cancel the venue accepted keeps its order here
 *    until a complete walk no longer shows it, and the row says a cancel is on its way through
 *    `cancelSentAt` rather than disappearing early; an order that filled in that gap was bought,
 *    not cancelled. A CSFloat edit the venue accepted keeps the order's *observed* terms, and says
 *    what was asked for through `editPending`, until a walk shows the new ones.
 *  - **It never converts or merges currencies.** A Steam order is priced in the wallet currency
 *    of the account that placed it, from that account's last wallet snapshot, or `null` when no
 *    wallet was ever observed; a CSFloat order is in US dollars. `money` groups by venue and
 *    currency, never one sum.
 *  - **It carries its own evidence.** `coverage` names the walk each account's rows rest on, per
 *    venue, and whether it finished; a book built on an unfinished or never-run walk is a floor.
 *
 * `balances` is each CSFloat account's available balance as `/me` last showed it, with when: the
 * figure an edit is judged against, since CSFloat refuses one its balance cannot cover. It is the
 * venue's number, never arithmetic over orders (CSF-ORDER-05), and `null` when the status on
 * record belongs to an earlier connection, which may have been another CSFloat account.
 *
 * Names are the venues' own `hash_name`, observed evidence already on the row. A buy order is for
 * a market name, not an item this app holds, so no identity key travels beside it; the host
 * attaches a picture by name on the way out, if the catalogue knows one.
 */

export type BuyOrderVenue = 'STEAM' | 'CSFLOAT';

export type BuyOrderBookRow = {
  accountId: string;
  venue: BuyOrderVenue;
  buyOrderId: string;
  /** What the venue calls the item. Never a catalogue name; the engine holds none. */
  hashName: string;
  /** The limit a buyer pays for one, buyer side. Never what a fill cost: that is the ledger's (N-BUY-04). */
  priceCents: number;
  quantity: number;
  quantityRemaining: number;
  /** How many the venue has reported bought against this order so far. `null` when it did not say. */
  purchased: number | null;
  /** Money still committed: the limit times what is left to buy. What a cancel would free. */
  openCents: number;
  /** Steam `ECurrencyCode` of the money. `null` is a Steam wallet this app has not observed. */
  currency: number | null;
  /** CSFloat: what the order restricts, in words, or `null` for any item of that name. Steam has none. */
  constraints: string | null;
  /**
   * What the order restricts, as the shared filter kinds (`kernel/buy-order-filters.ts`): the window
   * draws these, and `constraints` is the same in one line of words. `[]` is any item of that name,
   * which every Steam order is; `null` is a CSFloat row that reported no properties at all.
   */
  filters: BuyOrderFilter[] | null;
  /** CSFloat: whether a change from here can carry the order's constraints through unchanged. */
  editable: boolean;
  /**
   * When a cancel this app sent is waiting on a walk to show the order gone: the earliest such
   * attempt. `null` when none is. On Steam a cancel queued and never sent is not counted — nothing
   * would ever advance it; on CSFloat a queued one is, because the engine sends it (CSF-25).
   */
  cancelSentAt: string | null;
  /** Why the newest cancel failed, in the engine's words, when that is the latest thing that happened to it. */
  cancelFailure: string | null;
  /**
   * CSFloat: a change queued or sent and not yet proved by a walk, with the terms it asked for.
   * `filters` is the filter set it asked for when that differs from the order's, else `null`.
   */
  editPending: { sentAt: string; priceCents: number; quantity: number; filters: BuyOrderFilter[] | null } | null;
  /** CSFloat: why the newest change failed, when that is the latest thing that happened to it. */
  editFailure: string | null;
  /** When the walk that first saw this order finished. A website order is older than this. */
  firstSeenAt: string | null;
  /** When the walk that last saw this order finished, and whether that walk completed (rule 5). */
  observedAt: string | null;
  observationComplete: number;
};

/** Money still committed on one venue in one currency. Two are two rows, never one sum (BUY-09). */
export type BuyOrderMoneyBucket = { venue: BuyOrderVenue; currency: number | null; orders: number; openCents: number };
/** The walk one account's rows on one venue rest on. `observedAt: null` is "never walked". */
export type BuyOrderCoverageRow = { accountId: string; venue: BuyOrderVenue; observedAt: string | null; complete: number };
/** A CSFloat account's available balance, USD cents, as `/me` last showed it. `null` is not read on this connection. */
export type BuyOrderBalanceRow = { accountId: string; venue: 'CSFLOAT'; availableCents: number | null; observedAt: string | null };
export type BuyOrderBook = {
  kind: 'book';
  rows: BuyOrderBookRow[];
  /** Every open order in scope. Larger than `rows.length` only past `BUY_ORDER_BOOK_LIMIT`. */
  total: number;
  money: BuyOrderMoneyBucket[];
  coverage: BuyOrderCoverageRow[];
  balances: BuyOrderBalanceRow[];
};

const MARKET_SURFACE = 'steam-market';
const CSFLOAT_SURFACE = 'csfloat-buy-orders';
/**
 * A bound, like every read here. Steam returns a whole account's orders on one `mylistings` page
 * and a CSFloat book is walked whole, so the list is small; `total` says so when it is not, rather
 * than a cut list reading as complete.
 */
export const BUY_ORDER_BOOK_LIMIT = 1000;

type SteamRaw = Omit<BuyOrderBookRow, 'venue' | 'constraints' | 'filters' | 'editable' | 'editPending' | 'editFailure'>;
type CsfloatRaw = {
  accountId: string; buyOrderId: string; hashName: string; priceCents: number; quantity: number; purchased: number | null;
  propertiesJson: string | null; cancelSentAt: string | null; cancelFailure: string | null;
  editSentAt: string | null; editPriceCents: number | null; editQuantity: number | null; editParams: string | null; editFailure: string | null;
  firstSeenAt: string | null; observedAt: string | null; observationComplete: number;
};

/** The open buy orders for a scope, by name, with their money and the walks behind them. */
export function readBuyOrders(database: EngineDatabase, request: { accountIds: readonly string[] }): BuyOrderBook {
  const accounts = assertAccountScope(database, request.accountIds);
  const marks = accounts.map(() => '?').join(',');
  const raw = database.raw();

  const steam = raw.prepare(`
    SELECT b.account_id AS accountId, b.venue_order_id AS buyOrderId, b.hash_name AS hashName,
      b.price_cents AS priceCents, b.quantity AS quantity, b.quantity - b.filled AS quantityRemaining,
      b.filled AS purchased, b.price_cents * (b.quantity - b.filled) AS openCents,
      (SELECT w.currency FROM wallet_snapshot w WHERE w.account_id=b.account_id ORDER BY w.id DESC LIMIT 1) AS currency,
      (SELECT MIN(a.created_at) FROM action a
        WHERE a.account_id=b.account_id AND a.kind='CANCEL_BUY_ORDER' AND a.target_id=b.venue_order_id
          AND (a.state IN ('RUNNING','AWAITING_OBSERVATION') OR (a.state='READY' AND a.resolution='OBSERVED_NOT_APPLIED'))) AS cancelSentAt,
      (SELECT CASE WHEN a.state='FAILED' THEN IFNULL(a.error, 'refused') END FROM action a
        WHERE a.account_id=b.account_id AND a.kind='CANCEL_BUY_ORDER' AND a.target_id=b.venue_order_id
          AND a.state<>'READY'
        ORDER BY a.updated_at DESC, a.id DESC LIMIT 1) AS cancelFailure,
      f.finished_at AS firstSeenAt, o.finished_at AS observedAt, IFNULL(o.complete, 0) AS observationComplete
    FROM venue_order b
    LEFT JOIN observation f ON f.id=b.first_seen_obs
    LEFT JOIN observation o ON o.id=b.last_seen_obs
    WHERE b.account_id IN (${marks}) AND b.venue='steam' AND b.side='BUY' AND b.first_seen_obs IS NOT NULL AND b.state NOT LIKE 'ENDED_%'`).all(...accounts) as SteamRaw[];

  const csfloat = raw.prepare(`
    SELECT b.account_id AS accountId, b.venue_order_id AS buyOrderId, b.hash_name AS hashName,
      b.price_cents AS priceCents, b.quantity AS quantity, b.filled AS purchased, s.properties_json AS propertiesJson,
      (SELECT MIN(p.created_at) FROM work_step p
        WHERE p.account_id=b.account_id AND p.kind='CSFLOAT_BUY_ORDER_CANCEL' AND p.target_id=b.venue_order_id
          AND p.state IN ${OPEN_STEP_STATES_SQL}) AS cancelSentAt,
      (SELECT CASE WHEN p.state='FAILED' THEN IFNULL(p.reason, 'refused') END FROM work_step p
        WHERE p.account_id=b.account_id AND p.kind='CSFLOAT_BUY_ORDER_CANCEL' AND p.target_id=b.venue_order_id
        ORDER BY p.updated_at DESC, p.id DESC LIMIT 1) AS cancelFailure,
      e.created_at AS editSentAt, json_extract(e.params_json,'$.maxPriceCents') AS editPriceCents, json_extract(e.params_json,'$.quantity') AS editQuantity,
      (SELECT a.params_json FROM action a WHERE a.id=e.action_id) AS editParams,
      (SELECT CASE WHEN p.state='FAILED' THEN IFNULL(p.reason, 'refused') END FROM work_step p
        WHERE p.account_id=b.account_id AND p.kind='CSFLOAT_BUY_ORDER_EDIT' AND p.target_id=b.venue_order_id
        ORDER BY p.updated_at DESC, p.id DESC LIMIT 1) AS editFailure,
      f.finished_at AS firstSeenAt, o.finished_at AS observedAt, IFNULL(o.complete, 0) AS observationComplete
    FROM venue_order b
    JOIN csfloat_order s ON s.account_id=b.account_id AND s.order_id=b.order_id
    LEFT JOIN work_step e ON e.id=(SELECT p.id FROM work_step p
      WHERE p.account_id=b.account_id AND p.kind='CSFLOAT_BUY_ORDER_EDIT' AND p.target_id=b.venue_order_id
        AND p.state IN ${OPEN_STEP_STATES_SQL} ORDER BY p.created_at, p.id LIMIT 1)
    LEFT JOIN observation f ON f.id=b.first_seen_obs
    LEFT JOIN observation o ON o.id=b.last_seen_obs
    WHERE b.account_id IN (${marks}) AND b.venue='csfloat' AND b.side='BUY' AND b.first_seen_obs IS NOT NULL AND b.gone_obs IS NULL`).all(...accounts) as CsfloatRaw[];

  const rows = [...steam.map(fromSteam), ...csfloat.map(fromCsfloat)]
    .sort((left, right) => left.hashName.localeCompare(right.hashName) || left.accountId.localeCompare(right.accountId)
      || left.venue.localeCompare(right.venue) || left.buyOrderId.localeCompare(right.buyOrderId));

  const buckets = new Map<string, BuyOrderMoneyBucket>();
  for (const row of rows) {
    const key = `${row.venue}:${row.currency ?? 'unknown'}`;
    const bucket = buckets.get(key) ?? { venue: row.venue, currency: row.currency, orders: 0, openCents: 0 };
    bucket.orders += 1;
    bucket.openCents += row.openCents;
    buckets.set(key, bucket);
  }
  const money = [...buckets.values()].sort((left, right) => left.venue.localeCompare(right.venue) || (left.currency ?? -1) - (right.currency ?? -1));

  const marketplace = new MarketplaceStore(database);
  const coverage: BuyOrderCoverageRow[] = [];
  const balances: BuyOrderBalanceRow[] = [];
  for (const accountId of accounts) {
    // Steam is every account's venue, so an account with no walk still gets a row saying so.
    // CSFloat is an account's venue once a key has been attached or once the book has been walked;
    // an account that has done neither gets no line, because the coverage of a venue it does not
    // use would be answering a question nobody asked.
    const market = database.latestObservation(accountId, MARKET_SURFACE);
    coverage.push({ accountId, venue: 'STEAM', observedAt: market?.finished_at ?? null, complete: market?.complete === 1 ? 1 : 0 });
    const book = database.latestObservation(accountId, CSFLOAT_SURFACE);
    const connection = marketplace.connection(accountId, 'csfloat');
    if (book || connection) {
      coverage.push({ accountId, venue: 'CSFLOAT', observedAt: book?.finished_at ?? null, complete: book?.complete === 1 ? 1 : 0 });
      // A status from an earlier generation says nothing about this connection (CSF-04).
      const status = marketplace.currentStatus(accountId);
      balances.push({ accountId, venue: 'CSFLOAT', availableCents: status?.available_cents ?? null, observedAt: status?.observed_at ?? null });
    }
  }
  return bounded({ kind: 'book' as const, rows: rows.slice(0, BUY_ORDER_BOOK_LIMIT), total: rows.length, money, coverage, balances });
}

function fromSteam(row: SteamRaw): BuyOrderBookRow {
  return { ...row, venue: 'STEAM', constraints: null, filters: [], editable: false, editPending: null, editFailure: null };
}

/** The filters a pending change asked for, when they are not the ones the order already has. */
function askedFilters(paramsJson: string | null, properties: Record<string, unknown> | null): BuyOrderFilter[] | null {
  if (paramsJson === null) return null;
  const asked = (JSON.parse(paramsJson) as { constraints?: CsfloatBuyOrderConstraints | null }).constraints ?? null;
  if (asked === null) return null;
  const observed = preservableConstraints(properties);
  if (observed !== null && sameBuyOrderConstraints(observed, asked)) return null;
  return csfloatBuyOrderFilters(constraintsAsProperties(asked));
}

/**
 * A CSFloat row. What is left to buy is `qty` less `bought_item_count`: whether the venue shrinks
 * `qty` as it fills has not been observed, so the count is honest as an upper bound and says so
 * in DATA-INDEX. A row whose bought count the venue did not report keeps the whole quantity open.
 */
function fromCsfloat(row: CsfloatRaw): BuyOrderBookRow {
  const properties = row.propertiesJson === null ? null : JSON.parse(row.propertiesJson) as Record<string, unknown>;
  const quantityRemaining = row.purchased === null ? row.quantity : Math.max(0, row.quantity - row.purchased);
  return {
    accountId: row.accountId,
    venue: 'CSFLOAT',
    buyOrderId: row.buyOrderId,
    hashName: row.hashName,
    priceCents: row.priceCents,
    quantity: row.quantity,
    quantityRemaining,
    purchased: row.purchased,
    openCents: row.priceCents * quantityRemaining,
    currency: CSFLOAT_CURRENCY,
    constraints: describeBuyOrderConstraints(properties),
    filters: csfloatBuyOrderFilters(properties),
    editable: preservableConstraints(properties) !== null,
    cancelSentAt: row.cancelSentAt,
    cancelFailure: row.cancelFailure,
    editPending: row.editSentAt !== null && row.editPriceCents !== null && row.editQuantity !== null
      ? { sentAt: row.editSentAt, priceCents: row.editPriceCents, quantity: row.editQuantity, filters: askedFilters(row.editParams, properties) }
      : null,
    editFailure: row.editFailure,
    firstSeenAt: row.firstSeenAt,
    observedAt: row.observedAt,
    observationComplete: row.observationComplete
  };
}
