import type { RawEconItem } from '@cslytics/ports';
import { ATTRIBUTE_CANNOT_TRADE, QUALITY_VOLATILE, attributeValue } from './identity.js';

/**
 * What an item row keeps of the attributes the Game Coordinator sent (holdings plan D6).
 *
 * The engine has no schema. It stores what the adapter decoded, and for an attribute the adapter
 * could not name it keeps the bytes as hex rather than dropping them: observation is truth, and a
 * regenerated table re-derives the value without another walk. A four-byte payload with no decoded
 * value is read as a uint32 — right for every identity attribute, and what the Oracle sends.
 */
export const ATTRIBUTES_JSON_VERSION = 1;

export type EncodedAttributes = { v: number } & Record<string, number | string>;

export function encodeAttributes(item: RawEconItem): EncodedAttributes {
  const encoded: EncodedAttributes = { v: ATTRIBUTES_JSON_VERSION };
  for (const attribute of item.attributes ?? []) {
    const value = attributeValue(attribute);
    if (value !== null) encoded[String(attribute.defIndex)] = value;
    else if (attribute.valueBytes && attribute.valueBytes.byteLength > 0) {
      encoded[String(attribute.defIndex)] = `0x${Array.from(attribute.valueBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return encoded;
}

/**
 * `cannot trade` read back off a stored row, for admission, which holds rows rather than the
 * walk's items. The same rule as `cannotTrade` in `identity.ts`; `cannotTradeSql` is its spelling
 * for a query. A row with no attributes, or unreadable ones, says nothing beyond its quality.
 */
export function storedCannotTrade(row: { attributes_json?: string | null; quality: number } | null | undefined): boolean {
  if (!row) return false;
  if (row.quality === QUALITY_VOLATILE) return true;
  if (!row.attributes_json) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.attributes_json);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const value = (parsed as Record<string, unknown>)[String(ATTRIBUTE_CANNOT_TRADE)];
  return value !== undefined && value !== null && value !== 0 && value !== '0';
}

/** `storedCannotTrade` as a SQL predicate over an `item` alias. */
export function cannotTradeSql(alias: string): string {
  return `(${alias}.quality = ${QUALITY_VOLATILE} OR COALESCE(json_extract(${alias}.attributes_json, '$."${ATTRIBUTE_CANNOT_TRADE}"'), 0) NOT IN (0, '0'))`;
}

/** One applied accessory on a carrier: a sticker or patch in a slot, or the charm. */
export type AccessorySlot = {
  kind: 'sticker-slot' | 'charm-slot';
  slot: number;
  kitId: number;
  wear: number | null;
  scale: number | null;
  rotation: number | null;
  pattern: number | null;
  highlight: number | null;
};

/** Items that are accessories carry their own kit in the slot attribute; nothing on them is applied. */
const ACCESSORY_ITEMS: ReadonlySet<number> = new Set([1209, 4609, 1348, 1349, 1355, 1314]);

/**
 * The applied slots of a carrier, for `item_accessory`. Sticker slot N is `113 + 4N` for the id,
 * then wear, scale and rotation; the one charm slot is 299 (kit), 306 (pattern), 314 (highlight
 * reel). Which of these the GC writes on a fresh sticker or a patched agent is still the
 * attribution plan's G-03 and G-04; absent ones are null here rather than guessed.
 */
export function accessorySlots(item: RawEconItem): AccessorySlot[] {
  if (ACCESSORY_ITEMS.has(item.defIndex)) return [];
  const values = new Map<number, number>();
  for (const attribute of item.attributes ?? []) {
    const value = attributeValue(attribute);
    if (typeof value === 'number') values.set(attribute.defIndex, value);
  }
  const number = (defIndex: number): number | null => values.get(defIndex) ?? null;
  const slots: AccessorySlot[] = [];
  for (let slot = 0; slot < 6; slot += 1) {
    const kitId = values.get(113 + slot * 4);
    if (kitId === undefined) continue;
    slots.push({
      kind: 'sticker-slot', slot, kitId,
      wear: number(114 + slot * 4), scale: number(115 + slot * 4), rotation: number(116 + slot * 4),
      pattern: null, highlight: null
    });
  }
  const charm = values.get(299);
  if (charm !== undefined) {
    slots.push({ kind: 'charm-slot', slot: 0, kitId: charm, wear: null, scale: null, rotation: null, pattern: number(306), highlight: number(314) });
  }
  return slots;
}
