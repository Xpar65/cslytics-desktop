import { useState } from 'react';
import type { ListingVenue } from '@cslytics/engine';
import { formatAmount } from '../../lib/money.js';
import { dollars, type PricedEntry, type StagedEntry, type WorkspaceIntent } from '../../components/listing-workspace-store.js';
import { listingKey, listingTitle, type NamedListing } from './listing-parts.js';
import { VENUE_ID } from '../../lib/marketplaces.js';
import type { Message } from '../../components/ui.js';

/**
 * What can be done to a standing listing, and how each thing is sent.
 *
 * The counterpart of `item-actions.ts` and `commands.ts` for the Listings page, and under the
 * same rule: **the engine is the gate; this is a courtesy.** A control is withheld only where the
 * row already proves the engine would refuse, it says why, and whatever the engine refuses anyway
 * comes back verbatim.
 */

/**
 * What each venue lets a standing listing have done to it.
 *
 * A venue states its own, so one added later that cannot reprice says `false` here and its tiles
 * simply show a price with no pencil — nothing else on the page needs to learn about it.
 */
const VENUE_SUPPORT: Readonly<Record<ListingVenue, { reprice: boolean; delist: boolean }>> = {
  STEAM: { reprice: true, delist: true },
  CSFLOAT: { reprice: true, delist: true }
};

/** Why this listing cannot be repriced, as a predicate phrase, or `null` when it can. */
export function repriceBlocked(row: NamedListing): string | null {
  if (!VENUE_SUPPORT[row.venue].reprice) return 'on a marketplace that cannot change a price';
  if (row.venue === 'CSFLOAT') return row.state === 'listed' ? null : 'not an active CSFloat listing';
  // Steam has no edit: a reprice is a delist and a relist of the item, so it needs the item.
  return row.localId ? null : 'not matched to an item this app holds';
}

/** Why this listing cannot be delisted, or `null` when it can. */
export function delistBlocked(row: NamedListing): string | null {
  if (!VENUE_SUPPORT[row.venue].delist) return 'on a marketplace that cannot be delisted from here';
  if (row.venue === 'CSFLOAT') return row.state === 'listed' ? null : 'not an active CSFloat listing';
  // Steam would take the removal. What could never follow is the proof: a listing gone from the
  // market is a cancel only if the item is seen back in inventory, and with no item to look for
  // the engine could not tell it from a sale — the work would wait for ever.
  return row.localId ? null : 'not matched to an item this app holds, so a delist could not be told from a sale';
}

/** A standing listing in the listing workspace. */
export type StagedListing = StagedEntry & { listing: NamedListing };

/**
 * The workspace's entry for a listing.
 *
 * It opens at the price it has, in the field its venue's call takes — what the seller receives for
 * Steam (rule 4), what the buyer pays for CSFloat — so the first thing on the row is the figure to
 * change, and a row left alone sends nothing.
 */
export function stageListing(row: NamedListing): StagedListing {
  // The figure the venue's own call takes. Steam's is unknown only if the walk never named it.
  const listed = row.venue === 'STEAM' ? row.receiveCents : row.buyerPriceCents;
  return {
    key: listingKey(row),
    accountId: row.accountId,
    name: listingTitle(row),
    // A CSFloat listing is sold under Steam's market name too, so its Steam book is the one to show.
    marketHashName: row.hashName,
    imageUrl: row.imageUrl,
    paintWear: row.paintWear,
    localId: row.localId,
    place: { icon: 'tag', label: `Listed at ${formatAmount(row.buyerPriceCents, row.currency)}` },
    ...(row.venue === 'STEAM' ? { caption: { icon: 'smartphone' as const, short: 'Phone confirm', text: 'Steam has no price edit: the listing is removed and a new one created, which asks for a phone confirmation.' } } : {}),
    venues: [VENUE_ID[row.venue]],
    seed: listed === null
      ? { price: dollars(row.buyerPriceCents), basis: 'buyer' }
      : { price: dollars(listed), basis: row.venue === 'STEAM' ? 'receive' : 'buyer' },
    ...(listed === null ? {} : { currentListCents: listed }),
    listing: row
  };
}

