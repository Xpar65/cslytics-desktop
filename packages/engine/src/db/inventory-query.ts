import type { EngineDatabase, ItemRow } from './database.js';
import { cannotTradeSql } from '../kernel/attributes.js';
import { csfloatListedSql, steamListedSql } from './commitment.js';

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
   * `true` keeps the holdings a listing on any marketplace names — Steam's market walk or CSFloat's
   * stall walk, the row's `steamListed` or `csfloatListed` — and `false` the ones none does. Not a
   * location: a listed item is in main inventory on either venue (`db/commitment.ts`).
   */
  listed?: boolean;
  /** What must be applied to a holding: every requirement holds (`AppliedRequirement`). */
  applied?: readonly AppliedRequirement[] };

/** The two kinds of slot an owner fills: a sticker slot holds a sticker or a patch, the charm slot a charm. */
export type AppliedSlot = 'sticker-slot' | 'charm-slot';
/** One kit an applied filter names: a sticker or patch by its sticker kit, a charm by its charm kit and, for a souvenir charm, its highlight. */
export type AppliedKit = { slot: AppliedSlot; kitId: number; highlight?: number | undefined };
/**
 * One thing a holding must have applied, read from `item_accessory`, which every walk rewrites.
 *
 * `{ slot }` is anything in that kind of slot: "has stickers", "has a charm". `{ kits }` is any one
 * of the kits named, which is how a sticker *name* arrives: the host resolves it against the
 * catalogue into the kits it is, as it resolves an item name into `matchKeys`, and the engine never
 * sees the name. `kits: []` is a name the catalogue matched to no sticker, patch or charm, and
 * matches nothing, by the same rule as `matchKeys: []`.
 */
export type AppliedRequirement = { slot: AppliedSlot } | { kits: readonly AppliedKit[] };

/** A slot kind as SQL. Spelled from this table and never from the request, so a value that is not one is refused. */
const SLOT_SQL: Readonly<Record<AppliedSlot, string>> = { 'sticker-slot': "'sticker-slot'", 'charm-slot': "'charm-slot'" };

/**
 * The applied requirements as predicates on one holding, named by the SQL for its account and its
 * local id, so the inventory and the listings pages ask them identically.
 *
 * Each requirement is one `EXISTS` over the holding's own slots, a seek of `item_accessory`'s key,
 * whatever else the filter asks. A kit list is one JSON value read by a CTE of its own, as every
 * other list in these queries is, so a name that resolves to every sticker in the catalogue is one
 * parameter. The CTEs come first in the text, and so do their parameters.
 */
export function appliedPredicates(requirements: readonly AppliedRequirement[], holding: { account: string; local: string }): {
  lists: string[]; listParams: string[]; clauses: string[];
} {
  const lists: string[] = [];
  const listParams: string[] = [];
  const clauses: string[] = [];
  const own = `a.account_id=${holding.account} AND a.local_id=${holding.local}`;
  requirements.forEach((requirement, index) => {
    if ('slot' in requirement) {
      const slot = SLOT_SQL[requirement.slot];
      if (!slot) throw new Error(`Unknown applied slot ${String(requirement.slot)}`);
      clauses.push(`EXISTS (SELECT 1 FROM item_accessory a WHERE ${own} AND a.kind=${slot})`);
      return;
    }
    if (requirement.kits.length === 0) { clauses.push('0'); return; }
    for (const kit of requirement.kits) {
      if (!SLOT_SQL[kit.slot] || !Number.isSafeInteger(kit.kitId) || (kit.highlight !== undefined && !Number.isSafeInteger(kit.highlight))) {
        throw new Error('An applied kit names a slot kind and whole-number ids');
      }
    }
    const name = `applied${index}`;
    lists.push(`${name}(slot, kit, highlight) AS MATERIALIZED (SELECT json_extract(value, '$.slot'), json_extract(value, '$.kitId'), json_extract(value, '$.highlight') FROM json_each(?))`);
    listParams.push(JSON.stringify(requirement.kits));
    // A kit with no highlight is any highlight of it: a plain charm has none, and a highlight
    // charm named without one is still that charm.
    clauses.push(`EXISTS (SELECT 1 FROM item_accessory a JOIN ${name} k ON k.slot=a.kind AND k.kit=a.kit_id AND (k.highlight IS NULL OR k.highlight=a.highlight) WHERE ${own})`);
  });
  return { lists, listParams, clauses };
}
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
    || filter.lock || filter.wearBands || filter.excludeMatchKeys?.length || filter.excludeCannotTrade || filter.applied?.length);
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
  // What is applied is asked of either kind: a patched agent is a fungible unit with patches in its sticker slots.
  const applied = appliedPredicates(filter.applied ?? [], { account: 'inventory.account_id', local: 'inventory.local_id' });
  lists.push(...applied.lists);
  listParams.push(...applied.listParams);
  // The engine's clock, bound twice: a lock is over when its end is at or before now (D23).
  const lockFree = '(tradable_after IS NULL OR tradable_after<=?) AND (trade_protected_until IS NULL OR trade_protected_until<=?)';
  const branches = accountIds.flatMap((accountId) => {
    return [false, true].map((commodity) => {
      const match = IDENTITY_MATCH_SQL;
      let where = `account_id=? AND location<>'MISSING' AND unit_kind=${commodity ? "'fungible'" : "'individual'"}`;
      params.push(accountId);
      if (filter.location) { where += ' AND location=?'; params.push(filter.location); }
      // Listed on any marketplace: what the row's `steamListed` and `csfloatListed` say, asked the same way.
      if (filter.listed !== undefined) where += ` AND ${filter.listed ? '' : 'NOT '}(${steamListedSql('inventory')} OR ${csfloatListedSql('inventory')})`;
      if (filter.casketId) { where += ' AND casket_id=?'; params.push(filter.casketId); }
      if (matchKeys) where += matchKeys.length === 0 ? ' AND 0' : ` AND (${match}) IN (SELECT key FROM named)`;
      if (filter.excludeMatchKeys && filter.excludeMatchKeys.length > 0) {
        // Never a market item by kind, unless the Community read says this unit is: observation
        // outranks the catalogue.
        where += ` AND NOT ((${match}) IN (SELECT key FROM excluded)
          AND IFNULL((SELECT t.marketable FROM asset_evidence t WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.asset_id AND t.source='community'), 0)<>1)`;
      }
      if (filter.excludeCannotTrade) where += ` AND NOT (${cannotTradeSql('inventory')})`;
      for (const clause of applied.clauses) where += ` AND ${clause}`;
      if (filter.tradableOnly) {
        // Per unit, for either kind and in any place: free of both locks and of `cannot trade`.
        // The Community read is walked only for a transfer or a sale, so it can take an item out
        // but is never required to let one in: requiring it showed nothing on an account that had
        // never been read (2026-10-30). It takes one out only when no lock explains its no — a
        // lock running when it was read ends on its own clock, and a coin's no never does. The
        // transfer planner still demands a current yes before it sends anything.
        where += ` AND ${lockFree} AND NOT (${cannotTradeSql('inventory')})
          AND NOT EXISTS (SELECT 1 FROM asset_evidence t JOIN observation o ON o.id=t.last_seen_obs
            WHERE t.account_id=inventory.account_id AND t.asset_id=inventory.asset_id AND t.source='community' AND t.tradable=0
            AND IFNULL(inventory.tradable_after,'')<=o.started_at AND IFNULL(inventory.trade_protected_until,'')<=o.started_at)`;
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
        (${csfloatListedSql('inventory')}) AS csfloatListed,
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