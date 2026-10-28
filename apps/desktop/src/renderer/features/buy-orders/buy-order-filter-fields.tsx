import React, { useEffect, useId, useState } from 'react';
import type { CsfloatItemClass } from '@cslytics/catalogue';
import type { BuyOrderFilterKind, BuyOrderVenue } from '@cslytics/engine';
import { IconButton, Thumbnail } from '../../components/ui.js';
import type { AccessoryPick, FilterDraft } from './buy-order-filter-draft.js';

/**
 * The filters a change can set, drawn as fields — the edit form's half of `buy-order-filters.tsx`.
 *
 * The same two layers. Fields are shared: a range of two numbers, a list of numbers, a list of
 * accessories picked by name. Which of them a venue's edit form offers, and in what order, is
 * `VENUE_FILTER_FIELDS`, a record over every venue, so a new marketplace says what its orders can
 * be changed to or offers none. A kind with no field is not offered — the order keeps it as it is.
 * Which of those apply to the item one order is for is `filterFieldsFor`.
 */

/** A filter kind the edit form can set: everything but what this app cannot read. */
export type EditableFilterKind = Exclude<BuyOrderFilterKind, 'unrecognised'>;

export const VENUE_FILTER_FIELDS: Readonly<Record<BuyOrderVenue, readonly EditableFilterKind[]>> = {
  // A Steam buy order cannot be changed at all: it is cancelled and placed again.
  STEAM: [],
  // Every constraint `PATCH /buy-orders/{id}` takes (captured 2026-09-24).
  CSFLOAT: ['float', 'pattern', 'stickers', 'charms', 'charm-pattern']
};

/**
 * Which of CSFloat's filters apply to the item an order is for: CSFloat's own rule, read from the
 * `isApplicable` of each filter in its buy-order dialog (csfloat.com's bundle as the sibling
 * repository's HAR of 2026-09-14 holds it). A float range and patterns go on any skin, knives and
 * gloves too; stickers on a gun, an agent — whose stickers are its patches — and a souvenir
 * package; a charm on a gun alone; a charm pattern on a charm, and never on a highlight charm.
 * Everything else — a case, a sticker, a pin, a music kit — takes none.
 */
export const CSFLOAT_FILTERS_BY_ITEM: Readonly<Record<CsfloatItemClass, readonly EditableFilterKind[]>> = {
  gun: ['float', 'pattern', 'stickers', 'charms'],
  knife: ['float', 'pattern'],
  gloves: ['float', 'pattern'],
  agent: ['stickers'],
  'souvenir-package': ['stickers'],
  charm: ['charm-pattern'],
  'highlight-charm': [],
  container: [],
  sticker: [],
  patch: [],
  'music-kit': [],
  collectible: [],
  other: []
};

/**
 * The fields one order's change offers, in the venue's order.
 *
 * Those that apply to its item, and any the order already carries whether or not they do, so a
 * filter set somewhere else can still be seen and cleared here rather than riding along unseen.
 * An item main could not place (`csfloatItem` null: a name the catalogue lacks, or no CSFloat
 * schema yet) is offered every field the venue has, and the form says so.
 */
export function filterFieldsFor(venue: BuyOrderVenue, item: CsfloatItemClass | null | undefined, held: ReadonlySet<BuyOrderFilterKind>): EditableFilterKind[] {
  const all = VENUE_FILTER_FIELDS[venue];
  if (venue !== 'CSFLOAT' || !item) return [...all];
  const applies = new Set(CSFLOAT_FILTERS_BY_ITEM[item]);
  return all.filter((kind) => applies.has(kind) || held.has(kind));
}

/** Two numbers, either left empty for an open end. */
export function RangeField({ label, low, high, onLow, onHigh, placeholder, decimal, disabled }: {
  label: string;
  low: string;
  high: string;
  onLow: (value: string) => void;
  onHigh: (value: string) => void;
  placeholder: [string, string];
  decimal?: boolean | undefined;
  disabled?: boolean | undefined;
}): React.JSX.Element {
  return (
    <div className="order-field">
      <span className="order-field-label">{label}</span>
      <span className="order-field-range">
        <input className="input" inputMode={decimal ? 'decimal' : 'numeric'} value={low} placeholder={placeholder[0]} disabled={disabled}
          aria-label={`Lowest ${label.toLowerCase()}`} onChange={(event) => onLow(event.target.value)} />
        <span className="order-field-quiet">to</span>
        <input className="input" inputMode={decimal ? 'decimal' : 'numeric'} value={high} placeholder={placeholder[1]} disabled={disabled}
          aria-label={`Highest ${label.toLowerCase()}`} onChange={(event) => onHigh(event.target.value)} />
      </span>
    </div>
  );
}

