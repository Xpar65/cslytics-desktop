import React, { useCallback, useState } from 'react';
import type { PageEnvelope } from '@cslytics/engine';
import { PagedRows } from '../../components/PagedRows.js';
import { DetailView, Drawer, IconButton, Panel, SearchInput, Select, StatusBadge } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { formatCents, formatObservedAmount } from '../../lib/format.js';
import { HISTORY_EVENT, LEDGER_KIND, ORDER_SIDE, ORDER_STATE, TRADE_STATUS, formatDateTime, formatRelative, humanize, plural, stateLabel, type StateLabel } from '../../lib/labels.js';

type Domain = 'orders' | 'history' | 'trades' | 'ledger';
type Row = {
  accountId: string;
  orderId?: string;
  sourceKey?: string;
  rowId?: string;
  offerId?: string | null;
  listingId?: string | null;
  state?: string;
  status?: string;
  kind?: string;
  side?: string;
  occurredAt?: string;
  openedAt?: string;
  settledAt?: string | null;
  eventType?: number;
  priceReceiveCents?: number | null;
  amountCents?: number | null;
  feeCents?: number | null;
  quantity?: number;
  lines?: number;
  amountBasis?: 'EVIDENCED' | 'UNKNOWN';
  attribution?: string;
  currency?: number | null;
  counterparty?: string;
};

const META: Record<Domain, { title: string; icon: IconName; subtitle: string; command: 'orders.page' | 'history.page' | 'trades.page' | 'ledger.page'; detail: 'orders.detail' | 'history.detail' | 'trades.detail' | 'ledger.detail'; empty: string }> = {
  orders: { title: 'Orders', icon: 'receipt', subtitle: 'Every order this app has placed or seen. Amounts that were never observed stay unknown.', command: 'orders.page', detail: 'orders.detail', empty: 'Orders appear once a listing or a buy order has been placed or observed.' },
  history: { title: 'Trading history', icon: 'history', subtitle: 'Market events exactly as Steam reported them, newest first.', command: 'history.page', detail: 'history.detail', empty: 'History fills in as the market walk reads events from Steam.' },
  trades: { title: 'Trades', icon: 'arrow-left-right', subtitle: 'Trade offers and executed trades. An accepted offer is not a delivery until both inventories show it.', command: 'trades.page', detail: 'trades.detail', empty: 'Trade offers appear once an account has been read.' },
  ledger: { title: 'Ledger', icon: 'book', subtitle: 'Observed economic events. An amount that was never evidenced is shown as unknown, never as zero.', command: 'ledger.page', detail: 'ledger.detail', empty: 'The ledger fills in as sales, purchases and trades are observed.' }
};

const ORDER_FILTER = ['ACTIVE', 'PENDING_CONFIRMATION', 'UNEXPLAINED', 'CLOSED'];
const LEDGER_FILTER = ['MARKET_SALE', 'BUY_ORDER_FILL', 'EXTERNAL_PURCHASE', 'TRADE_RECEIPT', 'TRADE_DISPOSAL', 'UNEXPLAINED_MOVEMENT', 'CORRECTION'];
const TRADE_FILTER = ['ACTIVE', 'ACCEPTED', 'ESCROW', 'COMPLETE', 'CANCELLED', 'DECLINED', 'EXPIRED', 'INVALID_ITEMS', 'FAILED', 'UNKNOWN', 'ROLLED_BACK'];

function rowId(row: Row): string {
  return row.orderId ?? row.sourceKey ?? row.rowId ?? '';
}

function describe(domain: Domain, row: Row): { icon: IconName; title: string; sub: string; state: StateLabel | null; amount: string; reference: string } {
  const when = row.occurredAt ?? row.openedAt;
  const date = when ? `${formatDateTime(when)} · ${formatRelative(when)}` : '';
  if (domain === 'orders') {
    const state = stateLabel(ORDER_STATE, row.state);
    return { icon: row.side === 'BUY' ? 'shopping-cart' : 'tag', title: ORDER_SIDE[row.side ?? ''] ?? humanize(row.side ?? 'Order'), sub: date, state,
      amount: row.priceReceiveCents === undefined || row.priceReceiveCents === null ? 'Amount unknown' : `${formatCents(row.priceReceiveCents, row.currency ?? null)} to receive`,
      reference: row.orderId ? `Order #${row.orderId}` : '' };
  }
  if (domain === 'history') {
    const event = row.eventType !== undefined ? HISTORY_EVENT[row.eventType] ?? { label: `Event ${row.eventType}`, tone: 'neutral' as const } : null;
    return { icon: event?.icon ?? 'history', title: event?.label ?? 'Market event', sub: date, state: null,
      amount: row.amountCents === null || row.amountCents === undefined ? '' : formatCents(row.amountCents, row.currency ?? null),
      reference: row.listingId ? `Listing #${row.listingId}` : '' };
  }
  if (domain === 'trades') {
    const state = stateLabel(TRADE_STATUS, row.status);
    const offer = row.kind === 'offer';
    return { icon: offer ? 'send' : 'arrow-left-right', title: offer ? 'Trade offer' : 'Executed trade',
      sub: `${row.counterparty ? `with Steam ID ${row.counterparty} · ` : ''}${plural(row.lines ?? 0, 'item')} · ${date}`, state,
      amount: '', reference: row.offerId ? `Offer #${row.offerId}` : '' };
  }
  const kind = stateLabel(LEDGER_KIND, row.kind);
  return { icon: kind.icon ?? 'book', title: kind.label, sub: `${row.quantity ? `${plural(row.quantity, 'item')} · ` : ''}${date}`, state: null,
    amount: formatObservedAmount(row.amountCents, row.amountBasis, row.currency ?? null),
    reference: row.attribution ? humanize(row.attribution) : '' };
}

