import React from 'react';
import { Thumbnail } from './ui.js';
import { Icon } from './Icon.js';
import { formatFloat, wearTier } from '../lib/format.js';
import { UNRESOLVED_REASON } from '../lib/labels.js';

/**
 * One group of interchangeable items, as a row that opens onto its copies.
 *
 * Inventory groups what an account holds and Trades groups what moved in one trade, and the two
 * must read as the same object: the same picture, rarity dot, name and caret, the same tray opening
 * underneath. So the row lives here and knows neither. A caller hands it the meta line, the count
 * chips and any action (Inventory's *Select all*), and the copies go in as children.
 *
 * The children sit in `.group-stack`, which `PagedRows` measures to grow an opened row in a
 * virtual list; outside one, the tray simply flows.
 */
export function GroupBlock({ name, imageUrl, rarity, unresolved, open, selected = false, meta, counts, actions, onToggle, children }: {
  name: string;
  imageUrl: string | null;
  rarity: { name: string; colour: string } | null;
  /** Why the catalogue could not name the group, when it could not. */
  unresolved?: string | null | undefined;
  open: boolean;
  selected?: boolean | undefined;
  meta: React.ReactNode;
  counts: React.ReactNode;
  actions?: React.ReactNode;
  onToggle: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="group-block" data-open={open}>
      <div className="group-row" data-open={open} data-selected={selected} data-unresolved={unresolved ?? undefined} onClick={onToggle}>
        <Thumbnail url={imageUrl} name={name} size={44} />
        <button className="group-expand" aria-label={`Expand ${name}`} aria-expanded={open} onClick={(event) => { event.stopPropagation(); onToggle(); }}>
          <span className="group-name">
            {rarity ? <span className="wear-dot" style={{ background: rarity.colour, display: 'inline-block', marginRight: 7, verticalAlign: 'middle' }} title={rarity.name} /> : null}
            {name}
          </span>
          <span className="group-meta">{meta}</span>
          {unresolved ? <span className="group-unresolved">{UNRESOLVED_REASON[unresolved] ?? unresolved}</span> : null}
        </button>
        <span className="group-counts">{counts}</span>
        {actions}
        <span className="group-caret"><Icon name="chevron-right" size={16} /></span>
      </div>
      {open ? <div className="group-stack" onClick={(event) => event.stopPropagation()}>{children}</div> : null}
    </div>
  );
}

/** The wear of a group as a marker on the float scale, from Factory New to Battle-Scarred. */
export function WearRange({ min, max, wide = false }: { min: number; max: number | null; wide?: boolean | undefined }): React.JSX.Element {
  const tier = wearTier(min);
  const high = max ?? min;
  return (
    <span className="wear" title={`Float ${formatFloat(min)}${high !== min ? ` to ${formatFloat(high)}` : ''}${tier ? ` · ${tier.label}` : ''}`}>
      <span className="wear-bar" style={wide ? { width: 160 } : undefined}>
        <span className="wear-marker" style={{ left: `${Math.min(100, Math.max(0, min * 100))}%` }} />
        {high !== min ? <span className="wear-marker" style={{ left: `${Math.min(100, Math.max(0, high * 100))}%`, opacity: 0.6 }} /> : null}
      </span>
      {tier ? <span>{tier.code}</span> : null}
      <span className="mono num">{formatFloat(min)}</span>
    </span>
  );
}
