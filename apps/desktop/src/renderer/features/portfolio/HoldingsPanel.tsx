import React, { useMemo } from 'react';
import type { AccountHoldings } from '../../lib/types.js';
import {
  aggregate,
  freshness,
  holdingsSegments,
  quantity,
  share,
  totalHoldingsCents,
  type Freshness,
  type HoldingsSegment
} from '../../lib/portfolio.js';
import { currencyCodeOf, formatAmount } from '../../lib/money.js';
import { plural } from '../../lib/labels.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Tip } from '../../components/Tip.js';
import { Empty, Notice, Panel, Skeleton, Spinner } from '../../components/ui.js';
import { fillLabel, pricingProgress } from './fill-label.js';
import { MoneyFigures, type Figure } from './money-figures.js';
import type { ValuationState } from './use-valuation.js';

/**
 * The first thing on the portfolio page: one "Total holdings" figure and the bar under it. The bar
 * is every wallet, each venue in its own hue with its pending part hatched, and the inventory at
 * the Steam mid price. Neither listings nor buy orders are segments: a listed item stays a holding
 * until it sells and is inside the appraisal already (N-SELL-06), and a buy order is inside the
 * Steam wallet; either would count the same cents twice. Both keep their cards below.
 *
 * Every figure is main's, in the base (plan §5.2); a currency with no rate is left out, named, and
 * makes the figure a floor rather than a smaller total (plan §5.4). When nothing converts and
 * nothing is in the base, the wallets are printed side by side and no bar is drawn, because its
 * parts have no common width.
 *
 * No total is shown until every held kind has been asked for a price (`valued`). A figure over
 * half the books is a floor, and a floor that keeps moving as books arrive reads as a total that
 * cannot make up its mind. Until then the figure's place says what the fill has left to do.
 *
 * What a figure means is in a tip on it, not in a sentence under it. What changes how far a figure
 * can be trusted — an unfinished walk, a missing rate, a paused fill — is a chip under the figure,
 * because a reader must not have to go looking for that.
 */

