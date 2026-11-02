/**
 * Market data for the desktop: Steam's anonymous order book and price series, CSlytics's free
 * curves and FX, a desktop-owned cache, a scheduler and a valuation. Composed by main; the engine
 * never imports it (`check:deps`), and the renderer takes the pure half through `browser.ts`.
 */
export type * from './types.js';
export { PRICE_SNAPSHOT_SCHEMA, parseCurve, parseFxRates, parseOrderBook, parsePriceHistory, parsePriceSnapshot } from './parse.js';
export { STEAM_CURRENCIES, STEAM_CURRENCY_CODES, currencyByCode, currencyById, formatUnits, type SteamCurrency } from './currency.js';
export {
  MARKET_SCHEMA_VERSION, MarketDataStore, MarketSchemaNewerError, dayOf,
  type DailyTop, type NameStatus, type NameStatusKind, type StoredBook, type StoredCurve, type StoredFx, type StoredHistory, type StoredPrice,
  type StoredPriceSnapshot, type ValuationSnapshotRow
} from './store.js';
export {
  CSLYTICS_HOST, FX_RATES_URL, HttpMarketDataSource, MEMBER_BASE, OracleMarketDataSource, OracleMarketWorld, STEAM_MARKET_HOST, STEAM_PRICES_URL,
  curveNameHash, curveUrl, orderBookUrl, priceHistoryUrl,
  type Answer, type CurveAnswer, type FetchLike, type FetchResponseLike, type MarketDataSource, type OracleAnswer, type PricesAnswer, type PricesRequest
} from './source.js';
export { bidAtFloat, priceAtFloat } from './curve.js';
export { DEFAULT_SCHEDULER_OPTIONS, MarketDataScheduler, type FillEntry, type SchedulerEvent, type SchedulerOptions, type SchedulerStatus } from './scheduler.js';
export {
  addSums, convert, liquidation, sumInBase, unitPrice, valuePositions,
  type BaseSum, type CategoryShare, type Converted, type CurrencySubtotal, type CurvesPriced, type Figure, type Money, type Position, type PricedPosition,
  type UnpricedPosition, type UnpricedReason, type Valuation, type ValuationInput, type ValuationTotal, type ValuedPosition
} from './valuation.js';
