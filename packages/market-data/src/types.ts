/**
 * The market-data vocabulary.
 *
 * None of this is trading state. A book, a series, a curve and a rate are facts about the world
 * that any machine can fetch again, which is why they live in a desktop-owned cache and never in
 * the trading record (portfolio and pricing plan D3). Every amount here is an integer number of
 * hundredths of one named currency, the way Steam sends it: there is no bare number without a
 * currency beside it, and no float of money anywhere.
 */

/** Steam's numeric `ECurrencyCode`: 1 USD, 3 EUR, 21 AUD, up to 41. */
export type SteamCurrencyId = number;

/** One price level of an order book: the price and the units resting at exactly that price. */
export type BookLevel = { priceCents: number; quantity: number };

/**
 * `/market/orderbook` as the desktop keeps it: both sides best-first with point quantities, the
 * top of each side, and the currency the body named. `null` at the top of a side means that side
 * is empty, which is not the same as a price of zero.
 */
export type OrderBook = {
  currency: SteamCurrencyId;
  highestBidCents: number | null;
  lowestAskCents: number | null;
  /** Units resting on each side, as Steam counts them (`cBuyOrders`, `cSellOrders`). */
  bidUnits: number;
  askUnits: number;
  /** Best bid first. */
  bids: readonly BookLevel[];
  /** Best ask first. */
  asks: readonly BookLevel[];
  etag: string | null;
};

/** One row of a price series: an hour or a day, its median sale price and how many sales. */
export type HistoryPoint = { time: number; medianCents: number; purchases: number };

export type PriceHistory = { currency: SteamCurrencyId; points: readonly HistoryPoint[] };

/** `[float, price]` with the price in whole currency units of the document's currency. */
export type CurveVertex = readonly [number, number];
export type CurveSeries = { vertices: readonly CurveVertex[]; asOf: string | null };
/** Gaps between segments are real: nothing is bid there, and nothing may be interpolated across. */
export type CurveSegments = { segments: ReadonlyArray<readonly CurveVertex[]>; asOf: string | null };
export type CurveListing = { id: string; float: number | null; price: number };

/** A published float curve, as `api.cslytics.com/free/v1/{venue}/curves/{sha256}.json` serves it. */
export type CurveDoc = {
  venue: 'csfloat' | 'steam';
  marketHashName: string;
  /** Always USD on the free CDN; carried rather than assumed. */
  currency: string;
  floatRange: { min: number; max: number } | null;
  computedAt: string | null;
  fairPrice: CurveSeries | null;
  lowestAsk: CurveSeries | null;
  highestBid: CurveSegments | null;
  listings: readonly CurveListing[];
  listingsAsOf: string | null;
};

/** `fx-rates.json`: units of each currency per one USD, for exactly the Steam currencies. */
export type FxRates = {
  base: 'USD';
  asOf: string;
  stale: boolean;
  rates: Readonly<Record<string, number>>;
};

/**
 * What one read produced. `absent` is the platform saying there is no such thing, which is an
 * answer; `unknown` is anything that did not parse as either, which is not, and keeps whatever
 * was known before (plan D13).
 */
export type Parsed<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'absent' }
  | { kind: 'unknown'; detail: string };
