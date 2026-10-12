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

/** Steam econ quality ids that change how an item reads. */
export function qualityLabel(quality: number): string | null {
  if (quality === 9) return 'StatTrak™';
  if (quality === 12) return 'Souvenir';
  return null;
}
