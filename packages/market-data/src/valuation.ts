import { receiveFor } from '@cslytics/ports';
import { currencyByCode, currencyById } from './currency.js';
import { priceAtFloat } from './curve.js';
import type { NameStatus, StoredBook, StoredCurve, StoredPrice } from './store.js';
import type { FxRates } from './types.js';

/**
 * Positions × curves × books × fees × FX → figures, each carrying its grade.
 *
 * Pure on purpose: everything here is arithmetic over what the engine, the store and the
 * settings already said, so it can be held to vectors in `tests/unit/valuation.test.ts`. The
 * rules it keeps (portfolio and pricing plan D7, D8, D11; money and currency page §5):
 *
 *  - **The market value is the mid price**, the midpoint of the lowest ask and the highest bid,
 *    from CSlytics's hourly snapshot or Steam's book (D7). A one-sided book uses the side that
 *    exists and says so; an empty book prices nothing. It needs no float curve, so it is ready as
 *    soon as the books are.
 *  - **The float value is a second estimate beside it**: the same units, with every skin a
 *    CSlytics Steam float curve can price at the fair line's value at each unit's own float,
 *    summed. Two Field-Tested skins of one name are two prices there, because the market prices
 *    them apart. It re-prices only what the market value priced, so the two differ by the floats
 *    alone, and it never replaces the market value.
 *  - **Liquidation is the bids**: a sale into the book is what the book would pay.
 *  - **Unpriced is a value** (D8). A unit with no price is counted and its reason named; it is
 *    never a zero folded into a total.
 *  - **Sum per currency, convert once, round once** (D11). Nothing converted is ever stored.
 *  - **No rate, no number.** A currency the FX file lacks stays native and the total that would
 *    have included it is marked incomplete, naming the currency.
 */

export type UnpricedReason =
  /** The catalogue says no unit of this kind is ever a market item, or Steam said this one is not. */
  | 'display-only'
  /** The host could not spell a market name for the key. */
  | 'unresolved'
  | 'storage-unit'
  /** No book has been read for the name yet. */
  | 'no-book'
  /** The name was asked and the read failed or did not parse; it is asked again later, and the last book, if any, stands. */
  | 'read-failed'
  /** The market answered that no such item exists. */
  | 'absent'
  /** A book with neither bids nor asks. */
  | 'empty-book'
  /** The book's currency has no rate in the FX snapshot, so it cannot join a total. */
  | 'no-rate';

export type Position = {
  accountId: string;
  matchKey: string;
  wearBand: number | null;
  /** The exact market hash name, or `null` when none can be spelled. */
  name: string | null;
  category: string | null;
  quantity: number;
  /** Every unit's float, one per individual item; empty for a kind with no float. */
  floats: readonly number[];
  main: number;
  storage: number;
  listed: number;
  /** A reason the host already knows; the valuation adds its own. */
  unpriced: Extract<UnpricedReason, 'display-only' | 'unresolved' | 'storage-unit'> | null;
};

/** Integer hundredths of one ISO-coded currency. The only shape a figure leaves here in. */
export type Money = { cents: number; currency: string };

/** A figure that went through FX, with what it was before and the rate that moved it. */
export type Converted = Money & { native: Money; rate: number; rateAsOf: string };

export type Figure = {
  native: Money;
  /** `null` when the native currency is the base, or when no rate exists for it. */
  converted: Converted | null;
};

export type PricedPosition = Position & {
  priced: true;
  /** The book's mid, or the one side it has. */
  basis: 'mid' | 'ask-only' | 'bid-only';
  unitCents: number;
  bookCurrency: number;
  observedAt: string;
  /** Steam's book read from this machine, or CSlytics's hourly snapshot of the books (portfolio prices plan D13). */
  source: 'book' | 'snapshot';
  marketValue: Figure;
  liquidation: { value: Figure; absorbedUnits: number };
  /**
   * Every unit at its own float on CSlytics's Steam float curve, summed, in the curve's currency,
   * with the mean per unit; `null` when the curve cannot price this kind. An estimate beside
   * `marketValue`, never in it.
   */
  atFloat: { value: Figure; unitCents: number } | null;
};

