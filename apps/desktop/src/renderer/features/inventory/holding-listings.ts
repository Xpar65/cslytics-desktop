import { useEffect, useMemo, useState } from 'react';
import type { PageEnvelope } from '@cslytics/engine';
import type { NamedListing } from '../listings/listing-parts.js';
import { byVenue } from '../../lib/marketplaces.js';
import { listedVenues, type ActionRow } from './item-actions.js';
import { selectionKey } from './selection.js';

/** As many holdings as one `listings.page` filter may name. */
const HOLDINGS_LIMIT = 250;
/** Pages of a read before it stops: two venues' listings of 250 holdings are two. */
const PAGE_LIMIT = 8;
/** The walks that change what an item is listed at, or whether it is. */
const LISTING_SURFACES: readonly string[] = ['steam-market', 'steam-wallet', 'csfloat-stall', 'csfloat-listing'];

/** What the inspector asks about a row: whose it is, which holding, and whether it says it is listed. */
export type ListedHolding = Pick<ActionRow, 'accountId' | 'rowKey' | 'localId' | 'steamListed' | 'csfloatListed'> & { assetId?: string | null | undefined };

export type HoldingListings = {
  /** Each listed row's listings, by `selectionKey`; `null` until the read for the rows now shown has answered. */
  byHolding: ReadonlyMap<string, readonly NamedListing[]> | null;
  /** The read was refused or never answered: an engine host from before the holdings filter, say. */
  failed: boolean;
  /** Why, in the words it was refused with; `null` when it was not. */
  reason: string | null;
};

const NONE: ReadonlyMap<string, readonly NamedListing[]> = new Map();

/**
 * The standing listings of the listed items among `rows`, as the Listings page reads them.
 *
 * The inventory row says *that* an item is listed (`steamListed`, `csfloatListed`); this says
 * where and at what, by asking the Listings read for the listings that name these holdings. It is
 * the same row that page draws, names, pictures, stickers and all (main attaches them on the way
 * out), so the item inspector can show it and hand it to the reprice workspace exactly as a press
 * on the Listings page would (`stageListing`). Only rows that say they are listed are asked about,
 * so an inspector over unlisted items reads nothing.
 *
 * Read again whenever a market or stall walk lands for one of the accounts asked about, so a
 * reprice that went through shows its new price without the selection being made again.
 */
export function useHoldingListings(rows: readonly ListedHolding[]): HoldingListings {
  const asked = useMemo(() => JSON.stringify(
    rows
      .filter((row) => listedVenues(row).length > 0)
      .slice(0, HOLDINGS_LIMIT)
      .map((row) => ({ key: selectionKey(row), accountId: row.accountId, localId: row.localId, assetId: row.assetId ?? null }))
  ), [rows]);
  const accounts = useMemo(() => [...new Set((JSON.parse(asked) as Array<{ accountId: string }>).map((row) => row.accountId))].join('\0'), [asked]);
  const [revision, setRevision] = useState(0);
  const [answer, setAnswer] = useState<{ asked: string; byHolding: ReadonlyMap<string, readonly NamedListing[]> | null; failed: boolean; reason: string | null }>({ asked: '[]', byHolding: NONE, failed: false, reason: null });

  useEffect(() => {
    const wanted = JSON.parse(asked) as Array<{ key: string; accountId: string; localId: string; assetId: string | null }>;
    if (wanted.length === 0) {
      setAnswer({ asked, byHolding: NONE, failed: false, reason: null });
      return undefined;
    }
    let live = true;
    const read = async (): Promise<NamedListing[]> => {
      const found: NamedListing[] = [];
      let cursor: string | undefined;
      let restarted = false;
      for (let page = 0; page < PAGE_LIMIT; page += 1) {
        const envelope = await window.trading.invoke({
          type: 'listings.page',
          accountIds: [...new Set(wanted.map((row) => row.accountId))],
          pageSize: 250,
          filter: { holdings: wanted.map(({ accountId, localId, assetId }) => ({ accountId, localId, assetId })) },
          ...(cursor ? { cursor } : {})
        }) as PageEnvelope<NamedListing>;
        // A walk landed between pages: the pages are of two books, so read it again from the top, once.
        if (envelope.kind === 'stale-page' && !restarted) {
          restarted = true;
          found.length = 0;
          cursor = undefined;
          continue;
        }
        if (envelope.kind !== 'page') throw new Error('The listings could not be read.');
        found.push(...envelope.rows);
        if (!envelope.hasNext || !envelope.nextCursor) break;
        cursor = envelope.nextCursor;
      }
      return found;
    };
    void read()
      .then((found) => {
        if (!live) return;
        // A listing names its holding by row or by asset id, and either places it (`db/commitment.ts`).
        const byHolding = new Map<string, NamedListing[]>();
        // In the order every page shows the marketplaces, never the book's name order.
        for (const row of wanted) {
          byHolding.set(row.key, found.filter((listing) => listing.accountId === row.accountId
            && (listing.localId === row.localId || (row.assetId !== null && listing.assetId === row.assetId))).sort(byVenue));
        }
        setAnswer({ asked, byHolding, failed: false, reason: null });
      })
      .catch((error: unknown) => { if (live) setAnswer({ asked, byHolding: null, failed: true, reason: error instanceof Error ? error.message : String(error) }); });
    return () => { live = false; };
  }, [asked, revision]);

  useEffect(() => {
    if (accounts === '') return undefined;
    const inScope = new Set(accounts.split('\0'));
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue') || (inScope.has(notice.accountId) && notice.surfaces.some((surface) => LISTING_SURFACES.includes(surface)))) {
        setRevision((n) => n + 1);
      }
    });
  }, [accounts]);

  // The rows changed and their read has not answered: nothing is known about them yet.
  if (answer.asked !== asked) return { byHolding: null, failed: false, reason: null };
  return { byHolding: answer.byHolding, failed: answer.failed, reason: answer.reason };
}

/** One row's listings from the read above: none until it has answered, or when it found none. */
export function listingsOf(listings: HoldingListings, row: Pick<ActionRow, 'accountId' | 'rowKey'>): readonly NamedListing[] {
  return listings.byHolding?.get(selectionKey(row)) ?? [];
}
