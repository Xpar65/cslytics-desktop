import React, { useState } from 'react';
import { realToNorm, resizedImageUrl, type PaintRange } from '@cslytics/catalogue';
import { Badge, Thumbnail } from './ui.js';
import { Tip } from './Tip.js';
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
 *
 * What is on the item's picture, its stickers and charm (`beneath`), sits in the picture's own tile
 * along its foot when the preview is expanded, and across the aside under the collapsed picture and
 * the name beside it.
 */
export function InspectorHero({ name, imageUrl, rarity, collection, account, heading, beneath }: {
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
  /** Drawn in the picture's tile, under the picture: the strip of what is applied to the item. */
  beneath?: React.ReactNode;
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
      {/* One tile for the picture and what is on it. The strip is beside the button, not in it,
          because each sticker is a focus stop of its own and a button cannot hold one. */}
      <div className="inspector-picture">
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
        {beneath}
      </div>
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
 * The float as a marker on the scale from Factory New to Battle-Scarred, with the number beside it
 * and the pattern after that. Everything else about it is in the tip the line opens when hovered or
 * focused: the wear tier, the float, and the norm float.
 *
 * The line is two numbers and no sentence. The tier is already in the item's name, so it is not
 * printed again. The bare number is the real float, the one the tier is read from and the markets
 * filter on. The norm float is always named, in the tip, because the two are both 0 to 1 and a
 * trader who confuses them misprices by the width of the skin's range. It needs the skin's range
 * from the catalogue, so an unresolved or unranged item has the real float alone rather than a guess.
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
    <div className="inspector-wear" data-testid="inspector-wear">
      <Tip content={<>
        {tier ? <span className="tip-line">{tier.label}</span> : null}
        <span className="tip-line">Float {formatFloat(paintWear)}</span>
        {norm !== null && range ? (
          <span className="tip-line">Norm float {formatFloat(norm)}, its place in this skin's own range of {range.minFloat} to {range.maxFloat}</span>
        ) : null}
        {paintSeed !== null ? <span className="tip-line">Pattern {paintSeed}</span> : null}
      </>}>
        <span className="wear-bar">
          <span className="wear-marker" style={{ left: `${Math.min(100, Math.max(0, paintWear * 100))}%` }} />
        </span>
        <span className="num">{formatFloat(paintWear)}</span>
        {paintSeed !== null ? <span className="quiet">pattern <span className="num">{paintSeed}</span></span> : null}
      </Tip>
    </div>
  );
}

/**
 * Why an inspector offers nothing to do: an open command already names the item. A chip, with the
 * sentence in its tip, where the item inspector and the listing inspector both used to print it.
 */
export function InspectorBusy({ several = false }: { several?: boolean | undefined }): React.JSX.Element {
  return (
    <Tip content={`An open command already names ${several ? 'one of these items' : 'this item'}. Its actions return when the work leaves the panel.`}>
      <Badge tone="quiet" icon="hourglass">Busy</Badge>
    </Tip>
  );
}
