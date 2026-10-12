/**
 * Which buy orders a Buy orders filter keeps.
 *
 * The page's bar is the Listings bar, and its chips are resolved by the same resolver
 * (`CatalogueMediator.resolveListingFilter`), so a skin type, a rarity, a collection or StatTrak
 * means here exactly what it means on Listings and in Inventory. What differs is the other side of
 * the match. A listing carries an item; a buy order carries a market name and, on a venue that has
 * them, filters. So an order is matched by what it would buy:
 *
 *  - **its keys**: the catalogue entries its market name is, and the stickers and charms its
 *    filters require — so naming a sticker finds the orders that require it;
 *  - **its float window**: the wear tier in its name, narrowed by any float range it sets. A float
 *    or wear chip keeps an order whose window reaches into the chip's band; an order for a case has
 *    no window and is not kept, as a case in inventory has no wear;
 *  - **its patterns**: a pattern chip keeps an order that names that pattern. An order that names
 *    none would take any pattern, but it is not an order *for* that pattern, and that is the
 *    question the chip asks.
 *
 * Every clause is the listings read's (`read/queries/listings.ts`): typed names are alternatives,
 * each a substring of the market name or an exact order number, and `matchKeys: []` is a name that
 * matched nothing — never "no filter".
 */

/** A Buy orders filter after main has resolved its chips. Names are gone; keys and numbers remain. */
export type ResolvedBuyOrderFilter = {
  search?: readonly string[] | undefined;
  matchKeys?: readonly string[] | undefined;
  minWear?: number | undefined;
  maxWear?: number | undefined;
  paintSeed?: number | undefined;
};

/** What one order offers a filter. */
export type BuyOrderFacets = {
  hashName: string;
  buyOrderId: string;
  /** The catalogue keys of what it would buy, and of every sticker and charm it requires. */
  keys: readonly string[];
  /** The floats it would accept, or `null` for an item with no float. */
  floats: { min: number; max: number } | null;
  /** The patterns it names, or `null` for none named. */
  seeds: readonly number[] | null;
};

/** The wear tiers a market name ends in, with the floats each spans. */
const TIER_FLOATS: ReadonlyArray<{ suffix: string; min: number; max: number }> = [
  { suffix: '(Factory New)', min: 0, max: 0.07 },
  { suffix: '(Minimal Wear)', min: 0.07, max: 0.15 },
  { suffix: '(Field-Tested)', min: 0.15, max: 0.38 },
  { suffix: '(Well-Worn)', min: 0.38, max: 0.45 },
  { suffix: '(Battle-Scarred)', min: 0.45, max: 1 }
];

/**
 * The floats an order accepts: its name's wear tier, narrowed by the float range it sets. A float
 * range with no tier in the name is the range alone; neither is `null`, an item with no float.
 */
export function floatWindow(hashName: string, range: { min: number | null; max: number | null } | null): { min: number; max: number } | null {
  const tier = TIER_FLOATS.find((entry) => hashName.endsWith(` ${entry.suffix}`));
  if (!tier && !range) return null;
  const min = Math.max(tier?.min ?? 0, range?.min ?? 0);
  const max = Math.min(tier?.max ?? 1, range?.max ?? 1);
  return min <= max ? { min, max } : null;
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function buyOrderMatches(order: BuyOrderFacets, filter: ResolvedBuyOrderFilter): boolean {
  const terms = (filter.search ?? []).map((term) => term.trim()).filter(Boolean);
  if (terms.length && !terms.some((term) => fold(order.hashName).includes(fold(term)) || order.buyOrderId === term)) return false;
  if (filter.matchKeys) {
    const wanted = new Set(filter.matchKeys);
    if (!order.keys.some((key) => wanted.has(key))) return false;
  }
  if (filter.minWear !== undefined || filter.maxWear !== undefined) {
    // Overlap, strictly: a tier runs up to its bound and not onto it, so a Field-Tested order,
    // which starts at 0.15, is not reached by a Minimal Wear chip, which ends there.
    if (!order.floats) return false;
    if (filter.minWear !== undefined && !(order.floats.max > filter.minWear)) return false;
    if (filter.maxWear !== undefined && !(order.floats.min < filter.maxWear)) return false;
  }
  if (filter.paintSeed !== undefined && !(order.seeds ?? []).includes(filter.paintSeed)) return false;
  return true;
}
