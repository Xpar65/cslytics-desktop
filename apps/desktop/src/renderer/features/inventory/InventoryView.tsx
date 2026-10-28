import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryFilter, InventoryGroupRow, PageEnvelope, SelectionSnapshot, StoragePageRow } from '@cslytics/engine';
import { PagedRows } from '../../components/PagedRows.js';
import { Badge, Button, Check, DetailView, Drawer, Empty, Field, IconButton, Notice, Panel, Pill, Select, Segmented, Thumbnail } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import { GroupBlock, WearRange } from '../../components/GroupBlock.js';
import { Icon } from '../../components/Icon.js';
import { Avatar } from '../../components/Avatar.js';
import { locationLabel, plural } from '../../lib/labels.js';
import { busyKeysFromWork } from '../work/work-busy.js';
import { useOpenWork } from '../work/WorkIndicator.js';
import { addChip, chipsToFilter, type FilterChip } from '../../components/filter-grammar.js';
import { FilterBar } from '../../components/FilterBar.js';
import { useScopedChips } from '../../components/scoped-chips.js';
import { InventoryTiles, type NamedItem } from './InventoryTiles.js';
import { InspectorSplit } from '../../components/InspectorSplit.js';
import { ItemInspector } from './ItemInspector.js';
import type { StagedItem } from './list-intent.js';
import { emptyInventorySelection, selectionKey, selectionQuantity, withPage, type InventorySelection } from './selection.js';
import { isStorageUnit, itemName, unitGroupName, unitName } from './storage-unit.js';
import { DISPLAY_ONLY_CAPTION, DISPLAY_ONLY_LABEL, isDisplayOnly } from './display-only.js';
import { SortControl, type SortDirection, type SortOption } from '../../components/SortControl.js';
import { compareNames } from '../../../shared/name-order.js';
import type { Message } from '../../components/ui.js';

export type { InventorySelection };
export { emptyInventorySelection, selectionQuantity };

/** What the main process attaches on the way out. The engine supplies none of it. */
type Named = {
  name: string;
  marketHashName: string | null;
  category: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  collection: { id: string; name: string } | null;
  imageUrl: string | null;
  unresolved: string | null;
  /** The catalogue's `marketable` for the kind; `false` is a display item (`display-only.ts`). */
  catalogueMarketable?: boolean | null;
};
type NamedGroup = InventoryGroupRow & Named;


/**
 * A group is one kind of item, so it is ordered by what it is or by how many of it there are. The
 * count is the group's quantity, forty cases counting forty, because that is the number the row
 * shows.
 */
