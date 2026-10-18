import type { EngineDatabase, ItemRow } from './database.js';
import { cannotTradeSql } from '../kernel/attributes.js';
import { steamListedSql } from './commitment.js';

/**
 * What the engine will filter inventory by.
 *
 * There is deliberately no `search` and no `category` here. Both are questions about what an item
 * is *called*, and the engine does not know: the catalogue lives outside it, in the host. The host
 * resolves a search term or a category into the identity keys it matches and passes those in as
 * `matchKeys`, which is the only catalogue-shaped thing allowed across this boundary.
 *
 * The distinction between the two empty cases is load-bearing and is the most likely silent bug in
 * this design:
 *
 *   `matchKeys: undefined` — no name filter was asked for. Every row is eligible.
 *   `matchKeys: []`        — a name filter was asked for and **nothing matched**. No row is.
 *
 * Collapsing them makes a search for something nobody owns display the entire inventory, which
 * looks plausible and is wrong. `N-INV-01` / `EmptyFilterMatchesEverything` is the counterexample.
 */
export type WearBand = { matchKeys: readonly string[]; minWear: number; maxWear: number };
/**
 * Which lock an item is under, which the renderer cannot work out from `tradableAfter` alone.
 *
 * `market` is a Steam Market purchase — it **can** be stored in a casket, only not listed or
 * traded. `trade` is trade protection, which forbids both. Collapsing them is how a storable item
 * comes to look unstorable, so they are separate columns and a separate predicate.
 */
export type LockKind = 'market' | 'trade';
/**
 * `excludeMatchKeys` and `excludeCannotTrade` leave out what nothing may act on, so a Select all —
 * including one frozen as a manifest the window never paints — never holds a coin or a granted
 * music kit. The first is catalogue-shaped, identity keys the host says are never market items,
 * and a unit the last Community read holds marketable stays in whatever they say; the second is
 * the engine's own `cannot trade` (attribute 2).
 */
export type InventoryFilter = { matchKeys?: readonly string[]; location?: ItemRow['location']; casketId?: string; tradableOnly?: boolean;
  minWear?: number; maxWear?: number; paintSeed?: number; lock?: LockKind; wearBands?: readonly WearBand[];
  excludeMatchKeys?: readonly string[]; excludeCannotTrade?: boolean;
  /**
   * `true` keeps the holdings an open Steam listing names, `false` the ones none does. Not a
   * location: a listed item is in main inventory (`db/commitment.ts`).
   */
  listed?: boolean };
export type InventoryQueryPage = { after?: readonly [string, string]; limit?: number };

/**
 * The identity expression the `item_identity_match` index is built on. Keep the two in step, or
 * the `matchKeys IN (…)` filter becomes a scan of every row for the account.
 *
 * Four fields, matching the catalogue contract's item key. The fourth is `kit` — the identity-
 * bearing econ attributes that separate one sticker from another, since every sticker shares a def
 * index and has no paint kit. It is a stored column rather than an expression over attributes: the
 * attributes are not in this database, and an index cannot be built on something the row does not
 * carry. `kernel/identity.kitToken` derives it on ingest. One spelling for both unit kinds: a
 * fungible unit has no paint index, so its key leaves that position empty, which is what lets the
 * one index serve either kind (consolidation plan §4.2).
 */
export const IDENTITY_MATCH_SQL = "def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':' || IFNULL(kit,'')";

function filterIsNarrow(filter: InventoryFilter): boolean {
  return Boolean(filter.matchKeys || filter.tradableOnly || filter.location || filter.casketId || filter.listed !== undefined
    || filter.minWear !== undefined || filter.maxWear !== undefined || filter.paintSeed !== undefined
    || filter.lock || filter.wearBands || filter.excludeMatchKeys?.length || filter.excludeCannotTrade);
}

/** Wear, seed and band predicates are questions about an individual item. A case has no float. */
function hasIndividualPredicate(filter: InventoryFilter): boolean {
  return filter.minWear !== undefined || filter.maxWear !== undefined || filter.paintSeed !== undefined || Boolean(filter.wearBands);
}

/**
 * Shared by paging and frozen selection: filters apply before LIMIT.
 *
 * One row per holding, of either kind: a hundred cases are a hundred rows, as Steam's own
 * inventory shows them. Grouping them is `pageInventoryGroups`' job, by identity key, so nothing
 * here folds units together — not by lock date, not by location. The two branches differ only in
 * the identity expression each unit kind is indexed on.
 */
