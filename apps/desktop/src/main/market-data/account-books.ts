import type { AccountOrderBook } from '@cslytics/ports';
import type { StoredBook } from '@cslytics/market-data';
import type { EngineCommand } from '../../shared/api.js';

/**
 * An account's own read of the Steam order book, for a wallet whose currency the anonymous book
 * is not priced in (portfolio and pricing plan D17).
 *
 * The anonymous book follows the egress, so a USD wallet on an Australian connection sees AUD
 * figures it may not press: a figure that is sent is never converted (AGENTS.md rule 9). The
 * account's own read, made through its market port with its session and relayed by the runtime
 * (`steam.orderBook`), answers in the currency Steam names for that session. Only an answer in the
 * wallet's currency is kept; one in any other says the session follows the egress too, and the
 * account is left alone for an hour rather than asked on every tick. Nothing here is asked while
 * the anonymous book is already in the wallet's currency, so an AUD wallet from Australia costs
 * the session nothing.
 */

/** A book read within this long is current. Steam's own page polls every 5 s; two names staged are two pages. */
export const ACCOUNT_BOOK_FRESH_MS = 10_000;
/** After a read that failed (no session, a transport fault) the name is left alone this long. */
export const ACCOUNT_BOOK_RETRY_MS = 30_000;
/** A session whose book answered in a currency not the wallet's follows the egress: not asked again for this long. */
export const FOLLOWS_EGRESS_MS = 60 * 60_000;
/** The wallet's currency, read from the trading record through the runtime, is kept this long. */
export const WALLET_FRESH_MS = 60_000;

export type AccountBooksDeps = {
  invoke: (command: EngineCommand) => Promise<unknown>;
  now: () => Date;
  /**
   * A journey's seeded answer in place of the runtime's read: a profile holding `market-seed.json`
   * (`accountBooks`, by account then name). `null` is a session that answers no book of its own.
   */
  seeded?: (accountId: string, name: string) => AccountOrderBook | null;
};

type Held = { book: StoredBook | null; readAt: number };

export class AccountBooks {
  private readonly held = new Map<string, Held>();
  private readonly inflight = new Map<string, Promise<StoredBook | null>>();
  private readonly retryAt = new Map<string, number>();
  private readonly followsEgressUntil = new Map<string, number>();
  private readonly wallets = new Map<string, { currency: number | null; readAt: number }>();

  constructor(private readonly deps: AccountBooksDeps) {}

  /**
   * The account's own book for a name, or `null` when the anonymous book serves: it is in the
   * wallet's currency already, the wallet is unknown, no anonymous book has landed yet to say the
   * currencies differ, the session was found to follow the egress, or the read answered nothing.
   */
  async read(accountId: string, name: string, anonymous: StoredBook | null): Promise<StoredBook | null> {
    if (anonymous === null) return null;
    const wallet = await this.walletCurrency(accountId);
    if (wallet === null || anonymous.currency === wallet) return null;
    const now = this.deps.now().getTime();
    if ((this.followsEgressUntil.get(accountId) ?? 0) > now) return null;
    const key = `${accountId}\0${name}`;
    const held = this.held.get(key);
    if (held && now - held.readAt < ACCOUNT_BOOK_FRESH_MS) return held.book;
    if ((this.retryAt.get(key) ?? 0) > now) return held?.book ?? null;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const read = this.fetch(accountId, name, wallet, key, now).finally(() => this.inflight.delete(key));
    this.inflight.set(key, read);
    return read;
  }

  /** What is known of an account: for tests and the status line, never for a price. */
  followsEgress(accountId: string): boolean {
    return (this.followsEgressUntil.get(accountId) ?? 0) > this.deps.now().getTime();
  }

  private async fetch(accountId: string, name: string, wallet: number, key: string, now: number): Promise<StoredBook | null> {
    let answer: AccountOrderBook | null;
    try {
      answer = this.deps.seeded
        ? this.deps.seeded(accountId, name)
        : await this.deps.invoke({ type: 'steam.orderBook', accountId, name }) as AccountOrderBook | null;
    } catch {
      // No session, or the read failed: the held book, if any, with its age, and nothing asked
      // for half a minute. The anonymous book stays on the row either way.
      this.retryAt.set(key, now + ACCOUNT_BOOK_RETRY_MS);
      return this.held.get(key)?.book ?? null;
    }
    if (answer !== null && answer.currency !== wallet) {
      // Steam answered the session in a currency that is not the wallet's: the book follows the
      // egress logged in as well as anonymously, and asking again would only cost the account.
      this.followsEgressUntil.set(accountId, now + FOLLOWS_EGRESS_MS);
      this.held.delete(key);
      return null;
    }
    const book: StoredBook | null = answer === null ? null : { ...answer, name };
    this.held.set(key, { book, readAt: now });
    return book;
  }

  private async walletCurrency(accountId: string): Promise<number | null> {
    const now = this.deps.now().getTime();
    const held = this.wallets.get(accountId);
    if (held && now - held.readAt < WALLET_FRESH_MS) return held.currency;
    try {
      const rows = await this.deps.invoke({ type: 'portfolio.read', accountIds: [accountId] }) as Array<{ accountId: string; currency: number | null }>;
      const currency = rows.find((row) => row.accountId === accountId)?.currency ?? null;
      this.wallets.set(accountId, { currency, readAt: now });
      return currency;
    } catch {
      return held?.currency ?? null;
    }
  }
}
