import type { CsfloatBuyOrderConstraints } from '@cslytics/ports';
import type { BuyOrderFilter } from './buy-order-filters.js';

/**
 * What an own buy order's `hybrid_properties` may say before this app will touch the order.
 *
 * The venue returns an order's constraints as an object whose keys it chooses, and an edit sends
 * every constraint back absolutely, `null` for none (`CsfloatBuyOrderEdit`). So an edit of the
 * price alone has to carry the order's own constraints through, and it can only do that for
 * keys it can express on the way back out. This is that allowlist, and it is an allowlist rather
 * than a denylist on purpose: a constraint CSFloat adds later is *unknown* by default, and an
 * order that carries one is never edited from here, because the edit would strip it
 * (CSF-ORDER-02, CSF-ORDER-03, and the incumbent's float-only rule in
 * `csfloat-buying-endpoints.md`). `paint_index` is the worked example: the create route accepts
 * it, the edit route does not, so an order pinned to a paint index cannot be repriced from here.
 */
export const BUY_ORDER_CONSTRAINT_KEYS = [
  'min_float', 'max_float', 'paint_seeds', 'min_keychain_pattern', 'max_keychain_pattern', 'applied_stickers', 'applied_keychains'
] as const;

export type BuyOrderConstraintReading =
  /** Every key is one the edit route takes, with a value this app can send back. */
  | { kind: 'preservable'; constraints: CsfloatBuyOrderConstraints; unknownKeys: [] }
  /** At least one key or value this app cannot carry through an edit. */
  | { kind: 'unknown'; unknownKeys: string[] }
  /** The row carried no `hybrid_properties` at all: the venue made no claim either way. */
  | { kind: 'unreported' };

/** What the order restricts, by allowlist. `null` properties are "not reported", never "none". */
export function readBuyOrderConstraints(properties: Record<string, unknown> | null): BuyOrderConstraintReading {
  if (properties === null) return { kind: 'unreported' };
  const unknownKeys: string[] = [];
  const known = new Set<string>(BUY_ORDER_CONSTRAINT_KEYS);
  for (const key of Object.keys(properties)) if (!known.has(key)) unknownKeys.push(key);
  const minFloat = unitInterval(properties['min_float']);
  const maxFloat = unitInterval(properties['max_float']);
  const paintSeeds = integerList(properties['paint_seeds']);
  const minKeychainPattern = integer(properties['min_keychain_pattern']);
  const maxKeychainPattern = integer(properties['max_keychain_pattern']);
  const appliedStickers = objectList(properties['applied_stickers']);
  const appliedKeychains = objectList(properties['applied_keychains']);
  // A known key whose value this app cannot read is as unknown as a key it has never seen: sending
  // it back as null would clear it. A key that is simply absent is none, and stays readable.
  for (const [key, value] of [['min_float', minFloat], ['max_float', maxFloat], ['paint_seeds', paintSeeds], ['min_keychain_pattern', minKeychainPattern],
    ['max_keychain_pattern', maxKeychainPattern], ['applied_stickers', appliedStickers], ['applied_keychains', appliedKeychains]] as const) {
    if (key in properties && value === undefined) unknownKeys.push(key);
  }
  if (unknownKeys.length) return { kind: 'unknown', unknownKeys: [...new Set(unknownKeys)] };
  return { kind: 'preservable', unknownKeys: [], constraints: {
    minFloat: minFloat ?? null, maxFloat: maxFloat ?? null, paintSeeds: paintSeeds ?? null,
    minKeychainPattern: minKeychainPattern ?? null, maxKeychainPattern: maxKeychainPattern ?? null,
    appliedStickers: appliedStickers ?? null, appliedKeychains: appliedKeychains ?? null
  } };
}

/** The highest paint seed CS2 assigns. */
const MAX_PAINT_SEED = 1000;
/** The most of one kind an order is let carry from here: a bound on what is sent, not a venue rule. */
const MAX_LISTED = 100;

/**
 * New constraints for an edit, checked and put in the form the edit route is sent.
 *
 * `PATCH /buy-orders/{id}` takes every constraint absolutely (a live capture of 2026-09-24
 * changed floats, patterns, stickers and a charm in one save), so a change of filters is a whole
 * new set, not a difference. What cannot be a filter is refused here in words, before any call:
 * a float outside [0, 1] or a range upside down, a pattern that is not a whole seed, a sticker or
 * charm without a whole-number definition id. Empty lists are `null`, which is how the route
 * says "none", and a pattern or accessory named twice is named once.
 */
