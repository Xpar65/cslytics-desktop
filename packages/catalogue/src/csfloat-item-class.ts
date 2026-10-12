/**
 * What an item is, in the classes CSFloat's own site sorts its schema into — which is what decides
 * which filters its buy-order dialog offers for it (`buy-order-filter-fields.tsx`). A skin splits
 * by its weapon's type, because charms and stickers go on guns only; a container splits off the
 * souvenir package, whose stickers a buy order may name; a charm splits off the highlight charm,
 * which has no pattern.
 *
 * Its own module because the window needs it and `csfloat-kinds.ts`, which answers it, reaches
 * `node:fs`; `browser.ts` exports this one.
 */
export type CsfloatItemClass =
  | 'gun' | 'knife' | 'gloves'
  | 'agent' | 'souvenir-package' | 'container'
  | 'charm' | 'highlight-charm'
  | 'sticker' | 'patch' | 'music-kit' | 'collectible' | 'other';
