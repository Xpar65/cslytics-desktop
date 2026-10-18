import React, { useMemo } from 'react';
import type { UnpricedReason } from '@cslytics/market-data';
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
 * What the inventory is worth (portfolio and pricing plan §5, §7): the mid-price figure, what a
 * sale into the bids would return, how many items there are, how much is priced and why the rest
 * is not, and the value by category as a ring. The headline that adds the wallets to it is the
 * holdings panel above.
 *
 * Nothing is shown until every held kind has been asked (`valued`): the cards are skeletons with
 * the fill's progress until then. Every figure says its currency, an estimate is marked `≈`, and a
 * part that could not be converted leaves the total a floor and is named. Nothing here is
 * computed: main did that.
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
        Each item is valued at the midpoint of Steam&apos;s lowest ask and highest bid; an item with only one side uses that side.
        A listed item is valued as an item, not at its asking price.
        {answer?.observedIn && answer.observedIn !== answer.base
          ? ` Steam prices are read in ${answer.observedIn} from this connection and converted to ${answer.base} at CSlytics's rate${answer.valuation?.fx ? ` of ${answer.valuation.fx.asOf}${answer.valuation.fx.stale ? ' (stale)' : ''}` : ''}; Steam converts at its own.`
          : answer?.observedIn ? ` Steam prices are read in ${answer.observedIn} from this connection.` : ''}
      </>
    )
  };

  if (answer === null) {
    return (
      <Panel className="enter enter-3">
        <PanelHeader title="Inventory value" icon="package" info={info} />
        <div className="panel-body">
          {error ? <Notice tone="error" role="status">{error}</Notice> : <Empty icon="trending-up" title={loading ? 'Pricing…' : 'Nothing to price yet'} hint="Figures appear once an inventory has been read." />}
        </div>
      </Panel>
    );
  }

  const { base, valuation, status } = answer;
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
            <div className="metrics value-cards" aria-hidden="true">
              {[0, 1, 2, 3].map((n) => (
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
            <div className="metrics value-cards" data-testid="portfolio-value-cards">
              <FigureCard
                index={0}
                title="Market value"
                icon="trending-up"
                hue="inventory"
                testId="portfolio-inventory-value"
                tip={`${plural(valuation.units.priced, 'unit')} at the midpoint of the lowest ask and the highest bid.`}
                value={valuation.marketValue.cents === null ? '—' : { figures: [{ code: currencyCodeOf(base), text: `≈ ${formatAmount(valuation.marketValue.cents, base)}` }] }}
                lines={valuation.marketValue.subtotals.filter((row) => row.converted !== null).map((row) => ({
                  key: row.currency, label: formatAmount(row.cents, row.currency), value: formatConverted(row.converted!), tip: conversionNote(row.converted!)
                }))}
              />
              <FigureCard
                index={1}
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
                index={2}
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
                index={3}
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