export function inventoryQuery(
  _database: EngineDatabase,
  accountIds: readonly string[],
  filter: InventoryFilter,
  now: string,
  page?: InventoryQueryPage,
  /**
   * `detected` adds `firstSeenAt`, the finished time of `first_seen_obs`. Only the detection
   * sort asks for it: every other page would otherwise carry a column it does not return.
   */
  columns?: { detected?: boolean }
) {
  const params: (string | number)[] = [];
  const limit = page?.limit === undefined ? undefined : Math.min(Math.max(1, page.limit | 0), 500);
  const matchKeys = filter.matchKeys;
  const bands = filter.wearBands?.filter((band) => band.matchKeys.length > 0);
  // Every list a filter carries is one JSON value, read once by a CTE that every branch shares.
  // A list spelled `?,?,…` spends a parameter per key in every branch, and a branch is an account
  // and a unit kind: the Sticker category's 10,433 keys over two accounts was 41,736 parameters
  // and "too many SQL variables" (2026-10-15).
  //
  // A bound list also told the planner how many keys it held, and a JSON value cannot, so the
  // identity index is named rather than left to an estimate. On a small record the planner would
  // otherwise walk the account in page order, and the plan `tests/unit/query-plans.registry.ts`
  // proves would stop being the plan that runs; at field scale it chooses this index unprompted.
  const lists: string[] = [];
  const listParams: string[] = [];
  const byIdentity = matchKeys && matchKeys.length > 0 ? ' INDEXED BY item_identity_match' : '';
  if (matchKeys && matchKeys.length > 0) {
    lists.push('named(key) AS MATERIALIZED (SELECT value FROM json_each(?))');
    listParams.push(JSON.stringify(matchKeys));
  }
  if (filter.excludeMatchKeys && filter.excludeMatchKeys.length > 0) {
    lists.push('excluded(key) AS MATERIALIZED (SELECT value FROM json_each(?))');
    listParams.push(JSON.stringify(filter.excludeMatchKeys));
  }
  if (bands && bands.length > 0) {
    lists.push(`band(key, low, high) AS MATERIALIZED (SELECT k.value, json_extract(b.value, '$.minWear'), json_extract(b.value, '$.maxWear')
      FROM json_each(?) b, json_each(b.value, '$.matchKeys') k)`);
    listParams.push(JSON.stringify(bands));
  }
  // The engine's clock, bound twice: a lock is over when its end is at or before now (D23).
  const lockFree = '(tradable_after IS NULL OR tradable_after<=?) AND (trade_protected_until IS NULL OR trade_protected_until<=?)';
  const branches = accountIds.flatMap((accountId) => {
    return [false, true].map((commodity) => {
      const match = IDENTITY_MATCH_SQL;
      let where = `account_id=? AND location<>'MISSING' AND unit_kind=${commodity ? "'fungible'" : "'individual'"}`;
      params.push(accountId);
      if (filter.location) { where += ' AND location=?'; params.push(filter.location); }
      if (filter.listed !== undefined) where += ` AND ${filter.listed ? '' : 'NOT '}${steamListedSql('inventory')}`;
      if (filter.casketId) { where += ' AND casket_id=?'; params.push(filter.casketId); }
      if (matchKeys) where += matchKeys.length === 0 ? ' AND 0' : ` AND (${match}) IN (SELECT key FROM named)`;
      if (filter.excludeMatchKeys && filter.excludeMatchKeys.length > 0) {
        // Never a market item by kind, unless the Community read says this unit is: observation
        // outranks the catalogue.
        where += ` AND NOT ((${match}) IN (SELECT key FROM excluded)
          AND IFNULL((SELECT t.marketable FROM asset_evidence t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.asset_id AND t.source='community'), 0)<>1)`;
      }
      if (filter.excludeCannotTrade) where += ` AND NOT (${cannotTradeSql('inventory')})`;
      if (filter.tradableOnly) {
        // Per unit, for either kind: the Community read names each asset, and every row carries
        // its own two locks.
        where += ` AND location='MAIN' AND EXISTS (SELECT 1 FROM asset_evidence t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.asset_id AND t.source='community' AND t.tradable=1
          AND t.last_seen_obs=(SELECT MAX(o.id) FROM observation o WHERE o.account_id=t.account_id AND o.surface='steam-trade-inventory')
          AND EXISTS (SELECT 1 FROM observation o WHERE o.id=t.last_seen_obs AND o.complete=1 AND o.error IS NULL))`;
        where += ` AND ${lockFree}`;
        params.push(now, now);
      }
      // Wear, seed and normalised-float bands are questions about an individual item. A case
      // has no float and no pattern, so the fungible branch answers "no row qualifies" rather
      // than silently ignoring the predicate and showing every case the account holds.
      if (hasIndividualPredicate(filter)) {
        if (commodity) where += ' AND 0';
        else {
          if (filter.minWear !== undefined) { where += ' AND paint_wear IS NOT NULL AND paint_wear>=?'; params.push(filter.minWear); }
          if (filter.maxWear !== undefined) { where += ' AND paint_wear IS NOT NULL AND paint_wear<=?'; params.push(filter.maxWear); }
          if (filter.paintSeed !== undefined) { where += ' AND paint_seed=?'; params.push(filter.paintSeed); }
          if (bands) {
            // Each band is its own key set with its own absolute bounds: the same normalised
            // position is a different float in a 0–0.4 skin than in a 0–1 one, which is the whole
            // reason the host computes bands rather than sending one range. A key is in one band.
            where += bands.length === 0 ? ' AND 0'
              : ` AND paint_wear IS NOT NULL AND EXISTS (SELECT 1 FROM band b WHERE b.key=(${match}) AND paint_wear BETWEEN b.low AND b.high)`;
          }
        }
      }
      // A lock is a per-unit time on either kind. `market` is a Steam Market purchase and stays
      // storable; `trade` is trade protection and is not — see `LockKind`.
      if (filter.lock) {
        if (filter.lock === 'market') {
          where += ' AND tradable_after IS NOT NULL AND tradable_after>? AND (trade_protected_until IS NULL OR trade_protected_until<=?)';
          params.push(now, now);
        } else {
          where += ' AND trade_protected_until IS NOT NULL AND trade_protected_until>?';
          params.push(now);
        }
      }
      if (page?.after) {
        where += ` AND (account_id, local_id)>(?,?)`;
        params.push(page.after[0], page.after[1]);
      }
      const suffix = limit === undefined ? '' : ` ORDER BY account_id, local_id LIMIT ${limit}`;
      const select = `SELECT account_id AS accountId,
        local_id AS rowKey, local_id AS localId, unit_kind AS unitKind,
        location, NULLIF(casket_id,'') AS casketId,
        ${commodity ? 'quantity' : '1'} AS quantity, def_index AS defIndex, quality,
        paint_index AS paintIndex, paint_wear AS paintWear, paint_seed AS paintSeed,
        tradable_after AS tradableAfter, trade_protected_until AS tradeProtectedUntil, ${match} AS matchKey,
        asset_id AS assetId,
        (${steamListedSql('inventory')}) AS steamListed,
        (SELECT t.marketable FROM asset_evidence t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.asset_id AND t.source='community') AS marketable,
        (${cannotTradeSql('inventory')}) AS cannotTrade${columns?.detected ? `,
        (SELECT o.finished_at FROM observation o WHERE o.id=inventory.first_seen_obs) AS firstSeenAt` : ''}
        FROM item AS inventory${byIdentity} WHERE ${where}${suffix}`;
      return suffix ? `SELECT * FROM (${select})` : select;
    });
  });
  // The CTE comes first in the text, so its parameters come first in the list.
  return { sql: `${lists.length ? `WITH ${lists.join(', ')} ` : ''}${branches.join(' UNION ALL ')}`, params: [...listParams, ...params] };
}

/** Unfiltered totals use per-account indexes; a filter still scans the matching union. */
export function inventoryTotals(database: EngineDatabase, accountIds: readonly string[], filter: InventoryFilter, now: string) {
  if (filterIsNarrow(filter)) {
    const query = inventoryQuery(database, accountIds, filter, now);
    return database.raw().prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS quantity, COUNT(DISTINCT matchKey) AS groups FROM (${query.sql})`).get(...query.params) as { rows: number; quantity: number; groups: number };
  }
  let rows = 0;
  let quantity = 0;
  for (const accountId of accountIds) {
    const items = database.raw().prepare(`
      SELECT COUNT(*) AS n FROM item
      WHERE account_id=? AND location<>'MISSING' AND unit_kind='individual'
    `).get(accountId) as { n: number };
    const units = database.raw().prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(quantity),0) AS q FROM item
      WHERE account_id=? AND location<>'MISSING' AND unit_kind='fungible'
    `).get(accountId) as { n: number; q: number };
    rows += items.n + units.n;
    quantity += items.n + units.q;
  }
  return { rows, quantity, groups: rows };
}