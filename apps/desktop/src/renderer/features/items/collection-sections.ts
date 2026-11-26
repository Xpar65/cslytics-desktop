import type { CollectionKind } from '../../../shared/market.js';

/**
 * The headings collections are listed under on the Items page, in the order they are read down it.
 *
 * What kind a collection is comes from the catalogue; which kinds share a heading is the page's
 * own. A person looking for a skin knows whether it came out of a case, and one looking for a
 * sticker is not looking for a skin, so those stand apart. Stickers and charms are both things
 * put on a weapon and are too few to stand alone, so they share one.
 *
 * Every kind is under exactly one heading. `other` is last: it is where a kind the catalogue has
 * no name for goes, so a new kind of collection is listed the day it is published and not hidden
 * until a build knows what to call it.
 */
export const COLLECTION_SECTIONS: ReadonlyArray<{ id: string; title: string; kinds: readonly CollectionKind[] }> = [
  { id: 'cases', title: 'Cases & terminals', kinds: ['case'] },
  { id: 'collections', title: 'Collections', kinds: ['collection'] },
  { id: 'accessories', title: 'Stickers & charms', kinds: ['sticker', 'charm'] },
  { id: 'agents', title: 'Agents', kinds: ['agent'] },
  { id: 'other', title: 'Other', kinds: ['other'] }
];

export type CollectionSection<T> = { id: string; title: string; collections: T[] };

/**
 * `collections` under their headings. Each heading keeps the order it was given them in, which is
 * the newest release first, and a heading with nothing under it is left out.
 */
export function collectionSections<T extends { kind: CollectionKind }>(collections: readonly T[]): Array<CollectionSection<T>> {
  return COLLECTION_SECTIONS
    .map(({ id, title, kinds }) => ({ id, title, collections: collections.filter((collection) => kinds.includes(collection.kind)) }))
    .filter((section) => section.collections.length > 0);
}
