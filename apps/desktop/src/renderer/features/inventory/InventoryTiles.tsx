import React, { useCallback, useRef, useState } from 'react';
import type { InventoryPageRow, PageEnvelope, StoragePageRow } from '@cslytics/engine';
import { PagedGrid } from '../../components/PagedGrid.js';
import { ItemTile, TileAccountBadge, TileBadge, TileWear } from '../../components/ItemTile.js';
import { Icon } from '../../components/Icon.js';
import { lockLabel } from '../../lib/labels.js';
import { itemIsBusy } from '../work/work-busy.js';
import { lockOf } from './item-actions.js';
import { unitName, unitOfItem } from './storage-unit.js';
import { DISPLAY_ONLY_CAPTION, isDisplayOnly } from './display-only.js';
import { isSelected, pressTile, selectionKey, type InventorySelection } from './selection.js';

/** An inventory row after the host has attached what the catalogue knows. */
export type NamedItem = InventoryPageRow & {
  name: string;
  marketHashName: string | null;
  category: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  collection: { id: string; name: string } | null;
  imageUrl: string | null;
  unresolved: string | null;
  minFloat: number | null;
  maxFloat: number | null;
  /** Whether CSFloat trades this kind, from its own catalogue; `null` before one is fetched. */
  csfloatSupport?: 'supported' | 'unsupported' | null;
  /** The catalogue's `marketable` for the kind; `false` is a display item (`display-only.ts`). */
  catalogueMarketable?: boolean | null;
};

/**
 * One tile per item, the way the Steam inventory page shows it: forty cases are forty tiles.
 *
 * A tile is a view of the same handle the list shows, so a selection made here is the same
 * selection object — switching views keeps it. Everything a tile displays is either identity the
 * engine gave or a name the host attached; nothing is computed from a price or a guess.
 *
 * The tile itself is `ItemTile`, which Listings draws too. What is here is what only inventory
 * has: the selection model, the locks, and where the item is.
 */
export function InventoryTiles({ accountIds, accounts, filter, selection, onSelection, subject, onSubject, onDetail, units, busyKeys, multiAccount, sort, direction, namesRevision, header }: {
  accountIds: readonly string[];
  accounts: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }>;
  filter: Record<string, unknown>;
  selection: InventorySelection;
  onSelection: (next: InventorySelection) => void;
  subject: NamedItem | null;
  onSubject: (row: NamedItem | null) => void;
  onDetail: (row: NamedItem) => void;
  units: readonly StoragePageRow[];
  /** `accountId:handle` for every item some open command names. Its actions are withheld. */
  busyKeys: ReadonlySet<string>;
  multiAccount: boolean;
  /**
   * The order to page in. A name order is main's to work out from the catalogue: the engine is
   * handed identity keys in that order and never a name.
   */
  sort: 'name' | 'float' | 'seen';
  direction: 'asc' | 'desc';
  /** The catalogue revision. A name order is only as current as the names it was worked out from. */
  namesRevision: string | null;
  /** Shown on the right of the count strip above the grid. */
  header?: React.ReactNode | undefined;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<NamedItem[]>([]);
  const anchor = useRef<string | null>(null);
  const scope = accountIds.join('\0');
  const filterKey = JSON.stringify(filter);

  const load = useCallback(async (cursor?: string) => await window.trading.invoke({
    type: 'inventory.page',
    accountIds: scope.split('\0'),
    filter: JSON.parse(filterKey),
    sort,
    direction,
    ...(cursor ? { cursor } : {})
    // `namesRevision` is not read, only watched: new names can reorder a name-sorted walk.
  }) as PageEnvelope<NamedItem>, [scope, filterKey, sort, direction, namesRevision]);

  const nameOf = (id: string): string => accounts.find((account) => account.id === id)?.name ?? id;
  const photoOf = (id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef;
  const unitLabel = (row: NamedItem): string => {
    const unit = units.find((entry) => entry.accountId === row.accountId && entry.casketId === row.casketId);
    return unit?.label ?? (row.casketId ? `Unit ${row.casketId}` : 'a storage unit');
  };

  /**
   * A press selects that tile alone and makes it the inspector's subject; Ctrl, or the tile's
   * check, adds or removes it without moving the subject; Shift selects the range within the
   * loaded rows (`pressTile`). Taking the subject out of the selection moves the inspector to what is
   * still selected, so it never goes on describing an item that is not.
   */
  function press(row: NamedItem, event: React.MouseEvent | React.KeyboardEvent, check: boolean): void {
    const toggle = check || event.ctrlKey || event.metaKey;
    const result = pressTile(selection, loaded, row, anchor.current, { toggle, range: event.shiftKey });
    anchor.current = result.anchor;
    onSelection(result.selection);
    if (isSelected(result.selection, row)) {
      if (!toggle || event.shiftKey) onSubject(row);
    } else if (subject && selectionKey(subject) === selectionKey(row)) {
      onSubject((Object.values(result.selection.rows)[0]?.row as NamedItem | undefined) ?? null);
    }
  }

  return <PagedGrid<NamedItem>
    load={load}
    onRows={setLoaded}
    header={header}
    rowKey={(row) => selectionKey(row)}
    emptyTitle="Nothing matches these filters"
    emptyHint="Try a broader search, or reset the filters."
    render={(row, index) => {
      const selected = isSelected(selection, row);
      const focused = subject?.accountId === row.accountId && subject.rowKey === row.rowKey;
      const busy = itemIsBusy(busyKeys, row);
      const lock = lockOf(row, new Date());
      // A storage unit is told apart by its own name; what it is goes on the quieter line under it.
      const unit = unitOfItem(row, units);
      // A display item still opens in the inspector, but has no box to tick into a batch.
      const display = isDisplayOnly(row);
      return (
        <ItemTile
          name={unit ? unitName(unit) : row.name}
          imageUrl={row.imageUrl}
          rarity={row.rarity}
          selected={selected}
          focused={focused}
          tabbable={focused || (subject === null && index === 0)}
          busy={busy}
          unresolved={row.unresolved}
          onActivate={(event) => press(row, event, false)}
          onCheck={display ? undefined : (event) => press(row, event, true)}
          onOpen={() => onSubject(row)}
          onDismiss={() => onSubject(null)}
          onDetail={() => onDetail(row)}
          badges={<>
            {display ? <TileBadge corner="lock" title={DISPLAY_ONLY_CAPTION}><Icon name="lock" size={11} /></TileBadge>
              : lock ? <TileBadge corner="lock" lock={lock.kind} title={lockLabel(lock.kind, lock.until)}><Icon name="lock" size={11} /></TileBadge> : null}
            {row.location === 'CASKET' ? <TileBadge corner="where" title={`In ${unitLabel(row)}`}><Icon name="archive" size={11} /></TileBadge> : null}
            {row.steamListed ? <TileBadge corner="where" title="Listed on the Steam Community Market"><Icon name="tag" size={11} /></TileBadge> : null}
            {multiAccount ? <TileAccountBadge name={nameOf(row.accountId)} photo={photoOf(row.accountId)} /> : null}
          </>}
          sub={unit ? <span>{row.name}</span> : <TileWear paintWear={row.paintWear} />}
        />
      );
    }}
  />;
}
