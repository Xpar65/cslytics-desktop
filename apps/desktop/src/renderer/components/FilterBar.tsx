import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { chipLabel } from '../lib/labels.js';
import { addChip, completions, ownedSuggestions, parse, removeChip, type ChipKind, type FilterChip, type ScopeAccount, type ScopeUnit } from './filter-grammar.js';

/** A row in the list: a chip to add, or, with `fill`, text to put in the box and keep typing. */
type Suggestion = {
  id: string;
  group: string;
  label: string;
  detail?: string | undefined;
  kind: ChipKind;
  chip?: FilterChip | undefined;
  fill?: string | undefined;
};

/** Long enough that a fast typist makes one round trip per word, short enough to feel immediate. */
const DEBOUNCE_MS = 60;
/** One empty list, so an omitted prop does not rebuild the suggestions on every render. */
const NONE: readonly never[] = [];
/** How far Page Up and Page Down move the highlight: about one screen of the list. */
const PAGE = 8;
/**
 * How many times one word asks again while main is still counting holdings. Each ask waits up to
 * `HOLDINGS_WAIT_MS` in main, so this is several seconds, after which the plain order stands.
 */
const PENDING_ASKS = 20;

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
 * The grammar also answers before a filter is typed in full: `f` already offers Float below and
 * Float above, which put `float < ` in the box for the number to follow, and `fact` offers Factory
 * New. With `holdingsOf`, the catalogue's item names come back ordered by how many of those
 * accounts' items each would match, and say so.
 *
 * `kinds` is what a screen can ask. Listings has no location, unit or lock to filter by, so its
 * bar never offers one: a chip that could only ever match nothing is not a filter, it is a trap.
 *
 * The keys are a combobox's, with a tag field's Tab and chips. `/` or Ctrl+F reaches the box from
 * anywhere on the page. The first suggestion is highlighted whenever the list opens or the text
 * changes. Up and Down move it and wrap, Page Up and Page Down jump, Alt+Down and Alt+Up open and
 * close the list, and Enter or Tab take the highlight as a chip. Escape closes the list, and a
 * second Escape empties the box; Enter with the list closed keeps the typed text as a name. Home
 * and End stay with the text, because the box is still a text field.
 *
 * The chips are reached from the box, not by Tab: Left at the start of the box steps onto the last
 * one, Left and Right move along them, Home and End go to the first chip and back to the box, and
 * Backspace or Delete removes the one in focus. Backspace in an empty box removes the last chip.
 */
