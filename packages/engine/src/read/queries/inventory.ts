import { randomUUID } from 'node:crypto';
import { wearBandSql } from '@cslytics/ports';
import type { EngineDatabase } from '../../db/database.js';
import { inventoryQuery, inventoryTotals, type InventoryFilter } from '../../db/inventory-query.js';
import { assertAccountScope, boundPageSize, bounded, decode, hash, queryPage, readRevision, type PageEnvelope, type Param, type ScopedPageRequest } from './paging.js';

/**
 * `'name'` is deliberately absent. Sorting by name needs names, and the engine has none — the
 * catalogue lives in the host. A bounded group summary is sorted there instead, which is why
 * `pageInventoryGroups` exists.
 *
 * `'keys'` is how the host pages every handle in name order all the same, without a name crossing
 * into the engine: it sorts the group summary by name itself and hands back the identity keys in
 * that order as `keyOrder`, exactly as a name filter comes back as `matchKeys`. The engine pages
 * handles in the order of their keys, least worn first within a key. `'float'` orders by wear
 * alone. `'seen'` orders by when the holding was first detected: the finished time of
 * `first_seen_obs`. Steam does not say when an item was acquired, so a holding that arrived later
 * — a trade, a purchase — is dated by the walk that first showed it, which is when it was received.
 * All three honour `direction`; the two older sorts ascend only.
 */
export type InventorySort = 'localId' | 'defIndex' | 'keys' | 'float' | 'seen';
export type InventoryPageRequest = Omit<ScopedPageRequest, 'filter'> & {
  sort?: InventorySort;
  /** With `'keys'`: identity keys in the order to page their handles. A key it omits sorts last. */
  keyOrder?: readonly string[];
  direction?: 'asc' | 'desc';
  filter?: InventoryFilter;
};
/**
 * One holding: identity, quantity and location. A case is a row of its own, exactly as a skin is.
 * No name, no category, no image: those are the host's to attach on the way to the renderer, from
 * a catalogue this package has never heard of.
 */
export type InventoryPageRow = {
  accountId: string; rowKey: string; localId: string;
  /** `fungible` for a case, sticker, agent and the like, whose copies are interchangeable; `individual` for a skin or a storage unit. */
  unitKind: 'individual' | 'fungible';
  location: string; casketId: string | null; quantity: number;
  defIndex: number; paintIndex: number | null; quality: number; matchKey: string;
  paintWear: number | null; paintSeed: number | null; tradableAfter: string | null;
  tradeProtectedUntil: string | null;
  /** Steam's asset id for this holding. */
  assetId: string | null;
  /**
   * `1` when an open Steam Market listing names this holding, else `0`. Beside `location`, never
   * one of its values: the Game Coordinator keeps a listed item in main inventory, so a listed
   * row is `MAIN` and listed at once (`db/commitment.ts`).
   */
  steamListed: number;
  /**
   * Steam's `marketable` flag from the last Community read of the asset (holdings plan D7):
   * `1`, `0`, or `null` when no read has named it. Unknown never blocks; the host and the
   * preflight both read it that way.
   */
  marketable: number | null;
  /** `1` when the Game Coordinator marks the unit `cannot trade` (attribute 2), else `0`. Refuses only: `0` grants nothing. */
  cannotTrade: number;
};
/** One `(def_index, paint_index, quality)` across a scope: the default inventory view. */
export type InventoryGroupRow = {
  accountId: string; matchKey: string; defIndex: number; paintIndex: number | null; quality: number;
  quantity: number; handles: number; main: number; storage: number;
  /** Of `main`, how many an open Steam listing names: a share of it, not a third place. */
  listed: number;
  minWear: number | null; maxWear: number | null;
  /** `1` only when every unit under the key is marked `cannot trade`; one tradable unit makes it `0`. */
  cannotTrade: number;
  /**
   * `1` when the last Community read holds any unit under the key marketable, `0` when it names
   * them all unmarketable, `null` when it named none. Observation that outranks the catalogue.
   */
  anyMarketable: number | null;
};
/**
 * A group summary is meant to be held whole by the host, so that sorting and searching it by name
 * costs nothing. That is only affordable while the scope has few enough groups, and group count is
 * bounded by catalogue cardinality rather than by item count — a 200,000-item account is typically
 * a few hundred groups.
 *
 * When a scope exceeds the cap the answer is `needs-filter`, naming the count, and **never** a
 * truncated list. A partial list that reads as complete is how a user comes to believe they have
 * seen everything they own.
 */
