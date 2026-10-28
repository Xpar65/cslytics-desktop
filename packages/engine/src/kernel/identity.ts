import type { RawEconAttribute, RawEconItem } from '@cslytics/ports';
import { attributeValue, kitToken, matchKey as spellKey } from '@cslytics/ports';

export function isIndividualItem(item: RawEconItem): boolean {
  return item.defIndex === 1201
    || (item.paintIndex !== undefined && item.paintWear !== undefined && item.paintSeed !== undefined);
}

/**
 * Valve `kEconItemFlag_NonEconomy`. An SO object with this bit is not in the Steam
 * inventory: it cannot be traded, listed, stored, or shown as owned.
 * `cslytics-app-docs/steam/gc-inventory.md`.
 */
export const ECON_ITEM_FLAG_NONECONOMY = 8;

/**
 * Generated GC asset ids start here: `0xF000000000000000 | (paint << 16) | defIndex`.
 * Live captures (2026-09-14) of the default P250|X-Ray and CS:GO Weapon Case use this
 * range on every signed-in account; Community inventory and the Steam inventory UI omit them.
 */
export const GENERATED_GC_ASSET_ID_MIN = 0xF000000000000000n;

/** True when `id` is a decimal integer in the generated-GC range. Oracle/test ids such as `CASE-N-1` are not. */
export function isGeneratedGcAssetId(id: string): boolean {
  if (!/^[0-9]+$/.test(id)) return false;
  try {
    return BigInt(id) >= GENERATED_GC_ASSET_ID_MIN;
  } catch {
    return false;
  }
}

/**
 * A Game Coordinator stock object, not owned inventory.
 *
 * Either discriminator is enough: the NonEconomy flag is Valve's own "not in the
 * economy" bit, and the `0xF000` id range is how the live objects are minted. A
 * real owned handle (`CASE-N-1`, an 11-digit Steam asset id) matches neither.
 */
export function isSyntheticGcItem(item: Pick<RawEconItem, 'id' | 'flags'>): boolean {
  return ((item.flags ?? 0) & ECON_ITEM_FLAG_NONECONOMY) !== 0
    || isGeneratedGcAssetId(item.id);
}

// --- the `kit` field of the identity key ------------------------------------
//
// Spelled once, in `@cslytics/ports` (`item-key.ts`), which the catalogue files its entries
// under too. The allowlist is scoped by carrier and by quality there, with the live evidence.
export { attributeValue, kitToken } from '@cslytics/ports';

/**
 * The identity key, the same four fields the catalogue publishes.
 *
 * Empty is not zero: `7::4:` has no paint kit and `7:0:4:` wears paint kit 0.
 */
export function matchKey(item: RawEconItem): string {
  return spellKey({ defIndex: item.defIndex, paintIndex: isIndividualItem(item) ? item.paintIndex : null, quality: item.quality, kit: kitToken(item) });
}

/**
 * Kit/name-tag token so distinct non-float variants do not share a stack.
 *
 * It reuses the identity allowlist rather than folding in every attribute, and
 * that is a correctness requirement, not tidiness. Folding in everything means
 * `271` (modification date) joins the token, and a modification date is
 * per-asset — every case in a stack would become its own stack. Until the
 * `value_bytes` read in `attributeValue` landed that was hidden, because every attribute
 * rendered as an empty value and nothing ever split.
 */
export function variantToken(item: RawEconItem): string {
  return kitToken(item) || item.customName || '-';
}

/**
 * Valve's `cannot trade` attribute. The Game Coordinator stamps it on a unit no one may trade, sell
 * or move between accounts: a granted music kit carries `{"2":1}` (measured live, 2026-10-06).
 * A coin or service medal does not — there `cannot trade` lives on the schema's prefab, which the
 * engine never reads, so for those the Community read's flags are the only unit evidence.
 */
export const ATTRIBUTE_CANNOT_TRADE = 2;

/**
 * Econ quality 14, Valve's `volatile`: an unsealed terminal. Unsealing keeps the def and moves the
 * unit here, and Valve says it is then "non-tradable and non-marketable", yet the unit carries no
 * attribute 2 (captured 2026-10-28). So the
 * quality is the mark.
 */
export const QUALITY_VOLATILE = 14;

/** The restriction token of a unit Valve marks `cannot trade`. Permanent, so it outranks any lock. */
export const UNTRADABLE_RESTRICTION = 'untradable';

/** True when the unit carries `cannot trade` with a non-zero value, or is a volatile unit. */
export function cannotTrade(item: Pick<RawEconItem, 'attributes' | 'quality'>): boolean {
  if (item.quality === QUALITY_VOLATILE) return true;
  const attribute = item.attributes?.find((candidate) => candidate.defIndex === ATTRIBUTE_CANNOT_TRADE);
  if (!attribute) return false;
  const value = attributeValue(attribute);
  return value !== null && value !== 0 && value !== '0';
}

/**
 * The lock bucket: which lock, until when. A locked case is not the same commodity as a free
 * one, and a trade-protected case is not the same as a market-locked one with the same date —
 * one can be stored and the other cannot (ID-02), so they must never share a group. A unit Valve
 * marks `cannot trade` is not interchangeable with any other, so it is its own bucket, ahead of
 * the dated ones: a permanent restriction does not end when a lock does.
 */