export type UnpricedPosition = Position & { priced: false; reason: UnpricedReason };
export type ValuedPosition = PricedPosition | UnpricedPosition;

export type CurrencySubtotal = { currency: string; cents: number; units: number; converted: Converted | null };

/**
 * Figures in several currencies, each converted once and added in the base. `cents` is `null` when
 * nothing could be added; `complete` is `false` when a currency had no rate, and
 * `missingCurrencies` names it: the figure is then a floor, not a total.
 */
export type BaseSum = { cents: number | null; complete: boolean; missingCurrencies: string[] };

export type ValuationTotal = BaseSum & { base: string; subtotals: CurrencySubtotal[] };

export type CategoryShare = { category: string; cents: number; units: number; complete: boolean };

/**
 * How the float value priced the skins the market value priced. `units` and `kinds` are at their
 * floats; `withoutCurve` are skins CSlytics was asked for and has no Steam fair line for, and
 * `notAsked` skins with no curve record yet: both stay at the mid price in the float value too.
 */
export type CurvesPriced = {
  kinds: number;
  units: number;
  withoutCurve: { kinds: number; units: number };
  notAsked: { kinds: number; units: number };
  /** The oldest generation among the curves that priced something. */
  oldestComputedAt: string | null;
};

export type Valuation = {
  base: string;
  marketValue: ValuationTotal;
  /**
   * The market value with every skin its Steam curve can price at its own floats instead: the same
   * units at other prices. It equals the market value while no curve has priced anything.
   */
  floatValue: ValuationTotal;
  liquidation: ValuationTotal;
  positions: ValuedPosition[];
  kinds: { total: number; priced: number; unpriced: number };
  units: { total: number; priced: number; unpriced: number };
  unpricedUnitsByReason: Partial<Record<UnpricedReason, number>>;
  byCategory: CategoryShare[];
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
  fx: { asOf: string; stale: boolean } | null;
  /** Which generation of CSlytics's snapshot priced what; `null` when none was given. */
  snapshot: { generatedAt: string; kinds: number; bookKinds: number } | null;
  curves: CurvesPriced;
};

export type ValuationInput = {
  positions: readonly Position[];
  books: ReadonlyMap<string, StoredBook>;
  statuses?: ReadonlyMap<string, NameStatus>;
  fx: FxRates | null;
  /** ISO code the totals are shown in. */
  base: string;
  /**
   * CSlytics's hourly snapshot, for the names it covers: a covered name is priced from it and its
   * book, if any, is not consulted (portfolio prices plan D9, D13). The caller decides what is
   * covered; this function prices what it is handed.
   */
  snapshot?: { rows: ReadonlyMap<string, StoredPrice>; generatedAt: string };
  /**
   * CSlytics's Steam float curves by name, as the cache holds them: a record whose `doc` is `null`
   * is a recorded absence, and a name not in the map has not been asked yet. They price the float
   * value only; the market value never reads them.
   */
  curves?: ReadonlyMap<string, StoredCurve>;
};

/** The one Steam currency id the snapshot is in: USD. */
const SNAPSHOT_CURRENCY = 1;

/** What a position is priced from, whichever source gave it: the quote, its depth and its grade. */
type Quote = {
  highestBidCents: number | null;
  lowestAskCents: number | null;
  bids: readonly { priceCents: number; quantity: number }[];
  currency: number;
  observedAt: string;
  source: 'book' | 'snapshot';
};

/** The mid price of a book, or the one side it has, or nothing. */
export function unitPrice(book: Pick<StoredBook, 'highestBidCents' | 'lowestAskCents'>): { cents: number; basis: 'mid' | 'ask-only' | 'bid-only' } | null {
  const ask = book.lowestAskCents;
  const bid = book.highestBidCents;
  if (ask !== null && bid !== null) return { cents: Math.round((ask + bid) / 2), basis: 'mid' };
  if (ask !== null) return { cents: ask, basis: 'ask-only' };
  if (bid !== null) return { cents: bid, basis: 'bid-only' };
  return null;
}

