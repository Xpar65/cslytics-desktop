import type { AccountId, MarketHistoryAction, MyHistoryActionsPage } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage } from '../kernel/support.js';
import { emptyTally, LISTING_TIMES_SURFACE, ListingTimesStore, type ListingTimesTally } from '../db/listing-times.js';

export { LISTING_TIMES_SURFACE } from '../db/listing-times.js';

/**
 * Which accounts read listing times, and how far back (listing times plan D5). A composing host's
 * choice, never stored: absent, or naming no account, nothing is read and the surface is not on
 * anyone's cadence, which is the desktop's behaviour. `since` stops the backfill at the first older
 * page whose oldest event is before it.
 */
export type ListingTimesOptions = { accountIds: readonly AccountId[]; since?: string };

/** The first page the market page itself asks for, and the size of every page after it (corpus `steamcommunity.market.query-my-history`). */
export const LISTING_TIMES_TOP_PAGE = 50;
export const LISTING_TIMES_PAGE = 25;
/** The pages one walk may read: the top, then up to four older ones, each on its own token. */
export const LISTING_TIMES_PAGES_PER_WALK = 5;
/** Older pages in a row with no listing time on any event, after which the backfill stops: the log is older than the field. */
export const LISTING_TIMES_DRY_PAGES = 3;

/** Why a backfill stopped: the log ended, the host's floor was passed, the field ran out, or Steam refused the page pair. */
export type ListingTimesStop = 'end' | 'since' | 'no-listing-times' | 'query-my-history-refused';

/**
 * What the record keeps about its own walks of `QueryMyHistory`, in `surface_state` as the surface's
 * cursor: the offset the next older page is read at, why the backfill stopped when it did, the run
 * of older pages with no listing time, and what the last walk made of what it read. `gap` is open
 * while the events between a newest page that joined nothing already held and the newest event held
 * then (`anchorAt`) are read: it keeps where the backfill stood, which it returns to once a page
 * reaches `anchorAt`.
 */
export type ListingTimesCoverage = {
  depth: number; stopped?: ListingTimesStop; dry: number; last: ListingTimesTally;
  gap?: { depth: number; stopped?: ListingTimesStop; anchorAt: string | null };
};

export type ListingTimesSyncResult = { observationId: number; complete: boolean; tally: ListingTimesTally; coverage: ListingTimesCoverage | undefined };

/**
 * The listing time of each sale and purchase, read from the 2026 market's own history route beside
 * the history walk and never inside it (listing times plan D1).
 *
 * Its own surface, `steam-market-listing-times`, with its own observation, budget and breaker: a
 * walk of it that fails is incomplete on its own surface and nowhere else, so it can never mark the
 * history walk incomplete, and no precondition reads it. Each walk reads the newest page and, while
 * the backfill lasts, a few older ones, each on the endpoint's own token and handing the account's
 * web lane back whenever anything else waits for it. What it read is written once, keyed by the
 * listing and the event type, in one short transaction after the last page; it never touches
 * `market_history`, the ledger or any order. Its walk earns no settle: nothing any reconciler
 * reads is written here.
 */
export class ListingTimesService {
  constructor(protected readonly context: EngineContext, protected readonly options: ListingTimesOptions | undefined = undefined) {
    if (options?.since !== undefined && !Number.isFinite(Date.parse(options.since))) throw new Error('listingTimes.since must be an ISO-8601 time');
  }

  /** Whether this account reads listing times: the host named it and the market port can read the route. */
  enabled(accountId: AccountId): boolean {
    return Boolean(this.options?.accountIds.includes(accountId)) && typeof this.context.ports.market.getMyHistoryActionsPage === 'function';
  }

  /** The committed coverage, or undefined before the first walk that read the top. */
  coverage(accountId: AccountId): ListingTimesCoverage | undefined {
    const row = this.context.database.checkpoint(accountId, LISTING_TIMES_SURFACE);
    if (!row) return undefined;
    const cursor = JSON.parse(row.cursor_json) as Partial<ListingTimesCoverage>;
    return Number.isSafeInteger(cursor.depth) && Number.isSafeInteger(cursor.dry) ? cursor as ListingTimesCoverage : undefined;
  }

  /** Whether older pages remain to be read, which hurries the surface's cadence (`policy/cadence.ts`). */
  backfillPending(accountId: AccountId): boolean {
    const coverage = this.coverage(accountId);
    return this.enabled(accountId) && coverage !== undefined && !coverage.stopped;
  }

  /** The pages one walk may read. Isolated so a saboteur can read without end. */
  protected pagesPerWalk(): number {
    return LISTING_TIMES_PAGES_PER_WALK;
  }

  /**
   * Takes the endpoint's own token for one more page of a walk already admitted, or answers
   * `false` when the walk handed its lane back instead. Isolated so a saboteur can page for free,
   * or hold the lane.
   */
  protected async admitPage(accountId: AccountId, handBack?: () => boolean): Promise<boolean> {
    if (handBack) return this.context.governors.admitReadUnless(accountId, 'steam-web', LISTING_TIMES_SURFACE, handBack);
    await this.context.governors.admitRead(accountId, 'steam-web', LISTING_TIMES_SURFACE);
    return true;
  }

  /** Writes what a walk read. Isolated so a saboteur can write it the wrong way. */
  protected record(accountId: AccountId, events: readonly MarketHistoryAction[], observationId: number): ListingTimesTally {
    return new ListingTimesStore(this.context.database).record(accountId, events, observationId);
  }

