import type { FeeTerms } from '@cslytics/ports';

/**
 * The minimum each Steam wallet currency has, as the accounts' own wallet reads stated it.
 *
 * Steam states a wallet's least fee and least seller price with the wallet
 * (`wallet_market_minimum`), and the engine hands it out with each account's holdings
 * (`walletMinimumCents`). A price the window previews is made with that statement; the fee table in
 * `@cslytics/ports` answers only for a currency no wallet read has spoken for yet.
 *
 * It is kept by currency, not by account, because the minimum belongs to a currency's fee table:
 * two wallets in one currency have one minimum, and every pricing call on the listing workspace
 * already knows the currency it prices in. The shell calls `noteWalletMinimums` with every
 * holdings read, before it stores them, so a render that follows prices with what was just read.
 */
const stated = new Map<number, number>();

export function noteWalletMinimums(holdings: ReadonlyArray<{ currency: number | null; walletMinimumCents?: number | null | undefined }>): void {
  stated.clear();
  for (const row of holdings) {
    const minimum = row.walletMinimumCents;
    if (row.currency !== null && typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum >= 1) stated.set(row.currency, minimum);
  }
}

/** What a wallet in `currency` stated as its minimum, in whole cents; `null` when none has. */
export function walletMinimumOf(currency: number | null | undefined): number | null {
  return typeof currency === 'number' ? stated.get(currency) ?? null : null;
}

/** Fee terms for a figure made at `at` (now, by default) on a wallet in `currency`. */
export function feeTermsNow(currency: number | null, at: FeeTerms['at'] = Date.now()): FeeTerms {
  return { walletCurrency: currency, at, walletMinimumCents: walletMinimumOf(currency) };
}
