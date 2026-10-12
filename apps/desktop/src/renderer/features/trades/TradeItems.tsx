import React, { useCallback, useState } from 'react';
import type { PageEnvelope, TradeSide } from '@cslytics/engine';
import { PagedGrid } from '../../components/PagedGrid.js';
import { PagedRows } from '../../components/PagedRows.js';
import { ItemTile, TileBadge, TileWear } from '../../components/ItemTile.js';
import { GroupBlock, WearRange } from '../../components/GroupBlock.js';
import { Badge, Caption, Empty, SectionTitle } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { compareNames } from '../../../shared/name-order.js';
import { plural } from '../../lib/labels.js';
import { emptySideText, sideHeading, type NamedTradeEntry, type NamedTradeGroup, type NamedTradeItem, type TradeItemView } from './trade-state.js';

/** The key an item line is the inspector's subject by. */
export function itemKey(row: Pick<NamedTradeItem, 'accountId' | 'lineKey'>): string {
  return `${row.accountId}:${row.lineKey}`;
}

/**
 * What moved in one trade, a section per side, as tiles or as groups.
 *
 * The same two views as Inventory and built from the same pieces — `ItemTile` in a `PagedGrid`,
 * `GroupBlock` opening onto its copies — because a skin that came in a trade should look exactly
 * as it does in the inventory it came into. What is different is what a press means: there is one
 * subject and no selection, because nothing here can be acted on. A tile has no check, and a
 * modifier key is ignored rather than extending anything.
 */
export function TradeItems({ entry, view, subject, onSubject, revision, peer }: {
  entry: NamedTradeEntry;
  view: TradeItemView;
  subject: NamedTradeItem | null;
  onSubject: (row: NamedTradeItem | null) => void;
  revision: number;
  /** The owned account on the other side, which an empty side names as where the items go. */
  peer: string | null;
}): React.JSX.Element {
  if (entry.giveQuantity + entry.receiveQuantity === 0) {
    return <Empty icon="package" title="No items recorded for this trade" hint="Steam's offer and history reads named no items in it." />;
  }
  // Both sides, always. A side with nothing on it says so: a sale that takes nothing back, a
  // purchase that gives nothing, a transfer between the person's own accounts — the empty side is
  // half of what the trade was, and leaving it out reads as a side not loaded yet.
  return (
    <div className="trade-items">
      {(['GIVE', 'RECEIVE'] as const).map((side) => {
        const quantity = side === 'GIVE' ? entry.giveQuantity : entry.receiveQuantity;
        const heading = sideHeading(side, entry);
        return (
          <section className="trade-side" key={side} aria-label={heading} data-empty={quantity === 0 || undefined}>
            <SectionTitle icon={side === 'GIVE' ? 'arrow-up-right' : 'arrow-down-left'}>
              {heading} · {quantity === 0 ? 'nothing' : plural(quantity, 'item')}
            </SectionTitle>
            {quantity === 0 ? (
              <div className="trade-side-empty" data-testid={`trade-${side === 'GIVE' ? 'give' : 'receive'}-nothing`}>
                <Icon name="minus" size={14} />
                <span>{emptySideText(side, entry, peer)}</span>
              </div>
            ) : view === 'tiles'
              ? <SideTiles entry={entry} side={side} subject={subject} onSubject={onSubject} revision={revision} />
              : <SideGroups entry={entry} side={side} subject={subject} onSubject={onSubject} revision={revision} />}
          </section>
        );
      })}
    </div>
  );
}

function useSideLoad(entry: NamedTradeEntry, side: TradeSide, revision: number, groupKey?: string) {
  return useCallback(async (cursor?: string) => await window.trading.invoke({
    type: 'trades.items', accountId: entry.accountId, entryKey: entry.canonicalKey, side,
    ...(groupKey === undefined ? {} : { groupKey }), ...(cursor ? { cursor } : {})
  }) as PageEnvelope<NamedTradeItem>, [entry.accountId, entry.canonicalKey, side, groupKey, revision]);
}

