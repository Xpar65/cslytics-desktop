import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { chipLabel } from '../lib/labels.js';
import { addChip, ownedSuggestions, parse, removeChip, type ChipKind, type FilterChip, type ScopeAccount, type ScopeUnit } from './filter-grammar.js';

type Suggestion = {
  id: string;
  group: string;
  label: string;
  detail?: string | undefined;
  chip: FilterChip;
};

/** Long enough that a fast typist makes one round trip per word, short enough to feel immediate. */
const DEBOUNCE_MS = 60;
/** One empty list, so an omitted prop does not rebuild the suggestions on every render. */
const NONE: readonly never[] = [];

/**
 * The search box, as a chip bar.
 *
 * Typed tokens become chips, and the chips — never the raw string — are the query. That is
 * CSFloat's spotlight model, and the reason to copy it is that it makes the filter *legible*:
 * `nf<0.01` is an incantation, "Top 1 % of its range" is a sentence, and the bar shows the second
 * one while meaning the first.
 *
 * Suggestions come from two places and are merged here. The grammar answers locally for anything
 * it can decide alone — wear, float, seed, location, lock. Names, collections, rarities and
 * categories come from `catalogue.suggest`, which the host answers from memory: one IPC round
 * trip, no network, against the same index the search already uses. Storage units and accounts
 * are answered locally too, from the scope the window already holds, and sit between the two.
 *
 * `kinds` is what a screen can ask. Listings has no location, unit or lock to filter by, so its
 * bar never offers one: a chip that could only ever match nothing is not a filter, it is a trap.
 */
