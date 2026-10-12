import React from 'react';
import type { BuyOrderFilter, BuyOrderFilterKind, BuyOrderVenue } from '@cslytics/engine';
import { Thumbnail } from '../../components/ui.js';
import { wearTier } from '../../lib/format.js';
import { plural } from '../../lib/labels.js';

/**
 * What a buy order restricts beyond its market name, drawn on its row.
 *
 * Two layers, so a new marketplace is one entry and a new kind of filter is one piece:
 *
 *  - **Pieces are shared.** The engine hands every venue's filters over in the same few kinds
 *    (`BuyOrderFilter`): a float range, a list of patterns, stickers, charms, a charm-pattern range,
 *    and whatever it could not read. Each kind has one builder here, and each builder is made of
 *    parts any venue can reuse — the wear bar with its range marked, a list of numbers, a list of
 *    accessories with their pictures, a numeric range.
 *  - **Presenters are per venue.** `VENUE_FILTERS` is a record over every venue, so the type
 *    system refuses a venue without one. A presenter lists the kinds that venue's orders can carry,
 *    in the order its rows read them, each with the shared builder or one of its own when the venue
 *    means something different by it. Steam's buy orders take a market name and nothing else, so
 *    Steam's presenter is empty.
 *
 * Every list is shown whole, however long, up to a point: an order may accept a dozen patterns or
 * require four stickers, and the folded line counts what the open row shows.
 */

/** A sticker or charm after main has named it from the catalogue; `null` is a definition the catalogue does not hold. */
type Named = { name?: string | null; imageUrl?: string | null };

/** A filter as the window receives it: the engine's, with its stickers and charms named. */
export type NamedBuyOrderFilter =
  | Exclude<BuyOrderFilter, { kind: 'stickers' | 'charms' }>
  | { kind: 'stickers'; stickers: Array<{ stickerId: number; slot: number | null } & Named> }
  | { kind: 'charms'; charms: Array<{ charmId: number } & Named> };

/** One filter as a row shows it: its label, its words for a folded row, and what the open row draws. */
export type FilterPiece = { key: string; label: string; summary: string; body: React.ReactNode; tone?: 'warn' | undefined };

type FilterOf<K extends BuyOrderFilterKind> = Extract<NamedBuyOrderFilter, { kind: K }>;
type PieceBuilder<K extends BuyOrderFilterKind> = (filter: FilterOf<K>) => FilterPiece;
/** A venue's presenter: the kinds its orders carry, in reading order, each with how it is drawn. */
export type VenueFilterPresenter = { readonly [K in BuyOrderFilterKind]?: PieceBuilder<K> };

// ------------------------------------------------------------------------------ reusable parts

/** A float, the way a float filter is read: three places unless the venue gave more. */
function floatText(value: number): string {
  const text = value.toString();
  return text.length > 7 ? value.toFixed(5) : value.toFixed(Math.max(3, text.split('.')[1]?.length ?? 0));
}

/** The wear tiers a range covers, by code: `FT`, or `MW–FT`. */
function tierSpan(min: number, max: number): string {
  const low = wearTier(min);
  const high = wearTier(Math.max(min, max - 1e-9));
  if (!low || !high) return '';
  return low.code === high.code ? low.label : `${low.code}–${high.code}`;
}

/** A float range on the Factory New to Battle-Scarred scale, the range marked on the wear bar. */
export function FloatRangePart({ min, max }: { min: number | null; max: number | null }): React.JSX.Element {
  const low = min ?? 0;
  const high = max ?? 1;
  const tiers = tierSpan(low, high);
  return (
    <span className="order-filter-float">
      <span className="wear-bar order-filter-wear" aria-hidden="true">
        <span className="order-filter-range" style={{ left: `${low * 100}%`, width: `${Math.max(1, (high - low) * 100)}%` }} />
      </span>
      <span className="num">{floatText(low)} – {floatText(high)}</span>
      {tiers ? <span className="order-filter-quiet">{tiers}</span> : null}
    </span>
  );
}

