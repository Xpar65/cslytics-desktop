import React from 'react';
import type { ListingPageRow, ListingVenue } from '@cslytics/engine';
import { Button, Spinner } from '../../components/ui.js';
import { stopTilePress } from '../../components/ItemTile.js';
import { formatCents } from '../../lib/format.js';
import { CSFLOAT_STATE, LISTING_STATUS, currencyCode, stateLabel, type StateLabel } from '../../lib/labels.js';

/**
 * What the Listings page, its tiles and its inspector all say the same way: whose venue a
 * listing is on, what state it is in, what it is called, and money with its currency.
 */

/** A listing after the main process has attached what the catalogue knows. The engine supplies none of it. */
export type NamedListing = ListingPageRow & {
  name: string;
  rarity: { id: string; name: string; colour: string } | null;
  collection: { id: string; name: string } | null;
  imageUrl: string | null;
  unresolved: string | null;
  /** The skin's paint range, for the norm float. `null` when the catalogue does not know the item or it has no wear. */
  minFloat: number | null;
  maxFloat: number | null;
};

/** Account-scoped and venue-scoped, because a listing id is only unique inside one venue's book. */
export function listingKey(row: Pick<ListingPageRow, 'accountId' | 'venue' | 'listingId'>): string {
  return `${row.accountId}:${row.venue}:${row.listingId}`;
}

/** The catalogue's name, or the venue's own when the catalogue could not place the item. */
export function listingTitle(row: NamedListing): string {
  return row.unresolved ? row.hashName : row.name || row.hashName;
}

/**
 * Each venue's own state words, in English.
 *
 * Two dictionaries rather than one merged table, because the two venues genuinely mean different
 * things: Steam's `PENDING_CONFIRMATION` is a listing waiting on a phone tap, and CSFloat has no
 * such state. Folding them into a single vocabulary would invent an equivalence nobody observed.
 */
export function listingState(venue: ListingVenue, state: string): StateLabel {
  return stateLabel(venue === 'STEAM' ? LISTING_STATUS : CSFLOAT_STATE, state);
}

/**
 * Money, with the currency it is in — never without.
 *
 * `A$` and `$` differ by one character on a page that shows both, so the ISO code rides along
 * beside the amount. A currency nothing has observed prints the bare number and says so, which is
 * the one case where adding a symbol would be a claim rather than a formatting choice.
 */
export function Money({ cents, currency, tone }: { cents: number | null; currency: number | null; tone?: 'quiet' | undefined }): React.JSX.Element {
  if (cents === null) return <span className="quiet">—</span>;
  const code = currencyCode(currency);
  return (
    <span className="money" data-tone={tone}>
      <span className="num">{formatCents(cents, currency)}</span>
      <span className="currency-tag">{code || 'currency not observed'}</span>
    </span>
  );
}

/**
 * A delist that has been asked for: the question, and then the moment it is being sent. What
 * becomes of it after that is the work panel's to say.
 *
 * Shared by the tile and the inspector so the two cannot disagree about a listing that is on its
 * way down. It stops its own clicks, because on a tile the thing underneath is a click target too.
 */
export function DelistPrompt({ phase, name, onAnswer }: {
  phase: 'asking' | 'sending';
  name: string;
  onAnswer: (yes: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="delist-prompt" data-phase={phase} role={phase === 'asking' ? 'group' : 'status'} aria-label={phase === 'asking' ? `Delist ${name}?` : undefined} onClick={stopTilePress} onDoubleClick={stopTilePress}>
      {phase === 'asking' ? <>
        <span className="delist-prompt-label">Delist?</span>
        <Button size="sm" variant="danger" aria-label={`Yes, delist ${name}`} onClick={() => onAnswer(true)}>Yes</Button>
        <Button size="sm" aria-label={`No, keep ${name} listed`} onClick={() => onAnswer(false)}>No</Button>
      </> : <><Spinner size={12} /> Delisting…</>}
    </span>
  );
}
