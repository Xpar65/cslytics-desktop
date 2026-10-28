import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BookLevel, StoredBook } from '@cslytics/market-data';
import type { ItemCurve, ItemHistory, ItemPage, ItemVariants } from '../../../shared/market.js';
import { Tip } from '../../components/Tip.js';
import { Empty, Notice, Panel, PanelHeader, Pill, Segmented, Skeleton } from '../../components/ui.js';
import { engine } from '../../lib/engine.js';
import { amountParts, conversionNote, currencyCodeOf, formatAmount, formatConverted, formatTick } from '../../lib/money.js';
import { freshness } from '../../lib/portfolio.js';
import { curveWears } from './curve-math.js';
import { FloatCurveChart, type CurveLayers, type CurveWear } from './FloatCurveChart.js';
import { ageLabel, bookChanges, liveness, midOf, type BookChanges, type LevelChange, type Move } from './live-book.js';
import { PriceChart, type ChartSeries } from './PriceChart.js';

/**
 * The Items page's parts (portfolio and pricing plan §7): the quote in the header, the order book
 * beside the price history, and the float curve across the foot. Each waits for its own answer
 * behind a skeleton of its own shape, and each names its currency once, in its header; the amounts
 * inside a ladder or on an axis carry the symbol only.
 *
 * The book and the quote are live: the order book's header says so, and each read marks what it
 * changed for a moment (a level's units, a side's total, the ask, the bid, the mid), so a trader
 * sees the market move rather than a number that is silently different.
 */

const BOOK_ROWS = 10;
const DAY_S = 86_400;

/** A panel's answer: loading, failed, or here (which may be an honest nothing). */
export type Loaded<T> = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; value: T };

/**
 * What the newest read changed against the read before it, kept until the next read so the marks
 * outlive any re-render in between. The page holds one book object per read, so identity is the
 * read; the first read of a page, and a read in another currency, mark nothing.
 */
export function useBookChanges(book: StoredBook | null): BookChanges | null {
  const [seen, setSeen] = useState<{ book: StoredBook | null; changes: BookChanges | null }>({ book, changes: null });
  if (seen.book === book) return seen.changes;
  const changes = book === null ? null : bookChanges(seen.book, book, BOOK_ROWS);
  setSeen({ book, changes });
  return changes;
}

/** What a trader reads first: the lowest ask, the highest bid and the mid between them. */
export function Quote({ page, changes }: { page: Loaded<ItemPage>; changes: BookChanges | null }): React.JSX.Element | null {
  const answer = page.state === 'ready' ? page.value : null;
  const book = answer?.book ?? null;
  const settled = answer !== null && (book !== null || answer.status?.kind === 'absent' || answer.status?.kind === 'unknown');
  if (page.state === 'failed' || (settled && book === null)) return null;
  if (!book || !answer) {
    return (
      <div className="items-quote" aria-hidden="true">
        {[0, 1, 2].map((n) => <div key={n} className="items-figure"><Skeleton width={36} height={10} /><Skeleton width={96} height={22} /></div>)}
      </div>
    );
  }
  const read = book.observedAt;
  return (
    <div className="items-quote" data-testid="item-quote">
      <Figure label="Ask" tone="ask" testId="item-book-ask" cents={book.lowestAskCents} currency={book.currency} converted={answer.converted.ask} move={changes?.ask ?? null} read={read} />
      <Figure label="Bid" tone="bid" testId="item-book-bid" cents={book.highestBidCents} currency={book.currency} converted={answer.converted.bid} move={changes?.bid ?? null} read={read} />
      <Figure label="Mid" testId="item-book-mid" cents={midOf(book)} currency={book.currency} converted={answer.converted.mid} move={changes?.mid ?? null} read={read} minor />
    </div>
  );
}

function Figure({ label, tone, testId, cents, currency, converted, move, read, minor }: {
  label: string; tone?: 'ask' | 'bid' | undefined; testId: string; cents: number | null; currency: number; converted: ItemPage['converted']['mid'];
  move: Move; read: string; minor?: boolean | undefined;
}): React.JSX.Element {
  const parts = amountParts(cents, currency);
  return (
    <div className="items-figure" data-testid={testId} data-tone={tone} data-minor={minor || undefined} data-move={move ?? undefined}>
      <div className="holdings-label">{label}</div>
      <div className="items-amount num">
        <Flash change={move} read={read} />
        {parts.amount}{parts.code ? <span className="items-code">{parts.code}</span> : null}
        {move ? <span key={read} className="items-move" aria-hidden="true">{move === 'up' ? '▲' : '▼'}</span> : null}
      </div>
      {converted ? <div className="cell-sub num" title={conversionNote(converted)}>{formatConverted(converted)}</div> : null}
    </div>
  );
}