export type GroupEnvelope = PageEnvelope<InventoryGroupRow> | { kind: 'needs-filter'; groups: number; cap: number };
/**
 * One storage unit. `localId` is the unit's own inventory row, so a window that shows the unit as
 * an item can find its label and count; null until an inventory read has seen the unit itself.
 */
export type StoragePageRow = { accountId: string; casketId: string; localId: string | null; label: string | null; reportedCount: number; knownQuantity: number; complete: boolean };

export function pageInventory(database: EngineDatabase, request: InventoryPageRequest, now: string): PageEnvelope<InventoryPageRow> {
  if (request.sort === 'keys' || request.sort === 'float' || request.sort === 'seen') return pageInventoryOrdered(database, request, now);
  const accounts = assertAccountScope(database, request.accountIds);
  const size = boundPageSize(request.pageSize);
  const keys = request.sort === 'defIndex' ? ['accountId', 'defIndex', 'rowKey'] : ['accountId', 'rowKey'];
  const binding = hash({ domain: 'inventory', accounts, filter: request.filter ?? {}, sort: request.sort ?? 'localId' });
  const marks = database.revisionMarks(accounts);
  // The catalogue revision used to be hashed in here, which meant a name refresh invalidated every
  // open inventory cursor. Renaming an item changes nothing about which handles exist or how they
  // page, so it no longer participates — and now it could not, since the engine has no catalogue.
  const revision = hash([marks, readRevision(database, accounts)]);
  const cursor = request.cursor ? decode(request.cursor) : undefined;
  if (cursor && (cursor.binding !== binding || cursor.revision !== revision || cursor.after.length !== keys.length)) {
    return { kind: 'stale-page', reason: 'cursor does not match surface, scope, filter, sort or revision' };
  }
  const defaultSort = request.sort === undefined || request.sort === 'localId';
  const query = inventoryQuery(database, accounts, request.filter ?? {}, now, defaultSort
    ? { ...(cursor ? { after: [String(cursor.after[0]), String(cursor.after[1])] as const } : {}), limit: size + 1 }
    : undefined);
  // A resolved key set can still select tens of thousands of rows. COUNT(*) of that set is not a
  // 250 ms indexed aggregate — walk the page instead and treat hasNext as a lower bound.
  const exactTotals = request.filter?.matchKeys === undefined;
  const count = exactTotals ? inventoryTotals(database, accounts, request.filter ?? {}, now) : undefined;
  const sql = `SELECT * FROM (${query.sql})`;
  const rows = (defaultSort
    ? database.raw().prepare(`${sql} ORDER BY ${keys.join(',')} LIMIT ?`).all(...query.params, size + 1)
    : database.raw().prepare(`${sql} ${cursor ? `WHERE (${keys.join(',')})>(${keys.map(() => '?').join(',')})` : ''} ORDER BY ${keys.join(',')} LIMIT ?`)
      .all(...query.params, ...(cursor?.after ?? []), size + 1)) as Array<InventoryPageRow & Record<string, Param>>;
  const hasNext = rows.length > size;
  if (hasNext) rows.pop();
  const last = rows.at(-1);
  const pageQuantity = rows.reduce((n, row) => n + row.quantity, 0);
  const total = count ?? {
    handles: rows.length + (hasNext ? 1 : 0),
    quantity: pageQuantity + (hasNext ? 1 : 0),
    groups: rows.length + (hasNext ? 1 : 0),
    rows: rows.length + (hasNext ? 1 : 0)
  };
  return bounded({ kind: 'page', requestId: randomUUID(), revision, rows,
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ binding, revision, after: keys.map(k => last[k]) })).toString('base64url') : null,
    hasNext, total: { handles: total.quantity, quantity: total.quantity, groups: total.groups, rows: total.rows } });
}
/**
 * Handles in an order the caller chose: the host's order of identity keys, wear, or first detection.
 *
 * All three go through `queryPage`, so the cursor is one row-value comparison over every key and
 * runs one way for all of them. None of these orders has an index behind it, so the filtered set
 * is sorted for each page. That is the price of an order the engine cannot store, and it is the
 * same full pass the totals already make.
 *
 * Nothing is ever left out to make an order work. A handle whose key the order does not name (the
 * inventory moved between the host's summary and this page), a handle with no float, and a handle
 * whose first sighting cannot be read are given stand-ins that sort them last whichever way the
 * page runs, because a keyset comparison with NULL strands every row behind it, and a walk that
 * quietly loses a row misstates what is owned.
 */