/** A list of whole numbers typed with commas: patterns, say. */
export function NumberListField({ label, value, onChange, placeholder, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean | undefined;
}): React.JSX.Element {
  return (
    <label className="order-field">
      <span className="order-field-label">{label}</span>
      <input className="input" inputMode="numeric" value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/**
 * Stickers, charms — any accessory named by a definition id: each picked one as a chip with its
 * picture, and a box that finds more by name in the catalogue (`catalogue.accessories`). The same
 * one may be picked twice, because an order may require the same sticker twice.
 */
export function AccessoryField({ label, family, picks, onChange, disabled }: {
  label: string;
  family: 'sticker' | 'patch' | 'charm';
  picks: readonly AccessoryPick[];
  onChange: (picks: AccessoryPick[]) => void;
  disabled?: boolean | undefined;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [found, setFound] = useState<AccessoryPick[]>([]);
  const listId = useId();

  // A pause in typing is one question; a keystroke is not.
  useEffect(() => {
    const needle = text.trim();
    if (!needle) { setFound([]); return undefined; }
    let current = true;
    const timer = setTimeout(() => {
      void window.trading.invoke({ type: 'catalogue.accessories', family, text: needle, limit: 6 })
        .then((answer) => { if (current) setFound(Array.isArray(answer) ? answer as AccessoryPick[] : []); })
        .catch(() => { if (current) setFound([]); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [text, family]);

  const add = (pick: AccessoryPick): void => {
    onChange([...picks, pick]);
    setText('');
    setFound([]);
  };

  return (
    <div className="order-field order-field-wide">
      <span className="order-field-label">{label}</span>
      <span className="order-field-picks">
        {picks.map((pick, index) => (
          <span className="order-filter-accessory" key={`${pick.id}:${index}`}>
            <Thumbnail url={pick.imageUrl} name={pick.name} size={20} />
            <span className="order-filter-accessory-name">{pick.name}</span>
            <IconButton icon="x" size="sm" label={`Remove ${pick.name}`} disabled={disabled}
              onClick={() => onChange(picks.filter((_, at) => at !== index))} />
          </span>
        ))}
        <span className="order-field-search">
          <input className="input" value={text} disabled={disabled} placeholder={`Add a ${family} by name`} aria-label={`Add a ${family}`}
            aria-controls={listId} aria-expanded={found.length > 0} role="combobox"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (found[0]) add(found[0]); } }} />
          {found.length > 0 ? (
            <span className="order-field-found" id={listId} role="listbox">
              {found.map((pick) => (
                <button type="button" role="option" aria-selected={false} className="order-field-option" key={pick.id} onClick={() => add(pick)}>
                  <Thumbnail url={pick.imageUrl} name={pick.name} size={22} />
                  <span>{pick.name}</span>
                </button>
              ))}
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

/** Strip a family's prefix from a catalogue name for a chip: `Sticker | Fowl Play` → `Fowl Play`. */
function short(pick: AccessoryPick, prefix: string): AccessoryPick {
  return pick.name.startsWith(`${prefix} | `) ? { ...pick, name: pick.name.slice(prefix.length + 3) } : pick;
}

/**
 * The fields a venue's edit form offers for one order, in its order, over one draft.
 *
 * `item` is what the order is for (`filterFieldsFor`), and `held` the filter kinds it carries now.
 * An agent's stickers are its patches, so for one the field says so and finds patches by name.
 */
export function BuyOrderFilterFields({ venue, item, held, draft, onChange, disabled }: {
  venue: BuyOrderVenue;
  item: CsfloatItemClass | null | undefined;
  held: ReadonlySet<BuyOrderFilterKind>;
  draft: FilterDraft;
  onChange: (draft: FilterDraft) => void;
  disabled?: boolean | undefined;
}): React.JSX.Element | null {
  if (VENUE_FILTER_FIELDS[venue].length === 0) return null;
  const kinds = filterFieldsFor(venue, item, held);
  if (kinds.length === 0) {
    return <span className="cell-sub buy-order-editor-note" data-testid="buy-order-filter-fields">CSFloat offers no filters on this kind of item.</span>;
  }
  const set = (change: Partial<FilterDraft>): void => onChange({ ...draft, ...change });
  const patches = item === 'agent';
  const fields: Record<EditableFilterKind, React.JSX.Element> = {
    float: <RangeField key="float" label="Float" low={draft.minFloat} high={draft.maxFloat} placeholder={['0', '1']} decimal disabled={disabled}
      onLow={(minFloat) => set({ minFloat })} onHigh={(maxFloat) => set({ maxFloat })} />,
    pattern: <NumberListField key="pattern" label="Patterns" value={draft.seeds} placeholder="Any, or e.g. 661, 670" disabled={disabled}
      onChange={(seeds) => set({ seeds })} />,
    stickers: <AccessoryField key="stickers" label={patches ? 'Patches' : 'Stickers'} family={patches ? 'patch' : 'sticker'}
      picks={draft.stickers.map((pick) => short(pick, patches ? 'Patch' : 'Sticker'))} disabled={disabled}
      onChange={(stickers) => set({ stickers })} />,
    charms: <AccessoryField key="charms" label="Charms" family="charm" picks={draft.charms.map((pick) => short(pick, 'Charm'))} disabled={disabled}
      onChange={(charms) => set({ charms })} />,
    'charm-pattern': <RangeField key="charm-pattern" label="Charm pattern" low={draft.minCharmPattern} high={draft.maxCharmPattern} placeholder={['Any', 'Any']} disabled={disabled}
      onLow={(minCharmPattern) => set({ minCharmPattern })} onHigh={(maxCharmPattern) => set({ maxCharmPattern })} />
  };
  return (
    <fieldset className="order-fields" data-testid="buy-order-filter-fields">
      <legend className="order-field-legend">Filters</legend>
      {kinds.map((kind) => fields[kind])}
    </fieldset>
  );
}
