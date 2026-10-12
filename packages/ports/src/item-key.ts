/**
 * The identity key an item is filed under, spelled once.
 *
 * The engine keys its rows with it and the catalogue files its entries under it, and neither may
 * import the other: the engine holds no names (SYS-05), and the catalogue is presentation. Both
 * already depend on this package, so the one spelling lives here, beside the other shared logic
 * (`fees.ts`), and there is nothing to keep in step. The engine also spells the key in SQL, from
 * columns it owns, to drive `item_identity_match`; `tests/unit/item-key.test.ts` pins the strings.
 *
 * `paint_index` is absent for non-float items and empty is **not** the same as zero: paint 0 is a
 * real paint kit, and `7::4:` (no paint) must never collide with `7:0:4:` (paint zero).
 */
export function matchKey(identity: {
  defIndex: number;
  paintIndex?: number | null | undefined;
  quality: number;
  kit?: string | null | undefined;
}): string {
  const paint = identity.paintIndex === undefined || identity.paintIndex === null ? '' : String(identity.paintIndex);
  return `${identity.defIndex}:${paint}:${identity.quality}:${identity.kit ?? ''}`;
}

/** A fungible unit has no paint index at all, so the middle position is always empty. */
export function commodityMatchKey(identity: { defIndex: number; quality: number; kit?: string | null | undefined }): string {
  return `${identity.defIndex}::${identity.quality}:${identity.kit ?? ''}`;
}

/**
 * The `kit` field: identity-bearing econ attributes, and only those — scoped by **the item that
 * carries the attribute**.
 *
 * `(def_index, paint_index, quality)` cannot identify a sticker — every sticker shares one def
 * index and has no paint kit, so ten thousand of them collapse into one key. Those families are
 * identified by a numbered attribute instead.
 *
 * Closed alone is not enough, and this shipped wrong: attribute `113` on a *weapon* is the sticker
 * applied in slot 0. A live read on 2026-09-13 held fifteen `Galil AR | Acid Dart`, fourteen plain
 * and one stickered; read globally that copy keys as `13:1296:4:113=9758` while its siblings key as
 * `13:1296:4:`, so it stops matching its own catalogue entry and moves again when the sticker is
 * scraped. What a carrier wears decides its group (`groupKey` in the engine), never its identity.
 *
 * Evidence: the live GC capture cited from `cslytics-app-docs/steam/gc-inventory.md`, which ties
 * attribute *values* on real items to catalogue entries for every kit family. The attribute names come from
 * Valve's shipped `items_game.txt`.
 */
export const KIT_ATTRIBUTES_BY_ITEM: ReadonlyMap<number, readonly number[]> = new Map([
  [1209, [113]],           // sticker
  [4609, [113]],           // patch
  [1348, [113, 233]],      // sealed graffiti: kit, and tint — a tint is a different market item
  [1314, [166]],           // music kit
  [1355, [299, 314]]       // charm; 314 is the tournament highlight reel
]);

/**
 * One attribute is scoped by **quality**, and it is the only thing separating a star item's
 * StatTrak™ form from its plain one.
 *
 * A knife or glove is econ quality 3 and stays 3 when StatTrak™, unlike an ordinary weapon which
 * goes 4 → 9; Valve's own inspect payloads for a StatTrak™ and a plain Butterfly Knife both decode
 * to quality 3. `81` is the kill-eater *score type* and is stable; `80` is the kill count and would
 * change the key on every kill. Confined to quality 3 because at quality 9 the quality already
 * carries the distinction.
 */
export const KIT_ATTRIBUTES_BY_QUALITY: ReadonlyMap<number, readonly number[]> = new Map([[3, [81]]]);

/**
 * An econ attribute's value, from whichever field the Game Coordinator filled.
 *
 * It fills `value_bytes` and leaves `value` null — measured on every one of 113/166/233/299/314.
 * Reading only `value` renders every kit empty on live data, and the symptom is an account that
 * appears to own no accessories rather than an error.
 */
export function attributeValue(attribute: { value?: unknown; valueBytes?: Uint8Array | undefined }): number | string | null {
  if (typeof attribute.value === 'number' || typeof attribute.value === 'string') return attribute.value;
  const bytes = attribute.valueBytes;
  if (!bytes || bytes.byteLength < 4) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

/** `attr=value` pairs, ascending by attribute index, joined with `,`. Empty when nothing it carries bears identity. */
export function kitToken(item: {
  defIndex: number;
  quality: number;
  attributes?: ReadonlyArray<{ defIndex: number; value?: unknown; valueBytes?: Uint8Array | undefined }> | undefined;
}): string {
  const allowed = new Set<number>([
    ...(KIT_ATTRIBUTES_BY_ITEM.get(item.defIndex) ?? []),
    ...(KIT_ATTRIBUTES_BY_QUALITY.get(item.quality) ?? [])
  ]);
  if (allowed.size === 0) return '';
  return (item.attributes ?? [])
    .filter((attribute) => allowed.has(attribute.defIndex))
    .map((attribute) => [attribute.defIndex, attributeValue(attribute)] as const)
    .filter((pair): pair is readonly [number, number | string] => pair[1] !== null)
    .sort((left, right) => left[0] - right[0])
    .map(([defIndex, value]) => `${defIndex}=${value}`)
    .join(',');
}