function pageInventoryOrdered(database: EngineDatabase, request: InventoryPageRequest, now: string): PageEnvelope<InventoryPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const filter = request.filter ?? {};
  const descending = request.direction === 'desc';
  const byKeys = request.sort === 'keys';
  const bySeen = request.sort === 'seen';
  // A repeated key would join its handles twice. Its first mention is its place.
  const order = byKeys ? [...new Set(request.keyOrder ?? [])] : [];
  const query = inventoryQuery(database, accounts, filter, now, undefined, bySeen ? { detected: true } : undefined);
  const wear = `IFNULL(q.paintWear, ${descending ? -1 : 2})`;
  // An ISO timestamp sorts lexicographically. The stand-in is before every date on the way down
  // and after every date on the way up, so a missing sighting is last either way.
  const seen = `IFNULL(q.firstSeenAt, '${descending ? '' : '~'}')`;
  const sql = byKeys
    ? `SELECT q.*, IFNULL(o.rank, ${descending ? -1 : order.length}) AS sortRank, ${wear} AS sortWear FROM (${query.sql}) q
       LEFT JOIN (SELECT value AS matchKey, CAST(key AS INTEGER) AS rank FROM json_each(?)) o ON o.matchKey = q.matchKey`
    : bySeen
      ? `SELECT q.*, ${seen} AS sortSeen FROM (${query.sql}) q`
      : `SELECT q.*, ${wear} AS sortWear FROM (${query.sql}) q`;
  const params: Param[] = byKeys ? [...query.params, JSON.stringify(order)] : [...query.params];
  const keys = byKeys ? ['sortRank', 'sortWear', 'accountId', 'rowKey'] : bySeen ? ['sortSeen', 'accountId', 'rowKey'] : ['sortWear', 'accountId', 'rowKey'];
  const totals = inventoryTotals(database, accounts, filter, now);
  const page = queryPage<InventoryPageRow & { sortRank?: unknown; sortWear?: unknown; sortSeen?: unknown; firstSeenAt?: unknown }>(
    database,
    // The order is part of what a cursor means: a cursor into one order is stale in another.
    { ...request, filter: byKeys ? { ...filter, keyOrder: hash(order) } : filter },
    'inventory',
    sql,
    params,
    keys,
    { handles: totals.quantity, quantity: totals.quantity, groups: totals.groups, rows: totals.rows }
  );
  // The sort columns are the cursor's business, not the row's. The detection time is one of them:
  // the page answers what is owned, and the date is only how that answer is ordered.
  if (page.kind === 'page') for (const row of page.rows) { delete row.sortRank; delete row.sortWear; delete row.sortSeen; delete row.firstSeenAt; }
  return page;
}

/**
 * How many groups one scope may summarise before the host has to narrow it.
 *
 * The ceiling on group count is catalogue cardinality — roughly 15,000-20,000 distinct CS2
 * entities exist at all — so this is not a guess about inventories, it is a fraction of a hard
 * upper bound. A scope past it gets `needs-filter`, never a short list.
 */
export const GROUP_SUMMARY_CAP = 5_000;