/**
 * Repricing: Steam's rows are one `REPRICE` command, atomic like any other; CSFloat edits one
 * listing per call, so each of its rows is a batch of one and is refused or accepted alone.
 */
export const REPRICE_INTENT: WorkspaceIntent<StagedListing> = {
  verb: 'Reprice',
  noun: 'listing',
  icon: 'pencil',
  refused: 'the new price',
  batches(rows) {
    const steam = rows.filter((row) => row.venue === 'steam');
    const csfloat = rows.filter((row) => row.venue === 'csfloat');
    return [
      ...(steam.length === 0 ? [] : [{
        venue: 'steam' as const,
        kind: 'REPRICE',
        keys: steam.map(({ entry }) => entry.key),
        send: () => window.trading.invoke({
          type: 'command.submit',
          commandId: crypto.randomUUID(),
          kind: 'REPRICE',
          members: steam.map(({ entry, cents }: PricedEntry<StagedListing>) => ({ accountId: entry.accountId, localId: entry.listing.localId!, priceReceiveCents: cents }))
        })
      }]),
      ...csfloat.map(({ entry, cents }) => ({
        venue: 'csfloat' as const,
        kind: 'CSFLOAT_REPRICE',
        keys: [entry.key],
        send: () => window.trading.invoke({ type: 'csfloat.reprice', commandId: crypto.randomUUID(), accountId: entry.accountId, listingId: entry.listing.listingId, priceCents: cents })
      }))
    ];
  }
};

/**
 * Take a listing down.
 *
 * The reply is evidence about an attempt, never proof the listing is gone (rule 1). Either venue's
 * removal is open work from here on — `work.open` reports a CSFloat cancel and a Steam delist
 * alike — and the engine reads the surfaces that can prove it as soon as the attempt settles, so
 * there is nothing left for this window to chase.
 */
export async function delistListing(row: NamedListing): Promise<void> {
  await window.trading.invoke(row.venue === 'CSFLOAT'
    ? { type: 'csfloat.cancel', commandId: crypto.randomUUID(), accountId: row.accountId, listingId: row.listingId }
    : { type: 'listing.remove', accountId: row.accountId, listingId: row.listingId });
}

/** Where one listing's delist is, as far as this window is concerned. Only `idle` offers the control. */
export type DelistPhase = 'idle' | 'asking' | 'sending';

export type Delisting = {
  phase: (row: NamedListing) => DelistPhase;
  /** The trash was pressed. Nothing is sent until the question is answered. */
  ask: (row: NamedListing) => void;
  answer: (row: NamedListing, yes: boolean) => void;
};


/**
 * Delisting, as the tile and the inspector both offer it.
 *
 * It asks first, because a delist is the one press on this page that cannot be taken back by
 * pressing something else: on Steam the way back is a new listing and a phone confirmation. One
 * listing is asked about at a time, so a second trash moves the question rather than stacking it.
 *
 * Once it is sent this keeps nothing. The delist is open work like any other: the work panel says
 * how far it has got, and the tile reads *Busy* and withholds its controls for as long as the
 * work names its item — which also means a delist that fails hands the controls back, where a
 * note kept here would have gone on saying "sent" over a listing that was still up.
 */
export function useDelisting(report: (message: Message | null) => void, refreshWork: () => void): Delisting {
  const [asking, setAsking] = useState<string | null>(null);
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());

  async function send(row: NamedListing): Promise<void> {
    const key = listingKey(row);
    setSending((current) => new Set(current).add(key));
    report(null);
    try {
      await delistListing(row);
      // Work appears out of nothing here and raises no observation notice, so the indicator is
      // asked to read again rather than left to find out at its next poll.
      refreshWork();
      report({ tone: 'success', title: `Delisting ${listingTitle(row)}`, detail: 'Submitted. It is confirmed by a later observation, and progress is shown in the work panel.' });
    } catch (error) {
      // The engine's own words, verbatim.
      report({ tone: 'error', title: 'The delist was not accepted', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }

  return {
    phase: (row) => (sending.has(listingKey(row)) ? 'sending' : asking === listingKey(row) ? 'asking' : 'idle'),
    ask: (row) => setAsking(listingKey(row)),
    answer: (row, yes) => {
      setAsking(null);
      if (yes) void send(row);
    }
  };
}
