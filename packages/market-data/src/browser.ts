/**
 * The pure half, for the window.
 *
 * The barrel reaches `node:sqlite` and `node:crypto`, which a browser bundle cannot resolve, so the
 * renderer build aliases `@cslytics/market-data` here, as it does the catalogue. What the window
 * needs is the currency table and the money types; it formats figures and never computes them.
 */
export type * from './types.js';
export { STEAM_CURRENCIES, STEAM_CURRENCY_CODES, currencyByCode, currencyById, formatUnits, type SteamCurrency } from './currency.js';
export {
  convert,
  type CategoryShare, type Converted, type CurrencySubtotal, type Figure, type Money, type Position, type PricedPosition, type UnpricedPosition, type UnpricedReason,
  type Valuation, type ValuationTotal, type ValuedPosition
} from './valuation.js';
export type { SchedulerStatus } from './scheduler.js';
export type { DailyTop, StoredBook, StoredCurve, StoredHistory, ValuationSnapshotRow } from './store.js';