export function validateBuyOrderConstraints(input: CsfloatBuyOrderConstraints): CsfloatBuyOrderConstraints {
  const float = (value: number | null, name: string): number | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`The ${name} float must be between 0 and 1`);
    return value;
  };
  const minFloat = float(input.minFloat, 'lowest');
  const maxFloat = float(input.maxFloat, 'highest');
  if (minFloat !== null && maxFloat !== null && minFloat > maxFloat) throw new Error('The lowest float is above the highest');
  const pattern = (value: number | null, name: string): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`The ${name} charm pattern must be a whole number`);
    return value;
  };
  const minKeychainPattern = pattern(input.minKeychainPattern, 'lowest');
  const maxKeychainPattern = pattern(input.maxKeychainPattern, 'highest');
  if (minKeychainPattern !== null && maxKeychainPattern !== null && minKeychainPattern > maxKeychainPattern) throw new Error('The lowest charm pattern is above the highest');
  let paintSeeds: number[] | null = null;
  if (input.paintSeeds !== null) {
    if (!Array.isArray(input.paintSeeds) || input.paintSeeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > MAX_PAINT_SEED)) {
      throw new Error(`Patterns must be whole numbers from 0 to ${MAX_PAINT_SEED}`);
    }
    paintSeeds = [...new Set(input.paintSeeds)];
    if (paintSeeds.length > MAX_LISTED) throw new Error(`An order can name at most ${MAX_LISTED} patterns here`);
    if (paintSeeds.length === 0) paintSeeds = null;
  }
  const accessories = (value: readonly unknown[] | null, name: string): Array<{ sId: number }> | null => {
    if (value === null) return null;
    const ids = Array.isArray(value) ? value.map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['sId'] : undefined)) : [undefined];
    if (ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)) throw new Error(`Every ${name} needs its definition id`);
    if (ids.length > MAX_LISTED) throw new Error(`An order can require at most ${MAX_LISTED} ${name}s here`);
    return ids.length ? (ids as number[]).map((sId) => ({ sId })) : null;
  };
  return {
    minFloat, maxFloat, paintSeeds, minKeychainPattern, maxKeychainPattern,
    appliedStickers: accessories(input.appliedStickers, 'sticker'),
    appliedKeychains: accessories(input.appliedKeychains, 'charm')
  };
}

/**
 * Whether two constraint sets say the same thing, as the venue would echo them: floats and charm
 * patterns by value, patterns as a set, stickers and charms by definition id counted — the same
 * sticker twice is two stickers — and the order of a list as no part of it. `[]` and `null` are
 * both none.
 */
export function sameBuyOrderConstraints(left: CsfloatBuyOrderConstraints, right: CsfloatBuyOrderConstraints): boolean {
  const close = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
  const seeds = (list: readonly number[] | null): string => [...new Set(list ?? [])].sort((a, b) => a - b).join(',');
  const ids = (list: readonly unknown[] | null): string => (list ?? [])
    .map((entry) => (typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>)['sId']) : '?'))
    .sort().join(',');
  return close(left.minFloat, right.minFloat) && close(left.maxFloat, right.maxFloat)
    && left.minKeychainPattern === right.minKeychainPattern && left.maxKeychainPattern === right.maxKeychainPattern
    && seeds(left.paintSeeds) === seeds(right.paintSeeds)
    && ids(left.appliedStickers) === ids(right.appliedStickers) && ids(left.appliedKeychains) === ids(right.appliedKeychains);
}

/** Constraints as the venue's `hybrid_properties` would carry them: only what is not none. */
export function constraintsAsProperties(constraints: CsfloatBuyOrderConstraints): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (constraints.minFloat !== null) properties['min_float'] = constraints.minFloat;
  if (constraints.maxFloat !== null) properties['max_float'] = constraints.maxFloat;
  if (constraints.paintSeeds !== null && constraints.paintSeeds.length) properties['paint_seeds'] = [...constraints.paintSeeds];
  if (constraints.minKeychainPattern !== null) properties['min_keychain_pattern'] = constraints.minKeychainPattern;
  if (constraints.maxKeychainPattern !== null) properties['max_keychain_pattern'] = constraints.maxKeychainPattern;
  if (constraints.appliedStickers !== null && constraints.appliedStickers.length) properties['applied_stickers'] = [...constraints.appliedStickers];
  if (constraints.appliedKeychains !== null && constraints.appliedKeychains.length) properties['applied_keychains'] = [...constraints.appliedKeychains];
  return properties;
}

/** The constraints an edit must carry, or null when the order cannot be edited from here. */
export function preservableConstraints(properties: Record<string, unknown> | null): CsfloatBuyOrderConstraints | null {
  const reading = readBuyOrderConstraints(properties);
  return reading.kind === 'preservable' ? reading.constraints : null;
}

/**
 * What the order restricts, in words, for the row. `null` is a plain order: any item of that
 * market name. An unknown key is named rather than hidden, because the person reading the row is
 * about to be told the order cannot be changed from here and deserves to know why.
 */