  /**
   * One walk: the newest page, `[0, 50]`, then older pages `[depth, 25]` while the backfill lasts,
   * the walk's pages last and nobody waits for the lane. The log grows at the top between walks, so
   * an offset read again later holds events already read, never skips one; the key makes a second
   * reading a no-op. The backfill stops for good at the log's end (`more` false or an empty page),
   * at the host's `since`, after three older pages with no listing time, or when Steam refuses the
   * pair. A failed top commits nothing; a failed older page keeps what the pages before it read, and
   * the walk is incomplete either way, on this surface alone.
   */
  async sync(accountId: AccountId, options: { yield?: () => boolean } = {}): Promise<ListingTimesSyncResult> {
    const { database } = this.context;
    const readPage = this.context.ports.market.getMyHistoryActionsPage?.bind(this.context.ports.market);
    if (!readPage) throw new Error('This market port cannot read QueryMyHistory');
    const startedAt = this.context.now();
    const previous = this.coverage(accountId);
    const sinceMs = this.options?.since === undefined ? undefined : Date.parse(this.options.since);
    const events: MarketHistoryAction[] = [];
    let pages = 0;
    let error: string | undefined;
    let coverage: ListingTimesCoverage | undefined;
    const read = async (start: number, count: number, handBack?: () => boolean): Promise<MyHistoryActionsPage | null> => {
      if (pages > 0 && !(await this.admitPage(accountId, handBack))) return null;
      const page = await readPage(accountId, start, count);
      pages += 1;
      if (page.start !== start || page.count !== count || page.events.length > count) throw new Error('listing-times-pagination-mismatch');
      return page;
    };
    const before = (page: MyHistoryActionsPage): boolean =>
      sinceMs !== undefined && page.events.some((event) => Date.parse(event.occurredAt) < sinceMs);
    const store = new ListingTimesStore(database);
    const joins = (page: MyHistoryActionsPage): boolean => page.events.some((event) => store.holds(accountId, event));
    try {
      const top = (await read(0, LISTING_TIMES_TOP_PAGE))!;
      events.push(...top.events);
      coverage = previous ? { ...previous } : { depth: LISTING_TIMES_TOP_PAGE, dry: 0, last: emptyTally() };
      if (!previous && (!top.more || !top.events.length)) coverage.stopped = 'end';
      else if (!previous && before(top)) coverage.stopped = 'since';
      else if (previous && top.more && top.events.length && !joins(top)) {
        // More than a page landed since the last walk (a host down for hours, a busy day): the events
        // between this page and the newest already held are read next, before the backfill goes on.
        // A gap already open keeps its anchor and is read again from here; what it read is a no-op.
        const gap = previous.gap ?? { depth: previous.depth, ...(previous.stopped ? { stopped: previous.stopped } : {}), anchorAt: store.newest(accountId) };
        coverage = { depth: LISTING_TIMES_TOP_PAGE, dry: 0, last: previous.last, gap };
      }
      while (!coverage.stopped && pages < this.pagesPerWalk()) {
        let page: MyHistoryActionsPage | null;
        try {
          page = await read(coverage.depth, LISTING_TIMES_PAGE, options.yield);
        } catch (caught) {
          // A refused pair is Steam's rule about offsets, not a bad moment: asking again cannot help.
          if (errorMessage(caught).includes('query-my-history-refused')) { coverage = { ...coverage, stopped: 'query-my-history-refused' }; break; }
          throw caught;
        }
        if (!page) break;
        events.push(...page.events);
        const gap: ListingTimesCoverage['gap'] = coverage.gap;
        if (gap && gap.anchorAt !== null && page.events.some((event) => event.occurredAt <= gap.anchorAt!)) {
          // The gap is closed: what lies below its anchor was read before. Back to where the backfill stood.
          coverage = { depth: Math.max(coverage.depth + LISTING_TIMES_PAGE, gap.depth), dry: 0, last: coverage.last, ...(gap.stopped ? { stopped: gap.stopped } : {}) };
          continue;
        }
        const dry: number = page.events.some((event) => event.listedAt !== undefined) ? 0 : coverage.dry + 1;
        coverage = { ...coverage, depth: coverage.depth + LISTING_TIMES_PAGE, dry };
        if (!page.events.length || !page.more) coverage.stopped = 'end';
        else if (before(page)) coverage.stopped = 'since';
        else if (dry >= LISTING_TIMES_DRY_PAGES) coverage.stopped = 'no-listing-times';
        if (coverage.stopped && coverage.gap) {
          const { gap: _closed, ...rest } = coverage;
          coverage = rest;
        }
      }
    } catch (caught) {
      error = errorMessage(caught);
    }
    let tally = emptyTally();
    const observationId = database.transaction(() => {
      const now = this.context.now();
      const obs = database.insertObservation({ accountId, surface: LISTING_TIMES_SURFACE, startedAt, finishedAt: now,
        complete: !error, pagesWalked: pages, ...(error ? { error } : {}) });
      tally = this.record(accountId, events, obs);
      if (coverage) {
        coverage = { ...coverage, last: tally };
        database.advanceCheckpoint({ accountId, surface: LISTING_TIMES_SURFACE, cursor: coverage, coveredThrough: null, observationId: obs, now });
        if (coverage.stopped && coverage.stopped !== previous?.stopped) {
          database.addEvent(accountId, 'listing-times-backfill-stopped', { reason: coverage.stopped, depth: coverage.depth }, now);
        }
      }
      // A disagreement between the two routes, or within this one, is on record once, when it is first seen.
      if (tally.conflicts || tally.differs) {
        database.addEvent(accountId, 'listing-times-quarantined', { conflicts: tally.conflicts, differs: tally.differs }, now);
      }
      return obs;
    });
    return { observationId, complete: !error, tally, coverage };
  }
}