/**
 * A wash behind a figure that a read changed, fading out. Keyed by the read, so a figure that moves
 * on two reads in a row flashes twice, and absent on a read that left it alone.
 */
function Flash({ change, read }: { change: LevelChange; read: string }): React.JSX.Element | null {
  return change ? <span key={read} className="items-flash" data-change={change} aria-hidden="true" /> : null;
}

/** The wall clock, re-read once a second, so a live mark turns to an age when the reads stop. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "Live" with a beating dot while reads keep arriving, and the book's age once they stop. */
function LiveMark({ book }: { book: StoredBook }): React.JSX.Element {
  const { live, ageMs } = liveness(book.observedAt, useNow());
  const code = currencyCodeOf(book.currency);
  const age = ageLabel(ageMs);
  return (
    <span className="items-live" data-testid="item-book-live" data-live={live}>
      <span className="conn-dot" data-tone={live ? 'live' : 'partial'} aria-hidden="true" />
      <Tip
        label="About the live book"
        content={live
          ? `Steam's order book, read every 5 s while this page is open. Last read ${age}, from this connection, in ${code}. What a read changes flashes.`
          : `Last read ${age} (${new Date(book.observedAt).toLocaleString()}), in ${code}. No newer read has landed since; the page keeps asking every 5 s.`}
      >
        {live ? 'Live' : `Delayed · ${age}`}
      </Tip>
      <span className="items-live-code">{code}</span>
    </span>
  );
}

