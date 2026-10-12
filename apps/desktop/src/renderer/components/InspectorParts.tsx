import React, { useState } from 'react';
import { realToNorm, resizedImageUrl, type PaintRange } from '@cslytics/catalogue';
import { Thumbnail } from './ui.js';
import { Icon } from './Icon.js';
import { formatFloat, wearTier } from '../lib/format.js';

/**
 * The parts of an inspector that describe the item rather than act on it.
 *
 * The item inspector and the listing inspector sit in the same column of the same layout and
 * describe the same object — an item, and an advertisement of that item — so the picture, the name
 * and the wear read identically in both. What each then offers to *do* is its own.
 */

const PREVIEW_KEY = 'cslytics.inventory.preview';

/**
 * The picture, the name, and what it is.
 *
 * The picture is a preview the person can expand to fill the aside or collapse beside the name.
 * The choice is one setting for both inspectors and is remembered per window: someone who wants
 * the big picture wants it for a listing as much as for the item behind it.
 *
 * A row's handle is list size, 128 px, and the expanded preview fills an aside up to 720 CSS px
 * wide. Drawn from that handle it was visibly soft, so the preview asks for 512, the largest size
 * with real detail behind it (Steam's source art is 512×384; anything larger is upscaled). The
 * row's own picture, already in this window, stands in until the sharp one arrives. One size
 * serves both states, so collapsing and expanding never refetch.
 */
export function InspectorHero({ name, imageUrl, rarity, collection, account, heading }: {
  name: string;
  imageUrl: string | null;
  rarity: { name: string; colour: string } | null;
  collection: { name: string } | null;
  /** Named only when the page holds more than one account's. */
  account?: string | undefined;
  /**
   * The item's own name, for an item that has one: a storage unit's label. It takes the name's
   * place, and the catalogue name moves under it to say what kind of thing this is.
   */
  heading?: React.ReactNode;
}): React.JSX.Element {
  const detailUrl = resizedImageUrl(imageUrl, 512) ?? imageUrl;
  const [open, setOpen] = useState(() => (
    typeof localStorage === 'undefined' || localStorage.getItem(PREVIEW_KEY) !== 'collapsed'
  ));

  function toggle(): void {
    const next = !open;
    setOpen(next);
    localStorage.setItem(PREVIEW_KEY, next ? 'expanded' : 'collapsed');
  }

  return (
    <div className="inspector-hero" data-preview={open ? 'expanded' : 'collapsed'}>
      <button
        type="button"
        className="inspector-preview"
        aria-expanded={open}
        aria-label={open ? 'Collapse item preview' : 'Expand item preview'}
        title={open ? 'Collapse preview' : 'Expand preview'}
        onClick={toggle}
      >
        <Thumbnail url={detailUrl} standIn={imageUrl} name={name} size={96} fill={open} />
        <span className="inspector-preview-toggle" aria-hidden="true">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        </span>
      </button>
      <div className="inspector-hero-text">
        {heading ?? <div className="inspector-name">{name}</div>}
        {heading ? <div className="inspector-meta quiet">{name}</div> : null}
        <InspectorKind rarity={rarity} collection={collection} />
        {account ? <div className="inspector-meta quiet">{account}</div> : null}
      </div>
    </div>
  );
}

/** "Covert · The Revolution Collection", the rarity in its own colour. Nothing when neither is known. */
export function InspectorKind({ rarity, collection }: {
  rarity: { name: string; colour: string } | null;
  collection: { name: string } | null;
}): React.JSX.Element | null {
  if (!rarity && !collection) return null;
  return (
    <div className="inspector-meta quiet">
      {rarity ? <span style={{ color: rarity.colour }}>{rarity.name}</span> : null}
      {rarity && collection ? ' · ' : ''}
      {collection?.name ?? ''}
    </div>
  );
}

/**
 * The float as a marker on the scale from Factory New to Battle-Scarred, with the norm float and the
 * pattern beside it.
 *
 * The bare number is the real float, the one the tier is read from and the markets filter on. The
 * norm float is always named, because the two are both 0 to 1 and a trader who confuses them
 * misprices by the width of the skin's range. It needs the skin's range from the catalogue, so an
 * unresolved or unranged item shows the real float alone rather than a guess.
 */
export function InspectorWear({ paintWear, paintSeed, range }: {
  paintWear: number | null;
  paintSeed: number | null;
  /** The skin's paint range, which the norm float is read against. */
  range?: PaintRange | undefined;
}): React.JSX.Element | null {
  if (paintWear === null) return null;
  const tier = wearTier(paintWear);
  const norm = range ? realToNorm(paintWear, range) : null;
  return (
    <div className="inspector-wear">
      <span className="wear-bar">
        <span className="wear-marker" style={{ left: `${Math.min(100, Math.max(0, paintWear * 100))}%` }} />
      </span>
      <span className="caption">
        {tier ? `${tier.label} · ` : ''}<span className="num">{formatFloat(paintWear)}</span>
        {norm !== null && range ? (
          <span title={`Where the float sits in this skin's own range, ${range.minFloat} to ${range.maxFloat}: 0 is the lowest float it can have, 1 the highest.`}>
            {' · norm float '}<span className="num">{formatFloat(norm)}</span>
          </span>
        ) : null}
        {paintSeed !== null ? <> · pattern <span className="num">{paintSeed}</span></> : null}
      </span>
    </div>
  );
}
