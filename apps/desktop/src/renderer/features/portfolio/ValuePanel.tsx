import React, { useMemo } from 'react';
import type { UnpricedReason, Valuation } from '@cslytics/market-data';
import type { CurvesSource, PortfolioValuation } from '../../../shared/market.js';
import type { AccountHoldings } from '../../lib/types.js';
import { Caption, Empty, Notice, Panel, PanelHeader, Skeleton, Spinner } from '../../components/ui.js';
import { conversionNote, currencyCodeOf, formatAmount, formatConverted } from '../../lib/money.js';
import { plural } from '../../lib/labels.js';
import { aggregate, heldCounts } from '../../lib/portfolio.js';
import { CategoryPie } from './CategoryPie.js';
import { FigureCard, type CardLine } from './FigureCard.js';
import { pricingProgress } from './fill-label.js';
import { slices } from './pie-math.js';
import type { ValuationState } from './use-valuation.js';

/**
 * What the inventory is worth (portfolio and pricing plan §5, §7): the market value at the mid
 * price, the float value beside it with each skin at its own float on the Steam float curve (D7),
 * what a sale into the bids would return, how many items there are, how much is priced and why the
 * rest is not, and the value by category as a ring. The headline that adds the wallets to it is the
 * holdings panel above, and it holds the market value, never the float value.
 *
 * Nothing is shown until every held kind has been asked (`valued`): the cards are skeletons with
 * the fill's progress until then. The float value also waits for the curve fill (`floatValued`),
 * alone: its card says how far the fill has got while every other card is already shown. Every
 * figure says its currency, an estimate is marked `≈`, and a part that could not be converted
 * leaves the total a floor and is named. Nothing here is computed: main did that.
 */

const REASON_LABEL: Record<UnpricedReason, string> = {
  'display-only': 'not market items',
  unresolved: 'not in the catalogue yet',
  'storage-unit': 'storage units',
  'no-book': 'not priced yet',
  'read-failed': 'could not be read; asked again later',
  absent: 'no market listing exists',
  'empty-book': 'no bids or asks',
  'no-rate': 'no exchange rate'
};

