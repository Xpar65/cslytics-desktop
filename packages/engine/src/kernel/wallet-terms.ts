import type { FeeTerms } from '@cslytics/ports';
import type { EngineDatabase } from '../db/database.js';

/**
 * Whose wallet a Steam fee is charged to, read from the record.
 *
 * Steam states each wallet's minimum fee and price with the wallet (`wallet_market_minimum`), and
 * a wallet read keeps what it learned (`wallet_snapshot.market_minimum_cents`). A figure the engine
 * makes now is made with that statement; the fee table in `@cslytics/ports` answers only for a
 * wallet whose reads have learned none. Money dated in the past is not asked through here: a sale
 * keeps the minimum of its own time, which only the table knows.
 */

/** What a wallet read stated as its market minimum, as the record keeps it: whole cents from 1 up, else `null`. */
export function statedMinimum(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The latest wallet read of an account: its currency as Steam numbers it, and the minimum it stated, if any. */
export type WalletStatement = { currency: number; marketMinimumCents: number | null };

export function latestWalletStatement(database: EngineDatabase, accountId: string): WalletStatement | null {
  const row = database.statement('SELECT currency, market_minimum_cents FROM wallet_snapshot WHERE account_id=? ORDER BY id DESC LIMIT 1')
    .get(accountId) as { currency: number; market_minimum_cents: number | null } | undefined;
  return row ? { currency: row.currency, marketMinimumCents: statedMinimum(row.market_minimum_cents) } : null;
}

/**
 * Fee terms for a figure made at `at`, which is now, on the wallet a statement describes.
 * `currency` overrides the statement's when the figure belongs to a listing that names its own;
 * the stated minimum then applies only if it is that currency's.
 */
export function feeTermsNow(statement: WalletStatement | null, at: FeeTerms['at'], currency?: number | null): FeeTerms {
  const walletCurrency = currency ?? statement?.currency ?? null;
  const walletMinimumCents = statement && statement.currency === walletCurrency ? statement.marketMinimumCents : null;
  return { walletCurrency, at, walletMinimumCents };
}
