import type { EngineDatabase, ItemRow } from './database.js';
import { cannotTradeSql } from '../kernel/attributes.js';
import { steamListedSql } from './steam-listing.js';

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
   * location: a listed item is in main inventory (`db/steam-listing.ts`).
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
 * carry. `kernel/identity.kitToken` derives it on ingest.
 */
export const INDIVIDUAL_MATCH_SQL = "def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':' || IFNULL(kit,'')";
/** Fungible units carry no paint index, so their key leaves that position empty. */
export const COMMODITY_MATCH_SQL = "def_index || '::' || quality || ':' || IFNULL(kit,'')";

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
 * the identity expression each unit kind is indexed on and in which rows the published-generation
 * predicate applies to.
 */
export function inventoryQuery(
  database: EngineDatabase,
  accountIds: readonly string[],
  filter: InventoryFilter = {},
  page?: InventoryQueryPage,
  /**
   * `detected` adds `firstSeenAt`, the finished time of `first_seen_obs`. Only the detection
   * sort asks for it: every other page would otherwise carry a column it does not return.
   */
  columns?: { detected?: boolean }
) {
  const params: (string | number)[] = [];
  const limit = page?.limit === undefined ? undefined : Math.min(Math.max(1, page.limit | 0), 500);
  // Bind catalogue keys rather than `IN (SELECT …)`. SQLite only uses item_catalogue_match's
  // expression column for a bound list; a subquery search scans every row for the account.
  const matchKeys = filter.matchKeys;
  const lockFree = "(tradable_after IS NULL OR tradable_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (trade_protected_until IS NULL OR trade_protected_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  const branches = accountIds.flatMap((accountId) => {
    const visible = database.publishedInventoryVisibility(accountId);
    return [false, true].map((commodity) => {
      const table = database.inventoryReadTable('item', accountId);
      const match = commodity ? COMMODITY_MATCH_SQL : INDIVIDUAL_MATCH_SQL;
      let where = `account_id=? AND location<>'MISSING' AND unit_kind=${commodity ? "'fungible'" : "'individual'"}`;
      params.push(accountId);
      // The published-generation predicate applies to individual rows only, as it always has.
      if (!commodity) { where += visible.sql; params.push(...visible.params); }
      if (filter.location) { where += ' AND location=?'; params.push(filter.location); }
      if (filter.listed !== undefined) where += ` AND ${filter.listed ? '' : 'NOT '}${steamListedSql('inventory')}`;
      if (filter.casketId) { where += ' AND casket_id=?'; params.push(filter.casketId); }
      if (matchKeys) {
        if (matchKeys.length === 0) where += ' AND 0';
        else {
          where += ` AND (${match}) IN (${matchKeys.map(() => '?').join(',')})`;
          params.push(...matchKeys);
        }
      }
      if (filter.excludeMatchKeys && filter.excludeMatchKeys.length > 0) {
        // Never a market item by kind, unless the Community read says this unit is: observation
        // outranks the catalogue.
        where += ` AND NOT ((${match}) IN (${filter.excludeMatchKeys.map(() => '?').join(',')})
          AND IFNULL((SELECT t.marketable FROM trade_inventory_item t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.current_asset_id), 0)<>1)`;
        params.push(...filter.excludeMatchKeys);
      }
      if (filter.excludeCannotTrade) where += ` AND NOT (${cannotTradeSql('inventory')})`;
      if (filter.tradableOnly) {
        // Per unit, for either kind: the Community read names each asset, and every row carries
        // its own two locks.
        where += ` AND location='MAIN' AND EXISTS (SELECT 1 FROM trade_inventory_item t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.current_asset_id AND t.tradable=1
          AND t.observation_id=(SELECT MAX(o.id) FROM observation o WHERE o.account_id=t.account_id AND o.surface='steam-trade-inventory')
          AND EXISTS (SELECT 1 FROM observation o WHERE o.id=t.observation_id AND o.complete=1 AND o.error IS NULL))`;
        where += ` AND ${lockFree}`;
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
          if (filter.wearBands) {
            // Each band is its own key set with its own absolute bounds: the same normalised
            // position is a different float in a 0–0.4 skin than in a 0–1 one, which is the whole
            // reason the host computes bands rather than sending one range.
            const bands = filter.wearBands.filter((band) => band.matchKeys.length > 0);
            if (bands.length === 0) where += ' AND 0';
            else {
              where += ` AND (${bands.map((band) => `((${match}) IN (${band.matchKeys.map(() => '?').join(',')}) AND paint_wear IS NOT NULL AND paint_wear BETWEEN ? AND ?)`).join(' OR ')})`;
              for (const band of bands) params.push(...band.matchKeys, band.minWear, band.maxWear);
            }
          }
        }
      }
      // A lock is a per-unit time on either kind. `market` is a Steam Market purchase and stays
      // storable; `trade` is trade protection and is not — see `LockKind`.
      if (filter.lock) {
        if (filter.lock === 'market') {
          where += " AND tradable_after IS NOT NULL AND tradable_after>strftime('%Y-%m-%dT%H:%M:%fZ','now')"
            + " AND (trade_protected_until IS NULL OR trade_protected_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
        } else {
          where += " AND trade_protected_until IS NOT NULL AND trade_protected_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')";
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
        current_asset_id AS assetId,
        (${steamListedSql('inventory')}) AS steamListed,
        (SELECT t.marketable FROM trade_inventory_item t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.current_asset_id) AS marketable,
        (${cannotTradeSql('inventory')}) AS cannotTrade${columns?.detected ? `,
        (SELECT o.finished_at FROM observation o WHERE o.id=inventory.first_seen_obs) AS firstSeenAt` : ''}
        FROM ${table} AS inventory WHERE ${where}${suffix}`;
      return suffix ? `SELECT * FROM (${select})` : select;
    });
  });
  return { sql: branches.join(' UNION ALL '), params };
}

/** Unfiltered totals use per-account indexes; a filter still scans the matching union. */
export function inventoryTotals(database: EngineDatabase, accountIds: readonly string[], filter: InventoryFilter = {}) {
  if (filterIsNarrow(filter)) {
    const query = inventoryQuery(database, accountIds, filter);
    return database.raw().prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS quantity, COUNT(DISTINCT matchKey) AS groups FROM (${query.sql})`).get(...query.params) as { rows: number; quantity: number; groups: number };
  }
  let rows = 0;
  let quantity = 0;
  for (const accountId of accountIds) {
    const visible = database.publishedInventoryVisibility(accountId);
    const table = database.inventoryReadTable('item', accountId);
    const items = database.raw().prepare(`
      SELECT COUNT(*) AS n FROM ${table}
      WHERE account_id=? AND location<>'MISSING' AND unit_kind='individual'${visible.sql}
    `).get(accountId, ...visible.params) as { n: number };
    const units = database.raw().prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(quantity),0) AS q FROM ${table}
      WHERE account_id=? AND location<>'MISSING' AND unit_kind='fungible'
    `).get(accountId) as { n: number; q: number };
    rows += items.n + units.n;
    quantity += items.n + units.q;
  }
  return { rows, quantity, groups: rows };
}