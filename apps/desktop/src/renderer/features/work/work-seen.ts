/**
 * Which failed members the work indicator has already shown the person.
 *
 * `work.open` keeps the recent settled commands, including the ones that failed, so the panel can
 * still list them. The indicator paints red for a failure only until the panel has been opened on
 * it — a failure that scrolls past unseen is the same as no report. That opening used to live in a
 * ref, so it died with the window and every launch painted the first failures red again.
 *
 * This is a fact about the window, not about the accounts: what a person was shown does not belong
 * in the trading record. It sits in `localStorage` beside the sidebar and the inventory view.
 */

/** Member states that paint the indicator red until the panel has been opened on them. */
export const FAILURE_MEMBER_STATES: ReadonlySet<string> = new Set(['REJECTED', 'FAILED', 'BLOCKED', 'REFUSED']);

/**
 * How many seen failures the window keeps.
 *
 * One `work.open` answer holds at most 1,000 rows. The cap is well above that, and a failure still
 * in the answer is never the one dropped — forgetting it would paint the indicator red on the next
 * launch for a member the panel was already opened on.
 */
export const SEEN_LIMIT = 8_000;

const STORAGE_KEY = 'cslytics.work.seen';

export type SeenFailure = {
  commandId: string;
  memberId: string;
  memberState: string;
};

/** Enough of `Storage` to read and write the one key. Tests pass a stand-in; the window passes `localStorage`. */
export type SeenStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function failureKey(row: { commandId: string; memberId: string }): string {
  return `${row.commandId}:${row.memberId}`;
}

/** Failures the indicator should still paint. A member already opened on is quiet. */
export function unseenFailures<T extends SeenFailure>(rows: readonly T[], seen: ReadonlySet<string>): T[] {
  return rows.filter((row) => FAILURE_MEMBER_STATES.has(row.memberState) && !seen.has(failureKey(row)));
}

/**
 * The panel is open, so every failure currently on screen has been seen.
 *
 * Returns the same set when nothing changed, so a poll can tell a fresh acknowledgement from a
 * repeat. Insertion order is kept: oldest first. Past the cap, the oldest keys that are *not* on
 * this screen are dropped. A key still in `rows` stays, even if that means the set runs past the cap.
 */
export function acknowledgeSeen(seen: ReadonlySet<string>, rows: readonly SeenFailure[]): ReadonlySet<string> {
  const onScreen = new Set<string>();
  for (const row of rows) {
    if (FAILURE_MEMBER_STATES.has(row.memberState)) onScreen.add(failureKey(row));
  }
  const next = new Set(seen);
  for (const key of onScreen) next.add(key);
  const capped = capSeen(next, onScreen);
  if (sameKeys(capped, seen)) return seen;
  return capped;
}

export function readSeenFailures(store: SeenStore | null): Set<string> {
  if (!store) return new Set();
  let stored: unknown;
  try {
    stored = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return new Set();
  }
  if (!Array.isArray(stored)) return new Set();
  const keys = stored.filter((entry): entry is string => typeof entry === 'string' && entry.includes(':'));
  return capSeen(new Set(keys), new Set());
}

export function writeSeenFailures(store: SeenStore | null, seen: ReadonlySet<string>): void {
  store?.setItem(STORAGE_KEY, JSON.stringify([...seen]));
}

/** The window's store, or nothing where there is no `localStorage` (a test, a non-browser render). */
export function browserSeenStore(): SeenStore | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function capSeen(seen: ReadonlySet<string>, pinned: ReadonlySet<string>): Set<string> {
  if (seen.size <= SEEN_LIMIT) return new Set(seen);
  const drop = seen.size - SEEN_LIMIT;
  const remove = new Set<string>();
  for (const key of seen) {
    if (remove.size >= drop) break;
    if (pinned.has(key)) continue;
    remove.add(key);
  }
  if (remove.size === 0) return new Set(seen);
  return new Set([...seen].filter((key) => !remove.has(key)));
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}
