import React, { useMemo } from 'react';
import type { AccountHoldings } from '../../lib/types.js';
import {
  aggregate,
  freshness,
  heldCounts,
  observedTotalCents,
  segments,
  share,
  type HoldingsSegment,
  type PortfolioCurrency
} from '../../lib/portfolio.js';
import { formatCents } from '../../lib/format.js';
import { plural } from '../../lib/labels.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Empty, Panel, PanelHeader } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';

/**
 * Portfolio.
 *
 * One headline figure, a stacked allocation bar, a row of value cards, and a per-account table
 * you click through into an account. What it does *not* do is value anything — see
 * `../lib/portfolio.ts` for why every number here is one a venue named rather than one this
 * app estimated.
 *
 * Two scopes, one component. Across every known account it shows the aggregate and the table;
 * scoped to one account it shows that account's own figures and no table, because a one-row
 * table is a worse way to read one row.
 */
export function PortfolioView({
  holdings,
  scope,
  onSelectAccount,
  avatars,
  now = new Date()
}: {
  holdings: readonly AccountHoldings[];
  /** `null` = every signed-in account. Otherwise the one account being shown. */
  scope: string | null;
  onSelectAccount: (accountId: string) => void;
  /** `avatar:<hash>` by accountId, when a persona walk has observed one. */
  avatars?: Readonly<Record<string, string | null>> | undefined;
  now?: Date;
}): React.JSX.Element {
  const totals = useMemo(() => aggregate(holdings), [holdings]);
  const total = observedTotalCents(totals);
  const bars = segments(totals);
  const currency = displayCurrency(totals.currency);
  const only = scope === null ? null : holdings.find((row) => row.accountId === scope) ?? null;

  const description = <PageHeader subtitle="Observed money only. Inventory is counted, never appraised." />;

  if (holdings.length === 0) {
    return (
      <Panel>
        {description}
        <Empty icon="wallet" title="Nothing observed yet" hint="Figures appear once an account has been connected and its wallet and market have been read." />
      </Panel>
    );
  }

  const marketAge = freshness(totals.market.observedAt, now);
  const inventoryAge = freshness(totals.inventory.observedAt, now);

  return (
    <>
      {description}
      <Panel className="enter">
        <div className="panel-body">
          <div className="holdings-head">
            <div>
              {/* Which accounts these are is the account strip's to say; this only names the figure. */}
              <div className="holdings-label">{only ? `${only.accountName}'s holdings` : 'Total holdings'}</div>
              <div className="holdings-total num" data-settled={totals.market.settled}>
                {formatCents(total, currency)}
              </div>
              <div className="holdings-caption">
                {/* CLAUDE.md rule 5. A walk that did not finish proves nothing about what it did
                    not reach, so the figure above is a floor and has to say so. */}
                {totals.market.settled
                  ? <><Icon name="check-circle" size={13} /> Observed across wallet and open listings</>
                  : <><Icon name="alert-circle" size={13} /> At least this much — the last market walk did not complete</>}
              </div>
              {totals.currency.kind === 'mixed' ? (
                <div className="holdings-caption" data-tone="warn">
                  <Icon name="alert-triangle" size={13} />
                  Accounts report different Steam currencies ({totals.currency.codes.join(', ')}). This app has no
                  exchange rate, so the figure above adds numbers that are not comparable — read the per-account rows.
                </div>
              ) : null}
            </div>
            <dl className="holdings-evidence">
              <div>
                <dt><Icon name="store" size={12} /> Market</dt>
                <dd data-tone={marketAge.tone}>{marketAge.label}{totals.market.settled ? '' : ' · partial'}</dd>
              </div>
              <div>
                <dt><Icon name="package" size={12} /> Inventory</dt>
                <dd data-tone={inventoryAge.tone}>{inventoryAge.label}{totals.inventory.settled ? '' : ' · partial'}</dd>
              </div>
            </dl>
          </div>

          <AllocationBar segments={bars} total={total} currency={currency} />

          <div className="holdings-legend">
            {bars.filter((segment) => segment.cents > 0).map((segment) => (
              <span key={segment.key} className="holdings-legend-item">
                <SegmentDot segment={segment} />
                {segment.label}
                <span className="num">{formatCents(segment.cents, currency)}</span>
              </span>
            ))}
            {total === 0 ? <span className="holdings-legend-item quiet"><Icon name="info" size={12} /> Nothing observed yet — connect an account and let it refresh.</span> : null}
          </div>
        </div>
      </Panel>

      <div className="metrics">
        <ValueCard
          index={0}
          icon="wallet"
          variable="--cs-hold-wallet"
          title="Wallet"
          value={formatCents(totals.wallet?.balanceCents ?? null, currency)}
          lines={[
            { label: 'Delayed', value: formatCents(totals.wallet?.delayedBalanceCents ?? null, currency) },
            { label: 'Reserved by this app', value: formatCents(totals.reservedCents, currency) }
          ]}
          note={totals.wallet ? undefined : 'not observed yet'}
        />
        <ValueCard
          index={1}
          icon="tag"
          variable="--cs-hold-listed"
          title="Listed proceeds"
          value={formatCents(totals.listedReceiveCents + totals.onHoldReceiveCents, currency)}
          lines={[
            { label: `Live · ${totals.counts.listingsActive}`, value: formatCents(totals.listedReceiveCents, currency) },
            { label: `On hold · ${totals.counts.listingsOnHold}`, value: formatCents(totals.onHoldReceiveCents, currency) }
          ]}
          note="What you receive; Steam adds the buyer fee on top."
        />
        <ValueCard
          index={2}
          icon="smartphone"
          variable="--cs-hold-unconfirmed"
          title="Awaiting confirmation"
          value={formatCents(totals.awaitingConfirmationReceiveCents, currency)}
          lines={[{ label: 'Listings', value: String(totals.counts.listingsAwaitingConfirmation) }]}
          note="Waiting on a phone tap this app never makes."
        />
        <ValueCard
          index={3}
          icon="shopping-cart"
          variable="--cs-hold-wallet"
          title="Open buy orders"
          value={formatCents(totals.buyOrderOpenCents, currency)}
          lines={[{ label: 'Orders', value: String(totals.counts.buyOrdersActive) }]}
          note="Reserved out of the wallet above, not added to it."
        />
        <ValueCard
          index={4}
          icon="package"
          title="Items held"
          value={heldCounts(totals.counts).total.toLocaleString()}
          lines={[
            { label: 'In storage units', value: `${heldCounts(totals.counts).crated.toLocaleString()} · ${plural(totals.counts.storageUnits, 'unit')}` },
            { label: 'Stackable units', value: totals.counts.fungibleUnits.toLocaleString() }
          ]}
          note="Counted, not valued: there is no price catalogue."
        />
      </div>

      {scope === null ? (
        <Panel className="enter enter-2">
          <PanelHeader icon="users" title="By account" subtitle="Select a row to open that account." />
          <div className="panel-body flush">
            <div className="rows">
              <div className="row account-row row-head">
                <span>Account</span>
                <span>Observed</span>
                <span>Wallet</span>
                <span>Listed</span>
                <span>Items</span>
                <span>Synced</span>
              </div>
              {holdings.map((row) => {
                const age = freshness(row.market.observedAt ?? row.inventory.observedAt, now);
                const code = row.currency;
                return (
                  <button
                    key={row.accountId}
                    type="button"
                    className="row account-row"
                    aria-label={`Open ${row.accountName}`}
                    onClick={() => onSelectAccount(row.accountId)}
                  >
                    <span className="account-row-name">
                      <Avatar name={row.accountName} size={30} photo={avatars?.[row.accountId]} />
                      <span className="grow">
                        <span className="group-name">{row.accountName}</span>
                        <span className="cell-sub">Steam ID {row.steamId64}</span>
                      </span>
                    </span>
                    <span className="num" data-settled={row.market.settled}>
                      {formatCents(observedTotalCents(row), code)}
                    </span>
                    <span className="num">{formatCents(row.wallet?.balanceCents ?? null, code)}</span>
                    <span className="num">
                      {formatCents(row.listedReceiveCents + row.onHoldReceiveCents, code)}
                      <span className="cell-sub">{plural(row.counts.listingsActive + row.counts.listingsOnHold, 'listing')}</span>
                    </span>
                    <span className="num">
                      {heldCounts(row.counts).total.toLocaleString()}
                      <span className="cell-sub">{heldCounts(row.counts).crated.toLocaleString()} in storage</span>
                    </span>
                    <span className="holdings-age" data-tone={age.tone}>{age.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Panel>
      ) : null}
    </>
  );
}

/**
 * The stacked bar. Segments carry their own figure in the accessible name, because the visual
 * one is a width and a width is not readable.
 */
function AllocationBar({
  segments: bars,
  total,
  currency
}: {
  segments: readonly HoldingsSegment[];
  total: number;
  currency: number | null;
}): React.JSX.Element {
  const visible = bars.filter((segment) => segment.cents > 0);
  return (
    <div className="allocation" role="img" aria-label="Holdings allocation">
      {visible.length === 0 ? <div className="allocation-empty" /> : visible.map((segment, index) => (
        <div
          key={segment.key}
          className="allocation-segment"
          data-pending={segment.pending}
          title={`${segment.label}: ${formatCents(segment.cents, currency)}`}
          aria-label={`${segment.label}: ${formatCents(segment.cents, currency)}`}
          style={{
            flex: `0 1 ${share(segment.cents, total)}%`,
            background: `var(${segment.variable})`,
            animationDelay: `${index * 60}ms`
          }}
        />
      ))}
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

function ValueCard({
  index,
  icon,
  variable,
  title,
  value,
  lines,
  note
}: {
  index: number;
  icon: IconName;
  variable?: string | undefined;
  title: string;
  value: string;
  lines: ReadonlyArray<{ label: string; value: string }>;
  note?: string | undefined;
}): React.JSX.Element {
  return (
    <article className="metric value-card enter" style={{ ...(variable ? { borderTopColor: `var(${variable})` } : {}), animationDelay: `${60 + index * 40}ms` }}>
      <div className="metric-head">
        <div className="metric-label">{title}</div>
        <span className="metric-icon"><Icon name={icon} size={15} /></span>
      </div>
      <div className="metric-value num">{value}</div>
      <dl className="value-lines">
        {lines.map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd className="num">{line.value}</dd>
          </div>
        ))}
      </dl>
      {note ? <div className="metric-note">{note}</div> : null}
    </article>
  );
}

/** `formatCents` wants a Steam currency code; a mixed or unobserved portfolio has none to give. */
function displayCurrency(currency: PortfolioCurrency): number | null {
  return currency.kind === 'single' ? currency.code : null;
}
