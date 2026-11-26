import type { CatalogueEntry } from './types.js';

/**
 * Composing the name a user reads, and the name Steam's market uses.
 *
 * These are the same string, and that matters more than it looks: `market_hash_name` is the join
 * key for order books, float curves and every priced surface, and it is the one thing `R-04` can
 * check against an authority outside our own expectations. A display name that is *nearly*
 * `market_hash_name` is a name that silently fails to join.
 *
 * The wear tier is appended here rather than stored, because wear is a per-item float and the
 * catalogue is keyed by identity. One entry, five names.
 */

export type WearTier = { code: 'FN' | 'MW' | 'FT' | 'WW' | 'BS'; label: string };

const TIERS: ReadonlyArray<{ max: number } & WearTier> = [
  { max: 0.07, code: 'FN', label: 'Factory New' },
  { max: 0.15, code: 'MW', label: 'Minimal Wear' },
  { max: 0.38, code: 'FT', label: 'Field-Tested' },
  { max: 0.45, code: 'WW', label: 'Well-Worn' },
  { max: 1.01, code: 'BS', label: 'Battle-Scarred' }
];

export function wearTier(paintWear: number | null | undefined): WearTier | null {
  if (paintWear === null || paintWear === undefined || Number.isNaN(paintWear)) return null;
  return TIERS.find((tier) => paintWear < tier.max) ?? null;
}

/**
 * The exact `market_hash_name`, when one can be formed.
 *
 * A `wearSuffixed` entry with no observed float has no market name: the wear tier is part of the
 * name Steam uses, so guessing one would produce a string that looks joinable and is not. `null`
 * says "identity is known, the market name is not", which is a different claim from "unknown item".
 */
export function marketHashName(entry: CatalogueEntry, paintWear: number | null | undefined): string | null {
  if (!entry.wearSuffixed) return entry.marketHashNameBase;
  const tier = wearTier(paintWear);
  return tier ? `${entry.marketHashNameBase} (${tier.label})` : null;
}

/**
 * What the row shows.
 *
 * Prefers the exact market name, falls back to the base plus a phase, and never returns empty —
 * an entry that resolved should always read as something, or the resolution was pointless.
 */
export function displayName(entry: CatalogueEntry, paintWear: number | null | undefined): string {
  const exact = marketHashName(entry, paintWear);
  if (exact) return entry.phase ? `${exact} — ${entry.phase}` : exact;
  return entry.phase ? `${entry.marketHashNameBase} — ${entry.phase}` : entry.marketHashNameBase;
}

/**
 * What an unresolved row shows, so an item the catalogue has never heard of is still readable and
 * still distinguishable from its neighbours. ITEM-01: an item is never hidden because enrichment
 * failed.
 */
export function rawFallbackName(identity: {
  defIndex: number;
  paintIndex?: number | null;
  quality: number;
  paintWear?: number | null;
}): string {
  const parts: string[] = [];
  const quality = qualityLabel(identity.quality);
  if (quality) parts.push(quality);
  parts.push(`Def ${identity.defIndex}`);
  if (identity.paintIndex !== null && identity.paintIndex !== undefined) parts.push(`Paint ${identity.paintIndex}`);
  const tier = wearTier(identity.paintWear);
  return `${parts.join(' · ')}${tier ? ` (${tier.label})` : ''}`;
}

/** How a base name says its quality: after the star a knife or a pair of gloves carries, before the name. */
const QUALITY_PREFIX = /^(★ )?(StatTrak™ |Souvenir )/;

/** The qualities one skin is sold in, in the order a page offers them. */
export type SkinQuality = 'normal' | 'stattrak' | 'souvenir';

/**
 * The skin a base name is a quality of: `★ StatTrak™ Karambit | Fade` and `★ Karambit | Fade` are
 * one skin, as `Souvenir AWP | Dragon Lore` and `AWP | Dragon Lore` are. The answer is the normal
 * quality's own base name, so it is a market name wherever that quality exists.
 */
export function skinName(marketHashNameBase: string): string {
  return marketHashNameBase.replace(QUALITY_PREFIX, '$1');
}

/** Which quality a base name is sold as, read from the name as Steam writes it. */
export function skinQuality(marketHashNameBase: string): SkinQuality {
  const prefix = QUALITY_PREFIX.exec(marketHashNameBase)?.[2];
  return prefix === 'StatTrak™ ' ? 'stattrak' : prefix === 'Souvenir ' ? 'souvenir' : 'normal';
}

/** The categories whose items are a weapon and a finish, so the name before the bar is the weapon's. */
const WEAPON_CATEGORIES: ReadonlySet<string> = new Set(['Pistol', 'Rifle', 'SMG', 'Heavy', 'Knife', 'Gloves', 'Equipment']);

/** Whether an entry is a thing a finish goes on: a weapon, a knife or gloves. */
export function isWeapon(entry: Pick<CatalogueEntry, 'category'>): boolean {
  return WEAPON_CATEGORIES.has(entry.category);
}

/**
 * The weapon an entry is a skin of: `AWP`, `Karambit`, `Sport Gloves`. `null` for anything that is
 * not a weapon, a knife or gloves: a sticker's name also has a bar in it, and `Sticker` is its
 * category, not a weapon.
 */
export function weaponName(entry: Pick<CatalogueEntry, 'marketHashNameBase' | 'category'>): string | null {
  if (!WEAPON_CATEGORIES.has(entry.category)) return null;
  const weapon = skinName(entry.marketHashNameBase).replace(/^★ /, '').split(' | ')[0]!.trim();
  return weapon || null;
}

/**
 * A weapon as the game issues it, with no finish: `AWP`, `Sport Gloves`, the default `Knife`.
 * Every player has one and no market sells it, so it is no skin to browse. A knife with no finish
 * that *is* sold carries the star (`★ Karambit`), which is what tells the two apart.
 */
export function isStockWeapon(entry: Pick<CatalogueEntry, 'marketHashNameBase' | 'category'>): boolean {
  return WEAPON_CATEGORIES.has(entry.category) && !entry.marketHashNameBase.includes(' | ') && !entry.marketHashNameBase.startsWith('★');
}

/** Steam econ quality ids that change how an item reads. */
export function qualityLabel(quality: number): string | null {
  if (quality === 9) return 'StatTrak™';
  if (quality === 12) return 'Souvenir';
  return null;
}
