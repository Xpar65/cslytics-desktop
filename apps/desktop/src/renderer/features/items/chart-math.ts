/**
 * The arithmetic under the Items page's charts, kept apart from the component so it can be tested
 * in a node environment with no DOM: which point the pointer is over, where the gridlines go, and
 * how a date tick reads at a given span.
 */

/**
 * The index of the value in `xs` nearest to `x`. `xs` must be ascending, which every series here
 * is: Steam's history by time, a curve by float. Ties go to the earlier point. `-1` when empty.
 */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let low = 0;
  let high = xs.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (xs[middle]! < x) low = middle + 1;
    else high = middle;
  }
  // `low` is the first value at or past `x`; the one before it may be nearer.
  if (low > 0 && Math.abs(xs[low - 1]! - x) <= Math.abs(xs[low]! - x)) return low - 1;
  return low;
}

/** A step of 1, 2, 2.5 or 5 times a power of ten, at least `raw`: the steps a person reads a scale in. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * About `count` gridline values covering `[min, max]`, on round steps, and the domain those lines
 * span. A flat series gets a band around its one value rather than a zero-height scale.
 */
export function niceScale(min: number, max: number, count = 4): { ticks: number[]; min: number; max: number } {
  let low = min;
  let high = max;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { ticks: [], min: 0, max: 1 };
  if (low === high) {
    const pad = Math.abs(low) * 0.05 || 1;
    low -= pad;
    high += pad;
  }
  const step = niceStep((high - low) / Math.max(1, count));
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // Rounded to the step's precision, so 0.1 + 0.2 does not become a tick label of 0.30000000000000004.
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Number(value.toFixed(digits)));
  return { ticks, min: start, max: end };
}

const DAY_MS = 86_400_000;

/** About `count` evenly spaced instants across `[min, max]`, ends included. */
export function timeTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const steps = Math.max(1, count - 1);
  return Array.from({ length: steps + 1 }, (_, index) => min + ((max - min) * index) / steps);
}

/** How an axis tick reads at a span: hours under two days, day and month under a year, else month and year. */
export function formatTimeTick(at: number, spanMs: number): string {
  const date = new Date(at);
  if (spanMs < 2 * DAY_MS) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (spanMs < 365 * DAY_MS) return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Whether the point at `index` is one of Steam's hourly rows. Steam's series is daily, then hourly
 * for about the last month; a point closer than a day to a neighbour is an hour, and its tooltip
 * names the hour as well as the date.
 */
export function isHourly(xs: readonly number[], index: number): boolean {
  const here = xs[index];
  if (here === undefined) return false;
  const before = index > 0 ? here - xs[index - 1]! : Infinity;
  const after = index < xs.length - 1 ? xs[index + 1]! - here : Infinity;
  return Math.min(before, after) < DAY_MS - 60_000;
}
