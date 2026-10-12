import type { EngineDatabase } from '../db/database.js';
import { ACCOUNT_MARKET, ACCOUNT_WALLET, surfaceEvidence, surfaceName } from '../kernel/evidence.js';
import type { EngineContext } from '../kernel/context.js';
import { required } from '../kernel/support.js';
import { LedgerStore } from '../db/ledger.js';

/**
 * Admitting money against a Steam wallet: the one arithmetic every wallet spender shares.
 *
 * Buy orders and in-game store purchases both bind funds before Steam has said anything, and
 * both were going to compute the same three claims on one balance. Held here, at the policy
 * level, so the store surface cannot import the buy-order surface for it — a surface-to-surface
 * edge `check:deps` would refuse — and so the two can never drift into two answers about what
 * is left to spend (requirements BUY-02, BUY-09; store STORE-02).
 *
 * Both halves fail closed. An incomplete or stale wallet observation is not a zero balance,
 * and an order somebody opened on the Steam website is not a reservation of ours: it has no
 * row to find, so it is counted from the observed order book and never reserved (N-BUY-05).
 */
export function requireFreshMoneyEvidence(context: EngineContext, accountId: string, who: string): void {
  const now = context.ports.clock.now();
  for (const ref of [ACCOUNT_WALLET, ACCOUNT_MARKET]) {
    const evidence = surfaceEvidence(context.database, accountId, ref, now);
    if (evidence.grade === 'SATISFIED') continue;
    const why = evidence.grade === 'UNKNOWN' ? evidence.freshness : evidence.reason;
    throw new Error(`${who} requires a complete, fresh ${surfaceName(ref)} observation (${why})`);
  }
}

export type WalletAvailability = { balanceCents: number; reservedCents: number; externalCents: number; availableCents: number };

/**
 * What the latest wallet observation leaves free to commit, in its own currency.
 *
 * `currency` is what the caller is about to spend in; a wallet in another currency is a
 * refusal, because nothing here converts money (BUY-09).
 */
export function walletAvailability(database: EngineDatabase, accountId: string, currency: number): WalletAvailability {
  const wallet = required(database.raw().prepare(`
    SELECT balance_cents, currency FROM wallet_snapshot WHERE account_id=? ORDER BY id DESC LIMIT 1
  `).get(accountId) as { balance_cents: number; currency: number } | undefined, 'No wallet snapshot');
  if (wallet.currency !== currency) throw new Error('Wallet and order currency differ');
  const reservedCents = new LedgerStore(database).reservedWalletCents(accountId);
  const externalCents = new LedgerStore(database).externalOrderCommitmentCents(accountId);
  return {
    balanceCents: wallet.balance_cents,
    reservedCents,
    externalCents,
    availableCents: wallet.balance_cents - reservedCents - externalCents
  };
}
