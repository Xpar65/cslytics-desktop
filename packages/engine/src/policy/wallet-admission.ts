import type { EngineDatabase } from '../db/database.js';
import { ACCOUNT_MARKET, ACCOUNT_WALLET, surfaceEvidence, surfaceName } from '../kernel/evidence.js';
import type { EngineContext } from '../kernel/context.js';
import { LedgerStore } from '../db/ledger.js';
import { DEFAULT_BUY_ORDER_ADMISSION, commitmentCapCents, type BuyOrderAdmissionPolicy } from '../kernel/context.js';

export { DEFAULT_BUY_ORDER_ADMISSION, admissionPolicy, commitmentCapCents, type BuyOrderAdmission, type BuyOrderAdmissionPolicy } from '../kernel/context.js';

/**
 * Why a buy order was not admitted, as a code a caller can act on without reading the sentence.
 * The sentence stays the message, for a person.
 *
 * - `STALE_MONEY_EVIDENCE`: the wallet or the order book is unread, incomplete or too old.
 * - `UNIT_ABOVE_WALLET`: one unit costs more than the wallet holds, less what is set aside.
 * - `COMMITMENT_CAP`: the order would take standing orders past the policy's cap.
 * - `OPEN_ORDER_CAP`: as many orders stand as the policy allows.
 * - `NAME_IN_FLIGHT`: a create for the same name is still unexplained.
 * - `CURRENCY`: the order is not in the wallet's currency.
 */
export type AdmissionRefusalCode = 'STALE_MONEY_EVIDENCE' | 'UNIT_ABOVE_WALLET' | 'COMMITMENT_CAP' | 'OPEN_ORDER_CAP' | 'NAME_IN_FLIGHT' | 'CURRENCY';

export class AdmissionRefused extends Error {
  override readonly name = 'AdmissionRefused';
  constructor(readonly code: AdmissionRefusalCode, message: string) {
    super(message);
  }
}

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

/*
 * Standing buy orders and their cap (requirements BUY-11). Steam lets standing buy orders total
 * more than the wallet holds; the market answers code 107 past roughly ten times the balance
 * (corpus `steamcommunity.market.createbuyorder`, a hypothesis still to be probed). How far to lean
 * on that is the composing host's belief, never the engine's: it passes a policy per account, and
 * without one the multiple is 1, the safety 1 and nothing is set aside, which is the rule every
 * desktop has always had — what the wallet holds, less what is committed, to the cent.
 */

export type WalletAvailability = {
  balanceCents: number; reservedCents: number; externalCents: number;
  /** The most every standing order together may commit: `floor(multiple × (balance − reserve) × safety)`. */
  capCents: number;
  /** What is left under the cap: the most a new order may commit in all. */
  availableCents: number;
};

/**
 * What the latest wallet observation leaves free to commit, in its own currency.
 *
 * `currency` is what the caller is about to spend in; a wallet in another currency is a
 * refusal, because nothing here converts money (BUY-09). `policy` is a standing buy order's cap
 * (BUY-11); a store purchase spends the balance itself and never passes one.
 */
export function walletAvailability(database: EngineDatabase, accountId: string, currency: number, policy: BuyOrderAdmissionPolicy = DEFAULT_BUY_ORDER_ADMISSION): WalletAvailability {
  const wallet = database.raw().prepare(`
    SELECT balance_cents, currency FROM wallet_snapshot WHERE account_id=? ORDER BY id DESC LIMIT 1
  `).get(accountId) as { balance_cents: number; currency: number } | undefined;
  if (!wallet) throw new AdmissionRefused('STALE_MONEY_EVIDENCE', 'No wallet snapshot');
  if (wallet.currency !== currency) throw new AdmissionRefused('CURRENCY', 'Wallet and order currency differ');
  const reservedCents = new LedgerStore(database).reservedWalletCents(accountId);
  const externalCents = new LedgerStore(database).externalOrderCommitmentCents(accountId);
  const capCents = commitmentCapCents(wallet.balance_cents, policy);
  return {
    balanceCents: wallet.balance_cents,
    reservedCents,
    externalCents,
    capCents,
    availableCents: capCents - reservedCents - externalCents
  };
}
