import React, { useMemo } from 'react';
import type { AccountHoldings } from '../../lib/types.js';
import type { AccountFigures, ObservedKey, PortfolioValuation } from '../../../shared/market.js';
import { aggregate, freshness, heldCounts, quantity, share } from '../../lib/portfolio.js';
import { formatAmount, type CurrencyRef } from '../../lib/money.js';
import { plural } from '../../lib/labels.js';
import { Avatar } from '../../components/Avatar.js';
import { Tip } from '../../components/Tip.js';
import { VenueMark } from '../../components/VenueMark.js';
import { Panel, PanelHeader, Skeleton } from '../../components/ui.jsx';
import { Beside, FigureCard } from './FigureCard.js';
import { MoneyFigures, shown, type Shown } from './money-figures.js';

/**
 * Portfolio: the observed money, and the per-account table you click through into an account.
 * Every number here is one a venue named — a wallet balance, a listing's proceeds, a buy order's
 * total — as main grouped it by currency and converted it (plan §3, §5.2). The headline that adds
 * the inventory's appraisal to these is the holdings panel above; what the inventory is *worth* is
 * the Value panel's question.
 *
 * The wallets come first and apart: Steam's and CSFloat's are different money, in different
 * currencies, spent on different venues, and each has a part its venue has not let the account
 * spend yet. Spendable and pending are printed side by side, because a pending balance hidden in a
 * footnote reads as money that can be spent.
 *
 * The table is for the scope of every account; scoped to one account the page leaves it out,
 * because a one-row table is a worse way to read one row.
 */

/** CSFloat's balance is US dollars, whatever the account's Steam wallet is in. */
const CSFLOAT_CURRENCY = 'USD';