export function FilterBar({ chips, onChange, accounts = NONE, units = NONE, kinds, label = 'Filter inventory', placeholder = 'Filter: awp fn st, f > 0.15, nf < 0.01' }: {
  chips: readonly FilterChip[];
  onChange: (next: FilterChip[]) => void;
  /** The scope's accounts, so typing one's name narrows to it. */
  accounts?: readonly ScopeAccount[] | undefined;
  /** The scope's storage units, so typing one's name narrows to what is inside it. */
  units?: readonly ScopeUnit[] | undefined;
  /** The chip kinds this bar may add. Every kind when absent. */
  kinds?: ReadonlySet<ChipKind> | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
}): React.JSX.Element {
  const allowed = (kind: ChipKind): boolean => kinds === undefined || kinds.has(kind);
  const [text, setText] = useState('');
  const [remote, setRemote] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Grammar suggestions are synchronous: the bar must never wait on the host to offer `ft`.
  const local = useMemo<Suggestion[]>(() => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const { chips: parsed } = parse(trimmed);
    return parsed.map((chip, index) => ({
      id: `local:${chip.kind}:${chip.text}:${index}`,
      group: GROUP[chip.kind] ?? 'Filter',
      label: chipLabel(chip),
      chip
    }));
  }, [text]);

  const owned = useMemo<Suggestion[]>(() => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const found = ownedSuggestions(trimmed, { accounts, units });
    const owner = (id: string | undefined): string | undefined => (accounts.length > 1 ? accounts.find((account) => account.id === id)?.name : undefined);
    return [
      ...found.units.map((chip) => ({ id: `unit:${chip.accountId}:${chip.casketId}`, group: 'Storage unit', label: chip.text, detail: owner(chip.accountId), chip })),
      ...found.accounts.map((chip) => ({ id: `account:${chip.accountId}`, group: 'Account', label: chip.text, chip }))
    ];
  }, [text, accounts, units]);

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) { setRemote([]); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      void window.trading.invoke({ type: 'catalogue.suggest', text: trimmed, limit: 8 })
        .then((answer) => {
          if (!live) return;
          const result = answer as {
            items?: Array<{ name: string; category: string }>;
            collections?: Array<{ id: string; name: string }>;
            keywords?: Array<{ kind: 'item' | 'rarity'; text: string; label: string; rarityId?: string }>;
          };
          setRemote([
            ...(result?.items ?? []).map((item) => ({
              id: `item:${item.name}`, group: 'Items', label: item.name, detail: item.category,
              chip: { kind: 'item' as const, text: item.name }
            })),
            ...(result?.collections ?? []).map((collection) => ({
              id: `collection:${collection.id}`, group: 'Collection', label: collection.name,
              chip: { kind: 'collection' as const, text: collection.name }
            })),
            ...(result?.keywords ?? []).map((keyword) => ({
              id: `keyword:${keyword.kind}:${keyword.text}`, group: keyword.kind === 'rarity' ? 'Rarity' : 'Category', label: keyword.label,
              chip: { kind: keyword.kind, text: keyword.text, ...(keyword.rarityId ? { rarityId: keyword.rarityId } : {}) } as FilterChip
            }))
          ]);
        })
        .catch(() => { if (live) setRemote([]); });
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [text]);

  // The grammar's strong forms first, which is what stops the item matcher eating `fn`. Names the
  // user chose come before the catalogue's: a unit called "Knives" is what "knives" meant.
  const suggestions = useMemo(
    () => [...local, ...owned, ...remote].filter((suggestion) => kinds === undefined || kinds.has(suggestion.chip.kind)),
    [local, owned, remote, kinds]
  );
  useEffect(() => { setActive(0); }, [text]);

  function take(suggestion: Suggestion | undefined): void {
    const trimmed = text.trim();
    // Text no matcher claimed is still a filter: it becomes a name chip, so the bar never does
    // less than the plain box it replaced.
    const chip = suggestion?.chip ?? (trimmed ? { kind: 'name' as const, text: trimmed } : null);
    if (!chip || !allowed(chip.kind)) return;
    onChange(addChip(chips, chip));
    setText('');
    setActive(0);
  }

  const groups = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions) groups.set(suggestion.group, [...(groups.get(suggestion.group) ?? []), suggestion]);
  const open = focused && (suggestions.length > 0 || text.trim().length > 0);

  return (
    <div className="filter-bar" data-open={open || undefined}>
      <span className="filter-chips">
        <Icon name="search" size={15} className="search-icon" />
        {chips.map((chip, index) => (
          <span className="filter-chip" key={`${chip.kind}:${chip.text}:${index}`} data-kind={chip.kind}>
            <span>{chipLabel(chip)}</span>
            <button
              type="button"
              className="filter-chip-remove"
              aria-label={`Remove filter ${chipLabel(chip)}`}
              onClick={() => onChange(removeChip(chips, index))}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="input filter-input"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          placeholder={chips.length ? '' : placeholder}
          value={text}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); take(suggestions[active]); }
            else if (event.key === 'Tab' && suggestions.length > 0) { event.preventDefault(); setActive((active + 1) % suggestions.length); }
            else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((active + 1) % Math.max(1, suggestions.length)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((active - 1 + Math.max(1, suggestions.length)) % Math.max(1, suggestions.length)); }
            else if (event.key === 'Escape') { setText(''); setFocused(false); }
            else if (event.key === 'Backspace' && text === '' && chips.length > 0) onChange(removeChip(chips, chips.length - 1));
          }}
        />
      </span>
      {open ? (
        <div className="filter-suggestions" id={listId} role="listbox" aria-label="Filter suggestions">
          {[...groups.entries()].map(([group, entries]) => (
            <div className="filter-group" key={group}>
              <div className="filter-group-name">{group}</div>
              {entries.map((suggestion) => {
                const index = suggestions.indexOf(suggestion);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    className="filter-suggestion"
                    key={suggestion.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => take(suggestion)}
                  >
                    <span>{suggestion.label}</span>
                    {suggestion.detail ? <span className="quiet">{suggestion.detail}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {suggestions.length === 0 ? (
            <div className="filter-group">
              <button type="button" role="option" aria-selected="true" data-active className="filter-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => take(undefined)}>
                <span>Search names for “{text.trim()}”</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const GROUP: Readonly<Record<string, string>> = {
  wear: 'Wear',
  float: 'Float',
  norm: 'Float',
  seed: 'Pattern',
  category: 'Category',
  rarity: 'Rarity',
  collection: 'Collection',
  where: 'Where',
  lock: 'Where',
  tradable: 'Where',
  item: 'Items',
  name: 'Items',
  unit: 'Storage unit',
  account: 'Account'
};