export function FilterBar({ chips, onChange, accounts = NONE, units = NONE, kinds, holdingsOf, itemsOnly = false, label = 'Filter inventory', placeholder = 'Filter: awp fn st, f > 0.15, nf < 0.01' }: {
  chips: readonly FilterChip[];
  onChange: (next: FilterChip[]) => void;
  /** The scope's accounts, so typing one's name narrows to it. */
  accounts?: readonly ScopeAccount[] | undefined;
  /** The scope's storage units, so typing one's name narrows to what is inside it. */
  units?: readonly ScopeUnit[] | undefined;
  /** The chip kinds this bar may add. Every kind when absent. */
  kinds?: ReadonlySet<ChipKind> | undefined;
  /**
   * The accounts whose holdings order the item names, held ones first and with how many: the
   * accounts the page is showing, which is its scope narrowed by any account chip. Absent on a page
   * whose rows are not holdings.
   */
  holdingsOf?: readonly string[] | undefined;
  /**
   * Offer the catalogue's item names and nothing else. A category comes back as an `item` chip
   * too (it narrows by name), so `kinds` alone cannot leave it out; the Items page, which opens
   * one item rather than filtering many, has no use for one.
   */
  itemsOnly?: boolean | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
}): React.JSX.Element {
  const allowed = (kind: ChipKind): boolean => kinds === undefined || kinds.has(kind);
  const [text, setText] = useState('');
  const [remote, setRemote] = useState<Suggestion[]>([]);
  // The highlight is held by id, so a late catalogue answer cannot move it out from under the
  // user. Null is "the first suggestion", which is where every new word starts.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  // Where focus goes once a removed chip has left the DOM: a chip's index, or the box.
  const refocus = useRef<number | 'box' | null>(null);
  const listId = useId();

  // `/` and Ctrl+F reach the box from anywhere on the page. `/` is a character, so it is left alone
  // in anything that takes text; Ctrl+F is a command and works from there too. A dialog keeps the
  // keyboard to itself, and a bar on a page that is not showing never answers.
  useEffect(() => {
    function onWindowKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      const find = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !takesText(event.target);
      const box = input.current;
      if (!(find || slash) || !box || box.getClientRects().length === 0 || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      box.focus();
      box.select();
    }
    window.addEventListener('keydown', onWindowKey);
    return () => window.removeEventListener('keydown', onWindowKey);
  }, []);

  useLayoutEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    if (target === 'box' || target >= chips.length) input.current?.focus();
    else chipAt(target)?.focus();
  }, [chips]);

  // Grammar suggestions are synchronous: the bar must never wait on the host to offer `ft`. What
  // parses comes first, then what the word being typed could become.
  const local = useMemo<Suggestion[]>(() => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const { chips: parsed } = parse(trimmed);
    const { chips: completed, fills } = completions(text);
    const asChip = (prefix: string) => (chip: FilterChip, index: number): Suggestion => ({
      id: `${prefix}:${chip.kind}:${chip.text}:${index}`, group: GROUP[chip.kind] ?? 'Filter', label: chipLabel(chip), kind: chip.kind, chip
    });
    return [
      ...parsed.map(asChip('local')),
      ...completed.map(asChip('complete')),
      ...fills.map((fill) => ({ id: `fill:${fill.kind}:${fill.label}`, group: GROUP[fill.kind] ?? 'Filter', label: fill.label, detail: fill.detail, kind: fill.kind, fill: fill.fill }))
    ];
  }, [text]);

  const owned = useMemo<Suggestion[]>(() => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const found = ownedSuggestions(trimmed, { accounts, units });
    const owner = (id: string | undefined): string | undefined => (accounts.length > 1 ? accounts.find((account) => account.id === id)?.name : undefined);
    return [
      ...found.units.map((chip) => ({ id: `unit:${chip.accountId}:${chip.casketId}`, group: 'Storage unit', label: chip.text, detail: owner(chip.accountId), kind: chip.kind, chip })),
      ...found.accounts.map((chip) => ({ id: `account:${chip.accountId}`, group: 'Account', label: chip.text, kind: chip.kind, chip }))
    ];
  }, [text, accounts, units]);

  // Joined, so a new array of the same ids asks nothing new.
  const holdingScope = holdingsOf?.join('\0') ?? '';

  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) { setRemote([]); return undefined; }
    let live = true;
    let asked = 0;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (): void => {
      asked += 1;
      void window.trading.invoke({ type: 'catalogue.suggest', text: trimmed, limit: 8, ...(holdingScope ? { accountIds: holdingScope.split('\0') } : {}) })
        .then((answer) => {
          if (!live) return;
          const result = answer as {
            items?: Array<{ name: string; category: string; owned?: number }>;
            collections?: Array<{ id: string; name: string }>;
            keywords?: Array<{ kind: 'item' | 'rarity'; text: string; label: string; rarityId?: string }>;
            pending?: boolean;
          };
          // Main was still counting what the accounts hold, so this list is in the plain order.
          // Asking again picks the counts up once they land; the highlight is held by id, so a row
          // that moves keeps it.
          if (result?.pending && asked < PENDING_ASKS) timer = setTimeout(ask, DEBOUNCE_MS);
          setRemote([
            ...(result?.items ?? []).map((item) => ({
              id: `item:${item.name}`, group: 'Items', label: item.name,
              detail: item.owned ? `${item.category} · ${item.owned.toLocaleString()} owned` : item.category,
              kind: 'item' as const, chip: { kind: 'item' as const, text: item.name }
            })),
            ...(result?.collections ?? []).map((collection) => ({
              id: `collection:${collection.id}`, group: 'Collection', label: collection.name,
              kind: 'collection' as const, chip: { kind: 'collection' as const, text: collection.name }
            })),
            ...(itemsOnly ? [] : result?.keywords ?? []).map((keyword) => ({
              id: `keyword:${keyword.kind}:${keyword.text}`, group: keyword.kind === 'rarity' ? 'Rarity' : 'Category', label: keyword.label,
              kind: keyword.kind, chip: { kind: keyword.kind, text: keyword.text, ...(keyword.rarityId ? { rarityId: keyword.rarityId } : {}) } as FilterChip
            }))
          ]);
        })
        .catch(() => { if (live) setRemote([]); });
    };
    timer = setTimeout(ask, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [text, holdingScope, itemsOnly]);

  // The grammar's strong forms first, which is what stops the item matcher eating `fn`. Names the
  // user chose come before the catalogue's: a unit called "Knives" is what "knives" meant.
  const suggestions = useMemo(
    () => [...local, ...owned, ...remote].filter((suggestion) => allowed(suggestion.kind)),
    [local, owned, remote, kinds]
  );
  const groups = useMemo(() => {
    const byGroup = new Map<string, Suggestion[]>();
    for (const suggestion of suggestions) byGroup.set(suggestion.group, [...(byGroup.get(suggestion.group) ?? []), suggestion]);
    return byGroup;
  }, [suggestions]);
  // The keys walk the list in the order it is drawn. A catalogue answer can join a group the
  // grammar already opened, so the order suggestions arrive in is not the order on screen.
  const ordered = useMemo(() => [...groups.values()].flat(), [groups]);
  const found = ordered.findIndex((suggestion) => suggestion.id === activeId);
  const active = found === -1 ? 0 : found;
  const open = listOpen && (ordered.length > 0 || text.trim().length > 0);
  const optionId = (index: number): string => `${listId}-option-${index}`;

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  function take(suggestion: Suggestion | undefined): void {
    // A form to finish, not a filter yet: it goes in the box and the list follows what is typed next.
    if (suggestion?.fill !== undefined) {
      setText(suggestion.fill);
      setActiveId(null);
      input.current?.focus();
      return;
    }
    const trimmed = text.trim();
    // Text no matcher claimed is still a filter: it becomes a name chip, so the bar never does
    // less than the plain box it replaced.
    const chip = suggestion?.chip ?? (trimmed ? { kind: 'name' as const, text: trimmed } : null);
    if (!chip || !allowed(chip.kind)) return;
    onChange(addChip(chips, chip));
    setText('');
    setActiveId(null);
  }

  function chipAt(index: number): HTMLElement | undefined {
    return bar.current?.querySelectorAll<HTMLElement>('.filter-chip')[index];
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const count = ordered.length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) { setListOpen(event.key === 'ArrowDown'); setActiveId(null); return; }
        // A closed list opens on its first suggestion before an arrow moves anything.
        if (!open) { setListOpen(true); setActiveId(null); return; }
        if (count > 0) setActiveId(ordered[(active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count]!.id);
        return;
      case 'PageDown':
      case 'PageUp':
        if (!open || count === 0) return;
        event.preventDefault();
        setActiveId(ordered[event.key === 'PageDown' ? Math.min(count - 1, active + PAGE) : Math.max(0, active - PAGE)]!.id);
        return;
      case 'Enter':
        event.preventDefault();
        take(open ? ordered[active] : undefined);
        return;
      case 'Tab':
        // Tab takes the highlight, as a tag field does, and moves focus on once nothing is typed.
        if (!open || !text.trim() || event.shiftKey) return;
        event.preventDefault();
        take(ordered[active]);
        return;
      case 'Escape':
        if (open) { event.preventDefault(); setListOpen(false); }
        else if (text) { event.preventDefault(); setText(''); }
        return;
      case 'ArrowLeft': {
        const box = event.currentTarget;
        if (chips.length === 0 || event.shiftKey || box.selectionStart !== 0 || box.selectionEnd !== 0) return;
        event.preventDefault();
        chipAt(chips.length - 1)?.focus();
        return;
      }
      case 'Backspace':
        if (text === '' && chips.length > 0) onChange(removeChip(chips, chips.length - 1));
        return;
    }
  }

  function onChipKeyDown(event: React.KeyboardEvent<HTMLElement>, index: number): void {
    const last = chips.length - 1;
    const remove = (then: number | 'box'): void => {
      refocus.current = then;
      onChange(removeChip(chips, index));
    };
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); chipAt(Math.max(0, index - 1))?.focus(); return;
      case 'ArrowRight': event.preventDefault(); (index < last ? chipAt(index + 1) : input.current)?.focus(); return;
      case 'Home': event.preventDefault(); chipAt(0)?.focus(); return;
      case 'End':
      case 'Escape': event.preventDefault(); input.current?.focus(); return;
      // Backspace leaves focus on the chip before, Delete on the one that takes this one's place.
      case 'Backspace': event.preventDefault(); remove(index > 0 ? index - 1 : 'box'); return;
      case 'Delete': event.preventDefault(); remove(index < last ? index : 'box'); return;
    }
    // A character goes back to the box. Focus moves before the key is typed, so it lands there.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) input.current?.focus();
  }

  return (
    <div className="filter-bar" data-open={open || undefined}>
      <span className="filter-chips" ref={bar}>
        <Icon name="search" size={15} className="search-icon" />
        {chips.map((chip, index) => (
          <span
            className="filter-chip"
            key={`${chip.kind}:${chip.text}:${index}`}
            data-kind={chip.kind}
            tabIndex={-1}
            aria-keyshortcuts="Backspace Delete"
            onKeyDown={(event) => onChipKeyDown(event, index)}
          >
            <span>{chipLabel(chip)}</span>
            <button
              type="button"
              className="filter-chip-remove"
              tabIndex={-1}
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
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(active) : undefined}
          aria-keyshortcuts="/ Control+F"
          placeholder={chips.length ? '' : placeholder}
          value={text}
          spellCheck={false}
          onFocus={() => { setListOpen(true); setActiveId(null); }}
          onBlur={() => setListOpen(false)}
          onClick={() => setListOpen(true)}
          onChange={(event) => { setText(event.target.value); setListOpen(true); setActiveId(null); }}
          onKeyDown={onKeyDown}
        />
      </span>
      {open ? (
        // Nothing in the list takes focus from the box, so the list stays open under a click on a
        // row, a group name or the scrollbar.
        <div className="filter-suggestions" id={listId} role="listbox" aria-label="Filter suggestions" onMouseDown={(event) => event.preventDefault()}>
          {[...groups.entries()].map(([group, entries]) => (
            <div className="filter-group" key={group}>
              <div className="filter-group-name">{group}</div>
              {entries.map((suggestion) => {
                const index = ordered.indexOf(suggestion);
                return (
                  <button
                    type="button"
                    role="option"
                    id={optionId(index)}
                    tabIndex={-1}
                    aria-selected={index === active}
                    // `|| undefined`: React writes `false` as the string "false", and the stylesheet's
                    // `[data-active]` would then light every row.
                    data-active={index === active || undefined}
                    className="filter-suggestion"
                    key={suggestion.id}
                    onMouseMove={() => { if (index !== active) setActiveId(suggestion.id); }}
                    onClick={() => take(suggestion)}
                  >
                    <span>{suggestion.label}</span>
                    {suggestion.detail ? <span className="quiet">{suggestion.detail}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {ordered.length === 0 ? (
            <div className="filter-group">
              <button type="button" role="option" id={optionId(0)} tabIndex={-1} aria-selected="true" data-active className="filter-suggestion" onClick={() => take(undefined)}>
                <span>Search names for “{text.trim()}”</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Whether a key pressed in `target` is typing, so a bare `/` belongs to it rather than to the bar. */
function takesText(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
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
