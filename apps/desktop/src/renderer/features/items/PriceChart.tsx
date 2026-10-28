import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { bucketStart, formatTimeTick, isHourly, nearestIndex, niceScale, timeTicks, volumeBars, type VolumeUnit } from './chart-math.js';

/**
 * One interactive line chart over time, drawn in SVG at the size it is shown, with no library.
 *
 * The pointer (or Left and Right once the chart has focus) moves a crosshair to the nearest point
 * of the first series, and a tooltip names its date, each series' value there and, where a point
 * carries one, its sales count. A series whose range does not reach the pointer is left out of the
 * tooltip rather than reporting its end. The float curve has a chart of its own (`FloatCurveChart`).
 *
 * Where the first series carries sales counts, they stand behind the line as bars of sales per
 * unit time, in a band along the foot of the plot. The price keeps the only axis: the bars have
 * no scale of their own beside it, because two scales on one plot line up wherever they are drawn
 * and so suggest a relation the data never showed. The key above the plot names the bars' unit
 * and their peak, and the tooltip gives the bucket under the pointer exactly.
 *
 * Prices are in hundredths of the series' currency; `formatY` prints them with their code, and
 * `formatTick`, when given, prints the gridlines without it for a panel that names the code once.
 */

export type ChartPoint = { x: number; y: number; volume?: number | undefined };
export type ChartSeries = { id: string; label: string; variable: string; points: readonly ChartPoint[] };

const HEIGHT = 260;
const PAD = { left: 8, right: 72, top: 12, bottom: 26 };
/** The strip above the plot that holds the key, when there is one. */
const KEY = 20;
/** The tallest bar's share of the plot's height: the bars are a background, never the subject. */
const VOLUME_BAND = 0.34;
/** The narrowest slot a bar may have: two pixels of bar and two of gap. */
const MIN_SLOT = 4;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

const PER: Record<VolumeUnit, { key: string; tip: string }> = {
  'hour': { key: 'Sold per hour', tip: 'that hour' },
  'six-hours': { key: 'Sold per 6 hours', tip: 'in those 6 hours' },
  'day': { key: 'Sold per day', tip: 'that day' },
  'week': { key: 'Sold per week', tip: 'that week' },
  'month': { key: 'Sold per month', tip: 'that month' }
};
/** What a bar the series covers only part of adds to its tooltip, so its low height is not read as a slump. */
const PARTIAL = { whole: '', start: ' within the span', end: ' so far' } as const;

