import type { CurveVertex } from '@cslytics/market-data';
import type { ItemVariants } from '../../../shared/market.js';
import { WEAR_TIERS } from '@cslytics/ports';

/**
 * The arithmetic under the float curve, apart from the component so it runs in a node test: where
 * each wear sits on the float axis, what a curve says at one float, where the gridlines go on a
 * linear or a log price axis, and how a view zooms and pans without leaving the data.
 *
 * A view is a pair of ranges in data units: floats across, whole currency units up.
 */

export type Range = readonly [number, number];
export type View = { x: Range; y: Range };

export type WearCode = (typeof WEAR_TIERS)[number]['code'];

/** Each wear's float band, from Valve's fixed thresholds; Battle-Scarred ends at 1. */
export const WEAR_BANDS: ReadonlyArray<{ code: WearCode; label: string; lo: number; hi: number }> = WEAR_TIERS.map((tier, index) => ({
  code: tier.code,
  label: tier.label,
  lo: index === 0 ? 0 : WEAR_TIERS[index - 1]!.max,
  hi: Math.min(1, tier.max)
}));

/** The tier a market name is sold in, from its `(Field-Tested)` suffix, or `null` for an item with no wear. */
export function wearOfName(name: string): WearCode | null {
  const suffix = /\(([^()]+)\)\s*$/.exec(name)?.[1];
  return WEAR_BANDS.find((band) => band.label === suffix)?.code ?? null;
}

/** The wears a curve can be drawn for: every tier the item is sold in, or just this name's own. */
export function curveWears(name: string, variants: ItemVariants | null): Array<{ code: WearCode; name: string; current: boolean }> {
  const tiers = (variants?.variants ?? []).flatMap((variant) => {
    const band = WEAR_BANDS.find((entry) => entry.code === variant.tier);
    return band ? [{ code: band.code, name: variant.name, current: variant.name === name }] : [];
  });
  if (tiers.some((tier) => tier.current)) return tiers;
  const own = wearOfName(name);
  return own ? [{ code: own, name, current: true }] : [];
}

/** A curve's price at one float, straight between its vertices and flat past either end. */
export function priceAtFloat(vertices: readonly CurveVertex[] | null | undefined, float: number): number | null {
  if (!vertices || vertices.length === 0) return null;
  const first = vertices[0]!;
  const last = vertices[vertices.length - 1]!;
  if (vertices.length === 1 || float <= first[0]) return first[1];
  if (float >= last[0]) return last[1];
  let low = 0;
  let high = vertices.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (vertices[middle]![0] <= float) low = middle;
    else high = middle;
  }
  const [ax, ay] = vertices[low]!;
  const [bx, by] = vertices[high]!;
  return bx === ax ? by : ay + (by - ay) * ((float - ax) / (bx - ax));
}

/** The bid at one float, or `null` in a gap: nothing is bid there, so nothing is drawn across it. */
export function bidAtFloat(segments: ReadonlyArray<readonly CurveVertex[]> | null | undefined, float: number): number | null {
  for (const segment of segments ?? []) {
    const first = segment[0];
    const last = segment[segment.length - 1];
    if (first && last && first[0] <= float && float <= last[0]) return priceAtFloat(segment, float);
  }
  return null;
}

/** The price range to draw: zero to the top on a linear axis, the data's own range on a log one. */
export function priceExtent(values: readonly number[], log: boolean): Range {
  const usable = values.filter((value) => Number.isFinite(value) && (!log || value > 0));
  if (usable.length === 0) return log ? [1, 10] : [0, 1];
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  if (low === high) return log ? [low / 2, low * 2] : [0, high * 1.1 || 1];
  return log ? [low, high] : [0, high];
}

/** A step of 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** About `count` round values inside `[min, max]`, for gridlines that stay put while the view moves. */
export function linearTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const step = niceStep((max - min) / Math.max(1, count));
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toFixed(digits)));
  return ticks;
}

/**
 * Gridlines on a log axis: 1, 2 and 5 of each decade, thinned to 1 and 3, then to 1, until no more
 * than `count + 2` fit. A view zoomed inside one decade has too few of those, and gets linear ones.
 */
export function logTicks(min: number, max: number, count = 5): number[] {
  if (!(min > 0) || !(max > min)) return [min];
  const from = Math.floor(Math.log10(min));
  const to = Math.ceil(Math.log10(max));
  let best: number[] = [];
  for (const multiples of [[1, 2, 5], [1, 3], [1]]) {
    const ticks: number[] = [];
    for (let power = from; power <= to; power += 1) {
      for (const multiple of multiples) {
        const value = Number((multiple * 10 ** power).toPrecision(6));
        if (value >= min * (1 - 1e-9) && value <= max * (1 + 1e-9)) ticks.push(value);
      }
    }
    best = ticks;
    if (ticks.length <= count + 2) break;
  }
  return best.length >= 2 ? best : linearTicks(min, max, count);
}