/**
 * What selling `quantity` units into the bids would return after Steam's fees: walk the bid side
 * best-first, take what each level absorbs, and convert each level's buyer price to what the
 * seller receives. Units the book cannot absorb are reported, not priced.
 */
export function liquidation(book: Pick<StoredBook, 'bids'>, quantity: number): { cents: number; absorbedUnits: number } {
  let remaining = quantity;
  let cents = 0;
  for (const level of book.bids) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, level.quantity);
    cents += receiveFor('steam', level.priceCents) * taken;
    remaining -= taken;
  }
  return { cents, absorbedUnits: quantity - remaining };
}

/**
 * `cents` of `from` in `to`, through the USD-based snapshot, rounded once. `null` when either
 * code has no rate. `rates` are units per USD, so a cross rate is `to / from`.
 */
export function convert(cents: number, from: string, to: string, fx: FxRates | null): Converted | null {
  if (fx === null) return null;
  const fromRate = fx.rates[from];
  const toRate = fx.rates[to];
  if (fromRate === undefined || toRate === undefined) return null;
  const rate = toRate / fromRate;
  return { cents: Math.round(cents * rate), currency: to, native: { cents, currency: from }, rate, rateAsOf: fx.asOf };
}

function figure(cents: number, currency: string, base: string, fx: FxRates | null): Figure {
  const native = { cents, currency };
  return { native, converted: currency === base ? null : convert(cents, currency, base, fx) };
}

/**
 * The one place figures in several currencies become one figure (plan D11): subtotals, one per
 * currency and each already converted once, added in the base. A subtotal in the base needs no
 * rate, and neither does a zero, which is nothing in every currency and must not make a total a
 * floor. A subtotal with no rate is left out and named.
 */
export function sumInBase(subtotals: readonly { cents: number; currency: string; converted: Converted | null }[], base: string): BaseSum {
  let cents = 0;
  let any = false;
  const missing: string[] = [];
  for (const entry of subtotals) {
    if (entry.currency === base || entry.cents === 0) { cents += entry.cents; any = true; continue; }
    if (entry.converted === null) { missing.push(entry.currency); continue; }
    cents += entry.converted.cents;
    any = true;
  }
  return { cents: any ? cents : null, complete: missing.length === 0, missingCurrencies: missing };
}

/** Two sums in the base, added. A part that is a floor, or was never computed (`null`), leaves the result a floor. */
export function addSums(left: BaseSum, right: BaseSum | null): BaseSum {
  const parts = [left.cents, right?.cents ?? null].filter((cents): cents is number => cents !== null);
  return {
    cents: parts.length === 0 ? null : parts.reduce((sum, cents) => sum + cents, 0),
    complete: left.complete && right !== null && right.complete,
    missingCurrencies: [...new Set([...left.missingCurrencies, ...(right?.missingCurrencies ?? [])])].sort()
  };
}

function total(base: string, fx: FxRates | null, perCurrency: Map<string, { cents: number; units: number }>): ValuationTotal {
  const subtotals: CurrencySubtotal[] = [...perCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, sum]) => ({
    currency, cents: sum.cents, units: sum.units, converted: currency === base ? null : convert(sum.cents, currency, base, fx)
  }));
  return { base, ...sumInBase(subtotals, base), subtotals };
}


/**
 * A skin at its floats on its curve's fair line, or `null` when the curve cannot price it: no
 * float for every unit, no record, a recorded absence, no fair line, or a currency not in the table.
 */
function curvePrice(position: Position, record: StoredCurve | undefined): { cents: number; code: string; computedAt: string } | null {
  if (position.quantity <= 0 || position.floats.length !== position.quantity) return null;
  const doc = record?.doc;
  const vertices = doc?.fairPrice?.vertices;
  if (!record || !doc || !vertices || vertices.length === 0) return null;
  const currency = currencyByCode(doc.currency);
  if (currency === undefined) return null;
  let cents = 0;
  for (const float of position.floats) {
    const price = priceAtFloat(vertices, float);
    if (price === null) return null;
    cents += Math.round(price * 100);
  }
  return { cents, code: currency.code, computedAt: doc.computedAt ?? record.fetchedAt };
}

