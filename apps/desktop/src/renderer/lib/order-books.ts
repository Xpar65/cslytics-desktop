import { useEffect, useState } from 'react';
import type { ItemBook } from '../../shared/market.js';
import { engine } from './engine.js';

/** Steam's own cadence: the book moves about every five seconds, and the Items page reads it at that rate. */
export const WATCH_MS = 5_000;

/** Out of sight, a book is still read at least this often, so a reopened panel never prices from an old one. */
export const FOLDED_MS = 60_000;

/** A book read within this long is current; past it the figure says how old it is. Three missed reads. */
export const LIVE_WITHIN_MS = 15_000;

/** What one row's book is read for: its account as well as its market name. */
export type BookKey = { accountId: string; name: string };

/** The map key for an account's book of a name. */
export function bookKey(accountId: string, name: string): string {
  return `${accountId}\u0000${name}`;
}

export type OrderBooks = ReadonlyMap<string, ItemBook>;

/**
 * The newest Steam order book for each account and market name staged, read as soon as it is
 * staged and kept fresh after, keyed by `bookKey`.
 *
 * One live read per key (`item.watch` with the account), asked again after each answer: five
 * seconds later while the rows are on screen (`live`), the Items page's cadence and the scheduler's
 * own floor; a minute later while they are folded away. The anonymous read behind every key is
 * shared by name, so a dock of twenty rows and the page open on one of them cost one read per name
 * per five seconds between them. Only a wallet the anonymous book is not priced for costs a read
 * of the account's own (plan D17), and two such accounts staging one name are two. A read that
 * waits (a paused market) holds only its own key's loop. A key that joins is asked at once, and so
 * is every key when the panel reopens, because the loop restarts on either.
 */
export function useOrderBooks(keys: readonly BookKey[], live: boolean): OrderBooks {
  const [books, setBooks] = useState<Map<string, ItemBook>>(() => new Map());
  const key = [...new Set(keys.map((entry) => bookKey(entry.accountId, entry.name)))].sort().join('\u0001');
  useEffect(() => {
    if (key === '') return undefined;
    let running = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const ask = async (composite: string): Promise<void> => {
      const split = composite.indexOf('\u0000');
      const accountId = composite.slice(0, split);
      const name = composite.slice(split + 1);
      try {
        const answer = await engine.itemWatch(name, accountId);
        if (running) setBooks((current) => new Map(current).set(composite, answer));
      } catch {
        // The next ask reads again; a failed read leaves the held book, and its age, on screen.
      }
      if (running) timers.set(composite, setTimeout(() => { void ask(composite); }, live ? WATCH_MS : FOLDED_MS));
    };
    for (const composite of key.split('\u0001')) void ask(composite);
    return () => {
      running = false;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [key, live]);
  return books;
}