export function ValuePanel({ state, holdings }: { state: ValuationState; holdings: readonly AccountHoldings[] }): React.JSX.Element {
  const { valuation: answer, loading, error } = state;
  const pie = useMemo(() => (answer?.valuation ? slices(answer.valuation.byCategory) : []), [answer?.valuation]);
  const counts = useMemo(() => heldCounts(aggregate(holdings).counts), [holdings]);
  const info = {
    label: 'How the inventory is valued',
    content: (
      <>
        Market value is each item at the midpoint of Steam&apos;s lowest ask and highest bid; an item with only one side uses that side.
        A listed item is valued as an item, not at its asking price.
        {answer?.curves && answer.curves.skins > 0
          ? ' Float value is the same items with each skin at its own float on the Steam float curve, which CSlytics fits each day to Steam\'s listings, so two skins of one name can be worth different amounts. It sits beside the market value and never replaces it; the curves are in US dollars and convert at CSlytics\'s daily rate.'
          : ''}
        {answer?.prices
          ? ` ${answer.prices.coveredKinds.toLocaleString()} of the kinds held are priced from CSlytics's hourly snapshot of Steam's books, in US dollars from ${new Date(answer.prices.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${answer.base !== 'USD' ? `, converted to ${answer.base} at CSlytics's rate${answer.valuation?.fx ? ` of ${answer.valuation.fx.asOf}${answer.valuation.fx.stale ? ' (stale)' : ''}` : ''}` : ''}.`
          : ''}
        {answer?.observedIn && answer.observedIn !== answer.base
          ? ` Steam prices read from this connection are in ${answer.observedIn}, converted to ${answer.base} at CSlytics's rate${answer.valuation?.fx ? ` of ${answer.valuation.fx.asOf}${answer.valuation.fx.stale ? ' (stale)' : ''}` : ''}; Steam converts at its own.`
          : answer?.observedIn ? ` Steam prices read from this connection are in ${answer.observedIn}.` : ''}
      </>
    )
  };

  if (answer === null) {
    return (
      <Panel className="enter enter-3">
        <PanelHeader title="Inventory value" icon="package" info={info} />
        <div className="panel-body">
          {error ? <Notice tone="error" role="status">{error}</Notice> : <Empty icon="trending-up" title={loading ? 'Pricing…' : 'Nothing to price yet'} />}
        </div>
      </Panel>
    );
  }

  const { base, valuation, status, curves } = answer;
  // The float value has a card only when something held has a float to price.
  const floats = curves !== null && curves.skins > 0 ? curves : null;
  const reasons: CardLine[] = valuation
    ? Object.entries(valuation.unpricedUnitsByReason).map(([reason, units]) => ({ key: reason, label: REASON_LABEL[reason as UnpricedReason], value: plural(units ?? 0, 'unit') }))
    : [];

  return (
    <Panel className="enter enter-3">
      <PanelHeader
        title="Inventory value"
        icon="package"
        info={info}
        actions={loading || !answer.valued ? <Spinner size={14} label="Pricing" /> : undefined}
      />
      <div className="panel-body">
        {valuation === null ? (
          <Notice tone="info">{answer.needsFilter ? `More than ${answer.needsFilter.cap.toLocaleString()} kinds in this scope; open one account at a time to value it.` : 'Nothing to value.'}</Notice>
        ) : !answer.valued ? (
          <div className="value-pricing" data-testid="portfolio-value-pricing" role="status">
            {answer.fill === 'stopped'
              ? <Notice tone="warn">Steam asked this machine to slow down; prices resume at {status.stoppedUntil ? new Date(status.stoppedUntil).toLocaleTimeString() : 'later'}.</Notice>
              : <Caption icon="loader" tone="quiet">{pricingProgress(answer)}</Caption>}
            <div className={`metrics value-cards${floats ? ' with-float' : ''}`} aria-hidden="true">
              {Array.from({ length: floats ? 5 : 4 }, (_, n) => n).map((n) => (
                <article key={n} className="metric value-card">
                  <Skeleton width={90} height={11} />
                  <div style={{ marginTop: 10 }}><Skeleton width={140} height={22} /></div>
                  <div style={{ marginTop: 10 }}><Skeleton width="70%" height={11} /></div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className={`metrics value-cards${floats ? ' with-float' : ''}`} data-testid="portfolio-value-cards">
              <FigureCard
                index={0}
                title="Market value"
                icon="trending-up"
                hue="inventory"
                testId="portfolio-inventory-value"
                tip={`${plural(valuation.units.priced, 'unit')} at the midpoint of the lowest ask and the highest bid${answer.prices ? `, from CSlytics's hourly snapshot${answer.prices.bookKinds > 0 ? ` and ${plural(answer.prices.bookKinds, 'kind')} from Steam's book` : ''}` : ''}.`}
                value={valuation.marketValue.cents === null ? '—' : { figures: [{ code: currencyCodeOf(base), text: `≈ ${formatAmount(valuation.marketValue.cents, base)}` }] }}
                lines={valuation.marketValue.subtotals.filter((row) => row.converted !== null).map((row) => ({
                  key: row.currency, label: formatAmount(row.cents, row.currency), value: formatConverted(row.converted!), tip: conversionNote(row.converted!)
                }))}
              />
              {floats ? <FloatValueCard answer={answer} valuation={valuation} curves={floats} index={1} /> : null}
              <FigureCard
                index={2}
                title="If sold now"
                icon="tag"
                testId="portfolio-liquidation"
                tip="Selling every unit into the current bids, after Steam's fees. Units the bids cannot absorb are left out."
                value={valuation.liquidation.cents === null ? '—' : { figures: [{ code: currencyCodeOf(base), text: `≈ ${formatAmount(valuation.liquidation.cents, base)}` }] }}
                lines={valuation.marketValue.cents !== null && valuation.liquidation.cents !== null && valuation.marketValue.cents > 0
                  ? [{ label: 'Of market value', value: `${Math.round((valuation.liquidation.cents / valuation.marketValue.cents) * 100)}%` }]
                  : []}
              />
              <FigureCard
                index={3}
                title="Items"
                icon="package"
                testId="portfolio-items"
                tip="Every holding, individual items and stackable units alike. A listed item is still in the inventory, so it is counted there once."
                value={counts.total.toLocaleString()}
                lines={[
                  { label: 'In inventory', value: counts.main.toLocaleString() },
                  { label: 'In storage units', value: counts.crated.toLocaleString() },
                  ...(counts.listed > 0 ? [{ label: 'Listed', value: counts.listed.toLocaleString() }] : [])
                ]}
              />
              <FigureCard
                index={4}
                title="Priced"
                icon="activity"
                testId="portfolio-unpriced"
                tip={valuation.units.unpriced > 0
                  ? `${plural(valuation.units.unpriced, 'unit')} unpriced; never counted as zero.`
                  : 'Every unit has a price.'}
                value={`${valuation.kinds.priced.toLocaleString()} of ${valuation.kinds.total.toLocaleString()} kinds`}
                lines={reasons}
              />
            </div>

            {pie.length > 0 && valuation.marketValue.cents !== null ? (
              <div className="category-breakdown" data-testid="portfolio-categories">
                <div className="holdings-label">By category</div>
                <CategoryPie slices={pie} base={base} totalCents={valuation.marketValue.cents} testId="portfolio-category-pie" />
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * The float value (plan D7): the market value again, with each skin at its own float on CSlytics's
 * Steam float curve. A second estimate beside the market value, never in the headline. It waits for
 * the curve fill alone (`floatValued`) and says how far the fill has got meanwhile, so the market
 * value, which needs no curve, is never held back for it.
 */
function FloatValueCard({ answer, valuation, curves, index }: {
  answer: PortfolioValuation;
  valuation: Valuation;
  curves: CurvesSource;
  index: number;
}): React.JSX.Element {
  const { base } = answer;
  const { fill } = curves;
  const card = {
    index,
    title: 'Float value',
    icon: 'waves',
    testId: 'portfolio-float-value',
    tip: "The market value again, with each skin at its own float on CSlytics's Steam float curve instead of the mid price, so two skins of one name can be worth different amounts. An estimate beside the market value; the total above never includes it."
  } as const;
  if (fill.state === 'no-feature') {
    return <FigureCard {...card} state="no-feature" value="—" lines={[{ label: 'Float curves', value: 'not in your plan', tip: 'Your CSlytics plan does not include Steam float curves, so no skin has a float value.' }]} />;
  }
  if (!answer.floatValued) {
    return <FigureCard {...card} state="reading" value={null} lines={[{ label: 'Reading float curves', value: `${fill.done.toLocaleString()} of ${fill.total.toLocaleString()}` }]} />;
  }
  const market = valuation.marketValue.cents;
  const float = valuation.floatValue.cents;
  const atMid = valuation.units.priced - curves.units;
  const resumes = fill.resumesAt ? time(fill.resumesAt) : 'later';
  const lines: CardLine[] = [
    { key: 'float', label: 'At their float', value: plural(curves.units, 'unit'), tip: "Each skin at its own float on CSlytics's Steam float curve." },
    ...(atMid > 0 ? [{ key: 'mid', label: 'At the mid price', value: plural(atMid, 'unit'), tip: 'Items without a float, and skins with no Steam curve, as Market value prices them.' }] : []),
    ...(curves.withoutCurve.units > 0 ? [{ key: 'no-curve', label: 'No Steam curve', value: plural(curves.withoutCurve.units, 'skin'), tip: 'CSlytics publishes no Steam float curve for these skins, so they stay at the mid price.' }] : []),
    ...(fill.state === 'deferred' && curves.notAsked.units > 0 ? [{
      key: 'waiting', label: `Curves after ${resumes}`, value: plural(curves.notAsked.units, 'skin'),
      tip: fill.deferredBy === 'sign-in'
        ? 'Float curves need your CSlytics sign-in. Until it is confirmed these skins stay at the mid price.'
        : `CSlytics serves a limited number of float curves an hour. The rest are asked for at ${resumes}; until then these skins stay at the mid price.`
    }] : []),
    ...(market !== null && float !== null && market > 0 ? [{ key: 'against', label: 'Against market value', value: signedPercent(float, market) }] : [])
  ];
  return (
    <FigureCard
      {...card}
      state={fill.state === 'deferred' ? 'deferred' : 'ready'}
      value={float === null ? '—' : { figures: [{ code: currencyCodeOf(base), text: `≈ ${formatAmount(float, base)}` }] }}
      lines={lines}
    />
  );
}

/** How far one figure is above or below another, to a tenth of a percent, with its sign. */
function signedPercent(value: number, of: number): string {
  const percent = Math.round(((value - of) / of) * 1_000) / 10;
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
  return `${sign}${Math.abs(percent).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
