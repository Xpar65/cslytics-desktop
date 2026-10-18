/**
 * Market data for the desktop: Steam's anonymous order book and price series, CSlytics's free
 * curves and FX, a desktop-owned cache, a scheduler and a valuation. Composed by main; the engine
 * never imports it (`check:deps`), and the renderer takes the pure half through `browser.ts`.
 */
export type * from './types.js';
export { parseCurve, parseFxRates, parseOrderBook, parsePriceHistory } from './parse.js';
export { STEAM_CURRENCIES, STEAM_CURRENCY_CODES, currencyByCode, currencyById, formatUnits, type SteamCurrency } from './currency.js';
export {
  MARKET_SCHEMA_VERSION, MarketDataStore, MarketSchemaNewerError, dayOf,
  type DailyTop, type NameStatus, type NameStatusKind, type StoredBook, type StoredCurve, type StoredFx, type StoredHistory, type ValuationSnapshotRow
} from './store.js';
export {
  CSLYTICS_HOST, FX_RATES_URL, HttpMarketDataSource, OracleMarketDataSource, OracleMarketWorld, STEAM_MARKET_HOST,
  curveNameHash, curveUrl, orderBookUrl, priceHistoryUrl,
  type Answer, type FetchLike, type FetchResponseLike, type MarketDataSource, type OracleAnswer
} from './source.js';
export { DEFAULT_SCHEDULER_OPTIONS, MarketDataScheduler, type FillEntry, type SchedulerEvent, type SchedulerOptions, type SchedulerStatus } from './scheduler.js';
export {
  convert, liquidation, unitPrice, valuePositions,
  type CategoryShare, type Converted, type CurrencySubtotal, type Figure, type Money, type Position, type PricedPosition,
  type UnpricedPosition, type UnpricedReason, type Valuation, type ValuationInput, type ValuationTotal, type ValuedPosition
} from './valuation.js';