/**
 * The four record books, one component.
 *
 * Every row is what the engine observed, labelled in words; the raw record behind it opens in a
 * drawer with its identifiers folded under "Technical details". Filters are the engine's own
 * states, offered by name rather than by code.
 */
export function RecordsView({ domain, accountIds, accounts = [] }: { domain: Domain; accountIds: string[]; accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined }): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [detail, setDetail] = useState<{ row: Row; data: unknown; loading: boolean } | null>(null);
  const scope = accountIds.join('\0');
  const meta = META[domain];
  const nameOf = (id: string): string => accounts.find((account) => account.id === id)?.name ?? id;
  const photoOf = (id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef;
  const load = useCallback(async (cursor?: string) => await window.trading.invoke({
    type: meta.command,
    accountIds: scope.split('\0'),
    filter: { ...(search ? { search } : {}), ...(state ? { state } : {}) },
    ...(cursor ? { cursor } : {})
  }) as PageEnvelope<Row>, [meta.command, scope, search, state]);

  const open = (row: Row): void => {
    setDetail({ row, data: null, loading: true });
    void window.trading.invoke({ type: meta.detail, accountId: row.accountId, id: rowId(row) })
      .then((data) => setDetail((current) => (current && rowId(current.row) === rowId(row) ? { row, data, loading: false } : current)))
      .catch(() => setDetail((current) => (current && rowId(current.row) === rowId(row) ? { row, data: null, loading: false } : current)));
  };

  const filterTable = domain === 'orders' ? ORDER_STATE : domain === 'ledger' ? LEDGER_KIND : TRADE_STATUS;
  const filterOptions = domain === 'orders' ? ORDER_FILTER : domain === 'ledger' ? LEDGER_FILTER : domain === 'trades' ? TRADE_FILTER : [];
  const filterLabel = domain === 'orders' ? 'Order state' : domain === 'ledger' ? 'Ledger kind' : 'Trade status';

  return <Panel className="enter">
    <PageHeader subtitle={meta.subtitle} />
    <div className="toolbar page-controls">
      <SearchInput label="Find record" placeholder="Find by order, event, trade or listing number" value={search} onChange={setSearch} width={360} />
      {filterOptions.length > 0 ? (
        <Select label={filterLabel} value={state} onChange={setState}>
          <option value="">{domain === 'ledger' ? 'All kinds' : domain === 'orders' ? 'All states' : 'All statuses'}</option>
          {filterOptions.map((code) => <option key={code} value={code}>{stateLabel(filterTable, code).label}</option>)}
        </Select>
      ) : null}
    </div>
    <PagedRows load={load} rowKey={r => `${r.accountId}:${rowId(r)}`} emptyTitle={`No ${meta.title.toLowerCase()} yet`} emptyHint={meta.empty} render={row => {
      const shown = describe(domain, row);
      return (
        <div className="record-data-row group-row" onClick={() => open(row)}>
          <span className="timeline-icon"><Icon name={shown.icon} size={14} /></span>
          <span className="group-expand" style={{ cursor: 'pointer' }}>
            <span className="group-name">{shown.title}{shown.reference ? <span className="quiet" style={{ fontWeight: 400 }}> · {shown.reference}</span> : null}</span>
            <span className="group-meta">
              {accountIds.length > 1 ? <span className="inline"><Avatar name={nameOf(row.accountId)} size={14} photo={photoOf(row.accountId)} />{nameOf(row.accountId)}</span> : null}
              <span>{shown.sub}</span>
            </span>
          </span>
          {shown.state ? <StatusBadge label={shown.state.label} tone={shown.state.tone} icon={shown.state.icon} /> : null}
          {shown.amount ? <span className="num" style={{ minWidth: 120, textAlign: 'right', color: shown.amount === 'Amount unknown' ? 'var(--cs-text-faint)' : 'var(--cs-text)' }}>{shown.amount}</span> : null}
          <IconButton icon="chevron-right" size="sm" label={`Open ${shown.title}`} onClick={(event) => { event.stopPropagation(); open(row); }} />
        </div>
      );
    }} />
    <Drawer
      open={detail !== null}
      icon={meta.icon}
      title={detail ? describe(domain, detail.row).title : ''}
      subtitle={detail ? `${nameOf(detail.row.accountId)}${describe(domain, detail.row).reference ? ` · ${describe(domain, detail.row).reference}` : ''}` : undefined}
      onClose={() => setDetail(null)}
    >
      {detail?.loading ? <div className="empty"><span className="spinner"><Icon name="loader" size={18} /></span></div> : <DetailView data={detail?.data ?? detail?.row} />}
    </Drawer>
  </Panel>;
}