/**
 * The default inventory view: one row per `(def_index, paint_index, quality)`.
 *
 * This exists so that the host can sort and search by name without the engine holding any. Group
 * count is bounded by catalogue cardinality rather than by item count, so the host can hold the
 * whole summary, join names onto it, and order it in memory — where a 200,000-row alphabetical
 * sort would be impossible without names in SQL.
 *
 * Quantities are summed, not counted: `quantity` is how many items the group holds and `handles`
 * how many rows the item page would show for it, which a unit holding more than one would make
 * differ. Conflating them is how a storage move comes to shift the wrong number of items.
 */
export function pageInventoryGroups(database: EngineDatabase, request: InventoryPageRequest, now: string): GroupEnvelope {
  const accounts = assertAccountScope(database, request.accountIds);
  const size = boundPageSize(request.pageSize);
  const filter = request.filter ?? {};
  const binding = hash({ domain: 'inventory-groups', accounts, filter });
  const marks = database.revisionMarks(accounts);
  const revision = hash([marks, readRevision(database, accounts)]);
  const cursor = request.cursor ? decode(request.cursor) : undefined;
  if (cursor && (cursor.binding !== binding || cursor.revision !== revision || cursor.after.length !== 2)) {
    return { kind: 'stale-page', reason: 'cursor does not match surface, scope, filter or revision' };
  }
  const query = inventoryQuery(database, accounts, filter, now);
  const grouped = `SELECT accountId, matchKey,
      MAX(defIndex) AS defIndex, MAX(paintIndex) AS paintIndex, MAX(quality) AS quality,
      COALESCE(SUM(quantity),0) AS quantity, COUNT(*) AS handles,
      COALESCE(SUM(CASE WHEN location='MAIN' THEN quantity ELSE 0 END),0) AS main,
      COALESCE(SUM(CASE WHEN location='CASKET' THEN quantity ELSE 0 END),0) AS storage,
      COALESCE(SUM(CASE WHEN steamListed=1 THEN quantity ELSE 0 END),0) AS listed,
      MIN(paintWear) AS minWear, MAX(paintWear) AS maxWear,
      MIN(cannotTrade) AS cannotTrade, MAX(marketable) AS anyMarketable
    FROM (${query.sql}) GROUP BY accountId, matchKey`;
  const groups = (database.raw().prepare(`SELECT COUNT(*) AS n FROM (${grouped})`).get(...query.params) as { n: number }).n;
  if (groups > GROUP_SUMMARY_CAP) return { kind: 'needs-filter', groups, cap: GROUP_SUMMARY_CAP };
  const totals = database.raw().prepare(`SELECT COALESCE(SUM(quantity),0) AS quantity, COALESCE(SUM(handles),0) AS handles FROM (${grouped})`)
    .get(...query.params) as { quantity: number; handles: number };
  const rows = database.raw().prepare(
    `SELECT * FROM (${grouped}) ${cursor ? 'WHERE (accountId, matchKey)>(?,?)' : ''} ORDER BY accountId, matchKey LIMIT ?`
  ).all(...query.params, ...(cursor?.after ?? []), size + 1) as Array<InventoryGroupRow & Record<string, Param>>;
  const hasNext = rows.length > size;
  if (hasNext) rows.pop();
  const last = rows.at(-1);
  return bounded({ kind: 'page', requestId: randomUUID(), revision, rows,
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ binding, revision, after: [last.accountId, last.matchKey] })).toString('base64url') : null,
    hasNext, total: { handles: totals.handles, quantity: totals.quantity, groups, rows: groups } });
}
export type InventoryPositionRow = {
  accountId: string; matchKey: string; defIndex: number; paintIndex: number | null; quality: number;
  /** Valve's wear tier, 0 Factory New to 4 Battle-Scarred, or null for an item with no float. */
  wearBand: number | null;
  /** The least worn float under this band, so the host can spell the market name the way it spells a row's. */
  minWear: number | null;
  quantity: number; main: number; storage: number;
  /** Of `main`, how many an open Steam listing names. */
  listed: number;
  cannotTrade: number;
  anyMarketable: number | null;
};
export type InventoryPositionsRequest = { accountIds: readonly string[]; filter?: InventoryFilter };
export type PositionsEnvelope =
  | { kind: 'positions'; revision: string; rows: InventoryPositionRow[]; total: { quantity: number; positions: number; groups: number } }
  | { kind: 'needs-filter'; groups: number; cap: number };

