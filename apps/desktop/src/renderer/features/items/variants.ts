import type { ItemVariants } from '../../../shared/market.js';
import { engine } from '../../lib/engine.js';

/**
 * The market name a search opens: the tier the scope holds most of, else the item's first. A skin
 * nobody holds opens on its least worn tier, the order Steam's own market lists them in.
 */
export function defaultVariant(answer: ItemVariants): string {
  let best: { name: string; held: number } | null = null;
  for (const variant of answer.variants) {
    const held = variant.held ?? 0;
    if (held > 0 && (best === null || held > best.held)) best = { name: variant.name, held };
  }
  return best?.name ?? answer.variants[0]?.name ?? answer.base;
}

/**
 * The market name a base name opens on. A suggestion and a tile are both a skin, and a page is one
 * market name, so main is asked for the names the skin is sold under and `defaultVariant` picks.
 * A read that fails opens the name as it was given, which is right for every item with no wear.
 */
export async function marketNameOf(base: string, accountIds: readonly string[]): Promise<string> {
  const variants = await engine.itemVariants(base, accountIds).catch(() => null);
  return variants ? defaultVariant(variants) : base;
}