/** How many numbers a list shows before it says how many more; the title holds them all. */
const LIST_SHOWN = 12;

/** A list of whole numbers — patterns, say — each its own chip, `#` before it. */
export function NumberListPart({ values, prefix = '#' }: { values: readonly number[]; prefix?: string }): React.JSX.Element {
  const shown = values.slice(0, LIST_SHOWN);
  const more = values.length - shown.length;
  return (
    <span className="order-filter-list" title={more > 0 ? values.map((value) => `${prefix}${value}`).join(', ') : undefined}>
      {shown.map((value) => <span className="order-filter-token num" key={value}>{prefix}{value}</span>)}
      {more > 0 ? <span className="order-filter-quiet">+{more} more</span> : null}
    </span>
  );
}

export type AccessoryItem = { key: string; name: string; imageUrl: string | null; detail?: string | undefined };

/** Stickers, charms, patches: each with its picture and its name, the slot beside it when the venue names one. */
export function AccessoryListPart({ items }: { items: readonly AccessoryItem[] }): React.JSX.Element {
  return (
    <span className="order-filter-list">
      {items.map((item) => (
        <span className="order-filter-accessory" key={item.key} title={item.detail ? `${item.name} · ${item.detail}` : item.name}>
          <Thumbnail url={item.imageUrl} name={item.name} size={22} />
          <span className="order-filter-accessory-name">{item.name}</span>
          {item.detail ? <span className="order-filter-quiet">{item.detail}</span> : null}
        </span>
      ))}
    </span>
  );
}

/** A whole-number range with either end open: `1,000 – 2,000`, `from 1,000`, `up to 2,000`. */
export function rangeText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return min === max ? min.toLocaleString() : `${min.toLocaleString()} – ${max.toLocaleString()}`;
  if (min !== null) return `from ${min.toLocaleString()}`;
  return max !== null ? `up to ${max.toLocaleString()}` : 'any';
}

/** The catalogue's name less its family prefix, which the piece's label already says. */
function withoutPrefix(name: string, prefix: string): string {
  return name.startsWith(`${prefix} | `) ? name.slice(prefix.length + 3) : name;
}

// ------------------------------------------------------------------ shared builders, one per kind

export const floatPiece: PieceBuilder<'float'> = (filter) => ({
  key: 'float',
  label: 'Float',
  summary: `float ${floatText(filter.min ?? 0)}–${floatText(filter.max ?? 1)}`,
  body: <FloatRangePart min={filter.min} max={filter.max} />
});

export const patternPiece: PieceBuilder<'pattern'> = (filter) => ({
  key: 'pattern',
  label: filter.seeds.length === 1 ? 'Pattern' : 'Patterns',
  summary: filter.seeds.length <= 3 ? `pattern ${filter.seeds.map((seed) => `#${seed}`).join(', ')}` : plural(filter.seeds.length, 'pattern'),
  body: <NumberListPart values={filter.seeds} />
});

export const stickersPiece: PieceBuilder<'stickers'> = (filter) => ({
  key: 'stickers',
  label: filter.stickers.length === 1 ? 'Sticker' : 'Stickers',
  summary: plural(filter.stickers.length, 'sticker'),
  body: <AccessoryListPart items={filter.stickers.map((sticker, index) => ({
    key: `${sticker.stickerId}:${sticker.slot ?? index}`,
    name: sticker.name ? withoutPrefix(sticker.name, 'Sticker') : `Sticker ${sticker.stickerId}`,
    imageUrl: sticker.imageUrl ?? null,
    detail: sticker.slot !== null ? `slot ${sticker.slot + 1}` : undefined
  }))} />
});

export const charmsPiece: PieceBuilder<'charms'> = (filter) => ({
  key: 'charms',
  label: filter.charms.length === 1 ? 'Charm' : 'Charms',
  summary: plural(filter.charms.length, 'charm'),
  body: <AccessoryListPart items={filter.charms.map((charm, index) => ({
    key: `${charm.charmId}:${index}`,
    name: charm.name ? withoutPrefix(charm.name, 'Charm') : `Charm ${charm.charmId}`,
    imageUrl: charm.imageUrl ?? null
  }))} />
});