export function HoldingsPanel({
  holdings,
  scope,
  state,
  now = new Date()
}: {
  holdings: readonly AccountHoldings[];
  /** `null` = every signed-in account. Otherwise the one account being shown. */
  scope: string | null;
  state: ValuationState;
  now?: Date;
}): React.JSX.Element {
  const { valuation: answer, loading, error } = state;
  const totals = useMemo(() => aggregate(holdings), [holdings]);
  const only = scope === null ? null : holdings.find((row) => row.accountId === scope) ?? null;

  if (holdings.length === 0) {
    return (
      <Panel>
        <Empty icon="wallet" title="Nothing observed yet" hint="Figures appear once an account has been connected and read." />
      </Panel>
    );
  }

  const valued = answer !== null && answer.valued;
  const base = answer?.base ?? null;
  const wallets = answer?.observedInBase.wallets ?? null;
  // The bar's one currency is the base, once the wallets have a figure in it.
  const barCurrency = wallets !== null && wallets.cents !== null ? base : null;
  const inventory = valued ? answer.valuation?.marketValue ?? null : null;
  const inventoryCents = inventory?.cents ?? null;
  const bar = answer && barCurrency !== null ? holdingsSegments(answer.observedInBase, inventoryCents) : [];
  const barTotal = totalHoldingsCents(bar);
  const foreign = answer !== null && answer.observed.some((group) => group.currency !== answer.base && group.wallets.cents !== 0);
  const estimate = inventoryCents !== null || foreign;
  // What could not join the figure for want of a rate, observed and appraised alike.
  const missing = answer === null ? [] : [...new Set([...answer.observedInBase.wallets.missingCurrencies, ...(inventory?.missingCurrencies ?? [])])].sort();
  const walletView = answer ? quantity(answer, 'wallets') : null;

  const headline: Figure[] | null = !valued || answer === null ? null
    : barCurrency === null
      ? (walletView?.main ?? []).map((amount) => ({ code: currencyCodeOf(amount.currency), text: formatAmount(amount.cents, amount.currency) }))
      : [{ code: currencyCodeOf(barCurrency), text: `${estimate ? '≈ ' : ''}${formatAmount((wallets?.cents ?? 0) + (inventoryCents ?? 0), barCurrency)}` }];

  // Under a converted headline, each part as its venue named it: the wallets by currency, then the
  // items by the currency their books were read in.
  const natives = barCurrency !== null && valued && answer !== null && (foreign || missing.length > 0)
    ? [
      { label: 'Wallets', parts: answer.observed.filter((group) => group.wallets.cents !== 0)
        .map((group) => `${formatAmount(group.wallets.cents, group.currency)}${group.currency !== answer.base && group.wallets.converted === null ? ' (no rate)' : ''}`) },
      { label: 'Items', parts: (inventory?.subtotals ?? [])
        .map((row) => `≈ ${formatAmount(row.cents, row.currency)}${row.currency !== answer.base && row.converted === null ? ' (no rate)' : ''}`) }
    ].filter((group) => group.parts.length > 0).map((group) => `${group.label} ${group.parts.join(' + ')}`)
    : [];

  const unpriced = valued ? answer.valuation?.units.unpriced ?? 0 : 0;
  const readFailed = answer?.valuation?.unpricedUnitsByReason['read-failed'] ?? 0;
  const complete = valued && missing.length === 0 && readFailed === 0;
  const stoppedAt = answer?.status.stoppedUntil ? new Date(answer.status.stoppedUntil).toLocaleTimeString() : 'later';
  const inventoryLeftOut = answer === null || !valued || inventoryCents !== null ? null
    : answer.valuation === null && answer.needsFilter
      ? { chip: 'Inventory not valued', tip: `More than ${answer.needsFilter.cap.toLocaleString()} kinds in this scope. Open one account at a time to value its inventory.` }
      : barCurrency === null
        ? { chip: 'Inventory left out', tip: `There is no exchange rate for ${answer.observedInBase.wallets.missingCurrencies.join(', ') || 'these wallets'} yet, so nothing can be added in one currency.` }
        : { chip: 'Inventory left out', tip: 'Nothing in it could be priced yet.' };

  const oldest = answer?.valuation?.oldestObservedAt ? freshness(answer.valuation.oldestObservedAt, now) : null;

  return (
    <Panel className="enter">
      <div className="panel-body holdings-hero">
        <div className="holdings-head">
          <div className="holdings-main">
            <div className="holdings-label">
              {only ? `${only.accountName}'s holdings` : 'Total holdings'}
              <Tip label="What total holdings counts" content={
                <>
                  Every wallet, spendable and pending, plus every item at the midpoint of Steam&apos;s lowest ask and highest bid.
                  A listed item is counted once, as an item; buy orders are inside the Steam wallet already.
                  {base ? ` Shown in ${base}; other currencies are converted at CSlytics's daily rate, and Steam converts at its own.` : ''}
                </>
              } />
            </div>
            <div
              className="holdings-total num"
              data-testid="portfolio-value"
              data-settled={totals.market.settled}
              data-valued={valued}
              data-complete={complete}
              data-missing={missing.join(',') || undefined}
              data-converted={foreign ? true : undefined}
            >
              {headline === null
                ? <span className="holdings-pricing" role="status" aria-label="Pricing"><Skeleton width={240} height={40} /></span>
                : <MoneyFigures figures={headline} inline />}
            </div>
            {natives.length > 0 ? (
              <div className="holdings-natives num" data-testid="holdings-natives">
                <Tip wide content={<>{(walletView?.notes ?? []).map((note) => <span key={note} className="tip-line">{note}</span>)}{walletView?.notes.length ? null : 'Each part as its venue named it.'}</>}>
                  {natives.join(' · ')}
                </Tip>
              </div>
            ) : null}
            {error ? <Notice tone="error" role="status">{error}</Notice> : null}
            {!valued && !error ? (
              <div className="holdings-caption" data-testid="holdings-pricing">
                <Spinner size={13} label="Pricing" /> {answer === null ? 'Reading…' : pricingProgress(answer)}
              </div>
            ) : null}
            {valued ? (
              <div className="holdings-chips" data-testid="portfolio-value-basis">
                {!totals.market.settled ? (
                  <Chip tone="warn" icon="alert-circle" tip="The last market walk did not finish, so some listings or the wallet may be missing: the figure is at least this much.">
                    At least this much
                  </Chip>
                ) : null}
                {missing.length > 0 ? (
                  <Chip tone="warn" icon="alert-circle" tip={`There is no exchange rate for ${missing.join(', ')} yet. That money is left out of the figure and shown beneath it, so the figure is a floor, not a total.`}>
                    Floor · no rate for {missing.join(', ')}
                  </Chip>
                ) : null}
                {inventoryLeftOut ? <Chip tone="warn" icon="info" tip={inventoryLeftOut.tip}>{inventoryLeftOut.chip}</Chip> : null}
                {answer.fill === 'stopped' ? (
                  <Chip tone="warn" icon="pause" tip="Steam asked this machine to slow down. The figures are the last prices read.">Prices paused until {stoppedAt}</Chip>
                ) : null}
                {unpriced > 0 ? (
                  <Chip icon="info" tip="An item with no price is left out, never counted as zero. The Priced card below says why each is unpriced.">
                    {plural(unpriced, 'item')} unpriced
                  </Chip>
                ) : null}
                {totals.market.settled && missing.length === 0 && !inventoryLeftOut && answer.fill !== 'stopped' && unpriced === 0 ? (
                  <Chip icon="check-circle" tip="Every wallet was read by a complete walk, and every item has a price.">Every figure read</Chip>
                ) : null}
              </div>
            ) : answer !== null && answer.fill === 'stopped' ? (
              <Notice tone="warn" role="status">Steam asked this machine to slow down; prices resume at {stoppedAt}.</Notice>
            ) : null}
          </div>

          <dl className="holdings-evidence">
            <Evidence icon="activity" label="Prices" testId="portfolio-fill" state={answer?.fill ?? 'idle'} valued={valued}
              value={answer === null ? (loading ? 'reading' : 'none yet') : answer.fill === 'complete' && oldest ? oldest.label : shortFill(answer.fill, answer.status)}
              tone={oldest?.tone ?? 'none'}
              tip={answer === null ? 'No prices read yet.' : `${fillLabel(answer)}.${oldest ? ` The oldest price was read ${oldest.label}.` : ''}`} />
            <Evidence icon="store" label="Market" age={freshness(totals.market.observedAt, now)} partial={!totals.market.settled}
              tip="The last walk of the Steam market: wallet, listings and buy orders." />
            <Evidence icon="package" label="Inventory" age={freshness(totals.inventory.observedAt, now)} partial={!totals.inventory.settled}
              tip="The last read of the inventory and storage units." />
            {totals.csfloat.accounts > 0 ? (
              <Evidence icon="wallet" label="CSFloat" age={freshness(totals.csfloat.observedAt, now)} partial={false}
                tip="The last read of the CSFloat balance." />
            ) : null}
          </dl>
        </div>

        {barCurrency === null ? null : <AllocationBar segments={bar} total={barTotal} currency={barCurrency} pricing={!valued} />}

        {barCurrency === null ? null : (
          <div className="holdings-legend">
            {bar.filter((segment) => segment.cents > 0).map((segment) => (
              <span key={segment.key} className="holdings-legend-item" data-segment={segment.key}>
                <SegmentDot segment={segment} />
                {segment.label}
                <span className="num">{segment.key === 'inventory' || foreign ? '≈ ' : ''}{formatAmount(segment.cents, barCurrency)}</span>
              </span>
            ))}
            {!valued ? (
              <span className="holdings-legend-item" data-segment="inventory">
                <span className="allocation-dot skeleton" aria-hidden="true" />
                Inventory
                <span className="quiet">pricing…</span>
              </span>
            ) : null}
            {barTotal === 0 && valued ? <span className="holdings-legend-item quiet">Nothing held yet</span> : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** What the fill is doing, in the few characters a chip has. The tip says it in full. */
function shortFill(fill: string, status: { fillDone: number; fillTotal: number }): string {
  switch (fill) {
    case 'filling': return status.fillTotal > 0 ? `${status.fillDone.toLocaleString()} / ${status.fillTotal.toLocaleString()}` : 'reading';
    case 'stopped': return 'paused by Steam';
    case 'slowed': return 'slowed';
    case 'paused': return 'paused';
    case 'complete': return 'read';
    default: return 'idle';
  }
}

function Evidence({ icon, label, tip, age, partial, value, tone, testId, state, valued }: {
  icon: IconName;
  label: string;
  tip: string;
  age?: Freshness | undefined;
  partial?: boolean | undefined;
  value?: string | undefined;
  tone?: Freshness['tone'] | undefined;
  testId?: string | undefined;
  state?: string | undefined;
  valued?: boolean | undefined;
}): React.JSX.Element {
  return (
    <div>
      <dt><Icon name={icon} size={12} /> {label}</dt>
      <dd data-tone={age?.tone ?? tone ?? 'none'} data-testid={testId} data-state={state} data-valued={valued}>
        <Tip content={tip}>{value ?? `${age?.label ?? '—'}${partial ? ' · partial' : ''}`}</Tip>
      </dd>
    </div>
  );
}

/** A short status under the headline. Its full sentence is a tip on it. */
function Chip({ children, tip, tone, icon }: {
  children: React.ReactNode;
  tip: string;
  /** Warn is for what makes the figure a floor; anything else is quiet. Never green: nothing here is a profit. */
  tone?: 'warn' | undefined;
  icon: IconName;
}): React.JSX.Element {
  return (
    <span className="holdings-chip" data-tone={tone}>
      <Tip content={tip}><Icon name={icon} size={12} /> {children}</Tip>
    </span>
  );
}

/**
 * The stacked bar. Segments carry their own figure in the accessible name, because the visual
 * one is a width and a width is not readable. While pricing, the wallet segments share three
 * quarters of the bar and the last quarter shimmers where the inventory will go.
 */
function AllocationBar({
  segments: bar,
  total,
  currency,
  pricing
}: {
  segments: readonly HoldingsSegment[];
  total: number;
  currency: string;
  pricing: boolean;
}): React.JSX.Element {
  const visible = bar.filter((segment) => segment.cents > 0);
  const scale = pricing ? 0.75 : 1;
  return (
    <div className="allocation" role="img" aria-label={pricing ? 'Holdings allocation, inventory still pricing' : 'Holdings allocation'} data-pricing={pricing || undefined}>
      {visible.length === 0 && !pricing ? <div className="allocation-empty" /> : visible.map((segment, index) => (
        <div
          key={segment.key}
          className="allocation-segment"
          data-segment={segment.key}
          data-pending={segment.pending}
          title={`${segment.label}: ${segment.key === 'inventory' ? '≈ ' : ''}${formatAmount(segment.cents, currency)} · ${Math.round(share(segment.cents, total))}%`}
          aria-label={`${segment.label}: ${formatAmount(segment.cents, currency)}`}
          style={{
            flex: `0 1 ${share(segment.cents, total) * scale}%`,
            background: `var(${segment.variable})`,
            animationDelay: `${index * 60}ms`
          }}
        />
      ))}
      {pricing ? <div className="allocation-segment skeleton" data-segment="inventory-pricing" aria-label="Inventory: pricing" style={{ flex: '0 1 25%' }} /> : null}
    </div>
  );
}

function SegmentDot({ segment }: { segment: HoldingsSegment }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="allocation-dot"
      data-pending={segment.pending}
      style={{ background: `var(${segment.variable})` }}
    />
  );
}