export function valuePositions(input: ValuationInput): Valuation {
  const { base, fx } = input;
  const positions: ValuedPosition[] = [];
  const market = new Map<string, { cents: number; units: number }>();
  const floating = new Map<string, { cents: number; units: number }>();
  const liquid = new Map<string, { cents: number; units: number }>();
  const categories = new Map<string, { cents: number; units: number; complete: boolean }>();
  const unpricedUnitsByReason: Partial<Record<UnpricedReason, number>> = {};
  const kinds = new Set<string>();
  const pricedKinds = new Set<string>();
  const snapshotKinds = new Set<string>();
  const bookKinds = new Set<string>();
  const curveKinds = new Set<string>();
  const withoutCurveKinds = new Set<string>();
  const notAskedKinds = new Set<string>();
  let units = 0;
  let pricedUnits = 0;
  let curveUnits = 0;
  let withoutCurveUnits = 0;
  let notAskedUnits = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let oldestCurve: string | null = null;

  const add = (map: Map<string, { cents: number; units: number }>, currency: string, cents: number, count: number): void => {
    const sum = map.get(currency) ?? { cents: 0, units: 0 };
    sum.cents += cents;
    sum.units += count;
    map.set(currency, sum);
  };
  const unpriced = (position: Position, reason: UnpricedReason): void => {
    positions.push({ ...position, priced: false, reason });
    unpricedUnitsByReason[reason] = (unpricedUnitsByReason[reason] ?? 0) + position.quantity;
    const category = categories.get(position.category ?? 'Other') ?? { cents: 0, units: 0, complete: true };
    category.units += position.quantity;
    categories.set(position.category ?? 'Other', category);
  };
  // A book's age, for the oldest and newest read. A curve's generation is daily and says nothing
  // about how fresh a read of the books is, so it is reported apart, in `curves`.
  const seen = (at: string): void => {
    if (oldest === null || at < oldest) oldest = at;
    if (newest === null || at > newest) newest = at;
  };

  for (const position of input.positions) {
    const kind = `${position.matchKey}:${position.wearBand ?? ''}`;
    kinds.add(kind);
    units += position.quantity;
    if (position.unpriced !== null) { unpriced(position, position.unpriced); continue; }
    if (position.name === null) { unpriced(position, 'unresolved'); continue; }
    const quote = quoteFor(input, position.name);
    if (quote === undefined) {
      const status = input.statuses?.get(position.name);
      unpriced(position, status?.kind === 'absent' ? 'absent' : status?.kind === 'unknown' ? 'read-failed' : 'no-book');
      continue;
    }
    if (quote === 'absent') { unpriced(position, 'absent'); continue; }
    const price = unitPrice(quote);
    if (price === null) { unpriced(position, 'empty-book'); continue; }
    const currency = currencyById(quote.currency);
    if (currency === undefined) { unpriced(position, 'no-rate'); continue; }
    seen(quote.observedAt);
    (quote.source === 'snapshot' ? snapshotKinds : bookKinds).add(kind);
    const { code } = currency;
    const marketCents = price.cents * position.quantity;
    const sold = liquidation(quote, position.quantity);
    const marketFigure = figure(marketCents, code, base, fx);
    const record = input.curves?.get(position.name);
    const curve = curvePrice(position, record);
    const atFloat = curve === null ? null : { value: figure(curve.cents, curve.code, base, fx), unitCents: Math.round(curve.cents / position.quantity) };
    const row: PricedPosition = {
      ...position, priced: true, basis: price.basis, unitCents: price.cents, bookCurrency: quote.currency, observedAt: quote.observedAt, source: quote.source,
      marketValue: marketFigure, liquidation: { value: figure(sold.cents, code, base, fx), absorbedUnits: sold.absorbedUnits }, atFloat
    };
    positions.push(row);
    add(market, code, marketCents, position.quantity);
    add(liquid, code, sold.cents, sold.absorbedUnits);
    if (code !== base && marketFigure.converted === null) {
      // The figure exists in its own currency and is shown there; it cannot join a total, so it
      // counts as unpriced for the totals' purposes: `units.priced` is what the base figure holds,
      // and priced plus every reason adds up to the whole. The float value leaves it out with the
      // market value, so the two cover the same units.
      unpricedUnitsByReason['no-rate'] = (unpricedUnitsByReason['no-rate'] ?? 0) + position.quantity;
      add(floating, code, marketCents, position.quantity);
      const category = categories.get(position.category ?? 'Other') ?? { cents: 0, units: 0, complete: true };
      category.units += position.quantity;
      category.complete = false;
      categories.set(position.category ?? 'Other', category);
      continue;
    }
    pricedKinds.add(kind);
    pricedUnits += position.quantity;
    // The float value: this skin at its floats when its curve prices it and that figure can join the
    // base, else the market value's own figure for it, so a missing rate never makes it a floor.
    if (curve !== null && atFloat !== null && (curve.code === base || atFloat.value.converted !== null)) {
      add(floating, curve.code, curve.cents, position.quantity);
      curveKinds.add(kind);
      curveUnits += position.quantity;
      if (oldestCurve === null || curve.computedAt < oldestCurve) oldestCurve = curve.computedAt;
    } else {
      add(floating, code, marketCents, position.quantity);
      if (curve === null && position.floats.length > 0) {
        // A skin the curve could not price: asked and without a fair line, or not asked yet.
        if (record === undefined) { notAskedKinds.add(kind); notAskedUnits += position.quantity; }
        else { withoutCurveKinds.add(kind); withoutCurveUnits += position.quantity; }
      }
    }
    const inBase = marketFigure.converted?.cents ?? marketCents;
    const category = categories.get(position.category ?? 'Other') ?? { cents: 0, units: 0, complete: true };
    category.cents += inBase;
    category.units += position.quantity;
    categories.set(position.category ?? 'Other', category);
  }

  return {
    base,
    marketValue: total(base, fx, market),
    floatValue: total(base, fx, floating),
    liquidation: total(base, fx, liquid),
    positions,
    kinds: { total: kinds.size, priced: pricedKinds.size, unpriced: kinds.size - pricedKinds.size },
    units: { total: units, priced: pricedUnits, unpriced: units - pricedUnits },
    unpricedUnitsByReason,
    byCategory: [...categories.entries()]
      .map(([category, sum]) => ({ category, cents: sum.cents, units: sum.units, complete: sum.complete }))
      .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    oldestObservedAt: oldest,
    newestObservedAt: newest,
    fx: fx === null ? null : { asOf: fx.asOf, stale: fx.stale },
    snapshot: input.snapshot === undefined ? null : { generatedAt: input.snapshot.generatedAt, kinds: snapshotKinds.size, bookKinds: bookKinds.size },
    curves: {
      kinds: curveKinds.size,
      units: curveUnits,
      withoutCurve: { kinds: withoutCurveKinds.size, units: withoutCurveUnits },
      notAsked: { kinds: notAskedKinds.size, units: notAskedUnits },
      oldestComputedAt: oldestCurve
    }
  };
}

/**
 * The snapshot's row when it covers the name, else the book: a covered name's book is not read,
 * because two sources for one figure is a figure that flickers between them. An absent row is the
 * answer that there is no such item, and says so rather than falling through to a stale book.
 */
function quoteFor(input: ValuationInput, name: string): Quote | 'absent' | undefined {
  const row = input.snapshot?.rows.get(name);
  if (row !== undefined) {
    if (row.absent) return 'absent';
    return { highestBidCents: row.highestBidCents, lowestAskCents: row.lowestAskCents, bids: row.bids, currency: SNAPSHOT_CURRENCY, observedAt: row.asOf, source: 'snapshot' };
  }
  const book = input.books.get(name);
  if (book === undefined) return undefined;
  return { highestBidCents: book.highestBidCents, lowestAskCents: book.lowestAskCents, bids: book.bids, currency: book.currency, observedAt: book.observedAt, source: 'book' };
}