export function PortfolioView({
  holdings,
  valuation = null,
  now = new Date()
}: {
  holdings: readonly AccountHoldings[];
  /** Main's figures for the same scope: every money figure on this page is one of its. */
  valuation?: PortfolioValuation | null | undefined;
  now?: Date;
}): React.JSX.Element {
  const totals = useMemo(() => aggregate(holdings), [holdings]);
  // The currency an empty Steam figure is printed in: the one Steam wallet currency, else the base.
  const steamCodes = [...new Set(holdings.map((row) => row.currency).filter((code): code is number => code !== null))];
  const steamHome: CurrencyRef = steamCodes.length === 1 ? steamCodes[0] : valuation?.base ?? null;
  const show = (key: ObservedKey, home: CurrencyRef): Shown | null => (valuation ? shown(quantity(valuation, key), home) : null);
  const steamAt = oldest(holdings.map((row) => row.wallet?.observedAt ?? null));

  if (holdings.length === 0) return <></>;

  return (
    <>
      <div
        className="portfolio-observed enter enter-2"
        data-testid="portfolio-observed-cards"
        data-currencies={valuation ? valuation.observed.length : undefined}
        data-converted={valuation && valuation.observed.length > 1 ? true : undefined}
      >
        <div className="wallet-cards">
          <WalletCard
            venue="steam"
            title="Steam wallet"
            testId="portfolio-wallet"
            available={show('steam', steamHome)}
            pending={show('steamPending', steamHome)}
            share={valuation ? [valuation.observedInBase.steam.cents, valuation.observedInBase.steamPending.cents] : null}
            age={freshness(steamAt, now)}
            known={holdings.some((row) => row.wallet !== null)}
            unknown="Not read yet"
            tip="Spendable is what the wallet can pay with now. Pending is money Steam shows in the wallet but has not released yet."
            pendingTip="In the wallet, not yet spendable. Steam releases it on its own schedule."
            extra={valuation && valuation.observedInBase.reserved.cents ? (
              <dl className="value-lines">
                <div>
                  <dt><Tip content="Committed by buy orders this app placed that Steam has not shown back yet. Still part of the balance above.">Held for this app&apos;s orders</Tip></dt>
                  <dd className="num"><MoneyFigures figures={shown(quantity(valuation, 'reserved'), steamHome).figures} inline /></dd>
                </div>
              </dl>
            ) : null}
          />
          <WalletCard
            venue="csfloat"
            title="CSFloat balance"
            testId="portfolio-csfloat-wallet"
            available={totals.csfloat.accounts > 0 ? show('csfloat', CSFLOAT_CURRENCY) : null}
            pending={totals.csfloat.accounts > 0 ? show('csfloatPending', CSFLOAT_CURRENCY) : null}
            share={valuation ? [valuation.observedInBase.csfloat.cents, valuation.observedInBase.csfloatPending.cents] : null}
            age={freshness(totals.csfloat.observedAt, now)}
            known={totals.csfloat.accounts > 0}
            unknown={holdings.length === 1 ? 'No CSFloat key connected' : 'No account has a CSFloat key connected'}
            tip={`Spendable is what CSFloat lets the account buy with now. Pending is sale money CSFloat is still holding.${holdings.length > 1 ? ` A key is connected on ${totals.csfloat.accounts} of ${holdings.length} accounts.` : ''}`}
            pendingTip="Proceeds from sales CSFloat has not released yet. It cannot pay for a buy order."
          />
        </div>

        <div className="metrics value-cards market-cards">
          <FigureCard
            index={0}
            icon="tag"
            hue="listed"
            title="Listed"
            testId="portfolio-listed"
            tip="What you receive when these sell; the buyer pays Steam's fee on top. The items are still counted in inventory, so this is never added to the total."
            value={show('listings', steamHome)}
            // Live and on hold apart only when Steam is holding some: otherwise the one line would repeat the figure.
            lines={valuation && totals.counts.listingsOnHold > 0 ? [
              { label: `Live · ${totals.counts.listingsActive}`, value: shown(quantity(valuation, 'listed'), steamHome) },
              { label: `On hold · ${totals.counts.listingsOnHold}`, value: shown(quantity(valuation, 'onHold'), steamHome), tip: 'Listings Steam is holding before they go live.' }
            ] : [{ label: 'Listings', value: totals.counts.listingsActive.toLocaleString() }]}
          />
          <FigureCard
            index={1}
            icon="smartphone"
            hue="unconfirmed"
            title="Awaiting confirmation"
            testId="portfolio-awaiting"
            tip="Listings waiting for a tap in the Steam mobile app. This app never confirms them."
            value={show('awaitingConfirmation', steamHome)}
            lines={[{ label: 'Listings', value: totals.counts.listingsAwaitingConfirmation.toLocaleString() }]}
          />
          <FigureCard
            index={2}
            icon="shopping-cart"
            hue="wallet"
            title="Buy orders"
            testId="portfolio-buy-orders"
            tip="What open Steam buy orders would spend. Steam keeps it inside the wallet balance, so it is never added to anything."
            value={show('buyOrders', steamHome)}
            lines={[
              { label: 'Steam', value: plural(totals.counts.buyOrdersActive, 'order') },
              ...(totals.counts.csfloatBuyOrdersActive > 0 ? [{ label: 'CSFloat', value: plural(totals.counts.csfloatBuyOrdersActive, 'order') }] : [])
            ]}
          />
        </div>
      </div>
    </>
  );
}

/**
 * One venue's wallet: spendable and pending side by side, a thin meter of their split, and how old
 * the read is. A wallet nobody has read is said to be unread, never printed as zero.
 */
function WalletCard({ venue, title, testId, available, pending, share: split, age, known, unknown, tip, pendingTip, extra }: {
  venue: 'steam' | 'csfloat';
  title: string;
  testId: string;
  available: Shown | null;
  pending: Shown | null;
  /** Spendable and pending in the base, for the meter. */
  share: [number | null, number | null] | null;
  age: ReturnType<typeof freshness>;
  known: boolean;
  unknown: string;
  tip: string;
  pendingTip: string;
  extra?: React.ReactNode;
}): React.JSX.Element {
  const [spendable, held] = split ?? [null, null];
  const meter = known && spendable !== null && held !== null && spendable + held > 0 ? share(held, spendable + held) : null;
  return (
    <article className="wallet-card enter" data-testid={testId} data-venue={venue} data-known={known}>
      <div className="wallet-head">
        <VenueMark venue={venue} size={16} decorative />
        <span className="wallet-title">{title}</span>
        <Tip content={tip} label={`About the ${title.toLowerCase()}`} />
        <span className="grow" />
        {known ? <span className="wallet-age" data-tone={age.tone}>{age.label}</span> : null}
      </div>
      {!known ? (
        <div className="wallet-unknown">{unknown}</div>
      ) : (
        <>
          <div className="wallet-figures">
            <div className="wallet-figure">
              <div className="wallet-figure-label">Spendable</div>
              {available === null
                ? <Skeleton width={150} height={26} />
                : <div className="metric-value num" data-count={available.figures.length}><MoneyFigures figures={available.figures} /></div>}
              {available ? <Beside value={available} /> : null}
            </div>
            <div className="wallet-figure" data-pending="true">
              <div className="wallet-figure-label">
                <span className="allocation-dot wallet-dot" data-pending="true" aria-hidden="true" />
                <Tip content={pendingTip}>Pending</Tip>
              </div>
              {pending === null
                ? <Skeleton width={110} height={22} />
                : <div className="wallet-pending-value num"><MoneyFigures figures={pending.figures} /></div>}
              {pending ? <Beside value={pending} /> : null}
            </div>
          </div>
          {meter !== null ? (
            <div className="wallet-meter" role="img" aria-label={`${Math.round(meter)}% pending`}>
              <span style={{ flexBasis: `${100 - meter}%` }} />
              <span data-pending="true" style={{ flexBasis: `${meter}%` }} />
            </div>
          ) : null}
          {extra}
        </>
      )}
    </article>
  );
}

