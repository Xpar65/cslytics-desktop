import { instantOf } from '../../lib/clock.js';
import { formatCountdown } from '../../lib/labels.js';
import { formatAmount } from '../../lib/money.js';
import { NOT_YET_LISTED, repriceBlocked } from './listing-actions.js';
import type { NamedListing, PendingPriceChange } from './listing-parts.js';

/**
 * Where a listing stands on having its price changed, and the words for it.
 *
 * Steam changes a price on the listing that is there. A higher price applies at once. A lower one
 * waits for a confirmation, and the listing stays on sale at its current price until then. Either
 * way Steam takes one change per listing every five minutes, counted from the moment the listing
 * went on sale and from every change it accepted.
 *
 * The tile, the inspector and the listing workspace all show some of this, so all of it is read
 * here, from two facts the listings read reports per row. The engine reports times and facts; this
 * turns them into a state at an instant and into sentences. Nothing here decides what is sent: a
 * change asked inside the cooldown is still sent to the engine, which holds it until the cooldown
 * ends.
 */
export type RepriceState =
  /** Its price cannot be changed from here, and why, as `repriceBlocked` words it. */
  | { kind: 'unavailable'; why: string }
  /** A lower price is waiting for its confirmation. Nothing else can be asked of the listing until it is settled. */
  | ({ kind: 'awaiting-confirmation' } & PendingPriceChange)
  /** Steam refuses a price change for `leftMs` more. One asked for now is held, and sent at `readyAt`. */
  | { kind: 'cooling-down'; leftMs: number; readyAt: number }
  | { kind: 'ready' };

/**
 * A listing's state at `now` (milliseconds since the epoch), and the one place its precedence is
 * decided, so the tile, the inspector and the workspace cannot rank the same row differently.
 *
 * A listing not yet on the market, waiting for its own confirmation, outranks everything: it has
 * no price on sale to change, so no countdown and no waiting lower price is shown for it, whatever
 * the row carries (`repriceBlocked` says why). Then a lower price waiting for its confirmation,
 * which blocks a second change; then any other reason the price cannot be changed from here; then
 * the cooldown. A row that carries neither fact reads as no wait and nothing pending, and so does
 * every CSFloat row: the cooldown and the confirmation are Steam's. A wait ends at its instant, so
 * a listing whose cooldown ends exactly now is ready.
 */
export function repriceState(row: NamedListing, now: number): RepriceState {
  if (notYetListed(row)) return { kind: 'unavailable', why: NOT_YET_LISTED };
  const pending = pendingPriceChangeOf(row);
  if (pending) return { kind: 'awaiting-confirmation', ...pending };
  const why = repriceBlocked(row);
  if (why !== null) return { kind: 'unavailable', why };
  const readyAt = repriceReadyAtOf(row);
  if (readyAt !== null && readyAt > now) return { kind: 'cooling-down', leftMs: readyAt - now, readyAt };
  return { kind: 'ready' };
}

/**
 * The lower price waiting on a Steam listing, or `null`: what the tile's badge and state line are
 * drawn from. `null` on a listing not yet on the market, which outranks it (`repriceState`).
 */
export function pendingPriceChangeOf(row: NamedListing): PendingPriceChange | null {
  if (row.venue !== 'STEAM' || notYetListed(row)) return null;
  return row.pendingPriceChange ?? null;
}

/** A Steam listing waiting for its own confirmation: not on the market yet. */
function notYetListed(row: NamedListing): boolean {
  return row.venue === 'STEAM' && row.awaitingConfirmation === 1;
}

/**
 * When Steam next takes a price change on the listing, in milliseconds since the epoch, or `null`
 * when no wait is known. The read sends it as ISO-8601 text, read here once. It may already have
 * passed: this is the instant a countdown runs to, and `repriceState` says whether there is
 * anything left of it. Text that is not an instant is no wait.
 */
export function repriceReadyAtOf(row: NamedListing): number | null {
  return row.venue === 'STEAM' ? instantOf(row.repriceReadyAt) : null;
}

/** The tip on a tile's countdown. */
export function cooldownTip(leftMs: number): string {
  return `Steam allows a price change on this listing in ${formatCountdown(leftMs)}.`;
}

/** The inspector's line for the same wait. */
export function cooldownLine(leftMs: number): string {
  return `Price change available in ${formatCountdown(leftMs)}`;
}

/**
 * A waiting lower price in one sentence, both prices as a buyer sees them: the one asked for, and
 * the one the listing is still on sale at.
 */
export function pendingTitle(row: Pick<NamedListing, 'buyerPriceCents' | 'currency'>, pending: PendingPriceChange): string {
  const where = pending.confirmBy === 'email' ? 'the confirmation Steam e-mailed you' : 'your phone confirmation';
  return `Price change to ${formatAmount(pending.buyerCents, row.currency)} is waiting for ${where}. Still listed at ${formatAmount(row.buyerPriceCents, row.currency)}.`;
}

/** The same, in the few words a tile's state line has room for. */
export function pendingSubLine(confirmBy: PendingPriceChange['confirmBy']): string {
  return confirmBy === 'email' ? 'Confirm price by e-mail' : 'Confirm price on phone';
}
