/**
 * Real float and norm float: the two numbers a skin's wear is spoken of in.
 *
 * - The **real float** is the paint wear exactly as the game reports it: `paintWear` on a row,
 *   `paint_wear` on the GC item, `float_value` on CSFloat. Absolute, 0 to 1. It is what the wear
 *   tier is read from, what Steam's and CSFloat's float filters take, and what the engine stores
 *   and sorts by. A bare "float", in code or on screen, always means this one.
 * - The **norm float** is where that real float sits inside *this skin's own* paint range
 *   `[minFloat, maxFloat]`: 0 at the lowest float the finish can have, 1 at the highest. "Top 1 %
 *   of its range" is the question a trader actually asks, and it is not a question about a real
 *   float — 0.06 is the floor of one skin and the ceiling of another. It is always named as the
 *   norm float, never as a bare "float".
 *
 * `norm = (real − minFloat) / (maxFloat − minFloat)` and `real = minFloat + norm × (maxFloat − minFloat)`.
 * Every conversion between the two goes through this file. csgomarketv3 has the same pair as
 * `raw_to_norm` and `norm_to_raw` in `src/core/domain/float_normalization.py`; its "raw" is this
 * "real".
 *
 * The range lives in the catalogue, so only the host can convert. The engine and the venues only
 * ever see a real float: a norm-float filter becomes real-float bands first (`wearBandsFor`).
 */

import type { CatalogueEntry } from './types.js';

/** A skin's paint range: the lowest and highest real float its finish can have. `null` when it has no wear. */
export type PaintRange = Pick<CatalogueEntry, 'minFloat' | 'maxFloat'>;

/** The width of a usable range, or `null` when it is absent or empty. */
function spanOf(range: PaintRange): number | null {
  if (range.minFloat === null || range.maxFloat === null) return null;
  const span = range.maxFloat - range.minFloat;
  return span > 0 ? span : null;
}

/**
 * Where a real float sits in its skin's range, 0 to 1. `null` without a real float or a usable range.
 *
 * Clamped, because the stored wear is a 32-bit float and the range is a decimal: an item dropped at
 * a 0.06 floor is stored as 0.0599999987, one step below it, and must read as 0, not a hair under.
 */
export function realToNorm(realFloat: number | null | undefined, range: PaintRange): number | null {
  const span = spanOf(range);
  if (realFloat === null || realFloat === undefined || Number.isNaN(realFloat) || span === null) return null;
  return Math.min(1, Math.max(0, (realFloat - range.minFloat!) / span));
}

/** The real float at a norm position in a skin's range. `null` without a usable range. Not clamped: bound the norm first. */
export function normToReal(normFloat: number, range: PaintRange): number | null {
  const span = spanOf(range);
  return span === null ? null : range.minFloat! + normFloat * span;
}
