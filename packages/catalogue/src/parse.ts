import { createHash } from 'node:crypto';
import { isLoadableRef } from './images.js';
import type { CatalogueCollection, CatalogueEntry, CatalogueIndex, CatalogueShard, ShardRef } from './types.js';

/**
 * Where a response stops being the network's and starts being ours.
 *
 * The wire is **snake_case**, because this API's public contract is and the curve endpoints already
 * were; the TypeScript domain is camelCase. This module is the one place the two meet, which is why
 * every field name below is quoted rather than destructured.
 *
 * Everything here refuses rather than repairs. A body that is nearly right is not partially
 * accepted: a shard with one bad entry is rejected whole, because a catalogue that silently drops
 * rows produces unresolved items that look like Valve never released them.
 *
 * `CatalogueParseError` carries the reason so a failed sync can say *what* was wrong in a
 * diagnostic without carrying the body itself.
 */
export class CatalogueParseError extends Error {
  constructor(reason: string) {
    super(`catalogue: ${reason}`);
    this.name = 'CatalogueParseError';
  }
}

export const SUPPORTED_SCHEMA = 1;

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogueParseError(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CatalogueParseError(`${where} is not a non-empty string`);
  return value;
}

function optionalText(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, where);
}

function optionalNumber(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogueParseError(`${where} is not a finite number`);
  return value;
}

function schema(body: Record<string, unknown>, where: string): void {
  // An unknown schema is refused rather than best-effort parsed. A field that quietly changes
  // meaning while the shape stays valid is the expensive failure; a version bump is the cheap
  // defence, and it only works if an unrecognised value is fatal.
  if (body['schema'] !== SUPPORTED_SCHEMA) {
    throw new CatalogueParseError(`${where} has unsupported schema ${String(body['schema'])}; this build reads ${SUPPORTED_SCHEMA}`);
  }
}

export function parseIndex(body: unknown): CatalogueIndex {
  const root = object(body, 'index');
  schema(root, 'index');
  const revision = text(root['revision'], 'index.revision');
  const rawShards = root['shards'];
  if (!Array.isArray(rawShards) || rawShards.length === 0) throw new CatalogueParseError('index.shards is not a non-empty array');
  const seen = new Set<string>();
  const shards: ShardRef[] = rawShards.map((raw, i) => {
    const shard = object(raw, `index.shards[${i}]`);
    const file = text(shard['file'], `index.shards[${i}].file`);
    // A shard filename becomes a URL path segment and, in the store, a filename. Neither may be
    // steered by the response.
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) throw new CatalogueParseError(`index.shards[${i}].file is not a plain filename`);
    if (seen.has(file)) throw new CatalogueParseError(`index.shards names ${file} twice`);
    seen.add(file);
    const sha256 = text(shard['sha256'], `index.shards[${i}].sha256`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CatalogueParseError(`index.shards[${i}].sha256 is not a sha-256 digest`);
    const count = shard['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new CatalogueParseError(`index.shards[${i}].count is not a count`);
    return { file, count, sha256 };
  });
  const entryCount = root['entry_count'];
  if (typeof entryCount !== 'number' || !Number.isInteger(entryCount) || entryCount < 0) {
    throw new CatalogueParseError('index.entry_count is not a count');
  }
  const hosts = root['image_hosts'];
  return {
    schema: SUPPORTED_SCHEMA,
    revision,
    generatedAt: text(root['generated_at'], 'index.generated_at'),
    entryCount,
    shards,
    imageHosts: Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : []
  };
}

export function parseEntry(raw: unknown, where: string): CatalogueEntry {
  const entry = object(raw, where);
  const key = text(entry['key'], `${where}.key`);
  if (!/^\d+:\d*:\d+:[A-Za-z0-9=,]*$/.test(key)) throw new CatalogueParseError(`${where}.key is not a match key`);
  const minFloat = optionalNumber(entry['min_float'], `${where}.min_float`);
  const maxFloat = optionalNumber(entry['max_float'], `${where}.max_float`);
  if (minFloat !== null && maxFloat !== null && minFloat > maxFloat) {
    throw new CatalogueParseError(`${where} has min_float above max_float`);
  }
  const image = entry['image'] ?? null;
  // A reference this build could not load is refused at the door rather than stored and skipped at
  // render time, so "the image is missing" always means the catalogue said so.
  if (image !== null && !isLoadableRef(image)) throw new CatalogueParseError(`${where}.image is not a loadable reference`);
  const rawRarity = entry['rarity'];
  const rarity = rawRarity === null || rawRarity === undefined ? null : (() => {
    const r = object(rawRarity, `${where}.rarity`);
    return { id: text(r['id'], `${where}.rarity.id`), name: text(r['name'], `${where}.rarity.name`), colour: text(r['colour'], `${where}.rarity.colour`) };
  })();
  const wearSuffixed = entry['wear_suffixed'];
  if (typeof wearSuffixed !== 'boolean') throw new CatalogueParseError(`${where}.wear_suffixed is not a boolean`);
  // Absent is a generation from before the field, and says nothing. Anything but a boolean is
  // refused like every other field: `false` makes an item static, so a stray `0` must not.
  const marketable = entry['marketable'] ?? null;
  if (marketable !== null && typeof marketable !== 'boolean') throw new CatalogueParseError(`${where}.marketable is not a boolean`);
  return {
    key,
    marketHashNameBase: text(entry['market_hash_name_base'], `${where}.market_hash_name_base`),
    wearSuffixed,
    category: text(entry['category'], `${where}.category`),
    rarity,
    collectionId: optionalText(entry['collection_id'], `${where}.collection_id`),
    phase: optionalText(entry['phase'], `${where}.phase`),
    minFloat,
    maxFloat,
    image: (image as string | null),
    marketable
  };
}

/**
 * Parse a shard, and verify it is the shard the index said it would be.
 *
 * The hash check is the same defence the API applies when it publishes, applied again when we
 * consume: a CDN edge holding a stale object, a truncated transfer or a substituted body all fail
 * here rather than becoming names on somebody's inventory.
 */
export function parseShard(bytes: string, ref: ShardRef, expectedRevision: string): CatalogueShard {
  const digest = createHash('sha256').update(bytes, 'utf8').digest('hex');
  if (digest !== ref.sha256) throw new CatalogueParseError(`shard ${ref.file} does not match the digest the index published`);
  let body: unknown;
  try {
    body = JSON.parse(bytes);
  } catch {
    throw new CatalogueParseError(`shard ${ref.file} is not JSON`);
  }
  const root = object(body, `shard ${ref.file}`);
  schema(root, `shard ${ref.file}`);
  const revision = text(root['revision'], `shard ${ref.file}.revision`);
  if (revision !== expectedRevision) throw new CatalogueParseError(`shard ${ref.file} belongs to revision ${revision}, not ${expectedRevision}`);
  const rawEntries = root['entries'];
  if (!Array.isArray(rawEntries)) throw new CatalogueParseError(`shard ${ref.file}.entries is not an array`);
  const entries: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of rawEntries.entries()) {
    const entry = parseEntry(raw, `shard ${ref.file}.entries[${i}]`);
    // Two entries claiming one key is a broken generation, not one bad row: whichever lost would
    // silently decide what an item is called.
    if (seen.has(entry.key)) throw new CatalogueParseError(`shard ${ref.file} names key ${entry.key} twice`);
    seen.add(entry.key);
    entries.push(entry);
  }
  return { schema: SUPPORTED_SCHEMA, revision, entries };
}

