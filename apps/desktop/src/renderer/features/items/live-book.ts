import type { BookLevel, OrderBook } from '@cslytics/market-data';

/**
 * The Items page's live book: what one read changed against the read before it, which the page
 * marks for a moment, and whether the book on screen is still live.
 *
 * Steam refreshes the book about every five seconds and the page reads it at that cadence. Nothing
 * here guesses at a change: two reads in different currencies (an egress that moved mid-session)
 * are not compared, and the first read of a page has nothing to compare with, so it marks nothing.
 */

/** How a figure moved between two reads; `null` when it did not move. */
export type Move = 'up' | 'down' | null;

/** How a resting level changed: more or fewer units at its price, or a price that was not resting before. */
export type LevelChange = 'up' | 'down' | 'new' | null;

export type BookChanges = {
  /** By price, for the levels shown; a level that did not change is absent. */
  bids: ReadonlyMap<number, Exclude<LevelChange, null>>;
  asks: ReadonlyMap<number, Exclude<LevelChange, null>>;
  bidUnits: Move;
  askUnits: Move;
  ask: Move;
  bid: Move;
  mid: Move;
};

/** A book read within this long is live; past it the page says how old it is. Three missed reads at Steam's cadence. */
export const LIVE_WITHIN_MS = 15_000;

/**
 * What `next` changed against `previous`, for the first `rows` levels of each side of `next`. A
 * level is compared with the same price anywhere in the previous side, so a level that moves up
 * the ladder because the one above it filled is not new. `null` when there is nothing to compare.
 */
export function bookChanges(previous: OrderBook | null, next: OrderBook, rows: number): BookChanges | null {
  if (previous === null || previous.currency !== next.currency) return null;
  return {
    bids: levelChanges(previous.bids, next.bids, rows),
    asks: levelChanges(previous.asks, next.asks, rows),
    bidUnits: move(previous.bidUnits, next.bidUnits),
    askUnits: move(previous.askUnits, next.askUnits),
    ask: move(previous.lowestAskCents, next.lowestAskCents),
    bid: move(previous.highestBidCents, next.highestBidCents),
    mid: move(midOf(previous), midOf(next))
  };
}

/** The mid the quote shows: halfway between the top of each side, rounded to a cent; `null` with a side empty. */
export function midOf(book: Pick<OrderBook, 'lowestAskCents' | 'highestBidCents'>): number | null {
  return book.lowestAskCents !== null && book.highestBidCents !== null ? Math.round((book.lowestAskCents + book.highestBidCents) / 2) : null;
}

function levelChanges(previous: readonly BookLevel[], next: readonly BookLevel[], rows: number): Map<number, Exclude<LevelChange, null>> {
  const before = new Map(previous.map((level) => [level.priceCents, level.quantity]));
  const changes = new Map<number, Exclude<LevelChange, null>>();
  for (const level of next.slice(0, rows)) {
    const was = before.get(level.priceCents);
    if (was === undefined) changes.set(level.priceCents, 'new');
    else if (level.quantity !== was) changes.set(level.priceCents, level.quantity > was ? 'up' : 'down');
  }
  return changes;
}

/** A side that empties or fills is a change the ladder already shows; only two numbers have a direction. */
function move(previous: number | null, next: number | null): Move {
  if (previous === null || next === null || previous === next) return null;
  return next > previous ? 'up' : 'down';
}

/** Whether a book observed at `observedAt` is still live at `nowMs`, and how old it is. */
export function liveness(observedAt: string, nowMs: number): { live: boolean; ageMs: number } {
  const at = Date.parse(observedAt);
  const ageMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : Infinity;
  return { live: ageMs <= LIVE_WITHIN_MS, ageMs };
}

/** An age in the words the live mark uses: seconds under a minute, then minutes, hours and days. */
export function ageLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'never';
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
