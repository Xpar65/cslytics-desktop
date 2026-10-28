import React, { useState } from 'react';
import type { StoragePageRow } from '@cslytics/engine';
import { CopyButton } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { qualityLabel } from '../../lib/format.js';
import { formatDateTime, locationLabel } from '../../lib/labels.js';
import type { NamedItem } from './InventoryTiles.js';

/** One line of the fold. `copy: false` is for a yes or no, which nobody pastes anywhere. */
type Fact = { label: string; value: string; mono?: boolean; copy?: boolean };

/**
 * The holding's own facts, folded until asked for, each with a copy button.
 *
 * The panel above already says what the item is called, how worn it is and where it sits. This is
 * what someone pastes somewhere else: the market name a price site searches by, the float in full
 * rather than to five places, the pattern, the asset id, whose it is, and the keys the game uses.
 *
 * It lays out as label, value and copy in a row where there is room, and stacks the label over the
 * value in a roster card where there is not.
 */
export function ItemMoreDetails({ row, accounts, units }: {
  row: NamedItem;
  accounts: ReadonlyArray<{ id: string; name: string; steamId64?: string | null | undefined }>;
  units: readonly StoragePageRow[];
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const owner = accounts.find((account) => account.id === row.accountId);
  const unit = row.casketId ? units.find((entry) => entry.accountId === row.accountId && entry.casketId === row.casketId) : undefined;
  const quality = qualityLabel(row.quality);

  const item: Fact[] = [];
  if (row.marketHashName) item.push({ label: 'Market name', value: row.marketHashName });
  if (row.paintWear !== null) item.push({ label: 'Float', value: String(row.paintWear), mono: true });
  if (row.paintSeed !== null) item.push({ label: 'Pattern', value: String(row.paintSeed), mono: true });
  if (row.assetId) item.push({ label: 'Asset ID', value: row.assetId, mono: true });

  const where: Fact[] = [];
  if (owner) where.push({ label: 'Account', value: owner.name });
  if (owner?.steamId64) where.push({ label: 'Steam ID', value: owner.steamId64, mono: true });
  where.push({ label: 'Location', value: locationLabel(row.location).label });
  if (row.casketId) {
    if (unit?.label) where.push({ label: 'Storage unit', value: unit.label });
    where.push({ label: 'Storage unit ID', value: row.casketId, mono: true });
  }
  if (row.tradableAfter) where.push({ label: 'Tradable after', value: formatDateTime(row.tradableAfter) });
  if (row.tradeProtectedUntil) where.push({ label: 'Trade protected until', value: formatDateTime(row.tradeProtectedUntil) });
  where.push({
    label: 'Marketable',
    value: row.marketable === null || row.marketable === undefined ? 'Unknown' : row.marketable ? 'Yes' : 'No',
    copy: false
  });

  const game: Fact[] = [
    { label: 'Def index', value: String(row.defIndex), mono: true },
    ...(row.paintIndex !== null ? [{ label: 'Paint index', value: String(row.paintIndex), mono: true }] : []),
    { label: 'Quality', value: quality ? `${quality} (${row.quality})` : String(row.quality), mono: quality === null },
    { label: 'Identity key', value: row.matchKey || '—', mono: true }
  ];

  const everything = [...item, ...where, ...game].map((fact) => `${fact.label}: ${fact.value}`).join('\n');

  return (
    <details className="technical item-facts" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><Icon name="chevron-right" size={13} /> Show more details</summary>
      {open ? (
        <div className="item-facts-body">
          <div className="item-facts-tools">
            <CopyButton value={everything} label="Copy all details" />
          </div>
          <FactGroup title="Item" facts={item} />
          <FactGroup title="Ownership" facts={where} />
          <FactGroup title="Game data" facts={game} />
        </div>
      ) : null}
    </details>
  );
}

function FactGroup({ title, facts }: { title: string; facts: readonly Fact[] }): React.JSX.Element | null {
  if (facts.length === 0) return null;
  return (
    <section className="item-facts-group" aria-label={title}>
      <h4>{title}</h4>
      <dl>
        {facts.map((fact) => (
          <div className="fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              <span className={fact.mono ? 'fact-value fact-mono' : 'fact-value'}>{fact.value}</span>
              {fact.copy === false ? null : <CopyButton value={fact.value} label={`Copy ${fact.label.toLowerCase()}`} />}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
