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

const HOUR_MS = 3_600_000;

/** How long one volume bar is. Every bar on a chart is the same length, so their heights compare. */
export type VolumeUnit = 'hour' | 'six-hours' | 'day' | 'week' | 'month';
/**
 * One bar. `partial` marks the bar at either end that the series covers only part of: the week the
 * span starts inside, or the day still going on, whose low bar is time missing, not sales.
 */
export type VolumeBucket = { start: number; end: number; volume: number; partial?: 'start' | 'end' | undefined };
export type VolumeBars = { unit: VolumeUnit; buckets: VolumeBucket[]; peak: number };

const UNITS: readonly VolumeUnit[] = ['hour', 'six-hours', 'day', 'week', 'month'];

/** The start of the bucket holding `at`, in UTC, which is how Steam dates its rows: a week starts on Monday. */
export function bucketStart(at: number, unit: VolumeUnit): number {
  switch (unit) {
    case 'hour': return Math.floor(at / HOUR_MS) * HOUR_MS;
    case 'six-hours': return Math.floor(at / (6 * HOUR_MS)) * 6 * HOUR_MS;
    case 'day': return Math.floor(at / DAY_MS) * DAY_MS;
    case 'week': {
      const day = Math.floor(at / DAY_MS) * DAY_MS;
      return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
    }
    case 'month': {
      const date = new Date(at);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }
  }
}

function bucketEnd(start: number, unit: VolumeUnit): number {
  switch (unit) {
    case 'hour': return start + HOUR_MS;
    case 'six-hours': return start + 6 * HOUR_MS;
    case 'day': return start + DAY_MS;
    case 'week': return start + 7 * DAY_MS;
    case 'month': {
      const date = new Date(start);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
}

/**
 * Sales per unit time, as bars of one length: the finest of an hour, six hours, a day, a week or a
 * month that the series can be cut into and that fits `maxBars` across the plot.
 *
 * Steam's series is a row a day and then a row an hour for about the last month, so a bar per row
 * would fall twenty-fold where the rows turn hourly, a drop in sales that never happened. Rows are
 * summed into buckets instead, and a series with any daily row is never cut finer than a day. Every
 * bucket from the first row's to the last row's is drawn, and one with no row in it is a zero: Steam
 * leaves out a day or an hour with no sales. `null` when no point carries a sales count.
 */
export function volumeBars(points: readonly { x: number; volume?: number | undefined }[], maxBars: number): VolumeBars | null {
  const sold = points.filter((point): point is { x: number; volume: number } => point.volume !== undefined);
  if (sold.length === 0) return null;
  const xs = sold.map((point) => point.x);
  const hourly = sold.length > 1 && xs.every((_, index) => isHourly(xs, index));
  const from = Math.min(...xs);
  const to = Math.max(...xs);
  const units = hourly ? UNITS : UNITS.slice(UNITS.indexOf('day'));
  for (const unit of units) {
    // A month is the coarsest there is, so it is never cut short however narrow the plot.
    const cap = unit === 'month' ? Infinity : maxBars;
    const starts: number[] = [];
    for (let start = bucketStart(from, unit); start <= to && starts.length <= cap; start = bucketEnd(start, unit)) starts.push(start);
    if (starts.length > cap) continue;
    const volumes = new Map(starts.map((start) => [start, 0]));
    for (const point of sold) {
      const start = bucketStart(point.x, unit);
      if (volumes.has(start)) volumes.set(start, volumes.get(start)! + point.volume);
    }
    const buckets: VolumeBucket[] = starts.map((start) => ({ start, end: bucketEnd(start, unit), volume: volumes.get(start)! }));
    // A row stands for its hour or its day, so a bar is partial when its first row starts a row's
    // length or more after the bar does, or its last row's period ends before the bar does.
    const first = buckets[0]!;
    const last = buckets[buckets.length - 1]!;
    const firstRow = isHourly(xs, xs.indexOf(from)) ? HOUR_MS : DAY_MS;
    const lastRow = isHourly(xs, xs.indexOf(to)) ? HOUR_MS : DAY_MS;
    if (from - first.start >= firstRow) first.partial = 'start';
    if (last.end - to > lastRow) last.partial = 'end';
    return { unit, buckets, peak: Math.max(0, ...buckets.map((bucket) => bucket.volume)) };
  }
  return null;
}
