import type { ItemVariants } from '../../../shared/market.js';

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
