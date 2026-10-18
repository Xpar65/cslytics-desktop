import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CurveDoc, CurveVertex } from '@cslytics/market-data';
import { IconButton } from '../../components/ui.js';
import { formatAmount, formatTick } from '../../lib/money.js';
import {
  WEAR_BANDS, clampView, floatDigits, linearTicks, logTicks, panBy, priceAtFloat, priceExtent, sameView, zoomAbout,
  type Range, type View, type WearCode
} from './curve-math.js';

/**
 * A skin's float curves, every wear at once across its whole float range, the way the CSlytics
 * float-curves page draws them: the wear bands behind, each wear's fair price as a solid line in
 * its colour, the lowest ask dashed and the highest bid dotted (a gap in the bid is real, so it is
 * never bridged), and the listings the curves were fitted to as dots. Price runs on a log axis by
 * default, because a skin's cheapest and dearest floats are often two orders of magnitude apart.
 *
 * The wear this page is about is drawn on top and stronger; the person's own floats are marked
 * where they sit on it. Ctrl and the wheel zoom about the pointer (with Shift, the price axis), so
 * a plain wheel still scrolls the page; drag pans, Shift and drag zooms to a box, a double click or
 * 0 resets, and the buttons in the corner do the same. Every price is in the document's currency,
 * which the free CDN publishes in USD and the panel names once.
 */

export type CurveWear = {
  code: WearCode;
  /** The market name the curve is for. */
  name: string;
  doc: CurveDoc | null;
  /** The wear the page is about. */
  current: boolean;
};

export type CurveLayers = { fair: boolean; ask: boolean; bid: boolean; listings: boolean };

type Layer = 'fair' | 'ask' | 'bid';
type Line = { key: string; code: WearCode; layer: Layer; current: boolean; points: readonly CurveVertex[] };
type Dot = { code: WearCode; current: boolean; x: number; y: number };
type Held = { x: number; y: number | null; code: WearCode | null };
type Tip = { left: number; top: number; title: string; code: WearCode | null; float: number; price: number };

const HEIGHT = 340;
const PAD = { left: 8, right: 64, top: 22, bottom: 24 };
const LAYER_LABEL: Readonly<Record<Layer | 'listing', string>> = { fair: 'fair', ask: 'lowest ask', bid: 'highest bid', listing: 'listing' };
/** How near the pointer a point must be, in pixels, for the tooltip to name it. */
const REACH = 14;

const wearVariable = (code: WearCode): string => `--wear-${code.toLowerCase()}`;