/**
 * What an account set holds, by market kind: one row per `(account, match key, wear band)`.
 *
 * A market name is a catalogue key plus a wear tier, and the group summary carries no tier, so a
 * portfolio valuation could not be built on it without paging every unit. This read is bounded by
 * names rather than units — at most five rows per group — which is what keeps a 200,000-unit
 * account affordable. The band is identity arithmetic over the float (`wearBandSql`, the same
 * thresholds the catalogue spells names with); no name enters the engine.
 *
 * Unpaged on purpose: a valuation needs the whole set or none of it, and a partial set that reads
 * as complete is a wrong total. Past the group cap the answer is `needs-filter`, as the summary's is.
 */
export function pageInventoryPositions(database: EngineDatabase, request: InventoryPositionsRequest, now: string): PositionsEnvelope {
  const accounts = assertAccountScope(database, request.accountIds);
  const filter = request.filter ?? {};
  const query = inventoryQuery(database, accounts, filter, now);
  const grouped = `SELECT accountId, matchKey,
      MAX(defIndex) AS defIndex, MAX(paintIndex) AS paintIndex, MAX(quality) AS quality,
      ${wearBandSql('paintWear')} AS wearBand, MIN(paintWear) AS minWear,
      COALESCE(SUM(quantity),0) AS quantity,
      COALESCE(SUM(CASE WHEN location='MAIN' THEN quantity ELSE 0 END),0) AS main,
      COALESCE(SUM(CASE WHEN location='CASKET' THEN quantity ELSE 0 END),0) AS storage,
      COALESCE(SUM(CASE WHEN steamListed=1 THEN quantity ELSE 0 END),0) AS listed,
      MIN(cannotTrade) AS cannotTrade, MAX(marketable) AS anyMarketable
    FROM (${query.sql}) GROUP BY accountId, matchKey, wearBand`;
  const groups = (database.raw().prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT accountId, matchKey FROM (${query.sql}))`).get(...query.params) as { n: number }).n;
  if (groups > GROUP_SUMMARY_CAP) return { kind: 'needs-filter', groups, cap: GROUP_SUMMARY_CAP };
  const rows = database.raw().prepare(`SELECT * FROM (${grouped}) ORDER BY accountId, matchKey, wearBand`).all(...query.params) as InventoryPositionRow[];
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  return { kind: 'positions', revision: readRevision(database, accounts), rows, total: { quantity, positions: rows.length, groups } };
}

export function pageStorage(database: EngineDatabase, request: ScopedPageRequest): PageEnvelope<StoragePageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  // A unit's asset id is its casket id and never changes: a unit cannot be listed or traded, so
  // nothing that retires an asset id (a trade, a sale — rule 3) ever happens to one.
  const result = queryPage<StoragePageRow>(database, request, 'storage', `SELECT u.account_id AS accountId,u.casket_id AS casketId,
    (SELECT i.local_id FROM item i WHERE i.account_id=u.account_id AND i.asset_id=u.casket_id AND i.def_index=1201 AND i.location<>'MISSING') AS localId,
    u.label,u.contains_count AS reportedCount,
    (SELECT COALESCE(SUM(i.quantity),0) FROM item i WHERE i.account_id=u.account_id AND i.location='CASKET' AND i.casket_id=u.casket_id) AS knownQuantity,
    COALESCE((SELECT complete FROM observation WHERE id=u.contents_obs),0) AS complete FROM storage_unit u WHERE u.account_id IN (${accounts.map(() => '?')})`, accounts, ['accountId', 'casketId']);
  if (result.kind === 'page') result.rows = result.rows.map(row => ({ ...row, complete: Boolean(row.complete) }));
  return result;
}
