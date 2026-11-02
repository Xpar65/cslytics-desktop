/**
 * The pure half, for the window.
 *
 * The barrel reaches `node:sqlite` and `node:crypto`, which a browser bundle cannot resolve, so the
 * renderer build aliases `@cslytics/market-data` here, as it does the catalogue. What the window
 * needs is the currency table, the money types and the curve's reading at a float, which the Items
 * page draws with and the listing workspace prices from; it computes no portfolio figure.
 */
export type * from './types.js';
export { STEAM_CURRENCIES, STEAM_CURRENCY_CODES, currencyByCode, currencyById, formatUnits, type SteamCurrency } from './currency.js';
export { bidAtFloat, priceAtFloat } from './curve.js';
export {
  convert,
  type BaseSum, type CategoryShare, type Converted, type CurrencySubtotal, type CurvesPriced, type Figure, type Money, type Position, type PricedPosition, type UnpricedPosition, type UnpricedReason,
  type Valuation, type ValuationTotal, type ValuedPosition
} from './valuation.js';
export type { SchedulerStatus } from './scheduler.js';
export type { DailyTop, StoredBook, StoredCurve, StoredHistory, StoredPrice, StoredPriceSnapshot, ValuationSnapshotRow } from './store.js';
