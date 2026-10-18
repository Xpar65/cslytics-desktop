import { receiveFor } from '@cslytics/ports';
import { currencyById } from './currency.js';
import type { NameStatus, StoredBook } from './store.js';
import type { FxRates } from './types.js';

/**
 * Positions × books × fees × FX → figures, each carrying its grade.
 *
 * Pure on purpose: everything here is arithmetic over what the engine, the store and the
 * settings already said, so it can be held to vectors in `tests/unit/valuation.test.ts`. The
 * rules it keeps (portfolio and pricing plan §5):
 *
 *  - The headline is the **mid price**, the midpoint of the lowest ask and the highest bid (D7).
 *    A one-sided book uses the side that exists and says so; an empty book prices nothing.
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
  basis: 'mid' | 'ask-only' | 'bid-only';
  unitCents: number;
  bookCurrency: number;
  observedAt: string;
  marketValue: Figure;
  liquidation: { value: Figure; absorbedUnits: number };
};

export type UnpricedPosition = Position & { priced: false; reason: UnpricedReason };
export type ValuedPosition = PricedPosition | UnpricedPosition;

export type CurrencySubtotal = { currency: string; cents: number; units: number; converted: Converted | null };

export type ValuationTotal = {
  base: string;
  /** In the base currency; `null` when nothing could be converted at all. */
  cents: number | null;
  /** `false` when a subtotal could not be converted: the figure is a floor, not a total. */
  complete: boolean;
  missingCurrencies: string[];
  subtotals: CurrencySubtotal[];
};

export type CategoryShare = { category: string; cents: number; units: number; complete: boolean };

export type Valuation = {
  base: string;
  basis: 'mid';
  marketValue: ValuationTotal;
  liquidation: ValuationTotal;
  positions: ValuedPosition[];
  kinds: { total: number; priced: number; unpriced: number };
  units: { total: number; priced: number; unpriced: number };
  unpricedUnitsByReason: Partial<Record<UnpricedReason, number>>;
  byCategory: CategoryShare[];
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
  fx: { asOf: string; stale: boolean } | null;
};

export type ValuationInput = {
  positions: readonly Position[];
  books: ReadonlyMap<string, StoredBook>;
  statuses?: ReadonlyMap<string, NameStatus>;
  fx: FxRates | null;
  /** ISO code the totals are shown in. */
  base: string;
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

function total(base: string, fx: FxRates | null, perCurrency: Map<string, { cents: number; units: number }>): ValuationTotal {
  const subtotals: CurrencySubtotal[] = [];
  const missing: string[] = [];
  let cents = 0;
  let any = false;
  for (const [currency, sum] of [...perCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (currency === base) {
      subtotals.push({ currency, cents: sum.cents, units: sum.units, converted: null });
      cents += sum.cents;
      any = true;
      continue;
    }
    const converted = convert(sum.cents, currency, base, fx);
    subtotals.push({ currency, cents: sum.cents, units: sum.units, converted });
    if (converted === null) missing.push(currency);
    else { cents += converted.cents; any = true; }
  }
  return { base, cents: any ? cents : null, complete: missing.length === 0, missingCurrencies: missing, subtotals };
}

export function valuePositions(input: ValuationInput): Valuation {
  const { base, fx } = input;
  const positions: ValuedPosition[] = [];
  const market = new Map<string, { cents: number; units: number }>();
  const liquid = new Map<string, { cents: number; units: number }>();
  const categories = new Map<string, { cents: number; units: number; complete: boolean }>();
  const unpricedUnitsByReason: Partial<Record<UnpricedReason, number>> = {};
  const kinds = new Set<string>();
  const pricedKinds = new Set<string>();
  let units = 0;
  let pricedUnits = 0;
  let oldest: string | null = null;
  let newest: string | null = null;

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

  for (const position of input.positions) {
    const kind = `${position.matchKey}:${position.wearBand ?? ''}`;
    kinds.add(kind);
    units += position.quantity;
    if (position.unpriced !== null) { unpriced(position, position.unpriced); continue; }
    if (position.name === null) { unpriced(position, 'unresolved'); continue; }
    const book = input.books.get(position.name);
    if (book === undefined) {
      const status = input.statuses?.get(position.name);
      unpriced(position, status?.kind === 'absent' ? 'absent' : status?.kind === 'unknown' ? 'read-failed' : 'no-book');
      continue;
    }
    const price = unitPrice(book);
    if (price === null) { unpriced(position, 'empty-book'); continue; }
    const currency = currencyById(book.currency);
    if (currency === undefined) { unpriced(position, 'no-rate'); continue; }
    const code = currency.code;
    const marketCents = price.cents * position.quantity;
    const sold = liquidation(book, position.quantity);
    const marketFigure = figure(marketCents, code, base, fx);
    if (code !== base && marketFigure.converted === null) {
      // The figure exists in its own currency and is shown there; it cannot join a total, so it
      // counts as unpriced for the totals' purposes: `units.priced` is what the base figure holds,
      // and priced plus every reason adds up to the whole.
      positions.push({
        ...position, priced: true, basis: price.basis, unitCents: price.cents, bookCurrency: book.currency, observedAt: book.observedAt,
        marketValue: marketFigure, liquidation: { value: figure(sold.cents, code, base, fx), absorbedUnits: sold.absorbedUnits }
      });
      unpricedUnitsByReason['no-rate'] = (unpricedUnitsByReason['no-rate'] ?? 0) + position.quantity;
      add(market, code, marketCents, position.quantity);
      add(liquid, code, sold.cents, sold.absorbedUnits);
      const category = categories.get(position.category ?? 'Other') ?? { cents: 0, units: 0, complete: true };
      category.units += position.quantity;
      category.complete = false;
      categories.set(position.category ?? 'Other', category);
      if (oldest === null || book.observedAt < oldest) oldest = book.observedAt;
      if (newest === null || book.observedAt > newest) newest = book.observedAt;
      continue;
    }
    positions.push({
      ...position, priced: true, basis: price.basis, unitCents: price.cents, bookCurrency: book.currency, observedAt: book.observedAt,
      marketValue: marketFigure, liquidation: { value: figure(sold.cents, code, base, fx), absorbedUnits: sold.absorbedUnits }
    });
    pricedKinds.add(kind);
    pricedUnits += position.quantity;
    add(market, code, marketCents, position.quantity);
    add(liquid, code, sold.cents, sold.absorbedUnits);
    const inBase = marketFigure.converted?.cents ?? marketCents;
    const category = categories.get(position.category ?? 'Other') ?? { cents: 0, units: 0, complete: true };
    category.cents += inBase;
    category.units += position.quantity;
    categories.set(position.category ?? 'Other', category);
    if (oldest === null || book.observedAt < oldest) oldest = book.observedAt;
    if (newest === null || book.observedAt > newest) newest = book.observedAt;
  }

  return {
    base,
    basis: 'mid',
    marketValue: total(base, fx, market),
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
    fx: fx === null ? null : { asOf: fx.asOf, stale: fx.stale }
  };
}
