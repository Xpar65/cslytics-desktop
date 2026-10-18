import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { StorePurchasePage, StorePurchaseView } from '@cslytics/engine';
import { engine, type EnrichedStoreSheet } from '../../lib/engine.js';
import { formatAmount } from '../../lib/money.js';
import { Panel, PanelHeader } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import type { AccountHoldings } from '../../lib/types.js';

/**
 * The CS2 in-game store for one account: what the Game Coordinator will sell it, at the
 * prices the GC quoted in the account's own wallet currency, and every purchase this app has
 * asked for with the state Steam's evidence has reached.
 *
 * One click is the instruction (OP-01). Buy freezes the selected entries and quantities at the
 * shown prices; the checkout that follows is Valve's own page in a window this app opens, and
 * the purchase completes only when the items are observed in the inventory (STORE-05, STORE-06).
 */

const STATE_LABEL: Record<StorePurchaseView['state'], string> = {
  ADMITTED: 'Admitted, sending to Steam',
  INITIALISING: 'Sending to Steam',
  AWAITING_APPROVAL: 'Approve in the Steam checkout window',
  FINALISING: 'Approved, asking Steam to deliver',
  AWAITING_OBSERVATION: 'Waiting for the inventory to show it',
  COMPLETED: 'Delivered',
  REJECTED: 'Refused',
  CANCELLING: 'Cancelling',
  CANCELLED: 'Cancelled',
  UNRESOLVED: 'Needs attention'
};

const CANCELLABLE: ReadonlySet<StorePurchaseView['state']> = new Set(['ADMITTED', 'AWAITING_APPROVAL', 'AWAITING_OBSERVATION', 'UNRESOLVED']);