export function PriceChart({ series, formatY, formatTick = formatY, ariaLabel, height = HEIGHT, testId }: {
  series: readonly ChartSeries[];
  formatY: (y: number) => string;
  formatTick?: ((y: number) => string) | undefined;
  ariaLabel: string;
  height?: number | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const liveId = useId();

  // Drawn at the pixel width it is shown at, so text and strokes are never stretched.
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const drawn = useMemo(() => series.filter((row) => row.points.length > 0), [series]);
  const primary = drawn[0];
  const primaryXs = useMemo(() => primary?.points.map((point) => point.x) ?? [], [primary]);

  const geometry = useMemo(() => {
    const all = drawn.flatMap((row) => row.points);
    if (all.length === 0 || !drawn[0]) return null;
    const plotWidth = Math.max(1, width - PAD.left - PAD.right);
    const bars = volumeBars(drawn[0].points, Math.floor(plotWidth / MIN_SLOT));
    const keyed = bars !== null || drawn.length > 1;
    const top = PAD.top + (keyed ? KEY : 0);
    // The axis runs from the first bar's start to the last bar's end, so every bar is whole.
    const xMin = Math.min(...all.map((point) => point.x), bars?.buckets[0]?.start ?? Infinity);
    const xMax = Math.max(...all.map((point) => point.x), bars?.buckets[bars.buckets.length - 1]?.end ?? -Infinity);
    const scale = niceScale(Math.min(...all.map((point) => point.y)), Math.max(...all.map((point) => point.y)), 4);
    const plotHeight = Math.max(1, height - top - PAD.bottom);
    const sx = (value: number): number => PAD.left + (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin)) * plotWidth;
    const sy = (value: number): number => top + (scale.max === scale.min ? 0.5 : 1 - (value - scale.min) / (scale.max - scale.min)) * plotHeight;
    const invertX = (pixel: number): number => xMin + ((pixel - PAD.left) / plotWidth) * (xMax - xMin);
    return { xMin, xMax, scale, top, plotWidth, plotHeight, sx, sy, invertX, bars, keyed };
  }, [drawn, width, height]);

  // A new series is a new chart: a crosshair left over from the last one would point at nothing.
  // Keyed by what the series are, not by identity, so a parent's re-render does not clear it.
  const signature = drawn.map((row) => `${row.id}:${row.points.length}:${row.points[0]?.x ?? ''}`).join('|');
  useEffect(() => { setHover(null); }, [signature]);

  if (!geometry || !primary) return <div className="price-chart-empty" data-testid={testId}>Nothing to draw</div>;
  const { xMin, xMax, scale, top, plotHeight, sx, sy, invertX, bars, keyed } = geometry;
  const span = xMax - xMin;
  const xTicks = timeTicks(xMin, xMax, width < 480 ? 3 : 5);
  const base = top + plotHeight;

  const hovered = hover === null ? null : primary.points[hover] ?? null;
  const rows = hovered === null ? [] : tooltipRows(drawn, hovered.x);
  const pointerLabel = hovered === null ? '' : new Date(hovered.x).toLocaleString(undefined, isHourly(primaryXs, hover!)
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
  // The bar under the pointer, which the tooltip reads rather than the row: a row is an hour or a
  // day, and the bar may be a day or a week of them.
  const hoveredStart = hovered && bars ? bucketStart(hovered.x, bars.unit) : null;
  const hoveredBucket = hoveredStart === null || !bars ? null : bars.buckets.find((bucket) => bucket.start === hoveredStart) ?? null;
  const soldLine = hoveredBucket && bars ? `${hoveredBucket.volume.toLocaleString()} sold ${PER[bars.unit].tip}${PARTIAL[hoveredBucket.partial ?? 'whole']}`
    : rows[0]?.point.volume !== undefined ? `${rows[0].point.volume.toLocaleString()} sold` : null;
  const spoken = hovered === null ? '' : `${pointerLabel}: ${rows.map((row) => `${row.label} ${formatY(row.point.y)}`).join('; ')}${soldLine ? `; ${soldLine}` : ''}`;

  const track = (clientX: number): void => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const index = nearestIndex(primaryXs, invertX(clientX - box.left));
    setHover(index === -1 ? null : index);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = primary.points.length - 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const from = hover ?? (event.key === 'ArrowLeft' ? last + 1 : -1);
      setHover(Math.max(0, Math.min(last, from + (event.key === 'ArrowLeft' ? -step : step))));
    } else if (event.key === 'Home') { event.preventDefault(); setHover(0); }
    else if (event.key === 'End') { event.preventDefault(); setHover(last); }
    else if (event.key === 'Escape' && hover !== null) { event.preventDefault(); event.stopPropagation(); setHover(null); }
  };

  const crossX = hovered ? sx(hovered.x) : 0;
  // The tooltip sits beside the crosshair, and flips to its left near the right edge.
  const flip = crossX > width * 0.6;

  return (
    <div
      ref={frame}
      className="price-chart"
      data-testid={testId}
      data-hover={hover ?? undefined}
      data-volume-unit={bars?.unit}
      tabIndex={0}
      role="group"
      aria-label={`${ariaLabel}. Use the left and right arrow keys to read values.`}
      aria-describedby={liveId}
      onPointerMove={(event) => track(event.clientX)}
      onPointerDown={(event) => track(event.clientX)}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') setHover(null); }}
      onKeyDown={onKeyDown}
      onBlur={() => setHover(null)}
      style={{ height }}
    >
      {keyed ? (
        <div className="price-chart-key" style={{ top: PAD.top - 6, left: PAD.left }}>
          {drawn.map((row) => (
            <span key={row.id} className="price-chart-key-item">
              <span className="price-chart-key-line" style={{ background: `var(${row.variable})` }} aria-hidden="true" />
              {row.label}
            </span>
          ))}
          {bars ? (
            <span className="price-chart-key-item" data-testid={testId ? `${testId}-volume-key` : undefined}>
              <span className="price-chart-key-bar" aria-hidden="true" />
              {PER[bars.unit].key}
              <span className="price-chart-key-peak num">peak {bars.peak.toLocaleString()}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {scale.ticks.map((tick) => (
          <g key={`y${tick}`} className="price-chart-grid">
            <line x1={PAD.left} x2={width - PAD.right} y1={sy(tick)} y2={sy(tick)} />
            <text x={width - PAD.right + 8} y={sy(tick)} dominantBaseline="middle">{formatTick(tick)}</text>
          </g>
        ))}
        {bars && bars.peak > 0 ? (
          <g className="price-chart-volume" data-testid={testId ? `${testId}-volume` : undefined}>
            {bars.buckets.map((bucket) => {
              if (bucket.volume === 0) return null;
              const x0 = sx(bucket.start);
              const slot = sx(bucket.end) - x0;
              const barWidth = Math.max(1, Math.min(MAX_BAR, slot - GAP));
              // A bucket with a sale is never drawn flat: one pixel says there was trade.
              const barHeight = Math.max(1, (bucket.volume / bars.peak) * plotHeight * VOLUME_BAND);
              return (
                <path
                  key={bucket.start}
                  d={barPath(x0 + (slot - barWidth) / 2, base, barWidth, barHeight)}
                  data-active={bucket.start === hoveredStart || undefined}
                  data-partial={bucket.partial}
                />
              );
            })}
          </g>
        ) : null}
        {xTicks.map((tick, index) => (
          <text
            key={`x${index}`}
            className="price-chart-tick"
            x={sx(tick)}
            y={height - 8}
            textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}
          >
            {formatTimeTick(tick, span)}
          </text>
        ))}
        {drawn.map((row) => (
          <path
            key={row.id}
            className="price-chart-line"
            d={row.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`).join(' ')}
            style={{ stroke: `var(${row.variable})` }}
          />
        ))}
        {hovered ? (
          <g className="price-chart-cursor">
            <line x1={crossX} x2={crossX} y1={top} y2={base} />
            {rows.map((row) => (
              <circle key={row.id} cx={sx(row.point.x)} cy={sy(row.point.y)} r={4} style={{ fill: `var(${row.variable})` }} />
            ))}
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <div
          className="price-chart-tooltip"
          data-testid={testId ? `${testId}-tooltip` : undefined}
          data-flip={flip || undefined}
          style={{ left: flip ? undefined : crossX + 12, right: flip ? width - crossX + 12 : undefined }}
        >
          <div className="price-chart-tooltip-x">{pointerLabel}</div>
          {rows.map((row) => (
            <div key={row.id} className="price-chart-tooltip-row">
              <span className="price-chart-swatch" style={{ background: `var(${row.variable})` }} />
              <span className="price-chart-tooltip-label">{row.label}</span>
              <span className="num">{formatY(row.point.y)}</span>
            </div>
          ))}
          {soldLine ? <div className="price-chart-tooltip-sub num">{soldLine}</div> : null}
        </div>
      ) : null}
      <div id={liveId} className="visually-hidden" aria-live="polite">{spoken}</div>
    </div>
  );
}

/** A bar standing on `base`: square where it meets the baseline, its top corners rounded. */
function barPath(x: number, base: number, width: number, height: number): string {
  const radius = Math.min(RADIUS, width / 2, height);
  const top = base - height;
  return `M${x.toFixed(1)} ${base.toFixed(1)}V${(top + radius).toFixed(1)}`
    + `Q${x.toFixed(1)} ${top.toFixed(1)} ${(x + radius).toFixed(1)} ${top.toFixed(1)}`
    + `H${(x + width - radius).toFixed(1)}`
    + `Q${(x + width).toFixed(1)} ${top.toFixed(1)} ${(x + width).toFixed(1)} ${(top + radius).toFixed(1)}`
    + `V${base.toFixed(1)}Z`;
}

/**
 * Each series' point nearest `at`, one row per label, for the series whose range reaches it.
 * A curve's bid line is several segments under one label; the segment the pointer is in answers.
 */
function tooltipRows(series: readonly ChartSeries[], at: number): Array<{ id: string; label: string; variable: string; point: ChartPoint }> {
  const rows: Array<{ id: string; label: string; variable: string; point: ChartPoint }> = [];
  const seen = new Set<string>();
  for (const row of series) {
    if (seen.has(row.label)) continue;
    const first = row.points[0];
    const last = row.points[row.points.length - 1];
    if (!first || !last || at < first.x || at > last.x) continue;
    const index = nearestIndex(row.points.map((point) => point.x), at);
    if (index === -1) continue;
    rows.push({ id: row.id, label: row.label, variable: row.variable, point: row.points[index]! });
    seen.add(row.label);
  }
  return rows;
}
