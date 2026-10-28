import React, { useEffect, useRef, useState } from 'react';
import type { TradeFlowFilter, TradeOriginClass, TradeStage, TradeSummary } from '@cslytics/engine';
import { Button, Empty, Notice, Panel, Segmented, Select } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import { InspectorSplit } from '../../components/InspectorSplit.js';
import { TradeList } from './TradeList.js';
import { TradeHeader } from './TradeHeader.js';
import { TradeItems } from './TradeItems.js';
import { TradeItemInspector } from './TradeItemInspector.js';
import {
  KIND_ORDER,
  STAGE_ORDER,
  TRADE_FLOW,
  TRADE_ORIGIN_CLASS,
  TRADE_STAGE,
  defaultItemView,
  tradeKey,
  tradeQuantity,
  type NamedTradeEntry,
  type NamedTradeItem,
  type NamedTradeRow,
  type TradeItemView
} from './trade-state.js';

type AccountName = { id: string; name: string; avatarRef?: string | null | undefined; steamId64?: string | null | undefined };

/**
 * The walks whose rows this page is made of. A notice from one re-reads the open trade, the counts
 * and the list's first page; `gc-inventory` is here because an own transfer finishes on an inventory
 * walk, and `catalogue` because names arrive after the first paint.
 */
const WATCHED = ['steam-trade-offers', 'steam-trade-history', 'csfloat-trades', 'gc-inventory'];

type Selected = { accountId: string; entryKey: string };
type Loaded = { key: string; entry: NamedTradeEntry | null; error: string | null };
type Where = { stage?: TradeStage | null; origin?: TradeOriginClass | null; flow?: TradeFlowFilter | null };

/** A choice in a filter's list, with how many trades it would leave once the counts are in. */
function optionText(label: string, count: number | undefined): string {
  return count === undefined ? label : `${label} (${count.toLocaleString()})`;
}

/**
 * Trades: the filters across the top, every account's trades on the left, the one chosen beside it,
 * and — only once an item in it is clicked — that item on the right.
 *
 * One list, newest first, so what is still moving sits at the top on its own. The filters are laid out
 * as Listings lays out its own: the one most reached for as a segmented control — which way the items
 * went, Sent or Received — and the rest as lists — the kind, a marketplace sale or purchase, a transfer
 * between the person's accounts or anything else, and the stage, to be confirmed, the reversal period,
 * finalized, reversed or didn't go through. A list offers only what the scope holds, with its count,
 * so no choice in it can find nothing. The engine filters before it pages, so a filtered list is still
 * a full page and its count is the list's.
 *
 * It reads the local trading record only — the engine's walks keep it current on their own schedule —
 * and a page at a time, and a trade's items only once it is opened. Items open in tiles, or grouped
 * for a trade of more than fifteen; a toggle holds only for the trade it was made on.
 */