export function FloatCurveChart({ wears, range, floats, layers, log, currency, resetKey, testId }: {
  wears: readonly CurveWear[];
  /** The skin's float range: the x axis, whatever part of it each curve covers. */
  range: { min: number; max: number };
  /** Floats the scope holds of the page's own name. */
  floats: readonly number[];
  layers: CurveLayers;
  log: boolean;
  currency: string;
  /** A change puts the view back to the whole range: another item, another venue. */
  resetKey: string;
  testId?: string | undefined;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const clipId = useId();
  const [width, setWidth] = useState(720);
  const [view, setView] = useState<View | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const drag = useRef<{ mode: 'pan' | 'box'; x: number; y: number; from: View } | null>(null);

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

  // A new item, venue or axis is a new chart: a zoom kept from the last one would frame nothing.
  useEffect(() => { setView(null); setTip(null); }, [resetKey, log]);

  const drawn = useMemo(() => {
    const lines: Line[] = [];
    const dots: Dot[] = [];
    const prices: number[] = [];
    // The page's own wear last, so it is drawn on top of its neighbours.
    const ordered = [...wears].sort((a, b) => Number(a.current) - Number(b.current));
    for (const wear of ordered) {
      const doc = wear.doc;
      if (!doc) continue;
      const add = (layer: Layer, points: readonly CurveVertex[], index = 0): void => {
        const usable = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!log || y > 0));
        if (usable.length === 0) return;
        for (const point of usable) prices.push(point[1]);
        lines.push({ key: `${wear.code}-${layer}-${index}`, code: wear.code, layer, current: wear.current, points: usable });
      };
      if (layers.fair && doc.fairPrice) add('fair', doc.fairPrice.vertices);
      if (layers.ask && doc.lowestAsk) add('ask', doc.lowestAsk.vertices);
      if (layers.bid && doc.highestBid) doc.highestBid.segments.forEach((segment, index) => add('bid', segment, index));
      if (layers.listings) {
        for (const listing of doc.listings) {
          if (listing.float === null || !Number.isFinite(listing.price) || listing.price <= 0) continue;
          dots.push({ code: wear.code, current: wear.current, x: listing.float, y: listing.price });
          prices.push(listing.price);
        }
      }
    }
    // A held float sits on the fair line of the wear it falls in, when that wear has one.
    const held: Held[] = floats.map((float) => {
      const band = WEAR_BANDS.find((entry) => float >= entry.lo && float < entry.hi) ?? null;
      const doc = wears.find((wear) => wear.code === band?.code)?.doc ?? null;
      const y = priceAtFloat(doc?.fairPrice?.vertices, float);
      if (y !== null && (!log || y > 0)) prices.push(y);
      return { x: float, y: y !== null && (!log || y > 0) ? y : null, code: band?.code ?? null };
    });
    return { lines, dots, held, prices };
  }, [wears, floats, layers, log]);

  const full = useMemo<View>(() => {
    const span = Math.max(1e-6, range.max - range.min);
    const [low, high] = priceExtent(drawn.prices, log);
    const y: Range = log
      ? [Math.exp(Math.log(low) - (Math.log(high) - Math.log(low)) * 0.06), Math.exp(Math.log(high) + (Math.log(high) - Math.log(low)) * 0.06)]
      : [low, high + (high - low) * 0.06];
    return { x: [Math.max(0, range.min - span * 0.02), Math.min(1, range.max + span * 0.02)], y };
  }, [drawn.prices, range.min, range.max, log]);

  const shown = clampView(view ?? full, full, log);
  const zoomed = !sameView(shown, full);
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const toY = (value: number): number => (log ? Math.log(Math.max(value, Number.MIN_VALUE)) : value);
  const yLow = toY(shown.y[0]);
  const ySpan = toY(shown.y[1]) - yLow || 1;
  const sx = (x: number): number => PAD.left + ((x - shown.x[0]) / (shown.x[1] - shown.x[0] || 1)) * plotWidth;
  const sy = (y: number): number => PAD.top + (1 - (toY(y) - yLow) / ySpan) * plotHeight;
  const invertX = (pixel: number): number => shown.x[0] + ((pixel - PAD.left) / plotWidth) * (shown.x[1] - shown.x[0]);
  const invertY = (pixel: number): number => {
    const value = yLow + (1 - (pixel - PAD.top) / plotHeight) * ySpan;
    return log ? Math.exp(value) : value;
  };
  const apply = (next: View): void => { setView(clampView(next, full, log)); setTip(null); };
  const zoomCentre = (factor: number): void => apply(zoomAbout(shown, (shown.x[0] + shown.x[1]) / 2, log ? Math.sqrt(shown.y[0] * shown.y[1]) : (shown.y[0] + shown.y[1]) / 2, factor, factor, log));
  const reset = (): void => { setView(null); setTip(null); setBox(null); };

  // Ctrl and the wheel zoom, and only then is the page's scroll taken; a plain wheel scrolls past.
  const wheel = useRef<(event: WheelEvent) => void>(() => undefined);
  wheel.current = (event: WheelEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const rect = frame.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
    const at = { x: invertX(event.clientX - rect.left), y: invertY(event.clientY - rect.top) };
    apply(zoomAbout(shown, at.x, at.y, event.shiftKey ? 1 : factor, event.shiftKey ? factor : 1, log));
  };
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const listener = (event: WheelEvent): void => wheel.current(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const rect = frame.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
  };

  const nearest = (at: { x: number; y: number }): Tip | null => {
    let best: Tip | null = null;
    let bestDistance = REACH;
    const consider = (x: number, y: number, title: string, code: WearCode | null): void => {
      const px = sx(x);
      const py = sy(y);
      const distance = Math.hypot(px - at.x, py - at.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { left: px, top: py, title, code, float: x, price: y };
      }
    };
    for (const mark of drawn.held) if (mark.y !== null) consider(mark.x, mark.y, 'Your float', mark.code);
    for (const line of drawn.lines) for (const [x, y] of line.points) consider(x, y, `${line.code} ${LAYER_LABEL[line.layer]}`, line.code);
    for (const dot of drawn.dots) consider(dot.x, dot.y, `${dot.code} ${LAYER_LABEL.listing}`, dot.code);
    return best;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const at = local(event);
    if (!at) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { mode: event.shiftKey ? 'box' : 'pan', x: at.x, y: at.y, from: shown };
    if (event.shiftKey) setBox({ x1: at.x, y1: at.y, x2: at.x, y2: at.y });
    setTip(null);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = local(event);
    if (!at) return;
    const held = drag.current;
    if (held?.mode === 'pan') {
      const dx = -(at.x - held.x) / plotWidth;
      const dy = (at.y - held.y) / plotHeight;
      if (Math.abs(at.x - held.x) + Math.abs(at.y - held.y) > 2) setView(clampView(panBy(held.from, dx, dy, log), full, log));
      return;
    }
    if (held?.mode === 'box') { setBox({ x1: held.x, y1: held.y, x2: at.x, y2: at.y }); return; }
    setTip(nearest(at));
  };
  const onPointerUp = (): void => {
    const held = drag.current;
    drag.current = null;
    if (held?.mode !== 'box' || !box) return;
    setBox(null);
    if (Math.abs(box.x2 - box.x1) < 8 || Math.abs(box.y2 - box.y1) < 8) return;
    const xs = [invertX(Math.min(box.x1, box.x2)), invertX(Math.max(box.x1, box.x2))] as const;
    const ys = [invertY(Math.max(box.y1, box.y2)), invertY(Math.min(box.y1, box.y2))] as const;
    apply({ x: xs, y: ys });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = 0.1;
    if (event.key === '0') { event.preventDefault(); reset(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomCentre(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomCentre(1 / 1.25); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      apply(panBy(shown, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0, log));
    } else if (event.key === 'Escape' && (tip || zoomed)) { event.preventDefault(); event.stopPropagation(); if (tip) setTip(null); else reset(); }
  };

  if (drawn.lines.length === 0 && drawn.dots.length === 0) {
    return <div className="price-chart-empty" data-testid={testId}>Nothing to draw with these layers</div>;
  }

  const xTicks = linearTicks(shown.x[0], shown.x[1], width < 560 ? 4 : 8);
  const digits = floatDigits(xTicks);
  const yTicks = log ? logTicks(shown.y[0], shown.y[1], 5) : linearTicks(shown.y[0], shown.y[1], 5);
  const bands = WEAR_BANDS
    .map((band) => ({ ...band, x1: sx(Math.max(band.lo, range.min)), x2: sx(Math.min(band.hi, range.max)) }))
    .filter((band) => band.hi > range.min && band.lo < range.max && band.x2 > PAD.left && band.x1 < PAD.left + plotWidth);
  const currentCode = wears.find((wear) => wear.current)?.code ?? null;
  const path = (points: readonly CurveVertex[]): string => points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join(' ');
  const flip = tip !== null && tip.left > width * 0.62;

  return (
    <div
      ref={frame}
      className="curve-chart"
      data-testid={testId}
      data-zoomed={zoomed || undefined}
      tabIndex={0}
      role="group"
      aria-label="Price against float for every wear. Ctrl and the wheel zoom, drag pans, Shift and drag zooms to a box, 0 resets."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse' && !drag.current) setTip(null); }}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      style={{ height: HEIGHT }}
    >
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true">
        <defs>
          <clipPath id={clipId}><rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} /></clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {bands.map((band) => (
            <rect key={band.code} className="curve-band" data-current={band.code === currentCode} x={band.x1} y={PAD.top} width={Math.max(0, band.x2 - band.x1)} height={plotHeight} style={{ fill: `var(${wearVariable(band.code)})` }} />
          ))}
        </g>
        {yTicks.map((tick) => (
          <g key={`y${tick}`} className="price-chart-grid">
            <line x1={PAD.left} x2={width - PAD.right} y1={sy(tick)} y2={sy(tick)} />
            <text x={width - PAD.right + 8} y={sy(tick)} dominantBaseline="middle">{formatTick(Math.round(tick * 100), currency)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={`x${tick}`} className="price-chart-tick" x={sx(tick)} y={HEIGHT - 6} textAnchor="middle">{tick.toFixed(digits)}</text>
        ))}
        {bands.map((band) => {
          const centre = (Math.max(band.x1, PAD.left) + Math.min(band.x2, PAD.left + plotWidth)) / 2;
          return Math.min(band.x2, PAD.left + plotWidth) - Math.max(band.x1, PAD.left) < 22 ? null : (
            <text key={`l${band.code}`} className="curve-band-label" data-current={band.code === currentCode} x={centre} y={PAD.top - 8} textAnchor="middle" style={{ fill: `var(${wearVariable(band.code)})` }}>{band.code}</text>
          );
        })}
        <g clipPath={`url(#${clipId})`}>
          {drawn.dots.map((dot, index) => (
            <circle key={index} className="curve-dot" data-current={dot.current} cx={sx(dot.x)} cy={sy(dot.y)} r={2.2} style={{ fill: `var(${wearVariable(dot.code)})` }} />
          ))}
          {drawn.lines.map((line) => (
            <path key={line.key} className="curve-line" data-layer={line.layer} data-current={line.current} d={path(line.points)} style={{ stroke: `var(${wearVariable(line.code)})` }} />
          ))}
          {drawn.held.map((mark, index) => (
            <g key={`h${index}`} className="curve-held">
              <line x1={sx(mark.x)} x2={sx(mark.x)} y1={PAD.top} y2={PAD.top + plotHeight} />
              {mark.y !== null ? <circle cx={sx(mark.x)} cy={sy(mark.y)} r={4.5} /> : null}
            </g>
          ))}
          {tip ? <circle className="curve-hover" cx={tip.left} cy={tip.top} r={5} style={tip.code ? { stroke: `var(${wearVariable(tip.code)})` } : undefined} /> : null}
        </g>
        {box ? (
          <rect className="curve-box" x={Math.min(box.x1, box.x2)} y={Math.min(box.y1, box.y2)} width={Math.abs(box.x2 - box.x1)} height={Math.abs(box.y2 - box.y1)} />
        ) : null}
      </svg>
      <div className="curve-zoom">
        <IconButton icon="plus" size="sm" label="Zoom in" onClick={() => zoomCentre(1.5)} />
        <IconButton icon="minus" size="sm" label="Zoom out" disabled={!zoomed} onClick={() => zoomCentre(1 / 1.5)} />
        <IconButton icon="undo" size="sm" label="Reset zoom" disabled={!zoomed} onClick={reset} />
      </div>
      {tip ? (
        <div
          className="price-chart-tooltip"
          data-testid={testId ? `${testId}-tooltip` : undefined}
          style={{ top: Math.max(4, tip.top - 44), left: flip ? undefined : tip.left + 12, right: flip ? width - tip.left + 12 : undefined }}
        >
          <div className="price-chart-tooltip-x">{tip.title}</div>
          <div className="price-chart-tooltip-row">
            <span className="price-chart-swatch" style={tip.code ? { background: `var(${wearVariable(tip.code)})` } : undefined} />
            <span className="price-chart-tooltip-label num">{tip.float.toFixed(4)}</span>
            <span className="num">{formatAmount(Math.round(tip.price * 100), currency)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
