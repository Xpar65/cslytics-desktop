import React from 'react';
import { VenueMark } from './VenueMark.js';
import { MARKETPLACES, type VenueId } from '../lib/marketplaces.js';

/**
 * A sale tag with the marketplace's mark in the middle of it: this item is listed, and where.
 *
 * Inventory draws it on a tile, on a row of an opened group and beside the item in the inspector,
 * so an item that is also an advertisement says so wherever the item is shown. A listing lives in
 * the venue's book and the item stays in the inventory (`db/commitment.ts`), so this is a mark on
 * the item rather than a place it is in.
 *
 * The tag is drawn here rather than taken from the icon set: the set's tag is a stroke at 24 units
 * with nothing inside it, and the mark needs a body wide enough to hold a logo at badge size. It
 * points left, with its hole by the point, and the venue's mark sits in the rest of it.
 */
export function ListingMark({ venue, size = 16, title }: {
  venue: VenueId;
  /** The tag's height in pixels; it is half as wide again. */
  size?: number | undefined;
  /** Read out and shown on hover. Without one the mark is decorative, for a place that says it in words. */
  title?: string | undefined;
}): React.JSX.Element {
  const width = Math.round(size * 1.5);
  return (
    <span
      className="listing-mark"
      data-venue={venue}
      style={{ width, height: size }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      <svg className="listing-mark-tag" viewBox="0 0 30 20" width={width} height={size} aria-hidden="true" focusable="false">
        <path d="M9.2 1.5H26a2.5 2.5 0 0 1 2.5 2.5v12a2.5 2.5 0 0 1-2.5 2.5H9.2a2 2 0 0 1-1.5-.7L2 11.3a2 2 0 0 1 0-2.6l5.7-6.5a2 2 0 0 1 1.5-.7z" />
        <circle cx="6.6" cy="10" r="1.4" />
      </svg>
      <span className="listing-mark-venue" style={{ left: `${(18 / 30) * 100}%` }}>
        <VenueMark venue={venue} size={Math.max(8, Math.round(size * 0.62))} decorative />
      </span>
    </span>
  );
}

/** What a tag says on hover and to a screen reader: "Listed on CSFloat", or "Listed on Steam and CSFloat" for both. */
export function listedOnTitle(venues: VenueId | readonly VenueId[]): string {
  const names = (typeof venues === 'string' ? [venues] : venues).map((venue) => MARKETPLACES.find((market) => market.id === venue)?.label ?? venue);
  return `Listed on ${names.join(' and ')}`;
}

/**
 * One tag per marketplace the item is listed on, in the order every page shows them, each saying
 * where. `decorative` is for a place that already says it in words.
 */
export function ListingMarks({ venues, size, decorative = false }: {
  venues: readonly VenueId[];
  size?: number | undefined;
  decorative?: boolean | undefined;
}): React.JSX.Element | null {
  if (venues.length === 0) return null;
  return (
    <span className="listing-marks" data-testid="listing-marks">
      {venues.map((venue) => <ListingMark key={venue} venue={venue} size={size} title={decorative ? undefined : listedOnTitle(venue)} />)}
    </span>
  );
}