function SideTiles({ entry, side, subject, onSubject, revision }: {
  entry: NamedTradeEntry; side: TradeSide; subject: NamedTradeItem | null; onSubject: (row: NamedTradeItem | null) => void; revision: number;
}): React.JSX.Element {
  const load = useSideLoad(entry, side, revision);
  const subjectKey = subject ? itemKey(subject) : null;
  return <PagedGrid<NamedTradeItem>
    fit
    noun="items"
    load={load}
    rowKey={itemKey}
    emptyTitle="No items on this side"
    render={(row, index) => {
      const focused = subjectKey === itemKey(row);
      return (
        <ItemTile
          name={row.name}
          imageUrl={row.imageUrl}
          rarity={row.rarity}
          selected={focused}
          focused={focused}
          tabbable={focused || (subjectKey === null && index === 0)}
          unresolved={row.unresolved}
          onActivate={() => onSubject(focused ? null : row)}
          onDismiss={() => onSubject(null)}
          badges={<>
            {row.missing === 1 ? <TileBadge corner="lock" title="Steam said this item was no longer in the giver's inventory"><Icon name="alert-circle" size={11} /></TileBadge> : null}
            {row.csfloatTradeId ? <TileBadge corner="where" title="Part of a CSFloat trade"><VenueMark venue="csfloat" size={12} decorative /></TileBadge> : null}
          </>}
          sub={row.quantity > 1 ? <span className="tile-state">× {row.quantity.toLocaleString()}</span> : <TileWear paintWear={row.paintWear} />}
        />
      );
    }}
  />;
}

function SideGroups({ entry, side, subject, onSubject, revision }: {
  entry: NamedTradeEntry; side: TradeSide; subject: NamedTradeItem | null; onSubject: (row: NamedTradeItem | null) => void; revision: number;
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const groups = entry.groups.filter((group) => group.side === side).sort((left, right) => compareNames(left.name, right.name));
  return (
    <div className="trade-groups">
      {groups.map((group) => {
        const isOpen = open === group.groupKey;
        return (
          <GroupBlock
            key={group.groupKey}
            name={group.name}
            imageUrl={group.imageUrl}
            rarity={group.rarity}
            unresolved={group.unresolved}
            open={isOpen}
            selected={subject?.side === side && subject.groupKey === group.groupKey}
            meta={<GroupMeta group={group} />}
            counts={<span className="count-chip" title="Items in this group"><Icon name="layers" size={11} />{group.quantity.toLocaleString()}</span>}
            onToggle={() => setOpen(isOpen ? null : group.groupKey)}
          >
            <GroupItems entry={entry} side={side} groupKey={group.groupKey} subject={subject} onSubject={onSubject} revision={revision} />
          </GroupBlock>
        );
      })}
      {entry.groupsTruncated ? <Caption icon="info">This trade holds more kinds of item than one list shows. Tiles lists every one.</Caption> : null}
    </div>
  );
}

function GroupMeta({ group }: { group: NamedTradeGroup }): React.JSX.Element {
  return <>
    <span>{plural(group.quantity, 'item')}</span>
    {group.minWear !== null ? <><span className="sep">·</span><WearRange min={group.minWear} max={group.maxWear} /></> : null}
    {group.rarity ? <><span className="sep">·</span><span>{group.rarity.name}</span></> : null}
    {group.collection ? <><span className="sep">·</span><span>{group.collection.name}</span></> : null}
    {group.missing ? <><span className="sep">·</span><span className="caption" data-tone="warn">no longer with the giver</span></> : null}
  </>;
}

/** The copies behind one group, read only once it is opened, by the group key the engine issued. */
function GroupItems({ entry, side, groupKey, subject, onSubject, revision }: {
  entry: NamedTradeEntry; side: TradeSide; groupKey: string; subject: NamedTradeItem | null; onSubject: (row: NamedTradeItem | null) => void; revision: number;
}): React.JSX.Element {
  const load = useSideLoad(entry, side, revision, groupKey);
  return <PagedRows<NamedTradeItem> nested infinite viewportCap={220} load={load} rowKey={itemKey} emptyTitle="No copies recorded" render={(row) => {
    const focused = subject !== null && itemKey(subject) === itemKey(row);
    return (
      <div className="inventory-data-row" data-focused={focused} data-selected={focused}>
        <button className="group-expand" aria-label={`Inspect ${row.name}`} onClick={() => onSubject(focused ? null : row)}>
          <span className="group-name">{row.quantity > 1 ? `${row.name} × ${row.quantity.toLocaleString()}` : row.name}</span>
          <span className="group-meta">
            {row.paintWear !== null ? <WearRange min={row.paintWear} max={row.paintWear} /> : null}
            {row.paintSeed !== null ? <span>pattern {row.paintSeed}</span> : null}
            {row.missing === 1 ? <Badge tone="warn" icon="alert-circle">No longer with the giver</Badge> : null}
            {row.csfloatTradeId ? <Badge tone="quiet"><VenueMark venue="csfloat" size={11} decorative /> CSFloat</Badge> : null}
          </span>
        </button>
      </div>
    );
  }} />;
}
