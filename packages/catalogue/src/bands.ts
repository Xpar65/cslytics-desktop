/**
 * A norm-float filter, turned into something the engine can evaluate.
 *
 * The norm float is where an item sits inside *its own* skin's range; `float.ts` defines it
 * against the real float and owns the conversion both ways.
 *
 * The engine has no catalogue, so it cannot compute `nf` and must never learn how. What it can
 * evaluate is `key ∈ set ∧ paint_wear ∈ [a, b]`, which is `matchKeys` with a real-float range
 * attached. CS2 uses a few dozen distinct `(minFloat, maxFloat)` pairs, so one `nf` predicate becomes
 * a few dozen keyed bands — computed here, in the host, where the float ranges live.
 */

import { normToReal } from './float.js';
import type { CatalogueEntry, MatchKey } from './types.js';

export type WearBand = { matchKeys: MatchKey[]; minWear: number; maxWear: number };
export type NormPredicate = { op: '>' | '>=' | '<' | '<=' | '='; value: number };

/** The same ceilings the engine puts on `matchKeys`, so a band list cannot outgrow a bound query. */
export const MAX_BANDS = 64;
export const MAX_BAND_KEYS = 20_000;
/** `=` on a float is a tolerance, never an equality: the stored wear is a 32-bit float. */
export const EQUALITY_TOLERANCE = 0.0005;
/** `>` and `<` are strict; SQLite's BETWEEN is not. One float step is the difference. */
const STRICT_EPSILON = 1e-9;

/**
 * Fold every `nf` predicate into one norm-float window, or `null` when they contradict.
 *
 * Two float chips intersect rather than conflict (`f>0.1 f<0.2` is a band), and the same is true
 * here — `nf>0.9 nf<0.95` is the top decile minus the very top.
 */
export function normWindow(predicates: readonly NormPredicate[]): { low: number; high: number } | null {
  let low = 0;
  let high = 1;
  for (const { op, value } of predicates) {
    if (!Number.isFinite(value)) return null;
    const bounded = Math.min(1, Math.max(0, value));
    if (op === '>') low = Math.max(low, bounded + STRICT_EPSILON);
    else if (op === '>=') low = Math.max(low, bounded);
    else if (op === '<') high = Math.min(high, bounded - STRICT_EPSILON);
    else if (op === '<=') high = Math.min(high, bounded);
    else {
      low = Math.max(low, bounded - EQUALITY_TOLERANCE);
      high = Math.min(high, bounded + EQUALITY_TOLERANCE);
    }
  }
  return low > high ? null : { low, high };
}

/**
 * Keyed real-float bands for a set of `nf` predicates.
 *
 * `restrict`, when given, is the key set the rest of the chip bar already narrowed to — an item,
 * collection or rarity chip. Intersecting first is what keeps the common case (`redline nf<0.05`)
 * down to a handful of keys instead of every float skin in the game.
 *
 * An entry with no float range has no norm float and appears in no band: it can never match an
 * `nf` chip, which is the honest answer rather than a band of `[0, 1]` that matches everything.
 */
export function wearBandsFor(
  entries: Iterable<CatalogueEntry>,
  predicates: readonly NormPredicate[],
  restrict?: ReadonlySet<MatchKey> | undefined
): WearBand[] {
  const window = normWindow(predicates);
  if (!window) return [];

  const byRange = new Map<string, { range: { minFloat: number; maxFloat: number }; keys: MatchKey[] }>();
  for (const entry of entries) {
    if (entry.minFloat === null || entry.maxFloat === null) continue;
    if (entry.maxFloat <= entry.minFloat) continue;
    if (restrict && !restrict.has(entry.key)) continue;
    const id = `${entry.minFloat}:${entry.maxFloat}`;
    const group = byRange.get(id) ?? { range: { minFloat: entry.minFloat, maxFloat: entry.maxFloat }, keys: [] };
    group.keys.push(entry.key);
    byRange.set(id, group);
  }

  const bands: WearBand[] = [];
  let keyBudget = MAX_BAND_KEYS;
  const ordered = [...byRange.values()].sort((left, right) => left.range.minFloat - right.range.minFloat || left.range.maxFloat - right.range.maxFloat);
  for (const group of ordered) {
    if (bands.length >= MAX_BANDS || keyBudget <= 0) break;
    const minWear = normToReal(window.low, group.range)!;
    const maxWear = normToReal(window.high, group.range)!;
    if (maxWear < minWear) continue;
    const keys = group.keys.slice(0, keyBudget);
    keyBudget -= keys.length;
    bands.push({ matchKeys: keys, minWear, maxWear });
  }
  return bands;
}