export const charmPatternPiece: PieceBuilder<'charm-pattern'> = (filter) => ({
  key: 'charm-pattern',
  label: 'Charm pattern',
  summary: `charm pattern ${rangeText(filter.min, filter.max)}`,
  body: <span className="num">{rangeText(filter.min, filter.max)}</span>
});

/** A filter this app cannot read, named so the person knows why the order cannot be changed here. */
export const unrecognisedPiece: PieceBuilder<'unrecognised'> = (filter) => ({
  key: `unrecognised:${filter.key}`,
  label: 'Not readable here',
  summary: `also ${filter.key}`,
  body: <span className="mono">{filter.key}: {filter.value}</span>,
  tone: 'warn'
});

// ----------------------------------------------------------------------------- per-venue presenters

/**
 * Each marketplace's filters, in its reading order. A venue that means something of its own by a
 * kind gives its own builder for it; the rest reuse the shared ones.
 */
export const VENUE_FILTERS: Readonly<Record<BuyOrderVenue, VenueFilterPresenter>> = {
  // A Steam buy order is a market name, a price and a quantity; the order form offers no filter.
  STEAM: {},
  // CSFloat's `hybrid_properties`: float range, patterns, stickers and charms by definition, and the
  // charm's own pattern range (`kernel/csfloat-buy-orders.ts`).
  CSFLOAT: {
    float: floatPiece,
    pattern: patternPiece,
    stickers: stickersPiece,
    charms: charmsPiece,
    'charm-pattern': charmPatternPiece,
    unrecognised: unrecognisedPiece
  }
};

/**
 * The row's filters as pieces, in the venue's order. A kind the venue's presenter does not draw is
 * still shown, as unreadable, because a filter left off the row is a restriction the person was
 * not told about.
 */
export function filterPieces(venue: BuyOrderVenue, filters: readonly NamedBuyOrderFilter[]): FilterPiece[] {
  const presenter = VENUE_FILTERS[venue];
  const order = Object.keys(presenter) as BuyOrderFilterKind[];
  const pieces: FilterPiece[] = [];
  for (const kind of order) {
    const build = presenter[kind] as PieceBuilder<typeof kind> | undefined;
    for (const filter of filters) if (filter.kind === kind && build) pieces.push(build(filter as never));
  }
  for (const filter of filters) {
    if (presenter[filter.kind]) continue;
    pieces.push(unrecognisedPiece({ kind: 'unrecognised', key: filter.kind, value: 'a filter this window does not draw for this venue' }));
  }
  return pieces;
}

/** The pieces in one line of words, for a folded row, the change editor and a title. */
export function filterSummary(pieces: readonly FilterPiece[]): string {
  return pieces.map((piece) => piece.summary).join(' · ');
}

/**
 * The open row's filters: each piece labelled, laid out to wrap across the item column. `null`
 * filters are an order whose venue reported no properties at all, which is said rather than drawn
 * as "any item".
 */
export function BuyOrderFilters({ venue, filters, note }: {
  venue: BuyOrderVenue;
  filters: readonly NamedBuyOrderFilter[] | null;
  /** A line under the pieces, such as why the order cannot be changed here. */
  note?: string | null | undefined;
}): React.JSX.Element | null {
  if (filters === null) return <span className="cell-sub buy-order-constraints">Filters not reported by the venue</span>;
  const pieces = filterPieces(venue, filters);
  if (pieces.length === 0) return null;
  return (
    <span className="order-filters" data-testid="buy-order-filters">
      {pieces.map((piece) => (
        <span className="order-filter" key={piece.key} data-kind={piece.key.split(':')[0]} data-tone={piece.tone}>
          <span className="order-filter-label">{piece.label}</span>
          {piece.body}
        </span>
      ))}
      {note ? <span className="order-filter-note">{note}</span> : null}
    </span>
  );
}
