import type { AccountId, CsfloatListing, CsfloatStallResult } from '@cslytics/ports';
import { CSFLOAT_VENUE, MarketplaceStore } from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage } from '../kernel/support.js';
import { CsfloatStore } from '../db/csfloat.js';

export const CSFLOAT_STALL_SURFACE = 'csfloat-stall';
/** A walk that has not finished in this many pages has not established anything (CSF-05). */
export const MAX_STALL_PAGES = 40;

export type StallSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  collected: number;
  /** What the venue said the book holds. Null when it did not say. */
  totalCount: number | null;
  reason?: string;
};

/**
 * The account's own CSFloat listing book.
 *
 * The whole surface exists to answer one question honestly: *are these all of them?* Cross-venue
 * protection will rest on the answer (XLIST-04), and the ways to get it wrong are all shaped the
 * same — treating a request that returned as a book that ended.
 *
 * Completeness therefore needs three things together, and any one missing leaves the observation
 * incomplete while previously published rows stay exactly as they were:
 *
 *  1. the walk ran out of cursor rather than out of page budget;
 *  2. every page parsed, including the rows inside it;
 *  3. the rows collected match the `total_count` the venue itself reported.
 *
 * The third catches a book changing underneath the walk. It is also why a missing `total_count`
 * is not fatal: the venue simply did not make the claim, and a cursor-exhausted walk is still the
 * best available evidence — recorded as exactly that.
 */
export class CsfloatListingService {
  protected readonly store: MarketplaceStore;

  constructor(protected readonly context: EngineContext) {
    this.store = new MarketplaceStore(context.database);
  }

  syncStall(accountId: AccountId): Promise<StallSyncResult> {
    return this.walk(accountId);
  }

  async syncListing(accountId: AccountId, listingId: string): Promise<number> {
    const connection = this.store.connection(accountId,CSFLOAT_VENUE), startedAt = this.context.now();
    const ports = this.context.ports.csfloat;
    if (!connection?.credential_ref || connection.status === 'DISCONNECTED' || !ports) throw new Error('Connect CSFloat first');
    const result = await ports.listings.getListing(accountId,connection.credential_ref,listingId);
    const complete = result.kind === 'ok' && result.value.listingId === listingId && this.store.connection(accountId,CSFLOAT_VENUE)?.generation === connection.generation;
    const observationId = this.context.database.transaction(() => {
      const id = this.context.database.insertObservation({ accountId, surface: 'csfloat-listing', scopeKind: 'item', scopeId: listingId,
        generation: connection.generation, startedAt, finishedAt: this.context.now(), complete, pagesWalked: 1,
        ...(complete ? {} : { error: 'CSFloat listing unavailable or connection changed' }) });
      if (complete && result.kind === 'ok') new CsfloatStore(this.context.database).publishContract(accountId,result.value,id);
      return id;
    });
    // Without this a listing's read settled nothing by itself: a delist it proved stayed waiting
    // until some other walk happened to settle the account (CSF-45).
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-listing', scopeId: listingId, complete, observationId });
    return observationId;
  }

  protected async walk(accountId: AccountId): Promise<StallSyncResult> {
    const startedAt = this.context.now();
    const connection = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!connection?.credential_ref || !connection.remote_steam_id || connection.status === 'DISCONNECTED') {
      // Not a failed read: nothing was asked. An unlinked venue is not an empty book.
      return this.incomplete(accountId, startedAt, 0, 0, null, 'not-connected');
    }
    const ports = this.context.ports.csfloat;
    if (!ports) return this.incomplete(accountId, startedAt, 0, 0, null, 'no-csfloat-ports');

    const collected: CsfloatListing[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let totalCount: number | null = null;
    let pages = 0;

    while (pages < MAX_STALL_PAGES) {
      let result: CsfloatStallResult;
      try {
        result = await ports.listings.getStallPage(accountId, connection.credential_ref, connection.remote_steam_id, cursor);
      } catch (error) {
        return this.incomplete(accountId, startedAt, pages, collected.length, totalCount, errorMessage(error));
      }
      pages += 1;
      if (result.kind !== 'ok') {
        return this.incomplete(accountId, startedAt, pages, collected.length, totalCount, describe(result));
      }
      for (const listing of result.page.listings) {
        // Deduplicate by remote id: overlapping pages are a paging artefact, never two listings.
        if (seen.has(listing.listingId)) continue;
        seen.add(listing.listingId);
        collected.push(listing);
      }
      if (this.store.connection(accountId,CSFLOAT_VENUE)?.generation !== connection.generation) return this.incomplete(accountId,startedAt,pages,collected.length,totalCount,'connection-changed');
      if (result.page.totalCount === null || (totalCount !== null && result.page.totalCount !== totalCount)) return this.incomplete(accountId,startedAt,pages,collected.length,totalCount,'count-missing-or-changed');
      totalCount = result.page.totalCount;
      if (!result.page.nextCursor) {
        if (totalCount !== null && collected.length !== totalCount) {
          return this.incomplete(accountId, startedAt, pages, collected.length, totalCount, 'count-mismatch');
        }
        return this.publish(accountId, startedAt, pages, collected, totalCount, connection.generation);
      }
      if (cursors.has(result.page.nextCursor)) {
        // The same cursor twice is a walk that cannot progress, not a walk that finished.
        return this.incomplete(accountId, startedAt, pages, collected.length, totalCount, 'repeated-cursor');
      }
      cursor = result.page.nextCursor;
      cursors.add(cursor);
    }
    return this.incomplete(accountId, startedAt, pages, collected.length, totalCount, 'page-budget-exhausted');
  }

  /** Publishes a complete book: the rows, and the absence of everything not in it. */
  private publish(
    accountId: AccountId,
    startedAt: string,
    pages: number,
    listings: readonly CsfloatListing[],
    totalCount: number | null,
    generation: number
  ): StallSyncResult {
    const { database } = this.context;
    const observationId = database.transaction(() => {
      const id = database.insertObservation({
        accountId, surface: CSFLOAT_STALL_SURFACE, generation, startedAt,
        finishedAt: this.context.now(), complete: true, pagesWalked: pages,
        totalExpected: totalCount ?? listings.length
      });
      // Only a complete walk may say what is on the book, and this one write is how it does: every
      // listing shown is stated and marked on the book, every listing not shown is marked gone.
      new CsfloatStore(database).observeStall(accountId, id, listings);
      return id;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: CSFLOAT_STALL_SURFACE, complete: true, observationId });
    return { observationId, complete: true, pagesWalked: pages, collected: listings.length, totalCount };
  }

  /** Records what was seen and why it proves nothing. Published rows are left untouched. */
  private incomplete(
    accountId: AccountId,
    startedAt: string,
    pages: number,
    collected: number,
    totalCount: number | null,
    reason: string
  ): StallSyncResult {
    const observationId = this.context.database.insertObservation({
      accountId, surface: CSFLOAT_STALL_SURFACE, startedAt, finishedAt: this.context.now(),
      complete: false, pagesWalked: pages, ...(totalCount === null ? {} : { totalExpected: totalCount }), error: reason
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: CSFLOAT_STALL_SURFACE, complete: false, observationId });
    return { observationId, complete: false, pagesWalked: pages, collected, totalCount, reason };
  }
}

function describe(result: Exclude<CsfloatStallResult, { kind: 'ok' }>): string {
  if (result.kind === 'rejected') return `csfloat-${result.reason}`;
  if (result.kind === 'throttled') return 'csfloat-throttled';
  return `csfloat-${result.cause}`;
}
