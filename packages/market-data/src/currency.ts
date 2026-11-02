import type { SteamCurrency } from '@cslytics/ports';

/**
 * How Valve prints a Steam currency's hundredths. The table it reads, `STEAM_CURRENCIES`, is in
 * `@cslytics/ports` (`currency.ts`), the one copy the engine, this package and the window share;
 * it is re-exported here so that every money figure this package and the window format comes from
 * one import.
 */

export { STEAM_CURRENCIES, STEAM_CURRENCY_CODES, currencyByCode, currencyById, type SteamCurrency } from '@cslytics/ports';

/**
 * Hundredths of a currency as Valve prints them, without the symbol: `1,129.27`, `42,--` becomes
 * `42,00`, and a whole-unit currency drops its fraction (`124,659` for 12,465,900 JPY hundredths).
 * The symbol and the code are the caller's, because where they go depends on the page.
 */
export function formatUnits(cents: number, currency: SteamCurrency): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = currency.wholeUnits ? Math.round(absolute / 100) : Math.floor(absolute / 100);
  const fraction = currency.wholeUnits ? '' : `${currency.decimal}${String(absolute % 100).padStart(2, '0')}`;
  const digits = String(whole);
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    grouped += digits[index];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) grouped += currency.thousands;
  }
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}