type GroupSort = 'name' | 'count';
const GROUP_SORTS: ReadonlyArray<SortOption<GroupSort>> = [
  { id: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  { id: 'count', label: 'Item count', asc: 'fewest first', desc: 'most first' }
];
/**
 * A tile is one copy, so its wear is worth ordering by as well as what it is.
 * `seen` is when the holding was first detected: the walk that first showed it, which is also
 * when a later arrival was received. Steam does not report an acquisition date.
 */
type TileSort = 'name' | 'float' | 'seen';
const TILE_SORTS: ReadonlyArray<SortOption<TileSort>> = [
  { id: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  { id: 'float', label: 'Float', asc: 'lowest first', desc: 'highest first' },
  { id: 'seen', label: 'Detected', asc: 'oldest first', desc: 'newest first' }
];

/** The name a group row shows, which is the name it sorts by. Every storage unit shares one group. */
function groupSortName(group: NamedGroup): string {
  return isStorageUnit(group) ? unitGroupName(group.quantity) : group.name;
}

/** How many handles this screen will tick at once. Above that, highlighting would dump an unbounded page into the window, so Select all freezes the set in the engine instead. */
const HIGHLIGHT_CAP = 1_000;

/**
 * Inventory, grouped.
 *
 * A group is one `(def_index, paint_index, quality)`, which is what a user thinks of as "an item"
 * — a hundred identical cases are one row, not a hundred. Grouping is also what makes names
 * affordable: group count is bounded by how many CS2 items exist rather than by how many the
 * account holds, so the whole summary can be named and sorted without the engine knowing a single
 * name.
 *
 * Selection stays at the handle level. Opening a group lists every copy under that row, a case
 * as much as a skin: forty cases are forty rows to tick, as they are forty tiles. The inspector on the right is the same panel the tile view uses: click a copy
 * to see the skin and the actions that copy actually allows.
 */
export function InventoryView({ accountIds, accounts = [], selection, onSelection, selectionOnly = false, onStage, onOpenItem }: {
  accountIds: string[];
  /** Names (and optional avatar refs and Steam ids) for the ids, so a row can say which account owns it. */
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null; steamId64?: string | null | undefined; currency?: number | null | undefined }> | undefined;
  selection: InventorySelection;
  onSelection: (next: InventorySelection) => void;
  selectionOnly?: boolean;
  /** The inspector's *Stage listing*: the shell stages these and holds the workspace. */
  onStage?: ((selected: readonly StagedItem[]) => void) | undefined;
  /** Opens the item page for a market name: the book, the history and the curve (plan §7). */
  onOpenItem?: ((name: string) => void) | undefined;
}): React.JSX.Element {
  const { chips, setChips, scope, queryScope, scopeAccounts } = useScopedChips(accountIds, accounts);
  const [view, setView] = useState<'grouped' | 'tiles'>(() => (
    typeof localStorage !== 'undefined' && localStorage.getItem('cslytics.inventory.view') === 'tiles' ? 'tiles' : 'grouped'
  ));
  const [filtersOpen, setFiltersOpen] = useState(() => (
    typeof localStorage === 'undefined' || localStorage.getItem('cslytics.inventory.filters') !== 'collapsed'
  ));
  const [subject, setSubject] = useState<NamedItem | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [detail, setDetail] = useState<{ row: NamedItem; data: unknown; loading: boolean } | null>(null);
  const [expanded, setExpanded] = useState<NamedGroup | null>(null);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<StoragePageRow[]>([]);
  // Bumped when a unit's label or count may have changed, so the units are read again.
  const [unitsRevision, setUnitsRevision] = useState(0);
  const [price, setPrice] = useState('1.00');
  const [catalogueRevision, setCatalogueRevision] = useState<string | null>(null);
  // Read for the "Downloading item names…" caption only. The warning that the API cannot be
  // reached is a notification now (`features/notifications/producers/catalogue.ts`), raised
  // whichever tab is open rather than a band that only this panel could show.
  const [catalogueUnreachable, setCatalogueUnreachable] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [groupSort, setGroupSort] = useState<GroupSort>('name');
  const [groupDirection, setGroupDirection] = useState<SortDirection>('asc');
  const [tileSort, setTileSort] = useState<TileSort>('name');
  const [tileDirection, setTileDirection] = useState<SortDirection>('asc');
  // The inspected item is always one of the selection. The listing workspace, which the shell
  // holds (`useListingWorkspace` in `App.tsx`), takes rows out of the selection as it sends them,
  // so a subject it sent is let go of here rather than inspected on as if it were still chosen.
  useEffect(() => {
    if (subject && !(selectionKey(subject) in selection.rows)) setSubject(null);
  }, [selection.rows]);
  const work = useOpenWork(accountIds);
  const busyKeys = useMemo(() => busyKeysFromWork(work), [work]);
  const nameOf = useCallback((id: string): string => accounts.find((account) => account.id === id)?.name ?? id, [accounts]);
  const photoOf = useCallback((id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef, [accounts]);
  const resolved = chipsToFilter(chips);
  // Listed is not a place, but the select offers it beside the places, as a person asks it.
  const location = resolved.listed ? 'LISTED' : resolved.location ?? '';
  const tradableOnly = Boolean(resolved.tradableOnly);
  const filter: InventoryFilter & Record<string, unknown> = {
    ...resolved,
    ...(resolved.chips.length ? { chips: resolved.chips } : {})
  };
  const filterKey = JSON.stringify(filter);
  /**
   * The whole group summary, in name or count order.
   *
   * The engine pages groups by identity key, because it has no names to order them by. The summary
   * is bounded, and past its cap the engine refuses the scope rather than truncate it, so the window
   * reads every page and sorts here, which is what the summary exists for. The list is virtual, so
   * one long page costs no more on screen than a short one. A revision that moves mid-read starts
   * the read again, because pages from two revisions are not one summary.
   */
  const load = useCallback(async (): Promise<PageEnvelope<NamedGroup>> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows: NamedGroup[] = [];
      let head: Extract<PageEnvelope<NamedGroup>, { kind: 'page' }> | undefined;
      let cursor: string | undefined;
      let stale = false;
      do {
        const envelope = await window.trading.invoke({
          type: 'inventory.groups', accountIds: queryScope.split('\0'), filter: JSON.parse(filterKey), pageSize: 250, ...(cursor ? { cursor } : {})
        }) as PageEnvelope<NamedGroup> | { kind: 'needs-filter'; groups: number; cap: number };
        // A capped scope is reported, never truncated. Showing the first page of a list this large
        // would tell the user they had seen everything they own.
        if (envelope.kind === 'needs-filter') {
          throw new Error(`${envelope.groups.toLocaleString()} item types in this view, above the ${envelope.cap.toLocaleString()} this screen summarises at once. Narrow it with a search, a category or a location.`);
        }
        if (envelope.kind === 'stale-page') { stale = true; break; }
        head ??= envelope;
        rows.push(...envelope.rows);
        cursor = envelope.hasNext ? envelope.nextCursor ?? undefined : undefined;
      } while (cursor);
      if (stale || !head) continue;
      const sign = groupDirection === 'desc' ? -1 : 1;
      // Equal counts fall back to A to Z whichever way the counts run, so a tie reads as a list.
      rows.sort((left, right) => (groupSort === 'count' ? sign * (left.quantity - right.quantity) : 0)
        || (groupSort === 'count' ? 1 : sign) * compareNames(groupSortName(left), groupSortName(right))
        || left.accountId.localeCompare(right.accountId) || left.matchKey.localeCompare(right.matchKey));
      return { ...head, rows, nextCursor: null, hasNext: false };
    }
    return { kind: 'stale-page', reason: 'the inventory kept changing while its summary was read' };
  }, [queryScope, filterKey, catalogueRevision, groupSort, groupDirection]);
  const count = selectionQuantity(selection);
  const selectedByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of Object.values(selection.rows)) {
      const key = `${entry.row.accountId}:${entry.row.matchKey}`;
      map.set(key, (map.get(key) ?? 0) + entry.quantity);
    }
    return map;
  }, [selection]);

  // Names arrive after the first paint: the catalogue fetch is async and must not block the
  // window. Reload the grouped list once a revision lands, including the case where sync
  // finished before this tab subscribed.
  useEffect(() => {
    let cancelled = false;
    let found = false;
    const read = (): void => {
      void window.trading.invoke({ type: 'catalogue.status' }).then((raw) => {
        if (cancelled) return;
        const status = raw as { revision?: string | null; stale?: boolean };
        const revision = status.revision ?? null;
        const stale = Boolean(status.stale);
        setCatalogueUnreachable(stale);
        if (revision) {
          found = true;
          setCatalogueRevision((current) => (current === revision ? current : revision));
        } else if (stale) {
          found = true;
        }
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue')) read();
    });
    const timer = setInterval(() => { if (!found) read(); }, 2_000);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); };
  }, []);

  // Storage units for the scope, so a destination is picked from a list rather than typed, and so
  // typing a unit's name in the filter bar can narrow to what is inside it. The picker filters too.
  useEffect(() => {
    let current = true;
    void window.trading.invoke({ type: 'storage.page', accountIds: scope.split('\0'), pageSize: 250 })
      .then((envelope) => {
        const page = envelope as PageEnvelope<StoragePageRow>;
        if (current && page.kind === 'page') setUnits(page.rows);
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [scope, unitsRevision]);
  // A rename made here or in the game, and every store or retrieve, reach the window as a storage
  // read. The inspector shows a selected unit's label and how full it is, so both are kept current.
  useEffect(() => {
    const watched = ['gc-storage-units', 'gc-casket', 'gc-event'];
    const inScope = new Set(scope.split('\0'));
    return window.trading.subscribe((notice) => {
      if (!inScope.has(notice.accountId)) return;
      if (notice.surfaces.some((surface) => watched.includes(surface))) setUnitsRevision((n) => n + 1);
    });
  }, [scope]);
  // Until the new scope's units land, the old scope's must not be offered.
  const scopeUnits = useMemo(() => units.filter((unit) => scope.split('\0').includes(unit.accountId)), [units, scope]);

  // The list closes its group when the scope or filter changes: the group may no longer be in it.
  useEffect(() => { setExpanded(null); }, [queryScope, filterKey]);

  /**
   * Freeze everything these filters match as a selection the engine holds.
   *
   * Select all comes here on its own when the set is larger than this screen can tick. The engine
   * keeps the manifest and the inspector acts on it; the list does not try to paint it.
   */
  async function freezeMatching(applied: Record<string, unknown>): Promise<void> {
    const manifest = await window.trading.invoke({ type: 'selection.matching', accountIds: queryScope.split('\0'), filter: applied }) as SelectionSnapshot;
    onSelection({ rows: {}, manifest });
    setMessage({ tone: 'success', title: `${plural(manifest.counts.quantity, 'item')} selected`, detail: `That is more than the ${HIGHLIGHT_CAP.toLocaleString()} this screen can highlight, so the selection is held as a frozen set: a later inventory change will not silently add to it.` });
  }

  /**
   * Tick every handle the current filters match, so the list and the grid highlight them.
   *
   * With no filters applied that is everything in scope. Highlighting needs the rows themselves,
   * and only a bounded set of them, so above `HIGHLIGHT_CAP` the same filters are frozen as a
   * manifest instead (`freezeMatching`): the selection still holds every match, it just is not
   * painted row by row.
   */
  async function selectFiltered(extra?: Record<string, unknown>) {
    setSelecting(true);
    setMessage({ tone: 'info', title: 'Selecting…' });
    try {
      // Display items are never selected in bulk: nothing could be done to them, and a frozen
      // manifest is never painted, so the engine leaves them out too (`excludeDisplayOnly`).
      const applied = { ...filter, ...extra, excludeDisplayOnly: true };
      const collected: NamedItem[] = [];
      let cursor: string | undefined;
      let restarted = false;
      for (;;) {
        const envelope = await window.trading.invoke({
          type: 'inventory.page', accountIds: queryScope.split('\0'), filter: applied, pageSize: 250, ...(cursor ? { cursor } : {})
        }) as PageEnvelope<NamedItem>;
        if (envelope.kind === 'stale-page') {
          if (restarted) throw new Error('Inventory changed while selecting. Try again.');
          restarted = true;
          collected.length = 0;
          cursor = undefined;
          continue;
        }
        if (envelope.kind !== 'page') throw new Error('Could not read the items that match these filters.');
        const known = envelope.total.rows ?? envelope.total.handles;
        const overCap = (!cursor && envelope.hasNext && known > HIGHLIGHT_CAP)
          || collected.length + envelope.rows.length > HIGHLIGHT_CAP
          || (collected.length + envelope.rows.length >= HIGHLIGHT_CAP && envelope.hasNext);
        if (overCap) {
          await freezeMatching(applied);
          return;
        }
        collected.push(...envelope.rows.filter((row) => !isDisplayOnly(row)));
        if (!envelope.hasNext || !envelope.nextCursor) break;
        cursor = envelope.nextCursor;
      }
      if (collected.length === 0) {
        onSelection(emptyInventorySelection());
        setSubject(null);
        setMessage({ tone: 'info', title: 'Nothing to select', detail: 'Nothing matches these filters.' });
        return;
      }
      const next = withPage(collected);
      onSelection(next);
      setSubject(collected[0] ?? null);
      setMessage({ tone: 'success', title: `${plural(selectionQuantity(next), 'item')} selected` });
    } catch (error) {
      setMessage({ tone: 'error', title: 'Could not select', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setSelecting(false);
    }
  }

  const hasFilter = chips.length > 0;
  // One Select all, on the list's own header: it takes whatever the search and filters leave, and
  // everything in scope when nothing is applied.
  const selectAll = (
    <Button size="sm" icon="list-checks" loading={selecting} onClick={() => void selectFiltered()} title={hasFilter ? 'Selects every item that matches the current search and filters.' : 'Selects every item in view.'}>Select all</Button>
  );
  const settingsOn = Boolean(location || tradableOnly || (chips.find((chip) => chip.kind === 'item' && categoryIsCatalogue([chip]))));

  function toggleFilters(): void {
    const next = !filtersOpen;
    setFiltersOpen(next);
    localStorage.setItem('cslytics.inventory.filters', next ? 'open' : 'collapsed');
  }

  function openDetail(row: NamedItem): void {
    setDetail({ row, data: null, loading: true });
    void window.trading.invoke({ type: 'inventory.detail', accountId: row.accountId, id: row.localId })
      .then((data) => setDetail((current) => (current?.row.rowKey === row.rowKey ? { row, data, loading: false } : current)))
      .catch(() => setDetail((current) => (current?.row.rowKey === row.rowKey ? { row, data: null, loading: false } : current)));
  }

  const inspector = (
    <ItemInspector
      accountIds={accountIds}
      accounts={accounts}
      units={units}
      selection={selection}
      subject={subject}
      busyKeys={busyKeys}
      onOpenItem={onOpenItem}
      onMessage={setMessage}
      destinations={destinations}
      onDestinations={setDestinations}
      price={price}
      onPrice={setPrice}
      onSubmitted={() => { onSelection(emptyInventorySelection()); setSubject(null); }}
      onUnitRenamed={() => setUnitsRevision((n) => n + 1)}
      // Everything in the unit, so the unit's chip replaces whatever the bar held: a search that
      // already narrowed the view would hide some of what the unit holds. It is the chip the bar
      // offers for the unit's name (`ownedSuggestions`), and it filters by the casket id, so an
      // unnamed unit narrows as well.
      onShowUnit={(unit) => setChips([
        { kind: 'unit', text: unitName(unit), accountId: unit.accountId, casketId: unit.casketId }
      ])}
      onStage={(selected) => onStage?.(selected)}
      onDeselect={(key) => {
        const rows = { ...selection.rows };
        delete rows[key];
        onSelection({ rows });
        if (subject && selectionKey(subject) === key) {
          const remaining = Object.values(rows)[0]?.row as NamedItem | undefined;
          setSubject(remaining ?? null);
        }
      }}
    />
  );

  const filterRail = (
    <aside className="filter-panel" data-collapsed={filtersOpen ? undefined : 'true'} aria-label="Filters">
      <div className="filter-panel-head">
        <IconButton
          icon="filter"
          size="sm"
          label={filtersOpen ? 'Hide filters' : 'Show filters'}
          aria-expanded={filtersOpen}
          aria-controls={filtersOpen ? 'inventory-filter-settings' : undefined}
          data-active={settingsOn || undefined}
          className="filter-panel-toggle"
          onClick={toggleFilters}
        />
        {filtersOpen ? <span className="filter-panel-title">Filters</span> : null}
      </div>
      {filtersOpen ? (
        <div className="filter-panel-body" id="inventory-filter-settings">
          <Field label="Location">
            <Select label="Location" value={location} onChange={(next) => setChips((current) => {
              // A unit chip is a location too, so choosing another location replaces it.
              const without = current.filter((chip) => chip.kind !== 'where' && chip.kind !== 'unit');
              if (!next) return without;
              const text = next === 'MAIN' ? 'inventory' : next === 'CASKET' ? 'storage' : 'listed';
              return addChip(without, { kind: 'where', text });
            })}>
              <option value="">All locations</option>
              <option value="MAIN">In inventory</option>
              <option value="CASKET">In storage</option>
              <option value="LISTED">Listed on the market</option>
            </Select>
          </Field>
          <Field label="Category">
            <CategoryFilter value={chips.find((chip) => chip.kind === 'item')?.text && categoryIsCatalogue(chips) ? chips.find((chip) => chip.kind === 'item')!.text : ''} onChange={(next) => setChips((current) => {
              const without = current.filter((chip) => !(chip.kind === 'item' && categoryIsCatalogue([chip])));
              return next ? addChip(without, { kind: 'item', text: next }) : without;
            })} revision={catalogueRevision} />
          </Field>
          <Pill selected={tradableOnly} icon="unlock" onClick={() => setChips((current) => (
            tradableOnly ? current.filter((chip) => chip.kind !== 'tradable') : addChip(current, { kind: 'tradable', text: 'tradable' })
          ))}>Tradable only</Pill>
        </div>
      ) : null}
    </aside>
  );

  return <Panel className="enter">
    <PageHeader
      badge={selection.manifest ? <Badge tone="accent" icon="lock">Frozen selection</Badge> : null}
      actions={<>
        <Segmented
          label="Inventory view"
          value={view}
          options={[{ id: 'grouped', label: 'Grouped', icon: 'layers' }, { id: 'tiles', label: 'Tiles', icon: 'dashboard' }]}
          onChange={(next) => { setView(next); localStorage.setItem('cslytics.inventory.view', next); }}
        />
        <Button size="sm" variant="ghost" icon="x" disabled={count === 0} onClick={() => { onSelection(emptyInventorySelection()); setSubject(null); setMessage(null); }}>Clear selection</Button>
      </>}
    />
    {message ? (
      <div className="panel-body tight">
        <Notice tone={message.tone} role="status" title={message.title} action={<IconButton icon="x" size="sm" label="Dismiss" onClick={() => setMessage(null)} />}>{message.detail}</Notice>
      </div>
    ) : null}
    <InspectorSplit
      layout={view}
      railState={filtersOpen ? 'open' : 'collapsed'}
      inspector={selectionOnly ? null : inspector}
      rail={filterRail}
    >
      <div className="toolbar page-controls">
        <FilterBar chips={chips} onChange={setChips} accounts={scopeAccounts} units={scopeUnits} holdingsOf={queryScope.split('\0')} />
        {view === 'tiles'
          ? <SortControl label="Sort items by" options={TILE_SORTS} value={tileSort} direction={tileDirection} onSort={setTileSort} onDirection={setTileDirection} />
          : <SortControl label="Sort item groups by" options={GROUP_SORTS} value={groupSort} direction={groupDirection} onSort={setGroupSort} onDirection={setGroupDirection} />}
        {catalogueRevision || catalogueUnreachable ? null : <span className="quiet">Downloading item names…</span>}
        {hasFilter ? <Button size="sm" variant="ghost" icon="filter" onClick={() => setChips([])}>Reset filters</Button> : null}
      </div>
      {view === 'tiles' ? (
        <InventoryTiles
          accountIds={queryScope.split('\0')}
          accounts={accounts}
          filter={filter}
          selection={selection}
          onSelection={onSelection}
          subject={subject}
          onSubject={setSubject}
          onDetail={openDetail}
          units={units}
          busyKeys={busyKeys}
          multiAccount={accountIds.length > 1}
          sort={tileSort}
          direction={tileDirection}
          namesRevision={catalogueRevision}
          header={selectAll}
        />
      ) : (
        <PagedRows
          infinite
          header={selectAll}
          load={load}
          rowKey={r => `${r.accountId}:${r.matchKey}`}
          expandedKey={expanded ? `${expanded.accountId}:${expanded.matchKey}` : undefined}
          emptyTitle={hasFilter ? 'Nothing matches these filters' : 'No items observed yet'}
          emptyHint={hasFilter ? 'Try a broader search, or reset the filters.' : 'Items appear once the account has a CS2 Game Coordinator session and its inventory has been read.'}
          render={group => {
            const open = expanded?.accountId === group.accountId && expanded.matchKey === group.matchKey;
            const selectedQty = selectedByGroup.get(`${group.accountId}:${group.matchKey}`) ?? 0;
            // Every unit an account holds is one group, and its rows name each unit on its own.
            const groupName = isStorageUnit(group) ? unitGroupName(group.quantity) : group.name;
            // A display item keeps its place and its counts, but offers nothing to select.
            const display = isDisplayOnly(group);
            return (
              <GroupBlock
                name={groupName}
                imageUrl={group.imageUrl}
                rarity={group.rarity}
                unresolved={group.unresolved}
                open={open}
                selected={selectedQty > 0}
                onToggle={() => setExpanded(open ? null : group)}
                meta={<>
                  <span className="inline"><Avatar name={nameOf(group.accountId)} size={14} photo={photoOf(group.accountId)} />{nameOf(group.accountId)}</span>
                  <span className="sep">·</span>
                  <span>{group.quantity.toLocaleString()} total</span>
                  {group.main ? <><span className="sep">·</span><span>{group.main.toLocaleString()} in inventory</span></> : null}
                  {group.storage ? <><span className="sep">·</span><span>{group.storage.toLocaleString()} stored</span></> : null}
                  {group.listed ? <><span className="sep">·</span><span>{group.listed.toLocaleString()} listed</span></> : null}
                  {group.rarity ? <><span className="sep">·</span><span>{group.rarity.name}</span></> : null}
                  {group.collection ? <><span className="sep">·</span><span>{group.collection.name}</span></> : null}
                  {display ? <><span className="sep">·</span><span className="inline" title={DISPLAY_ONLY_CAPTION}><Icon name="lock" size={11} />{DISPLAY_ONLY_LABEL}</span></> : null}
                </>}
                counts={<>
                  <span className="count-chip" title="Total quantity in this group"><Icon name="layers" size={11} />{group.quantity.toLocaleString()}</span>
                  {selectedQty > 0 ? <span className="count-chip" data-tone="accent" title="Selected in this group">{selectedQty.toLocaleString()} selected</span> : null}
                </>}
                actions={display ? undefined : <Button size="sm" variant="subtle" icon="list-checks" disabled={selecting} aria-label={`Select all ${groupName}`} onClick={(event) => { event.stopPropagation(); void selectFiltered({ matchKeys: [group.matchKey] }); }}>Select all</Button>}
              >
                <GroupItems
                  key={`${group.accountId}:${group.matchKey}`}
                  group={group}
                  filter={filter}
                  selection={selection}
                  onSelection={onSelection}
                  subject={subject}
                  onSubject={setSubject}
                  onDetail={openDetail}
                  units={units}
                />
              </GroupBlock>
            );
          }}
        />
      )}
    </InspectorSplit>

    <Drawer
      open={detail !== null}
      icon="package"
      title={detail ? itemName(detail.row, units) : ''}
      subtitle={detail ? `${nameOf(detail.row.accountId)} · ${locationLabel(detail.row.location).label}` : undefined}
      onClose={() => setDetail(null)}
    >
      {detail ? (
        <>
          <div className="drawer-hero">
            <Thumbnail url={detail.row.imageUrl} name={detail.row.name} size={72} />
            <div className="drawer-hero-text">
              <div className="drawer-hero-name">{itemName(detail.row, units)}</div>
              <div className="drawer-hero-meta">
                {detail.row.rarity ? <span style={{ color: detail.row.rarity.colour }}>{detail.row.rarity.name}</span> : null}
                {detail.row.rarity && detail.row.collection ? ' · ' : ''}
                {detail.row.collection?.name ?? ''}
              </div>
              {detail.row.paintWear !== null ? <div style={{ marginTop: 8 }}><WearRange min={detail.row.paintWear} max={detail.row.paintWear} wide /></div> : null}
            </div>
          </div>
          {detail.loading ? <Empty icon="loader" title="Reading the item…" /> : <DetailView data={detail.data ?? detail.row} />}
        </>
      ) : null}
    </Drawer>
  </Panel>;
}

/**
 * The categories the catalogue actually holds.
 *
 * Offering a hard-coded list means offering filters that match nothing, which reads as an empty
 * inventory rather than as a dead option.
 */
function CategoryFilter({ value, onChange, revision }: { value: string; onChange: (next: string) => void; revision: string | null }): React.JSX.Element {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    void window.trading.invoke({ type: 'catalogue.status' })
      .then((status) => setOptions((status as { categories?: string[] })?.categories ?? []))
      .catch(() => setOptions([]));
  }, [revision]);
  return <Select label="Category" value={value} onChange={onChange}>
    <option value="">All categories</option>
    {options.map(c => <option key={c}>{c}</option>)}
  </Select>;
}

function categoryIsCatalogue(chips: readonly FilterChip[]): boolean {
  return chips.some((chip) => chip.kind === 'item' && !/[|]/.test(chip.text));
}

/**
 * The handles behind one group.
 *
 * Filtered by `matchKey`, which is the same predicate the engine indexes on — expanding a group is
 * an indexed lookup, not a scan, however large the account.
 */
function GroupItems({ group, filter, selection, onSelection, subject, onSubject, onDetail, units }: {
  group: NamedGroup;
  filter: Record<string, unknown>;
  selection: InventorySelection;
  onSelection: (next: InventorySelection) => void;
  subject: NamedItem | null;
  onSubject: (row: NamedItem | null) => void;
  onDetail: (row: NamedItem) => void;
  /** So each storage unit in the group is called by its own name. */
  units: readonly StoragePageRow[];
}): React.JSX.Element {
  const scopeKey = `${group.accountId}:${group.matchKey}:${JSON.stringify(filter)}`;
  const load = useCallback(async (cursor?: string) => await window.trading.invoke({
    type: 'inventory.page', accountIds: [group.accountId],
    filter: { ...filter, matchKeys: [group.matchKey] }, ...(cursor ? { cursor } : {})
  }) as PageEnvelope<NamedItem>, [scopeKey]);
  const select = (row: NamedItem, quantity: number) => {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > row.quantity) return;
    const rows = { ...selection.rows };
    const key = `${row.accountId}:${row.rowKey}`;
    if (quantity) rows[key] = { row, quantity }; else delete rows[key];
    onSelection({ rows });
    onSubject(quantity ? row : subject?.rowKey === row.rowKey && subject.accountId === row.accountId ? null : subject);
  };
  return <PagedRows nested infinite viewportCap={220} load={load} rowKey={r => `${r.accountId}:${r.rowKey}`} emptyTitle="No copies match the current filters" render={row => {
    const quantity = selection.rows[`${row.accountId}:${row.rowKey}`]?.quantity ?? 0;
    const where = locationLabel(row.location);
    const locked = row.tradableAfter !== null && new Date(row.tradableAfter) > new Date();
    const focused = subject?.accountId === row.accountId && subject.rowKey === row.rowKey;
    const name = itemName(row, units);
    // A display item opens in the inspector to be read, and has no box to tick or count to pick.
    const display = isDisplayOnly(row);
    return <div className="inventory-data-row" data-selected={quantity > 0} data-focused={focused}>
      {display
        ? <span className="caption" title={DISPLAY_ONLY_CAPTION} style={{ width: 17, flex: 'none', display: 'grid', placeItems: 'center' }}><Icon name="lock" size={12} /></span>
        : <Check label={`Select ${row.localId}`} checked={quantity > 0} onChange={() => select(row, quantity ? 0 : 1)} />}
      <button className="group-expand" aria-label={`Inspect ${name}`} onClick={() => { if (quantity === 0) select(row, 1); else onSubject(row); }}>
        <span className="group-name">{name}</span>
        <span className="group-meta">
          <Badge tone={where.tone === 'accent' ? 'accent' : 'quiet'} icon={where.icon}>{where.label}</Badge>
          {display ? <span title={DISPLAY_ONLY_CAPTION}>{DISPLAY_ONLY_LABEL}</span> : null}
          {row.paintWear !== null ? <WearRange min={row.paintWear} max={row.paintWear} /> : null}
          {row.paintSeed !== null ? <span>pattern {row.paintSeed}</span> : null}
          {locked ? <span className="caption" data-tone="warn"><Icon name="lock" size={11} /> trade locked</span> : null}
        </span>
      </button>
      <IconButton icon="eye" size="sm" label={`Show details for ${name}`} onClick={() => onDetail(row)} />
    </div>;
  }} />;
}
