import React from 'react';
import csfloatMark from '../assets/csfloatfavicon.png';
import steamMark from '../assets/steam.svg';
import type { VenueId } from '../lib/marketplaces.js';

/**
 * Which marketplace a piece of work is going to.
 *
 * The two marks are imported rather than fetched: Vite inlines both as `data:` URIs under its
 * 4 KB limit, which the window's CSP already permits (`img-src 'self' data:`). A remote favicon
 * would be a third-party request from the renderer on every render of the work panel. CSFloat's
 * mark is the site favicon at `assets/csfloatfavicon.png`.
 *
 * `decorative` is for a mark beside the venue's name, where reading the mark out as well would
 * name the venue twice.
 *
 * A record over every venue in `MARKETPLACES`, so a new one cannot be added without its mark.
 */
const MARKS: Readonly<Record<VenueId, { src: string; label: string }>> = {
  steam: { src: steamMark, label: 'Steam Community Market' },
  csfloat: { src: csfloatMark, label: 'CSFloat' }
};

export function VenueMark({ venue, size = 14, title, decorative = false }: {
  venue: VenueId;
  size?: number | undefined;
  title?: string | undefined;
  decorative?: boolean | undefined;
}): React.JSX.Element {
  const { src, label } = MARKS[venue];
  return (
    <img
      className="venue-mark"
      src={src}
      alt={decorative ? '' : label}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : title ?? label}
      width={size}
      height={size}
      decoding="async"
    />
  );
}
