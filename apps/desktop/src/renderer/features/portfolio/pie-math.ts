import type { CategoryShare } from '@cslytics/market-data';

/**
 * The arithmetic under the category pie, kept apart from the component so it can be tested
 * without a DOM: which categories become slices, how the tail folds into one, and the arc each
 * slice draws. Angles are radians from twelve o'clock, clockwise, which is how a pie is read.
 */

export type PieSlice = {
  key: string;
  label: string;
  cents: number;
  units: number;
  /** Of the priced total, 0–1. */
  share: number;
  start: number;
  end: number;
  /** The token holding this slice's colour. */
  variable: string;
  /** `false` when part of the slice could not be converted, so its figure is a floor. */
  complete: boolean;
  /** The categories an "Other" slice folds, in value order. */
  members: string[];
};

/** Named in full so the theme guard sees each token read; a template would hide them from it. */
export const SERIES_TOKENS = [
  '--cs-series-1', '--cs-series-2', '--cs-series-3', '--cs-series-4',
  '--cs-series-5', '--cs-series-6', '--cs-series-7', '--cs-series-8'
] as const;

export const DEFAULT_NAMED_SLICES = 7;

/**
 * Slices from the valuation's category rows: those worth anything, largest first, the `named`
 * largest kept and the rest folded into one "Other" slice, so a category worth three cents is
 * counted without becoming a sliver nobody can point at. A tail of one is not folded: "Other (1)"
 * would hide a name to save nothing.
 */
export function slices(rows: readonly CategoryShare[], named = DEFAULT_NAMED_SLICES): PieSlice[] {
  const priced = rows.filter((row) => row.cents > 0).sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category));
  const total = priced.reduce((sum, row) => sum + row.cents, 0);
  if (total <= 0) return [];
  const head = priced.length > named + 1 ? priced.slice(0, named) : priced;
  const tail = priced.slice(head.length);
  const kept: Array<Omit<PieSlice, 'share' | 'start' | 'end' | 'variable'>> = head.map((row) => ({
    key: row.category, label: row.category, cents: row.cents, units: row.units, complete: row.complete, members: []
  }));
  if (tail.length > 0) {
    kept.push({
      key: 'other',
      label: `Other (${tail.length})`,
      cents: tail.reduce((sum, row) => sum + row.cents, 0),
      units: tail.reduce((sum, row) => sum + row.units, 0),
      complete: tail.every((row) => row.complete),
      members: tail.map((row) => row.category)
    });
  }
  let angle = 0;
  return kept.map((row, index) => {
    const share = row.cents / total;
    const start = angle;
    angle += share * Math.PI * 2;
    return { ...row, share, start, end: angle, variable: SERIES_TOKENS[index % SERIES_TOKENS.length]! };
  });
}

/**
 * The SVG path of one ring segment from `start` to `end`, outer radius `outer` and inner `inner`,
 * about (`cx`, `cy`). A slice that is the whole ring is drawn as two half arcs, because an arc
 * command from a point back to itself draws nothing.
 */
export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const sweep = Math.min(Math.PI * 2, Math.max(0, end - start));
  if (sweep <= 0) return '';
  if (sweep >= Math.PI * 2 - 1e-9) {
    const half = start + Math.PI;
    return [arcPath(cx, cy, outer, inner, start, half), arcPath(cx, cy, outer, inner, half, start + Math.PI * 2)].join(' ');
  }
  const point = (radius: number, angle: number): string => `${(cx + radius * Math.sin(angle)).toFixed(2)} ${(cy - radius * Math.cos(angle)).toFixed(2)}`;
  const large = sweep > Math.PI ? 1 : 0;
  return [
    `M${point(outer, start)}`,
    `A${outer} ${outer} 0 ${large} 1 ${point(outer, end)}`,
    `L${point(inner, end)}`,
    `A${inner} ${inner} 0 ${large} 0 ${point(inner, start)}`,
    'Z'
  ].join(' ');
}
