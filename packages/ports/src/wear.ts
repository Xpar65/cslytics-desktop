/**
 * Valve's five wear tiers, by the float an item carries.
 *
 * The market names an item by its tier (`… (Field-Tested)`), so the tier is part of identity on
 * the market even though the engine keys holdings by the float itself. The bounds are Valve's
 * fixed thresholds, the same five every tool uses; they live here so the engine's positions read
 * and the catalogue's name spelling cannot drift apart, and a unit test holds them equal.
 *
 * A band is the tier's index, 0 for Factory New to 4 for Battle-Scarred, or `null` for an item
 * with no float: a case, a sticker, a storage unit.
 */
export const WEAR_TIERS = [
  { band: 0, code: 'FN', label: 'Factory New', max: 0.07 },
  { band: 1, code: 'MW', label: 'Minimal Wear', max: 0.15 },
  { band: 2, code: 'FT', label: 'Field-Tested', max: 0.38 },
  { band: 3, code: 'WW', label: 'Well-Worn', max: 0.45 },
  { band: 4, code: 'BS', label: 'Battle-Scarred', max: 1.01 }
] as const;

export type WearBand = (typeof WEAR_TIERS)[number]['band'];

export function wearBand(paintWear: number | null | undefined): WearBand | null {
  if (paintWear === null || paintWear === undefined || Number.isNaN(paintWear)) return null;
  return WEAR_TIERS.find((tier) => paintWear < tier.max)?.band ?? null;
}

/**
 * The same decision as SQL, over a column of floats, for a GROUP BY. `NULL` stays `NULL`.
 * Spelled from the table above so the two cannot disagree.
 */
export function wearBandSql(column: string): string {
  const cases = WEAR_TIERS.slice(0, -1).map((tier) => `WHEN ${column}<${tier.max} THEN ${tier.band}`).join(' ');
  return `CASE WHEN ${column} IS NULL THEN NULL ${cases} ELSE ${WEAR_TIERS[WEAR_TIERS.length - 1]!.band} END`;
}