export function StoreView({ accountId }: { accountId: string }): React.JSX.Element {
  const [sheet, setSheet] = useState<EnrichedStoreSheet | null>(null);
  const [purchases, setPurchases] = useState<StorePurchasePage | null>(null);
  const [holdings, setHoldings] = useState<AccountHoldings | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const command = useRef(crypto.randomUUID());
  const ticket = useRef(0);

  useEffect(() => {
    const request = ++ticket.current;
    void Promise.all([engine.storeSheet(accountId), engine.storePurchases(accountId), engine.readPortfolio([accountId])])
      .then(([sheetView, page, portfolio]) => {
        if (ticket.current !== request) return;
        setSheet(sheetView);
        setPurchases(page.stalePage ? null : page);
        setHoldings(portfolio.find((row) => row.accountId === accountId) ?? null);
      })
      .catch((error) => { if (ticket.current === request) setMessage(String(error)); });
    return () => { ticket.current++; };
  }, [accountId, revision]);
  useEffect(() => { const timer = setInterval(() => setRevision((n) => n + 1), 5_000); return () => clearInterval(timer); }, []);

  const resetCommand = useCallback(() => { command.current = crypto.randomUUID(); }, []);
  async function run(work: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true); setMessage('');
    try { await work(); setMessage(success); setRevision((n) => n + 1); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  const currency = sheet?.currency ?? holdings?.currency ?? null;
  const selected = (sheet?.entries ?? []).filter((entry) => (quantities[entry.entryKey] ?? 0) > 0);
  const total = selected.reduce((sum, entry) => sum + (entry.salePriceCents ?? entry.priceCents) * (quantities[entry.entryKey] ?? 0), 0);
  const available = holdings?.availableToCommitCents ?? null;
  const sheetUsable = sheet !== null && sheet.parseState === 'PARSED' && sheet.observationComplete;

  return <div className="stack" data-testid="store-screen">
    <PageHeader subtitle="What the CS2 Game Coordinator sells this account, at its own quoted prices. Approval happens on Steam's checkout page; delivery is proven by the inventory." />
    <Panel>
      <div className="toolbar page-controls">
        <button className="btn" disabled={busy} onClick={() => void run(() => engine.storeRefresh(accountId), 'Price sheet read from the Game Coordinator')}>Refresh price sheet</button>
        <span data-testid="store-sheet-status">
          {sheet ? `Sheet version ${sheet.version} · ${sheet.currencyLabel} · observed ${new Date(sheet.observedAt).toLocaleString()}${sheet.parseState === 'UNPARSEABLE' ? ' · could not be parsed; showing the last parsed sheet' : ''}` : 'No price sheet has been read for this account'}
        </span>
      </div>
      <p data-testid="store-wallet">
        {holdings?.wallet
          ? `Available to commit: ${available === null ? 'unknown' : formatAmount(available, holdings.currency)} · wallet observed ${new Date(holdings.wallet.observedAt).toLocaleString()}`
          : 'Wallet not observed yet'}
      </p>
      {message ? <p role="status">{message}</p> : null}
      {sheet?.entries.length ? <div className="stack" data-testid="store-entries">
        {sheet.entries.map((entry) => {
          const price = entry.salePriceCents ?? entry.priceCents;
          return <div className="inventory-data-row" key={entry.entryKey}>
            {entry.imageUrl ? <img src={entry.imageUrl} alt="" width={48} height={36} /> : null}
            <span>{entry.name}<br /><small>{formatAmount(price, currency)}{entry.salePriceCents !== null ? ` (was ${formatAmount(entry.priceCents, currency)})` : ''}{entry.reason ? ` · ${entry.reason}` : ''}</small></span>
            <label>Qty <input className="input" type="number" min={0} max={100} step={1} inputMode="numeric" aria-label={`Quantity of ${entry.name}`}
              value={quantities[entry.entryKey] ?? 0} disabled={busy || !entry.purchasable}
              onChange={(event) => { const next = Math.max(0, Math.min(100, Math.floor(Number(event.target.value) || 0))); setQuantities((current) => ({ ...current, [entry.entryKey]: next })); resetCommand(); }} /></label>
          </div>;
        })}
      </div> : <p>{sheet ? 'The sheet has no entries priced in this wallet currency.' : 'Refresh the price sheet to see what the store offers.'}</p>}
      <div className="toolbar page-controls">
        <span data-testid="store-total">Total: {formatAmount(total, currency)}{available !== null && total > available ? ' · exceeds the available balance' : ''}</span>
        <button className="btn" data-testid="store-buy" disabled={busy || !sheetUsable || selected.length === 0 || total <= 0 || (available !== null && total > available)}
          onClick={() => void run(async () => {
            await engine.storeBuy({ commandId: command.current, accountId, lines: selected.map((entry) => ({ entryKey: entry.entryKey, quantity: quantities[entry.entryKey] ?? 0, unitPriceCents: entry.salePriceCents ?? entry.priceCents })) });
            setQuantities({}); resetCommand();
          }, 'Purchase submitted. Approve it in the Steam checkout window when it opens; progress shows what Steam has confirmed.')}>
          Buy {selected.length || ''} {selected.length === 1 ? 'entry' : 'entries'}
        </button>
      </div>
    </Panel>
    <Panel>
      <PanelHeader title="Purchases" subtitle="Every purchase this app has asked Steam for, with the evidence it has reached." />
      {purchases?.rows.length ? purchases.rows.map((row) => <div className="inventory-data-row" key={row.id} data-testid="store-purchase" data-state={row.state}>
        <span>{STATE_LABEL[row.state]}<br />
          <small>{row.lines.map((line) => `${line.quantity} × ${line.entryKey}${line.observedQuantity ? ` (${line.observedQuantity} seen)` : ''}`).join(', ')} · {formatAmount(row.requestedTotalCents, row.currency)} · {new Date(row.createdAt).toLocaleString()}</small>
          {row.txnId ? <><br /><small>Transaction {row.txnId}</small></> : null}
          {row.error ? <><br /><small role="alert">{row.error}</small></> : null}</span>
        {CANCELLABLE.has(row.state) ? <button className="btn" disabled={busy} onClick={() => void run(() => engine.storeCancel(accountId, row.id), 'Cancel sent; the reserved funds return once the wallet and inventory have been observed')}>Cancel</button> : null}
        {row.state === 'AWAITING_APPROVAL' || row.state === 'UNRESOLVED' ? <button className="btn" disabled={busy} onClick={() => void run(() => engine.storeContinue(accountId, row.id), 'Continuing the purchase')}>Continue</button> : null}
      </div>) : <p>No purchases yet.</p>}
    </Panel>
  </div>;
}
