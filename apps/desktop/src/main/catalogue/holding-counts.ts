/**
 * How many of each item an account set holds, by match key, for ordering the filter bar's item
 * suggestions.
 *
 * The engine already answers this: its group summary (`inventory.groups`) is one row per account
 * and match key with a quantity, bounded by catalogue cardinality. What it cannot do is answer it
 * per keystroke. A page carries at most 250 groups and re-runs the grouping each time, so a large
 * scope is a second or more of reads. This keeps the last few account sets' answers, the way
 * `tileNameOrder` keeps a walk's name order, and lets each go when the engine reports a change on
 * one of its accounts.
 *
 * It orders suggestions and labels them, and nothing else. Nothing that acts on an item, filters a
 * page or decides a command reads it, so a count a moment behind costs a suggestion's position and
 * never a wrong answer.
 */

/** One page of `inventory.groups`, as much of it as this needs. */
export type GroupPage = {
  kind: string;
  rows?: ReadonlyArray<{ matchKey?: unknown; quantity?: unknown }>;
  hasNext?: boolean;
  nextCursor?: string | null;
};

export type ReadGroups = (accountIds: readonly string[], cursor: string | undefined) => Promise<GroupPage>;

/**
 * How long a suggestion waits for counts that are still loading. A typical inventory loads inside
 * it, so the first list is already in order. Past it the answer goes out in the plain order marked
 * `pending`, and the bar asks again, so a large inventory or a busy engine never holds a keystroke.
 */
export const HOLDINGS_WAIT_MS = 250;

/** The counts, when there are any, and whether a load is still under way that may bring them. */
export type Holdings = { counts: ReadonlyMap<string, number> | undefined; pending: boolean };
/** A read that failed is tried again after this, rather than on every keystroke. */
export const HOLDINGS_RETRY_MS = 30_000;
/** Account sets kept at once: the tabs and account chips a person moves between. */
const KEPT = 4;

type Entry = {
  accounts: ReadonlySet<string>;
  counts: ReadonlyMap<string, number> | null;
  /** False until a load finishes with no change reported since it began. */
  current: boolean;
  loading: Promise<void> | null;
  /** Bumped by every change notice, so a load that straddles one is not taken as current. */
  generation: number;
  retryAt: number;
};

export class HoldingCounts {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly read: ReadGroups,
    private readonly wait = HOLDINGS_WAIT_MS,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The counts for these accounts. `counts` is absent when there are none yet: still loading past
   * the wait (`pending`), unreadable, or a scope too large for the summary to answer.
   */
  async get(accountIds: readonly string[]): Promise<Holdings> {
    const key = [...new Set(accountIds)].sort().join('\0');
    const entry = this.entries.get(key) ?? { accounts: new Set(accountIds), counts: null, current: false, loading: null, generation: 0, retryAt: 0 };
    // Most recently asked last, so the oldest is the one let go.
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const [oldKey, old] of this.entries) {
      if (this.entries.size <= KEPT) break;
      if (!old.loading) this.entries.delete(oldKey);
    }
    if (!entry.current && !entry.loading && this.now() >= entry.retryAt) entry.loading = this.load(entry, [...entry.accounts]);
    if (entry.loading) await Promise.race([entry.loading, new Promise((resolve) => setTimeout(resolve, this.wait))]);
    return { counts: entry.counts ?? undefined, pending: entry.loading !== null };
  }

  /** The engine reported a change on this account: every set holding it is read again when next asked. */
  forget(accountId: string): void {
    for (const entry of this.entries.values()) {
      if (!entry.accounts.has(accountId)) continue;
      entry.current = false;
      entry.generation += 1;
      entry.retryAt = 0;
    }
  }

  private async load(entry: Entry, accountIds: readonly string[]): Promise<void> {
    const generation = entry.generation;
    try {
      const counts = await this.readAll(accountIds);
      // A load that straddled a change still beats no counts, but it is not current.
      if (counts !== 'changing') entry.counts = counts;
      entry.current = counts !== 'changing' && entry.generation === generation;
    } catch {
      entry.retryAt = this.now() + HOLDINGS_RETRY_MS;
    } finally {
      entry.loading = null;
    }
  }

  /** Every group in the scope, summed across its accounts; `null` past the summary's cap. */
  private async readAll(accountIds: readonly string[]): Promise<Map<string, number> | null | 'changing'> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const counts = new Map<string, number>();
      let cursor: string | undefined;
      let stale = false;
      do {
        const page = await this.read(accountIds, cursor);
        // Too many kinds of item to count at once: the suggestions keep their plain order.
        if (page.kind === 'needs-filter') return null;
        if (page.kind !== 'page') { stale = true; break; }
        for (const row of page.rows ?? []) {
          if (typeof row.matchKey !== 'string' || typeof row.quantity !== 'number' || row.quantity <= 0) continue;
          counts.set(row.matchKey, (counts.get(row.matchKey) ?? 0) + row.quantity);
        }
        cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
      } while (cursor);
      if (!stale) return counts;
    }
    return 'changing';
  }
}
