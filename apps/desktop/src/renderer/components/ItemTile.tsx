import React from 'react';
import { Thumbnail } from './ui.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';
import { formatFloat, wearTier } from '../lib/format.js';

/**
 * One tile, whatever is being tiled.
 *
 * Inventory tiles an item and Listings tiles an advertisement of one, and the two must read as the
 * same object seen from two ends — same picture, same rarity strip, same wear line — because they
 * are. So the tile itself lives here and knows nothing about either: a caller hands it what to
 * print and what a press means, and adds its own badges over the picture and its own footer under
 * the wear line. The footer is where Listings puts the price.
 *
 * Wear colours and rarity colours are data, not chrome: the rarity strip under the image is the
 * only coloured thing on the tile, and every other state (selected, busy, locked) is carried by
 * borders and glyphs so a colour-blind reader loses nothing.
 *
 * A tile is a click target that may hold controls of its own. Keys are therefore only answered
 * when the tile itself has focus — Space on a button inside it presses that button, and must not
 * also select the tile — and a control inside stops its own click (`stopTilePress`).
 *
 * A tile that can join a selection has a check in the top-right corner of its picture, shown
 * while it is selected and under the pointer otherwise. The check is the press that keeps the
 * rest of the selection, as Ctrl is on the tile; it is out of the Tab order, because Ctrl+Space
 * on the tile is the keyboard's way to the same thing.
 */
export function ItemTile({ name, imageUrl, rarity, selected = false, focused, tabbable, busy = false, unresolved, badges, sub, footer, onActivate, onCheck, onOpen, onDismiss, onDetail }: {
  name: string;
  imageUrl: string | null;
  rarity: { name: string; colour: string } | null;
  /** Ticked, which is a different fact from being the inspector's subject. */
  selected?: boolean | undefined;
  /** The inspector's subject. */
  focused: boolean;
  /** Whether Tab lands here: the subject, or the first tile while there is none. */
  tabbable: boolean;
  busy?: boolean | undefined;
  unresolved?: string | null | undefined;
  /** `TileBadge`s, laid over the picture. */
  badges?: React.ReactNode;
  /** The line under the name. `TileWear` is the usual one. */
  sub?: React.ReactNode;
  /** Whatever this kind of tile adds under that line. Size the grid's `tileHeight` to match. */
  footer?: React.ReactNode;
  /** A click, or Space. The event carries the modifier keys a selection model reads. */
  onActivate: (event: React.MouseEvent | React.KeyboardEvent) => void;
  /** The check's press, with its modifier keys. Without it the tile has no check. */
  onCheck?: ((event: React.MouseEvent) => void) | undefined;
  /** Enter: make this the subject without changing what is ticked. */
  onOpen?: (() => void) | undefined;
  /** Escape. */
  onDismiss?: (() => void) | undefined;
  onDetail?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div
      className="tile"
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-selected={selected}
      data-focused={focused}
      data-busy={busy || undefined}
      data-unresolved={unresolved ?? undefined}
      data-footer={footer ? 'true' : undefined}
      data-checkable={onCheck ? 'true' : undefined}
      aria-selected={selected}
      aria-label={name}
      onClick={onActivate}
      onDoubleClick={onDetail ? (event) => { event.preventDefault(); onDetail(); } : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === ' ') { event.preventDefault(); onActivate(event); }
        else if (event.key === 'Enter') { event.preventDefault(); (onOpen ?? (() => onActivate(event)))(); }
        else if (event.key === 'Escape') onDismiss?.();
      }}
    >
      <div className="tile-image">
        <Thumbnail url={imageUrl} name={name} size={88} />
        {badges}
        {onCheck ? (
          <button
            type="button"
            className="check tile-check"
            tabIndex={-1}
            data-checked={selected}
            aria-pressed={selected}
            aria-label={selected ? `Remove ${name} from the selection` : `Add ${name} to the selection`}
            onClick={(event) => { event.stopPropagation(); onCheck(event); }}
            onDoubleClick={stopTilePress}
          >
            {selected ? <Icon name="check" size={12} strokeWidth={3} /> : null}
          </button>
        ) : null}
      </div>
      <span className="rarity-strip" style={rarity ? { background: rarity.colour } : undefined} title={rarity?.name ?? undefined} />
      <div className="tile-name" title={name}>{name}</div>
      <div className="tile-sub">{sub}</div>
      {footer}
      {/* A tile with a footer says it there, where its controls were; laid over this corner it
          would sit on the line the footer pushed up. */}
      {busy && !footer ? <TileBusy /> : null}
    </div>
  );
}

/** Why a tile's controls are withheld: an open command already names the item. */
export function TileBusy(): React.JSX.Element {
  return <span className="tile-busy" title="An open command names this item">Busy</span>;
}

/** A glyph in one corner of the picture. `lock` is top left, `where` top right, `account` bottom right. */
export function TileBadge({ corner, title, lock, size, children }: {
  corner: 'lock' | 'where' | 'account';
  title: string;
  lock?: 'market' | 'trade' | undefined;
  /** `lg` where the badge is the tile's answer to "which one", as a listing's venue and account are. */
  size?: 'lg' | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`tile-badge tile-badge-${corner}`} data-lock={lock} data-size={size} title={title}>{children}</span>;
}

/** Whose it is, for a grid that holds more than one account's. */
export function TileAccountBadge({ name, photo, size }: { name: string; photo?: string | null | undefined; size?: 'lg' | undefined }): React.JSX.Element {
  return <TileBadge corner="account" title={name} size={size}><Avatar name={name} size={size === 'lg' ? 24 : 16} photo={photo} /></TileBadge>;
}

/** The wear tier and the float, which is what tells two copies of a skin apart at a glance. */
export function TileWear({ paintWear }: { paintWear: number | null }): React.JSX.Element | null {
  if (paintWear === null) return null;
  const tier = wearTier(paintWear);
  return <>{tier ? <span>{tier.code}</span> : null}<span className="num">{formatFloat(paintWear)}</span></>;
}

/** For a control inside a tile: the press is the control's, and must not also select the tile. */
export function stopTilePress(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
