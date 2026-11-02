import type { CurveVertex } from './types.js';

/**
 * What a published float curve says at one float. Pure, and shared by main and the window: the
 * portfolio prices every skin at its own float through `priceAtFloat`, and the Items page draws the
 * same line through it, so the figure a person reads off the chart is the figure in the total.
 *
 * Prices are whole units of the document's currency, as the curve contract serves them.
 */

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
