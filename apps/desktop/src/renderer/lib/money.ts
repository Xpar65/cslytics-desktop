import { currencyById, currencyByCode, formatUnits, type Converted, type Figure, type SteamCurrency } from '@cslytics/market-data';

/**
 * Every money figure the window prints, in one place, and none without its currency.
 *
 * Three grades (portfolio and pricing plan §5.1): *observed*, a figure a venue named in that
 * account's native currency; *appraised*, an estimate from the order book in the book's own
 * currency, marked `≈`; *converted*, a figure that went through FX, marked `≈` and carrying the
 * native figure, the rate and its date for the hover. The ISO code is printed on every one of
 * them, because a symbol alone is six Steam currencies, and there is no default currency: a
 * caller that does not know what currency a figure is in says so, and the figure says so too.
 *
 * A figure that is sent is never converted (AGENTS.md rule 9, plan D17). Everything here is for
 * what the window shows: a price is typed or pressed in the account's own currency, from a figure
 * named in it, and nothing on its way to a venue goes through `formatConverted` or a rate.
 *
 * `formatCents` used to default to AUD, which is wrong for anyone whose wallet is in another
 * currency. It is gone; `formatAmount` takes the currency or prints that it is unknown.
 */

/** A Steam numeric id, an ISO code, or nothing known. */
export type CurrencyRef = number | string | null | undefined;

export function currencyOf(currency: CurrencyRef): SteamCurrency | undefined {
  if (currency === null || currency === undefined) return undefined;
  return typeof currency === 'number' ? currencyById(currency) : currencyByCode(currency);
}

/** `AUD`, or the honest absence of a code: nothing for an unobserved wallet, `code 99` for an id no wallet carries. */
export function currencyCodeOf(currency: CurrencyRef): string {
  if (currency === null || currency === undefined) return '';
  return currencyOf(currency)?.code ?? (typeof currency === 'number' ? `code ${currency}` : currency.toUpperCase());
}

/** Integer hundredths of a named currency, as Valve prints the number and with the code after it. */
export function formatAmount(cents: number | null | undefined, currency: CurrencyRef): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const known = currencyOf(currency);
  if (known === undefined) {
    const plain = `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
    const code = currencyCodeOf(currency);
    return code === '' ? `${plain} (currency unknown)` : `${plain} ${code}`;
  }
  const units = formatUnits(cents, known);
  const symbol = known.symbolFirst ? `${known.symbol}${known.symbolSpaced ? ' ' : ''}${units}` : `${units}${known.symbolSpaced ? ' ' : ''}${known.symbol}`;
  return `${symbol} ${known.code}`;
}

/**
 * The same figure split in two, so a page can print the code smaller beside the amount. The code
 * is still printed; only its weight changes. A currency this table does not know stays whole in
 * `amount`.
 */
export function amountParts(cents: number | null | undefined, currency: CurrencyRef): { amount: string; code: string } {
  const whole = formatAmount(cents, currency);
  const code = currencyOf(currency)?.code;
  return code !== undefined && whole.endsWith(` ${code}`) ? { amount: whole.slice(0, -code.length - 1), code } : { amount: whole, code: '' };
}

/**
 * A gridline label: the symbol and the number, no code. Only for a chart axis whose panel names the
 * currency once, which is what keeps `$` from being read as any of six currencies.
 */
export function formatTick(cents: number, currency: CurrencyRef): string {
  return amountParts(cents, currency).amount;
}

/** A figure that carries its currency, printed the same way. */
export function formatMoney(money: { cents: number; currency: CurrencyRef } | null | undefined): string {
  return money ? formatAmount(money.cents, money.currency) : '—';
}

/** A figure that went through FX: marked, in the currency it was converted to. */
export function formatConverted(converted: Converted): string {
  return `≈ ${formatAmount(converted.cents, converted.currency)}`;
}

/** What the hover on a converted figure says: where it came from, and at what rate, when. */
export function conversionNote(converted: Converted): string {
  return `${formatAmount(converted.native.cents, converted.native.currency)} at ${converted.rate.toPrecision(5)} on ${converted.rateAsOf}, CSlytics daily rate; Steam converts at its own`;
}

/**
 * An appraised figure: its converted form when one exists and the page prefers it, otherwise
 * the native one. An estimate is marked `≈` either way, because it is one.
 */
export function formatFigure(figure: Figure, prefer: 'converted' | 'native' = 'converted'): string {
  if (prefer === 'converted' && figure.converted !== null) return formatConverted(figure.converted);
  return `≈ ${formatAmount(figure.native.cents, figure.native.currency)}`;
}

/**
 * Ledger money. `UNKNOWN` is a value of its own — printing `0` or `—` would invent a figure
 * DATA-04 forbids. Callers that only have cents and no basis must not use this.
 */
export function formatObservedAmount(
  amountCents: number | null | undefined,
  amountBasis: 'EVIDENCED' | 'UNKNOWN' | undefined,
  currency: CurrencyRef
): string {
  if (amountBasis !== 'EVIDENCED' || amountCents === null || amountCents === undefined) return 'Amount unknown';
  return formatAmount(amountCents, currency);
}