export function TradesView({ accountIds, accounts }: { accountIds: string[]; accounts: readonly AccountName[] }): React.JSX.Element {
  const [stage, setStage] = useState<TradeStage | null>(null);
  const [origin, setOrigin] = useState<TradeOriginClass | null>(null);
  const [flow, setFlow] = useState<TradeFlowFilter | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [override, setOverride] = useState<{ key: string; view: TradeItemView } | null>(null);
  const [subject, setSubject] = useState<NamedTradeItem | null>(null);
  const [revision, setRevision] = useState(0);
  const scope = accountIds.join('\0');
  const selectedKey = selected ? tradeKey(selected) : null;
  const selectedRef = useRef(selectedKey);
  selectedRef.current = selectedKey;

  useEffect(() => {
    const inScope = new Set(scope.split('\0'));
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue') || (inScope.has(notice.accountId) && notice.surfaces.some((surface) => WATCHED.includes(surface)))) {
        setRevision((current) => current + 1);
      }
    });
  }, [scope]);

  useEffect(() => {
    let live = true;
    void window.trading.invoke({ type: 'trades.summary', accountIds: scope.split('\0') })
      .then((answer) => { if (live) setSummary(answer as TradeSummary); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [scope, revision]);

  useEffect(() => {
    if (!selected) { setLoaded(null); return undefined; }
    const key = tradeKey(selected);
    let live = true;
    void window.trading.invoke({ type: 'trades.entry', accountId: selected.accountId, entryKey: selected.entryKey })
      .then((answer) => { if (live) setLoaded({ key, entry: (answer as NamedTradeEntry | null) ?? null, error: null }); })
      .catch((reason: unknown) => { if (live) setLoaded((current) => ({ key, entry: current?.key === key ? current.entry : null, error: reason instanceof Error ? reason.message : String(reason) })); });
    return () => { live = false; };
  }, [selectedKey, revision]);

  function select(row: Pick<NamedTradeRow, 'accountId' | 'entryKey'>): void {
    if (tradeKey(row) === selectedRef.current) return;
    setSelected({ accountId: row.accountId, entryKey: row.entryKey });
    setSubject(null);
  }

  /**
   * A filter changed is the list being read again: an open item is put down, and the list, folded
   * beside it on a narrow window, unfolds to show what the filter left.
   */
  function filter(next: Where): void {
    if (next.stage !== undefined) setStage(next.stage);
    if (next.origin !== undefined) setOrigin(next.origin);
    if (next.flow !== undefined) setFlow(next.flow);
    setSubject(null);
  }

  /** How many entries a filter would leave, with the other filters as they are. A swap is Sent and Received both. */
  const count = (where: Where): number | undefined => {
    if (!summary) return undefined;
    return summary.counts
      .filter((row) => (!where.stage || row.stage === where.stage)
        && (!where.origin || row.origin === where.origin)
        && (!where.flow || row.flow === where.flow || row.flow === 'both'))
      .reduce((sum, row) => sum + row.count, 0);
  };
  // Only what the scope holds is offered — and whatever is chosen, so a choice never vanishes under itself.
  const offered = <T extends string>(all: readonly T[], chosen: T | null, counted: (each: T) => number | undefined): T[] =>
    all.filter((each) => each === chosen || (counted(each) ?? 1) > 0);
  const kinds = offered(KIND_ORDER, origin, (each) => count({ stage, origin: each, flow }));
  const stages = offered(STAGE_ORDER, stage, (each) => count({ stage: each, origin, flow }));

  const entry = loaded && loaded.key === selectedKey ? loaded.entry : null;
  const view: TradeItemView = override && override.key === selectedKey ? override.view : defaultItemView(entry ? tradeQuantity(entry) : 0);
  // A subject the re-read trade no longer holds is not left on screen describing nothing.
  const liveSubject = subject && entry && subject.accountId === entry.accountId ? subject : null;
  const nameOf = (id: string | null): string | null => (id === null ? null : accounts.find((account) => account.id === id)?.name ?? id);
  const filtered = Boolean(stage || origin || flow);

  return <Panel className="enter trades-page">
    <PageHeader
      actions={entry ? (
        <Segmented
          label="Item view"
          value={view}
          options={[{ id: 'grouped', label: 'Grouped', icon: 'layers' }, { id: 'tiles', label: 'Tiles', icon: 'dashboard' }]}
          onChange={(next) => { if (selectedKey) setOverride({ key: selectedKey, view: next }); }}
        />
      ) : null}
    />
    <div className="toolbar page-controls trades-toolbar">
      <Segmented
        label="Direction"
        value={flow ?? ''}
        onChange={(next) => filter({ flow: next === '' ? null : next })}
        options={[
          { id: '' as const, label: 'All' },
          { id: 'out' as const, label: TRADE_FLOW.out!.label, icon: TRADE_FLOW.out!.icon, count: count({ stage, origin, flow: 'out' }) },
          { id: 'in' as const, label: TRADE_FLOW.in!.label, icon: TRADE_FLOW.in!.icon, count: count({ stage, origin, flow: 'in' }) }
        ]}
      />
      <Select label="Kind" value={origin ?? ''} onChange={(next) => filter({ origin: next === '' ? null : next as TradeOriginClass })}>
        <option value="">All kinds</option>
        {kinds.map((each) => <option key={each} value={each}>{optionText(TRADE_ORIGIN_CLASS[each].label, count({ stage, origin: each, flow }))}</option>)}
      </Select>
      <Select label="State" value={stage ?? ''} onChange={(next) => filter({ stage: next === '' ? null : next as TradeStage })}>
        <option value="">All states</option>
        {stages.map((each) => <option key={each} value={each}>{optionText(TRADE_STAGE[each].label, count({ stage: each, origin, flow }))}</option>)}
      </Select>
      {filtered ? <Button size="sm" variant="ghost" icon="filter" onClick={() => filter({ stage: null, origin: null, flow: null })}>Reset filters</Button> : null}
    </div>
    <div className="trades-split">
      <InspectorSplit
        layout="trades"
        railWidth="wide"
        rail={(
          <TradeList
            accountIds={accountIds}
            accounts={accounts}
            stage={stage}
            origin={origin}
            flow={flow}
            selectedKey={selectedKey}
            onSelect={select}
            onFirstRows={(rows) => { if (!selectedRef.current && rows[0]) select(rows[0]); }}
            revision={revision}
          />
        )}
        // Only an item that was clicked gets the column; with none, the trade has the width.
        inspector={liveSubject && entry
          ? <TradeItemInspector item={liveSubject} entry={entry} accounts={accounts} multiAccount={accountIds.length > 1} onClose={() => setSubject(null)} />
          : null}
      >
        {loaded?.error && loaded.key === selectedKey ? <Notice tone="warn" role="alert" title="This trade could not be read">{loaded.error}</Notice> : null}
        {!selected ? (
          <Empty icon="arrow-left-right" title="No trade selected" />
        ) : !entry ? (
          loaded && loaded.key === selectedKey
            ? (loaded.error ? null : <Empty icon="inbox" title="That trade is no longer recorded" />)
            : <Empty icon="loader" title="Reading the trade…" />
        ) : (
          <div className="trade-main" key={selectedKey ?? ''}>
            <TradeHeader entry={entry} accounts={accounts} multiAccount={accountIds.length > 1} />
            <TradeItems entry={entry} view={view} subject={liveSubject} onSubject={setSubject} revision={revision} peer={nameOf(entry.peerAccountId)} />
          </div>
        )}
      </InspectorSplit>
    </div>
  </Panel>;
}