/**
 * Per account: what it holds in the base, then each wallet in its own currency, its listings and
 * its items. The holdings column is main's per-account figure, shown only once the fill has asked
 * every held kind, for the same reason the headline waits.
 */
export function AccountsTable({ holdings, valuation, avatars, now = new Date(), onSelectAccount }: {
  holdings: readonly AccountHoldings[];
  valuation: PortfolioValuation | null;
  avatars?: Readonly<Record<string, string | null>> | undefined;
  now?: Date;
  onSelectAccount: (accountId: string) => void;
}): React.JSX.Element {
  const figures: readonly AccountFigures[] | null = valuation?.valued ? valuation.accounts : null;
  const base = valuation?.base ?? null;
  return (
    <Panel className="enter enter-4">
      <PanelHeader icon="users" title="By account" />
      <div className="panel-body flush">
        <div className="rows">
          <div className="row account-row row-head">
            <span>Account</span>
            <span><Tip content="Wallets plus items at the Steam mid price, in the portfolio's currency.">Holdings</Tip></span>
            <span>Steam wallet</span>
            <span>CSFloat</span>
            <span>Listed</span>
            <span>Items</span>
            <span>Synced</span>
          </div>
          {holdings.map((row) => {
            const age = freshness(row.market.observedAt ?? row.inventory.observedAt, now);
            const total = figures?.find((entry) => entry.accountId === row.accountId)?.total ?? null;
            const csfloat = row.csfloatWallet;
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
                  </span>
                </span>
                <span className="num account-holdings" data-settled={row.market.settled} data-complete={total?.complete}>
                  {figures === null ? <Skeleton width={80} height={13} /> : total === null || total.cents === null || base === null ? '—' : `≈ ${formatAmount(total.cents, base)}`}
                  {total && total.missingCurrencies.length > 0 ? <span className="cell-sub" data-tone="warn">no rate for {total.missingCurrencies.join(', ')}</span> : null}
                </span>
                <span className="num">
                  {formatAmount(row.wallet?.balanceCents ?? null, row.currency)}
                  {row.wallet && row.wallet.delayedBalanceCents > 0 ? <span className="cell-sub">+ {formatAmount(row.wallet.delayedBalanceCents, row.currency)} pending</span> : null}
                </span>
                <span className="num">
                  {csfloat ? formatAmount(csfloat.availableCents, csfloat.currency) : <span className="quiet">—</span>}
                  {csfloat && csfloat.pendingCents > 0 ? <span className="cell-sub">+ {formatAmount(csfloat.pendingCents, csfloat.currency)} pending</span> : null}
                </span>
                <span className="num">
                  {formatAmount(row.listedReceiveCents + row.onHoldReceiveCents, row.currency)}
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
  );
}

/**
 * The oldest of the reads behind a figure: it is as current as its least current part. A wallet
 * never read adds no money to the figure, so it has no age to add to it either.
 */
function oldest(stamps: ReadonlyArray<string | null>): string | null {
  return stamps.reduce<string | null>((least, stamp) => (stamp === null ? least : least === null || stamp < least ? stamp : least), null);
}