export function BookPanel({ page, changes }: { page: Loaded<ItemPage>; changes: BookChanges | null }): React.JSX.Element {
  const answer = page.state === 'ready' ? page.value : null;
  const book = answer?.book ?? null;
  const code = book ? currencyCodeOf(book.currency) : '';
  const absent = answer?.status?.kind === 'absent';
  const unknown = answer?.status?.kind === 'unknown';
  return (
    <Panel className="items-panel items-book">
      <PanelHeader
        title="Order book"
        icon="layers"
        subtitle={page.state === 'loading' ? <Skeleton width={90} height={12} /> : book ? <LiveMark book={book} /> : null}
      />
      <div className="panel-body" data-testid="item-book" data-state={page.state === 'ready' ? (book ? 'book' : absent ? 'absent' : 'waiting') : page.state} data-currency={code || undefined} data-observed-at={book?.observedAt}>
        {/* The skeleton stands while the first book is on its way. A read that failed says so
            instead: a skeleton that never resolves would claim progress nobody is making. */}
        {page.state === 'loading' || (answer && book === null && !absent && !unknown) ? <LadderSkeleton /> : null}
        {page.state === 'failed' ? <Notice tone="error" role="status">{page.error}</Notice> : null}
        {answer && book === null && (absent || unknown) ? (
          <Empty icon="layers" title={absent ? 'No market for this item' : 'Steam did not answer yet'} />
        ) : null}
        {book ? (
          <div className="items-sides">
            <Side title="Bids" total={book.bidUnits} levels={book.bids} currency={book.currency} tone="bid" changes={changes?.bids} totalMove={changes?.bidUnits ?? null} read={book.observedAt} />
            <Side title="Asks" total={book.askUnits} levels={book.asks} currency={book.currency} tone="ask" changes={changes?.asks} totalMove={changes?.askUnits ?? null} read={book.observedAt} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function LadderSkeleton(): React.JSX.Element {
  return (
    <div className="items-sides" aria-hidden="true" data-testid="item-book-skeleton">
      {[0, 1].map((side) => (
        <div key={side} className="items-side">
          <Skeleton width={48} height={10} />
          {Array.from({ length: 8 }, (_, n) => <Skeleton key={n} height={12} width={`${92 - n * 8}%`} />)}
        </div>
      ))}
    </div>
  );
}

/**
 * One side of the ladder. Rows are keyed by price, so a level that survives a read keeps its row
 * and its bar grows or shrinks to its new size; a changed level flashes, green for more units, red
 * for fewer, the accent for a price that was not resting before.
 */
function Side({ title, total, levels, currency, tone, changes, totalMove, read }: {
  title: string; total: number; levels: readonly BookLevel[]; currency: number; tone: 'bid' | 'ask';
  changes: BookChanges['bids'] | undefined; totalMove: Move; read: string;
}): React.JSX.Element {
  const shown = levels.slice(0, BOOK_ROWS);
  const most = Math.max(1, ...shown.map((level) => level.quantity));
  return (
    <div className="items-side" data-tone={tone}>
      <div className="items-side-head">
        <span className="holdings-label">{title}</span>
        <span className="items-side-total cell-sub num" data-move={totalMove ?? undefined}><Flash change={totalMove} read={read} />{total.toLocaleString()}</span>
      </div>
      {shown.length === 0 ? <div className="cell-sub">none</div> : shown.map((level) => (
        <div key={level.priceCents} className="items-level" data-price={level.priceCents} data-change={changes?.get(level.priceCents)} title={`${level.quantity.toLocaleString()} at ${formatAmount(level.priceCents, currency)}`}>
          <Flash change={changes?.get(level.priceCents) ?? null} read={read} />
          <span className="items-level-bar" aria-hidden="true"><span style={{ transform: `scaleX(${level.quantity / most})` }} /></span>
          <span className="num">{formatTick(level.priceCents, currency)}</span>
          <span className="cell-sub num">{level.quantity.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** A chart's stand-in while its answer is on the way: gridlines, an axis, and a shimmer where the line goes. */
export function ChartSkeleton({ testId, height }: { testId?: string | undefined; height?: number | undefined }): React.JSX.Element {
  return (
    <div className="chart-skeleton" aria-hidden="true" data-testid={testId}>
      <div className="chart-skeleton-plot" style={height ? { height } : undefined}>
        {[0, 1, 2, 3].map((n) => <span key={n} className="chart-skeleton-grid" style={{ top: `${12 + n * 26}%` }} />)}
        <span className="skeleton chart-skeleton-fill" />
      </div>
      <div className="chart-skeleton-axis">
        {[0, 1, 2, 3, 4].map((n) => <Skeleton key={n} width={44} height={10} />)}
      </div>
    </div>
  );
}

type Span = '7d' | '30d' | '90d' | '1y' | 'all';
const SPANS: ReadonlyArray<{ id: Span; days: number | null }> = [
  { id: '7d', days: 7 }, { id: '30d', days: 30 }, { id: '90d', days: 90 }, { id: '1y', days: 365 }, { id: 'all', days: null }
];

/** The span's start, counted back from the series' own last point rather than the clock: a series fetched yesterday still has 90 days. */
function since(end: number, span: Span): number {
  const days = SPANS.find((option) => option.id === span)?.days ?? null;
  return days === null ? -Infinity : end - days * DAY_S;
}

/**
 * Steam's median sale per day, or the top of the book on each day this desktop read it. The second
 * is offered once two days are kept, and both share the span.
 */
export function HistoryPanel({ history, page }: { history: Loaded<ItemHistory>; page: Loaded<ItemPage> }): React.JSX.Element {
  const [span, setSpan] = useState<Span>('90d');
  const [source, setSource] = useState<'sales' | 'book'>('sales');
  const series = history.state === 'ready' ? history.value : null;
  const answer = page.state === 'ready' ? page.value : null;
  const kept = answer && answer.book && answer.daily.length >= 2 ? { daily: answer.daily, currency: answer.book.currency } : null;
  const mode = source === 'book' && kept ? 'book' : 'sales';

  const sales = useMemo(() => {
    if (!series) return [];
    const from = since(series.points[series.points.length - 1]?.time ?? 0, span);
    return series.points.filter((point) => point.time >= from);
  }, [series, span]);
  const days = useMemo(() => {
    if (!kept) return [];
    const at = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;
    const from = since(at(kept.daily[kept.daily.length - 1]!.day), span);
    return kept.daily.filter((row) => at(row.day) >= from);
  }, [kept, span]);

  const chart = useMemo<ChartSeries[]>(() => mode === 'sales'
    ? [{ id: 'median', label: 'Median sale', variable: '--cs-accent', points: sales.map((point) => ({ x: point.time * 1000, y: point.medianCents, volume: point.purchases })) }]
    : [
      { id: 'ask', label: 'Lowest ask', variable: '--cs-negative', points: days.filter((row) => row.lowestAskCents !== null).map((row) => ({ x: Date.parse(`${row.day}T00:00:00Z`), y: row.lowestAskCents! })) },
      { id: 'bid', label: 'Highest bid', variable: '--cs-positive', points: days.filter((row) => row.highestBidCents !== null).map((row) => ({ x: Date.parse(`${row.day}T00:00:00Z`), y: row.highestBidCents! })) }
    ], [mode, sales, days]);

  const currency = mode === 'sales' ? series?.currency ?? null : kept?.currency ?? null;
  const code = currency === null ? '' : currencyCodeOf(currency);
  const sold = sales.reduce((sum, point) => sum + point.purchases, 0);
  const enough = mode === 'sales' ? sales.length >= 2 : chart.some((row) => row.points.length >= 2);
  return (
    <Panel className="items-panel items-history">
      <PanelHeader
        title="Price history"
        icon="trending-up"
        subtitle={history.state === 'loading' && mode === 'sales'
          ? <Skeleton width={120} height={12} />
          : mode === 'sales'
            ? (series ? <span title={`Median Steam sale per day; fetched ${freshness(series.fetchedAt, new Date()).label}`}>{code} · {sold.toLocaleString()} sold</span> : null)
            : <span title="Top of the order book on each day this desktop read it">{code} · {days.length.toLocaleString()} days kept</span>}
        actions={(
          <span className="items-actions">
            {kept ? (
              <Segmented label="Source" value={mode} onChange={setSource} options={[{ id: 'sales', label: 'Sales' }, { id: 'book', label: 'Book' }]} />
            ) : null}
            <span className="items-span" role="group" aria-label="Span">
              {SPANS.map((option) => (
                <button key={option.id} type="button" className="btn btn-ghost btn-sm" aria-pressed={span === option.id} disabled={mode === 'sales' && !series} onClick={() => setSpan(option.id)}>{option.id}</button>
              ))}
            </span>
          </span>
        )}
      />
      <div className="panel-body" data-testid="item-history" data-state={history.state} data-points={series?.points.length} data-source={mode}>
        {mode === 'sales' && history.state === 'loading' ? <ChartSkeleton testId="item-history-skeleton" /> : null}
        {mode === 'sales' && history.state === 'failed' ? <Notice tone="error" role="status">{history.error}</Notice> : null}
        {mode === 'sales' && history.state === 'ready' && (series === null || !enough) ? (
          <Empty icon="trending-up" title={series === null ? 'No history yet' : 'Not enough sales in this span'} />
        ) : null}
        {mode === 'book' && !enough ? <Empty icon="trending-up" title="Not enough days in this span" /> : null}
        {currency !== null && enough ? (
          <PriceChart
            testId="item-history-chart"
            series={chart}
            formatY={(cents) => formatAmount(Math.round(cents), currency)}
            formatTick={(cents) => formatTick(Math.round(cents), currency)}
            ariaLabel={mode === 'sales' ? `Median Steam sale price over ${span}` : `Lowest ask and highest bid by day over ${span}`}
          />
        ) : null}
      </div>
    </Panel>
  );
}

type Venue = 'steam' | 'csfloat';
const VENUES: ReadonlyArray<{ id: Venue; label: string }> = [{ id: 'steam', label: 'Steam' }, { id: 'csfloat', label: 'CSFloat' }];
const LAYERS: ReadonlyArray<{ id: keyof CurveLayers; label: string }> = [
  { id: 'fair', label: 'Fair' }, { id: 'ask', label: 'Ask' }, { id: 'bid', label: 'Bid' }, { id: 'listings', label: 'Listings' }
];

/**
 * The published float curves for every wear of the item, from Steam or CSFloat. An item with no
 * float, a case or a sticker, has no curve and no panel. Each wear's curve is its own fetch, which
 * main caches for a day, so switching venue or coming back costs nothing the second time.
 */
export function CurvePanel({ name, variants, floats }: { name: string; variants: ItemVariants | null; floats: readonly number[] }): React.JSX.Element | null {
  const [venue, setVenue] = useState<Venue>('steam');
  const [layers, setLayers] = useState<CurveLayers>({ fair: true, ask: false, bid: false, listings: true });
  const [log, setLog] = useState(true);
  const [curves, setCurves] = useState<ReadonlyMap<string, Loaded<ItemCurve>>>(new Map());
  const asked = useRef(new Set<string>());
  const wanted = useMemo(() => curveWears(name, variants), [name, variants]);
  const wantedKey = wanted.map((wear) => wear.name).join('\0');

  useEffect(() => {
    for (const wear of wanted) {
      const key = `${venue}:${wear.name}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      const settle = (next: Loaded<ItemCurve>): void => setCurves((current) => new Map(current).set(key, next));
      engine.itemCurve(wear.name, venue)
        .then((value) => settle({ state: 'ready', value }))
        .catch((failure: unknown) => settle({ state: 'failed', error: failure instanceof Error ? failure.message : String(failure) }));
    }
    // `wantedKey` stands for `wanted`: the list is rebuilt when the variants arrive, the names not always.
  }, [wantedKey, venue]);

  const entries = wanted.map((wear) => ({ ...wear, loaded: curves.get(`${venue}:${wear.name}`) ?? ({ state: 'loading' } as const) }));
  const wears: CurveWear[] = entries.map((entry) => ({
    code: entry.code, name: entry.name, current: entry.current,
    doc: entry.loaded.state === 'ready' ? entry.loaded.value?.doc ?? null : null
  }));
  if (wanted.length === 0) return null;

  const docs = wears.flatMap((wear) => (wear.doc ? [wear.doc] : []));
  const state = docs.length > 0 ? 'ok'
    : entries.some((entry) => entry.loaded.state === 'loading') ? 'loading'
      : entries.every((entry) => entry.loaded.state === 'failed') ? 'failed' : 'absent';
  const own = wears.find((wear) => wear.current)?.doc ?? docs[0] ?? null;
  const range = docs.find((doc) => doc.floatRange)?.floatRange
    ?? (variants && variants.minFloat !== null && variants.maxFloat !== null ? { min: variants.minFloat, max: variants.maxFloat } : { min: 0, max: 1 });
  const failure = entries.find((entry) => entry.loaded.state === 'failed')?.loaded;

  return (
    <Panel className="items-panel items-curve">
      <PanelHeader
        title="Float curve"
        icon="activity"
        subtitle={own ? <span title={own.computedAt ? `Computed ${new Date(own.computedAt).toLocaleString()} by CSlytics from ${own.venue === 'steam' ? 'Steam' : 'CSFloat'} listings` : undefined}>{own.currency}{own.computedAt ? ` · ${freshness(own.computedAt, new Date()).label}` : ''}</span> : null}
        actions={<Segmented label="Venue" value={venue} onChange={setVenue} options={VENUES} />}
      />
      <div className="panel-body" data-testid="item-curve" data-state={state} data-venue={venue}>
        {state === 'loading' ? <ChartSkeleton testId="item-curve-skeleton" height={300} /> : null}
        {state === 'failed' && failure?.state === 'failed' ? <Notice tone="error" role="status">{failure.error}</Notice> : null}
        {state === 'absent' ? <Empty icon="activity" title="No curve published" /> : null}
        {state === 'ok' && own ? (
          <>
            <div className="curve-toolbar" role="group" aria-label="Layers">
              {LAYERS.map((layer) => (
                <Pill key={layer.id} selected={layers[layer.id]} onClick={() => setLayers((current) => ({ ...current, [layer.id]: !current[layer.id] }))}>
                  <span className="curve-key" data-layer={layer.id} aria-hidden="true" />{layer.label}
                </Pill>
              ))}
              <span className="curve-toolbar-gap" />
              <Pill selected={log} onClick={() => setLog(!log)}>Log</Pill>
            </div>
            <FloatCurveChart
              testId="item-curve-chart"
              wears={wears}
              range={range}
              floats={floats}
              layers={layers}
              log={log}
              currency={own.currency}
              resetKey={`${name}:${venue}`}
            />
          </>
        ) : null}
      </div>
    </Panel>
  );
}
