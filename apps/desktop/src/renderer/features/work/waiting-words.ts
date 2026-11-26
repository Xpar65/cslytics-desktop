import type { IconName } from '../../components/Icon.js';
import { plural, priceChangeDeadlinePhrase } from '../../lib/labels.js';
import { formatAmount } from '../../lib/money.js';
import type { WaitingRow } from './use-waiting.js';

/**
 * What the waiting list and its pill say, decided from the rows in them.
 *
 * Two things a row can be change the words. A lower price on a listing is on sale at its current
 * price all the while, so "a listing that is never confirmed earns nothing" is false of it; what
 * becomes of it is that it is dropped at its deadline. And a lower price may be confirmed with a
 * link Steam e-mailed rather than in the Steam Mobile app (`confirmBy`, the only kind that says),
 * so "on your phone" is said only where it is true. Every other kind is confirmed on the phone.
 */

type Owed = Pick<WaitingRow, 'kind' | 'confirmBy'>;

/** Whether a row is confirmed with a link Steam e-mailed, rather than in the Steam Mobile app. */
export function confirmedByEmail(row: Owed): boolean {
  return row.kind === 'LISTING_PRICE_CHANGE' && row.confirmBy === 'email';
}

/** The notice above the list, as its sentences: where to confirm, what an unconfirmed row costs, and why the list lags. */
export function waitingNotice(rows: readonly Owed[]): string[] {
  const email = rows.filter(confirmedByEmail).length;
  const phone = rows.length - email;
  const where = email === 0
    ? 'Open the Steam Mobile app and go to Confirmations.'
    : phone === 0
      ? 'Open the link Steam e-mailed you for each one.'
      : 'Open the Steam Mobile app and go to Confirmations, and for the ones marked e-mail, the link Steam e-mailed you.';
  const sentences = [where];
  if (rows.some((row) => row.kind !== 'LISTING_PRICE_CHANGE')) {
    sentences.push('A sell listing that is never confirmed is never listed: it earns nothing and no amount of waiting here will change that.');
  }
  if (rows.some((row) => row.kind === 'LISTING_PRICE_CHANGE')) {
    sentences.push('A lower price that is not confirmed in time is dropped, and its listing stays on sale at the price it has.');
  }
  sentences.push('After you confirm, this list clears on the next complete walk, not at once.');
  return sentences;
}

/** The pill's sentence: how many, how they are confirmed, how many are overdue, and whether the count is a floor. */
export function waitingPillSentence(rows: readonly Owed[], overdue: number, complete: boolean): string {
  const how = rows.some(confirmedByEmail) ? 'waiting for you to confirm' : 'waiting for you to confirm on your phone';
  return `${plural(rows.length, 'thing')} ${how}`
    + (overdue > 0 ? ` · ${overdue} waiting more than an hour` : '')
    + (complete ? '' : ' · at least this many; a walk did not finish');
}

/** The badge on a row: how it is confirmed, or that it still is not. */
export function waitingBadge(row: Owed, overdue: boolean): { label: string; icon: IconName } {
  const email = confirmedByEmail(row);
  if (overdue) return { label: 'Still not confirmed', icon: email ? 'mail' : 'smartphone' };
  return email ? { label: 'Confirm by e-mail', icon: 'mail' } : { label: 'Confirm on phone', icon: 'smartphone' };
}

/**
 * A lower price's two prices and its deadline, as its row says them: the new price and the one the
 * listing is still on sale at, both as the buyer pays them and in the row's currency, with what the
 * seller would receive in the tip; and when the engine drops it unconfirmed. `null` on every other kind.
 */
export function priceChangeTerms(row: Pick<WaitingRow, 'kind' | 'buyerPriceCents' | 'receiveCents' | 'currentBuyerPriceCents' | 'currentReceiveCents' | 'currency' | 'expiresAt'>):
  { prices: string | null; title: string | null; dropped: string | null } | null {
  if (row.kind !== 'LISTING_PRICE_CHANGE') return null;
  const money = (cents: number | null): string | null => (cents === null ? null : formatAmount(cents, row.currency));
  const next = money(row.buyerPriceCents);
  const now = money(row.currentBuyerPriceCents);
  const prices = next && now ? `to ${next}, still listed at ${now}` : next ? `to ${next}` : now ? `still listed at ${now}` : null;
  const parts: string[] = [];
  if (next) parts.push(`At the new price the buyer pays ${next}${row.receiveCents === null ? '' : ` and you receive ${money(row.receiveCents)}`}.`);
  if (now) parts.push(`Until it is confirmed the listing stays at ${now}${row.currentReceiveCents === null ? '' : `, which pays you ${money(row.currentReceiveCents)}`}.`);
  return { prices, title: parts.length > 0 ? parts.join(' ') : null, dropped: priceChangeDeadlinePhrase(row.expiresAt) };
}
