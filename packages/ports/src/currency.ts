/**
 * The Steam currencies, one row each: the one table every package turns a Steam numeric id into an
 * ISO code with, and a code back into how Valve prints it. The engine reads it for the in-game
 * store's sheet, the market data for every figure it prices, and the window for every figure it
 * prints, so a wallet in any of the 41 currencies is named the same way on every page.
 *
 * The rows are Valve's own `g_rgCurrencyData` from `steamcommunity.com/public/javascript/global.js`
 * (SteamDatabase's SteamTracking mirror, read 2026-10-13), trimmed to the 41 ids that have a
 * wallet and an FX rate (the free `fx-rates.json` carries exactly these codes). Valve's table also
 * lists six retired European codes and two placeholders above 9000, which no wallet carries.
 *
 * `wholeUnits` is Valve's `bWholeUnitsOnly`: the integer Steam sends is still hundredths (a JPY
 * wallet was quoted 12,465,900 for an item near 787 USD), and the flag decides only that the display drops
 * the fraction. Valve's `IsCurrencyWholeUnits` excludes RUB from the flag it carries, so this
 * table does too.
 */

export type SteamCurrency = {
  id: number;
  /** ISO 4217 code: what settings store and the FX file is keyed by. */
  code: string;
  symbol: string;
  /** Whether the symbol goes before the number. */
  symbolFirst: boolean;
  /** Whether Valve prints a space between symbol and number. */
  symbolSpaced: boolean;
  wholeUnits: boolean;
  decimal: string;
  thousands: string;
};

const row = (id: number, code: string, symbol: string, symbolFirst: boolean, symbolSpaced: boolean, wholeUnits: boolean, decimal: string, thousands: string): SteamCurrency =>
  ({ id, code, symbol, symbolFirst, symbolSpaced, wholeUnits, decimal, thousands });

export const STEAM_CURRENCIES: readonly SteamCurrency[] = [
  row(1, 'USD', '$', true, false, false, '.', ','),
  row(2, 'GBP', '£', true, false, false, '.', ','),
  row(3, 'EUR', '€', false, false, false, ',', ' '),
  row(4, 'CHF', 'CHF', true, true, false, '.', ' '),
  row(5, 'RUB', 'руб.', false, true, false, ',', ''),
  row(6, 'PLN', 'zł', false, true, false, ',', ' '),
  row(7, 'BRL', 'R$', true, true, false, ',', '.'),
  row(8, 'JPY', '¥', true, true, true, '.', ','),
  row(9, 'NOK', 'kr', false, true, false, ',', '.'),
  row(10, 'IDR', 'Rp', true, true, true, '.', ' '),
  row(11, 'MYR', 'RM', true, false, false, '.', ','),
  row(12, 'PHP', 'P', true, false, false, '.', ','),
  row(13, 'SGD', 'S$', true, false, false, '.', ','),
  row(14, 'THB', '฿', true, false, false, '.', ','),
  row(15, 'VND', '₫', false, false, true, ',', '.'),
  row(16, 'KRW', '₩', true, true, true, '.', ','),
  row(17, 'TRY', 'TL', false, true, false, ',', '.'),
  row(18, 'UAH', '₴', false, false, true, ',', ' '),
  row(19, 'MXN', 'Mex$', true, true, false, '.', ','),
  row(20, 'CAD', 'CDN$', true, true, false, '.', ','),
  row(21, 'AUD', 'A$', true, true, false, '.', ','),
  row(22, 'NZD', 'NZ$', true, true, false, '.', ','),
  row(23, 'CNY', '¥', true, true, false, '.', ','),
  row(24, 'INR', '₹', true, true, true, '.', ','),
  row(25, 'CLP', 'CLP$', true, true, true, ',', '.'),
  row(26, 'PEN', 'S/.', true, false, false, '.', ','),
  row(27, 'COP', 'COL$', true, true, true, ',', '.'),
  row(28, 'ZAR', 'R', true, true, false, '.', ' '),
  row(29, 'HKD', 'HK$', true, true, false, '.', ','),
  row(30, 'TWD', 'NT$', true, true, true, '.', ','),
  row(31, 'SAR', 'SR', false, true, false, '.', ','),
  row(32, 'AED', 'AED', false, true, false, '.', ','),
  row(33, 'SEK', 'kr', false, true, false, '.', ','),
  row(34, 'ARS', 'ARS$', true, true, false, ',', '.'),
  row(35, 'ILS', '₪', true, false, false, '.', ','),
  row(36, 'BYN', 'Br', true, false, false, '.', ','),
  row(37, 'KZT', '₸', false, false, true, ',', ' '),
  row(38, 'KWD', 'KD', false, true, false, '.', ','),
  row(39, 'QAR', 'QR', false, true, false, '.', ','),
  row(40, 'CRC', '₡', true, false, true, ',', '.'),
  row(41, 'UYU', '$U', true, false, true, ',', '.')
];

const BY_ID = new Map(STEAM_CURRENCIES.map((currency) => [currency.id, currency]));
const BY_CODE = new Map(STEAM_CURRENCIES.map((currency) => [currency.code, currency]));

/** The row for a Steam id, or `undefined` for an id no wallet carries. */
export function currencyById(id: number | null | undefined): SteamCurrency | undefined {
  return id === null || id === undefined ? undefined : BY_ID.get(id);
}

/** The row for an ISO code, case-insensitively, or `undefined`. */
export function currencyByCode(code: string | null | undefined): SteamCurrency | undefined {
  return code === null || code === undefined ? undefined : BY_CODE.get(code.toUpperCase());
}

/** Every code, in id order: what a currency picker lists. */
export const STEAM_CURRENCY_CODES: readonly string[] = STEAM_CURRENCIES.map((currency) => currency.code);

/**
 * The Steam id of the currency CSFloat prices and pays in: US dollars on every account, whatever
 * the account's Steam wallet holds. The one place that is said; the engine stores it beside every
 * CSFloat row and the window prints CSFloat figures in it.
 */
export const CSFLOAT_CURRENCY = 1;
