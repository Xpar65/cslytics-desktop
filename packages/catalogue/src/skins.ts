import { isStockWeapon, isWeapon, skinName, skinQuality, type SkinQuality } from './names.js';
import type { CatalogueEntry, ImageRef, Rarity } from './types.js';

/**
 * Entries, as the skins a person browses.
 *
 * The catalogue holds one entry per identity key, so one skin is several: its StatTrak™ or Souvenir
 * copy, and each phase of a Doppler. A person looking through a collection means the skin, once.
 * Wear is already absent, because an entry's base name never carries it.
 */

export type Skin = {
  /** The base name the skin opens under: the normal quality's where there is one. */
  name: string;
  category: string;
  rarity: Rarity | null;
  image: ImageRef | null;
};

/** The normal quality stands for the skin when it exists; a skin sold only as a Souvenir is still shown. */
const QUALITY_ORDER: Readonly<Record<SkinQuality, number>> = { normal: 0, stattrak: 1, souvenir: 2 };

/**
 * Where a grade sits among the grades, from the word Valve's own id carries: `rarity_ancient_weapon`
 * is Covert, `rarity_ancient` is Extraordinary and `rarity_ancient_character` is Master, and all
 * three are the sixth grade of their kind. An id that names no grade sorts last.
 */
const GRADES = ['common', 'uncommon', 'rare', 'mythical', 'legendary', 'ancient', 'contraband'] as const;

export function rarityRank(rarity: Pick<Rarity, 'id'> | null): number {
  if (!rarity) return 0;
  const grade = rarity.id.replace(/^rarity_/, '').split('_')[0]!;
  return GRADES.indexOf(grade as (typeof GRADES)[number]) + 1;
}

/**
 * Whether an entry is something a person browses to: sold on a market. A coin or a medal is held
 * and never sold, and neither is a weapon with no finish. One rule, here, because the count offered
 * beside a name and the tiles shown under it must be the same number.
 */
export function isBrowsable(entry: CatalogueEntry): boolean {
  return entry.marketable !== false && !isStockWeapon(entry);
}

/**
 * One row per skin, the rarest first and by name within a grade, which is the order a collection
 * is always read in. Only what `isBrowsable` keeps.
 */
export function skinsOf(entries: Iterable<CatalogueEntry>): Skin[] {
  const bySkin = new Map<string, CatalogueEntry>();
  for (const entry of entries) {
    if (!isBrowsable(entry)) continue;
    const skin = skinName(entry.marketHashNameBase);
    const held = bySkin.get(skin);
    if (!held || standsBefore(entry, held)) bySkin.set(skin, entry);
  }
  return [...bySkin.entries()]
    .map(([skin, entry]) => ({ skin: skin.replace(/^★ /, ''), entry }))
    .sort((left, right) => rarityRank(right.entry.rarity) - rarityRank(left.entry.rarity) || left.skin.localeCompare(right.skin))
    .map(({ entry }) => ({ name: entry.marketHashNameBase, category: entry.category, rarity: entry.rarity, image: entry.image }));
}

/**
 * Collections in the order they are looked through: the newest release first. The collections of
 * one case drop share a day, so name settles a tie, and one with no release date follows every
 * dated one. `YYYY-MM-DD` orders as text.
 */
export function byRelease<T extends { name: string; releaseDate?: string | null }>(collections: readonly T[]): T[] {
  return [...collections].sort((left, right) => {
    const a = left.releaseDate ?? null;
    const b = right.releaseDate ?? null;
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return a > b ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * What a collection is a collection of, which is how a page sets them apart.
 *
 * It is read from the collection's own entries, so it is known the day a collection is published
 * and asks nothing the catalogue does not already say. Weapon finishes are two kinds, and
 * StatTrak™ is what tells them apart: only a case or a terminal issues a StatTrak™ weapon, so a
 * collection whose skins come in it is one a container is opened for (`case`), and one whose skins
 * do not is dropped, or comes in a souvenir package, or is an Armory reward (`collection`).
 * Anything else is named for the one type of item it holds, or is `other` where that type has no
 * name here yet.
 *
 * The rule is held to the public list's own account of which container carries which collection
 * (`tests/unit/items-collections.test.ts`). On the list of 2026-11-23 they disagree about one
 * collection in 94: the X-Ray Collection, whose container is a package that carries its name.
 */
export type CollectionKind = 'case' | 'collection' | 'sticker' | 'charm' | 'agent' | 'other';

const KIND_OF_CATEGORY: Readonly<Record<string, CollectionKind>> = { Sticker: 'sticker', Charm: 'charm', Agent: 'agent' };

export function collectionKind(entries: Iterable<Pick<CatalogueEntry, 'marketHashNameBase' | 'category'>>): CollectionKind {
  let weapons = false;
  let stattrak = false;
  const others = new Set<string>();
  for (const entry of entries) {
    if (!isWeapon(entry)) others.add(entry.category);
    else {
      weapons = true;
      if (skinQuality(entry.marketHashNameBase) === 'stattrak') stattrak = true;
    }
  }
  if (weapons) return stattrak ? 'case' : 'collection';
  const [only, ...rest] = others;
  return (rest.length === 0 && only !== undefined ? KIND_OF_CATEGORY[only] : undefined) ?? 'other';
}

/** Whether `entry` stands for its skin ahead of `held`: the more ordinary quality, then the one with a picture. */
function standsBefore(entry: CatalogueEntry, held: CatalogueEntry): boolean {
  const order = QUALITY_ORDER[skinQuality(entry.marketHashNameBase)] - QUALITY_ORDER[skinQuality(held.marketHashNameBase)];
  return order < 0 || (order === 0 && held.image === null && entry.image !== null);
}