export function parseCollections(body: unknown): readonly CatalogueCollection[] {
  const root = object(body, 'collections');
  schema(root, 'collections');
  const raw = root['collections'];
  if (!Array.isArray(raw)) throw new CatalogueParseError('collections.collections is not an array');
  return raw.map((item, i) => {
    const collection = object(item, `collections[${i}]`);
    const image = collection['image'] ?? null;
    if (image !== null && !isLoadableRef(image)) throw new CatalogueParseError(`collections[${i}].image is not a loadable reference`);
    return { id: text(collection['id'], `collections[${i}].id`), name: text(collection['name'], `collections[${i}].name`), image: image as string | null };
  });
}

/**
 * Whether a fetched revision may replace the applied one.
 *
 * Revisions are published as instants, and the comparison is deliberately strict: equal is not
 * newer. A CDN edge serving yesterday's index cannot roll the catalogue backwards, and a re-fetch
 * of the current revision is a no-op rather than a rewrite.
 */
export function isNewerRevision(candidate: string, applied: string | null): boolean {
  if (applied === null) return true;
  return candidate > applied;
}

/**
 * A domain entry rendered back into the wire shape.
 *
 * The deterministic twin and the fixture builders use this so they imitate the server rather than
 * the domain: an Oracle that emits a shape the real parser would reject is a lie the offline suite
 * would never catch.
 */
export function toWireEntry(entry: CatalogueEntry): Record<string, unknown> {
  return {
    key: entry.key,
    market_hash_name_base: entry.marketHashNameBase,
    wear_suffixed: entry.wearSuffixed,
    category: entry.category,
    rarity: entry.rarity,
    collection_id: entry.collectionId,
    phase: entry.phase,
    min_float: entry.minFloat,
    max_float: entry.maxFloat,
    image: entry.image,
    // An entry with no claim renders as a server from before the field: the key is absent.
    ...(typeof entry.marketable === 'boolean' ? { marketable: entry.marketable } : {})
  };
}

/** One shard, as the exporter would publish it. */
export function toWireShard(revision: string, entries: readonly CatalogueEntry[]): string {
  return JSON.stringify({ schema: SUPPORTED_SCHEMA, revision, entries: entries.map(toWireEntry) });
}