export function describeBuyOrderConstraints(properties: Record<string, unknown> | null): string | null {
  const reading = readBuyOrderConstraints(properties);
  if (reading.kind === 'unreported') return 'constraints not reported';
  const parts: string[] = [];
  const min = unitInterval(properties?.['min_float']);
  const max = unitInterval(properties?.['max_float']);
  if (min || max) parts.push(`float ${min ? min.toString() : '0'}–${max ? max.toString() : '1'}`);
  const seeds = integerList(properties?.['paint_seeds']);
  if (seeds && seeds.length) parts.push(`${seeds.length === 1 ? 'seed' : 'seeds'} ${seeds.join(', ')}`);
  const stickers = objectList(properties?.['applied_stickers']);
  if (stickers && stickers.length) parts.push(`${stickers.length} sticker${stickers.length === 1 ? '' : 's'}`);
  const keychains = objectList(properties?.['applied_keychains']);
  if (keychains && keychains.length) parts.push(`${keychains.length} keychain${keychains.length === 1 ? '' : 's'}`);
  const patternMin = integer(properties?.['min_keychain_pattern']);
  const patternMax = integer(properties?.['max_keychain_pattern']);
  if (patternMin || patternMax) parts.push(`keychain pattern ${patternMin ?? 0}–${patternMax ?? '∞'}`);
  if (reading.kind === 'unknown') parts.push(`also ${reading.unknownKeys.join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The order's `hybrid_properties` as the shared filter kinds (`kernel/buy-order-filters.ts`), in
 * the order a person reads them: float, pattern, stickers, charms, charm pattern, then anything
 * this app cannot read. `null` is a row that reported no properties at all, which is not "none".
 *
 * A sticker's or charm's `sId` is its definition id — the sticker kit, or the charm — which is
 * the id the catalogue keys it by (`csfloat-buying-endpoints.md`: "sticker definition ID"). An
 * entry without a whole-number `sId` is shown as unreadable rather than dropped, and so is any key
 * outside the allowlist, because the row is where the person learns the order cannot be changed
 * from here and why.
 */
export function csfloatBuyOrderFilters(properties: Record<string, unknown> | null): BuyOrderFilter[] | null {
  if (properties === null) return null;
  const filters: BuyOrderFilter[] = [];
  const unreadable = (key: string): void => { filters.push({ kind: 'unrecognised', key, value: shown(properties[key]) }); };
  const min = unitInterval(properties['min_float']);
  const max = unitInterval(properties['max_float']);
  if (min === undefined && 'min_float' in properties) unreadable('min_float');
  if (max === undefined && 'max_float' in properties) unreadable('max_float');
  if (typeof min === 'number' || typeof max === 'number') filters.push({ kind: 'float', min: min ?? null, max: max ?? null });
  const seeds = integerList(properties['paint_seeds']);
  if (seeds === undefined && 'paint_seeds' in properties) unreadable('paint_seeds');
  else if (seeds?.length) filters.push({ kind: 'pattern', seeds });
  const stickers = definitions(properties['applied_stickers']);
  if (stickers === undefined && 'applied_stickers' in properties) unreadable('applied_stickers');
  else if (stickers?.length) filters.push({ kind: 'stickers', stickers: stickers.map(({ id, slot }) => ({ stickerId: id, slot })) });
  const charms = definitions(properties['applied_keychains']);
  if (charms === undefined && 'applied_keychains' in properties) unreadable('applied_keychains');
  else if (charms?.length) filters.push({ kind: 'charms', charms: charms.map(({ id }) => ({ charmId: id })) });
  const patternMin = integer(properties['min_keychain_pattern']);
  const patternMax = integer(properties['max_keychain_pattern']);
  if (patternMin === undefined && 'min_keychain_pattern' in properties) unreadable('min_keychain_pattern');
  if (patternMax === undefined && 'max_keychain_pattern' in properties) unreadable('max_keychain_pattern');
  if (typeof patternMin === 'number' || typeof patternMax === 'number') filters.push({ kind: 'charm-pattern', min: patternMin ?? null, max: patternMax ?? null });
  const known = new Set<string>(BUY_ORDER_CONSTRAINT_KEYS);
  for (const key of Object.keys(properties)) if (!known.has(key)) unreadable(key);
  // Unreadable last, whichever key it came from, so what the order does restrict reads first.
  return [...filters.filter((filter) => filter.kind !== 'unrecognised'), ...filters.filter((filter) => filter.kind === 'unrecognised')];
}

/** `[{ sId, slot? }]` as ids, `null` for none, `undefined` when any entry has no whole-number `sId`. */
function definitions(value: unknown): Array<{ id: number; slot: number | null }> | null | undefined {
  const entries = objectList(value);
  if (entries === undefined || entries === null) return entries;
  const read = entries.map((entry) => {
    const fields = entry as Record<string, unknown>;
    const id = fields['sId'];
    const slot = fields['slot'];
    return typeof id === 'number' && Number.isSafeInteger(id) ? { id, slot: typeof slot === 'number' && Number.isSafeInteger(slot) ? slot : null } : null;
  });
  return read.every((entry) => entry !== null) ? read as Array<{ id: number; slot: number | null }> : undefined;
}

/** A value the venue sent, short enough for a row. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** A number in [0, 1], `null` for an explicit null, `undefined` for absent or unreadable. */
function unitInterval(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function integer(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function integerList(value: unknown): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry)) ? [...value] as number[] : undefined;
}

/** A list of plain objects (`{ sId }` and whatever else the venue puts beside it), kept as sent. */
function objectList(value: unknown): unknown[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) ? structuredClone(value) : undefined;
}