/** How many decimals a float tick needs at this spacing: two at least, so 0.1 reads 0.10. */
export function floatDigits(ticks: readonly number[]): number {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 0.1;
  return Math.min(4, Math.max(2, -Math.floor(Math.log10(step || 0.1))));
}

/** The smallest share of the whole a view may shrink to: two hundred times in. */
const MAX_ZOOM = 200;

/** `[low, high]` moved and widened as little as possible to sit inside `[min, max]` and span at least `minSpan`. */
function fit(low: number, high: number, min: number, max: number, minSpan: number): [number, number] {
  let a = low;
  let b = high;
  if (b - a < minSpan) {
    const middle = (a + b) / 2;
    a = middle - minSpan / 2;
    b = middle + minSpan / 2;
  }
  if (a < min) { b += min - a; a = min; }
  if (b > max) { a -= b - max; b = max; }
  a = Math.max(min, a);
  b = Math.min(max, b);
  if (b <= a) b = a + minSpan;
  return [a, b];
}

/** A view kept inside the data's extent, never zoomed further than `MAX_ZOOM`; a log axis is kept in log space. */
export function clampView(view: View, extent: View, log: boolean): View {
  const x = fit(view.x[0], view.x[1], extent.x[0], extent.x[1], (extent.x[1] - extent.x[0]) / MAX_ZOOM || 1e-9);
  if (!log) return { x, y: fit(view.y[0], view.y[1], extent.y[0], extent.y[1], (extent.y[1] - extent.y[0]) / MAX_ZOOM || 1e-9) };
  const lnExtent: Range = [Math.log(Math.max(extent.y[0], Number.MIN_VALUE)), Math.log(Math.max(extent.y[1], extent.y[0] * 1.0001))];
  const [low, high] = fit(Math.log(Math.max(view.y[0], Number.MIN_VALUE)), Math.log(Math.max(view.y[1], view.y[0] * 1.0001)), lnExtent[0], lnExtent[1], (lnExtent[1] - lnExtent[0]) / MAX_ZOOM || 1e-9);
  return { x, y: [Math.exp(low), Math.exp(high)] };
}

/** The view zoomed about one point in data units; a factor over 1 zooms in. */
export function zoomAbout(view: View, cx: number, cy: number, kx: number, ky: number, log: boolean): View {
  const x: Range = [cx + (view.x[0] - cx) / kx, cx + (view.x[1] - cx) / kx];
  if (!log) return { x, y: [cy + (view.y[0] - cy) / ky, cy + (view.y[1] - cy) / ky] };
  const centre = Math.log(Math.max(cy, Number.MIN_VALUE));
  const low = Math.log(Math.max(view.y[0], Number.MIN_VALUE));
  const high = Math.log(Math.max(view.y[1], view.y[0] * 1.0001));
  return { x, y: [Math.exp(centre + (low - centre) / ky), Math.exp(centre + (high - centre) / ky)] };
}

/** The view moved by a share of its own span in each direction; up is a positive `dy`. */
export function panBy(view: View, dx: number, dy: number, log: boolean): View {
  const xSpan = view.x[1] - view.x[0];
  const x: Range = [view.x[0] + dx * xSpan, view.x[1] + dx * xSpan];
  if (!log) {
    const ySpan = view.y[1] - view.y[0];
    return { x, y: [view.y[0] + dy * ySpan, view.y[1] + dy * ySpan] };
  }
  const low = Math.log(Math.max(view.y[0], Number.MIN_VALUE));
  const high = Math.log(Math.max(view.y[1], view.y[0] * 1.0001));
  const span = high - low;
  return { x, y: [Math.exp(low + dy * span), Math.exp(high + dy * span)] };
}

/** Whether two views are the same to within a rounding error: an untouched chart is not "zoomed". */
export function sameView(a: View, b: View): boolean {
  const close = (p: number, q: number): boolean => Math.abs(p - q) <= Math.max(Math.abs(p), Math.abs(q), 1e-12) * 1e-6;
  return close(a.x[0], b.x[0]) && close(a.x[1], b.x[1]) && close(a.y[0], b.y[0]) && close(a.y[1], b.y[1]);
}