export function restrictionToken(item: RawEconItem): string {
  if (cannotTrade(item)) return UNTRADABLE_RESTRICTION;
  const protectedUntil = tradeProtectedUntil(item);
  if (protectedUntil) return `protected:${protectedUntil}`;
  return item.tradableAfter ? `locked:${item.tradableAfter}` : '-';
}

/**
 * Items that *are* accessories. Their slot attribute is their own kit, already in `kitToken`,
 * so nothing on them counts as applied.
 */
const ACCESSORY_ITEMS: ReadonlySet<number> = new Set([1209, 4609, 1348, 1349, 1355, 1314]);
/** `sticker slot N id`: 113 + 4N. A patch on an agent uses the same slots. */
const STICKER_SLOT_IDS = [113, 117, 121, 125, 129, 133] as const;

/**
 * What an owner has applied to a carrier, as a signature: sticker or patch ids by slot, and a
 * charm's kit with its pattern. Empty on an accessory itself and on a bare carrier.
 *
 * This is the half of the group key the catalogue key must never see. A patched agent is still
 * that agent for its name and image, but it cannot be handed out in place of a plain one, and
 * before this signature existed the two shared one stack (holdings plan D4). Wear, scale,
 * rotation and offsets stay out: they change the price at the margin, not what the thing is.
 */
export function accessorySignature(item: RawEconItem): string {
  if (ACCESSORY_ITEMS.has(item.defIndex)) return '';
  const values = new Map<number, number | string>();
  for (const attribute of item.attributes ?? []) {
    const value = attributeValue(attribute);
    if (value !== null) values.set(attribute.defIndex, value);
  }
  const parts: string[] = [];
  STICKER_SLOT_IDS.forEach((defIndex, slot) => {
    const id = values.get(defIndex);
    if (id !== undefined) parts.push(`s${slot}=${id}`);
  });
  const charm = values.get(299);
  if (charm !== undefined) {
    const pattern = values.get(306);
    parts.push(pattern === undefined ? `c=${charm}` : `c=${charm}/${pattern}`);
  }
  return parts.join(',');
}

/**
 * Economically compatible non-float group: the interchangeability key. Broader than a single
 * asset, narrower than def-index+quality. Six fields, restriction last — `restrictionOf` and every
 * reader of the lock rely on that position.
 */
export function commodityKey(item: RawEconItem): string {
  if (isIndividualItem(item)) return stableItemKey(item);
  return `fungible:${item.defIndex}:${item.quality}:${variantToken(item)}:${accessorySignature(item) || '-'}:${restrictionToken(item)}`;
}

/**
 * The group key of any unit (holdings plan D4). A fungible unit's is its `commodityKey`; an
 * individual's is its fingerprint plus what is applied to it, so two float twins where one wears
 * a sticker are two groups.
 */
export function groupKey(item: RawEconItem): string {
  if (!isIndividualItem(item)) return commodityKey(item);
  return `${stableItemKey(item)}:${accessorySignature(item) || '-'}`;
}

/**
 * The lock a fungible group key carries — its last field — or null when free.
 *
 * Matched as a timestamp at the tail, not split on `:`: the ISO date is itself full of colons,
 * and `split(':').at(-1)` of `…:2027-01-01T00:00:00.000Z` is `00.000Z`, which parses as nothing.
 * The command preflight read the lock that way and so never saw one.
 */
export function restrictionOf(key: string): string | null {
  const tail = /:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/.exec(key);
  return tail?.[1] ?? null;
}

/** Whether a fungible group key is the `cannot trade` bucket. `restrictionOf` reads dates only. */
export function isUntradableGroup(key: string): boolean {
  return key.startsWith('fungible:') && key.endsWith(`:${UNTRADABLE_RESTRICTION}`);
}

export function stableItemKey(item: RawEconItem): string {
  if (!isIndividualItem(item)) return commodityKey(item);
  if (item.defIndex === 1201) return `storage-unit:${item.id}`;
  return [
    'skin',
    item.defIndex,
    item.paintIndex,
    item.paintWear?.toPrecision(17),
    item.paintSeed,
    item.quality
  ].join(':');
}

export function tradeProtectedUntil(item: RawEconItem): string | null {
  const attr = item.attributes?.find((candidate) => candidate.defIndex === 312);
  if (!attr) return null;
  const value = decodeDateAttribute(attr);
  return value?.toISOString() ?? null;
}

function decodeDateAttribute(attribute: RawEconAttribute): Date | null {
  if (typeof attribute.value === 'string') {
    const date = new Date(attribute.value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof attribute.value === 'number') return new Date(attribute.value * 1000);
  if (attribute.valueBytes && attribute.valueBytes.byteLength >= 4) {
    const view = new DataView(attribute.valueBytes.buffer, attribute.valueBytes.byteOffset, attribute.valueBytes.byteLength);
    return new Date(view.getUint32(0, true) * 1000);
  }
  return null;
}

