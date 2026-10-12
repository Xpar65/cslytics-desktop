import { createHash } from 'node:crypto';
import type { CatalogueEntry, CatalogueIndex, FetchOutcome, MatchKey, ShardRef } from './types.js';
import { keyHash, matchKey } from './keys.js';
import { parseCollections, parseEntry, parseIndex, toWireShard } from './parse.js';
import type { CatalogueCollection } from './types.js';

/**
 * Where catalogue bodies come from.
 *
 * This is the seam, and it is deliberately **not** called a `Port`. In this repository `Port`,
 * `Adapter` and `Oracle` name things on the *engine's* boundary — interfaces the engine depends on
 * so it can be tested without the world. The catalogue is not on that boundary at all: the engine
 * never calls it, never imports it and does not know it exists. Giving this a port would imply a
 * dependency that must not exist.
 *
 * `Oracle` is reused for the deterministic twin, because that word already means exactly this here.
 */
export type CatalogueSource = {
  /** `etag` is the caller's last known one; a `not-modified` outcome is a successful no-op. */
  fetchIndex(etag: string | null): Promise<FetchOutcome<CatalogueIndex>>;
  /** Raw bytes, not parsed: the shard's digest is verified over exactly what arrived. */
  fetchShard(ref: ShardRef): Promise<FetchOutcome<string>>;
  /** One key, for an item released after the applied revision was published. */
  fetchKey(key: MatchKey): Promise<FetchOutcome<CatalogueEntry>>;
  fetchCollections(etag: string | null): Promise<FetchOutcome<readonly CatalogueCollection[]>>;
};

export const CATALOGUE_HOST = 'api.cslytics.com';
export const CATALOGUE_BASE = `https://${CATALOGUE_HOST}/free/v1/catalogue`;

/**
 * The one place the catalogue meets the network.
 *
 * Four rules, each of which fails silently at a call site:
 *
 *  1. **One host.** Every request is built from `CATALOGUE_BASE` and a path that would escape it
 *     throws before a request is made. Nothing accepts a caller-supplied URL.
 *  2. **No redirects, ever.** `redirect: 'manual'`. There is no credential to leak here, which is
 *     exactly why the rule is worth stating: a following redirect would let the response choose the
 *     host that decides what a user's items are called.
 *  3. **No credentials, in either direction.** No `Authorization`, no cookie, and no account
 *     identifier in a path, query or header. Our own server learns that *some* copy of the app saw
 *     an item of some type, and nothing more. `check:assets` asserts this rather than trusting it.
 *  4. **A transport fact is not a verdict.** A timeout, a 502 and a 404 are different things, and
 *     only `absent` means "the catalogue does not have this". Everything else leaves the applied
 *     revision exactly where it was.
 */
export class HttpCatalogueSource implements CatalogueSource {
  constructor(
    private readonly language = 'en',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000
  ) {}

  async fetchIndex(etag: string | null): Promise<FetchOutcome<CatalogueIndex>> {
    return this.json('index.json', etag, parseIndex);
  }

  async fetchCollections(etag: string | null): Promise<FetchOutcome<readonly CatalogueCollection[]>> {
    return this.json('collections.json', etag, parseCollections);
  }

  async fetchKey(key: MatchKey): Promise<FetchOutcome<CatalogueEntry>> {
    return this.json(`key/${keyHash(key)}.json`, null, (body) => {
      const entry = parseEntry(body, 'key');
      // A server answering with a different item than the one asked for is a bug we must not
      // cache: it would attach one item's name to another's identity, which is the failure this
      // whole plan is most afraid of.
      if (entry.key !== key) throw new Error(`catalogue: asked for ${key} and was answered ${entry.key}`);
      return entry;
    });
  }

  async fetchShard(ref: ShardRef): Promise<FetchOutcome<string>> {
    return this.text(ref.file, null);
  }

  private async json<T>(path: string, etag: string | null, parse: (body: unknown) => T): Promise<FetchOutcome<T>> {
    const raw = await this.text(path, etag);
    if (raw.kind !== 'ok') return raw;
    try {
      return { kind: 'ok', value: parse(JSON.parse(raw.value)), etag: raw.etag };
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : 'unparseable body' };
    }
  }

  private async text(path: string, etag: string | null): Promise<FetchOutcome<string>> {
    let url: string;
    try {
      url = resolve(this.language, path);
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : 'bad path' };
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (etag) headers.set('If-None-Match', etag);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (response.status === 304) return { kind: 'not-modified' };
      if (response.status === 404) return { kind: 'absent' };
      if (response.status >= 300 && response.status < 400) return { kind: 'failed', detail: `redirected with ${response.status}` };
      const body = await response.text();
      if (!response.ok) {
        const html = /<!DOCTYPE|<html/i.test(body.slice(0, 200));
        return { kind: 'failed', detail: html ? `HTTP ${response.status} (HTML error page, not a catalogue body)` : `HTTP ${response.status}` };
      }
      return { kind: 'ok', value: body, etag: response.headers.get('etag') };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
      const detail = aborted ? 'timeout' : error instanceof Error ? error.message : 'transport error';
      return { kind: 'failed', detail: cause ? `${detail}: ${cause}` : detail };
    } finally {
      clearTimeout(timer);
    }
  }
}

function resolve(language: string, path: string): string {
  if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(language)) throw new Error('catalogue: language is not a language tag');
  const url = new URL(`${CATALOGUE_BASE}/${language}/${path}`);
  if (url.hostname !== CATALOGUE_HOST || !url.pathname.startsWith('/free/v1/catalogue/')) {
    throw new Error('catalogue: path escapes the catalogue namespace');
  }
  return url.toString();
}

/**
 * A catalogue with no network: the deterministic twin the offline suite and every journey use.
 *
 * It answers from an entry list a test controls, which is what makes the new-skin drill possible
 * offline — a key absent from the bulk revision but present here is exactly the shape of a skin
 * Valve released after the last publication.
 */
export class OracleCatalogueSource implements CatalogueSource {
  private readonly entries = new Map<MatchKey, CatalogueEntry>();
  private readonly onlyByKey = new Set<MatchKey>();
  private collections: CatalogueCollection[] = [];
  revision = '2026-01-01T00:00:00Z';
  /** Set to fail every call, to exercise the "unreachable subtracts nothing" path. */
  unreachable: string | null = null;

  /** Present in the bulk revision, and therefore in the store after a sync. */
  add(entry: CatalogueEntry): this {
    this.entries.set(entry.key, entry);
    this.onlyByKey.delete(entry.key);
    return this;
  }

  /** Resolvable only by single-key lookup: an item released after this revision was published. */
  addLateRelease(entry: CatalogueEntry): this {
    this.entries.set(entry.key, entry);
    this.onlyByKey.add(entry.key);
    return this;
  }

  addCollection(collection: CatalogueCollection): this {
    this.collections.push(collection);
    return this;
  }

  keyFor(identity: { defIndex: number; paintIndex?: number | null; quality: number }): MatchKey {
    return matchKey(identity);
  }

  private bulk(): CatalogueEntry[] {
    return [...this.entries.values()].filter((entry) => !this.onlyByKey.has(entry.key));
  }

  async fetchIndex(etag: string | null): Promise<FetchOutcome<CatalogueIndex>> {
    if (this.unreachable) return { kind: 'failed', detail: this.unreachable };
    if (etag === this.revision) return { kind: 'not-modified' };
    const bytes = this.shardBytes();
    return {
      kind: 'ok',
      etag: this.revision,
      value: parseIndex({
        schema: 1,
        revision: this.revision,
        generated_at: this.revision,
        entry_count: this.bulk().length,
        shards: [{ file: 'entries-000.json', count: this.bulk().length, sha256: digest(bytes) }],
        image_hosts: []
      })
    };
  }

  async fetchShard(): Promise<FetchOutcome<string>> {
    if (this.unreachable) return { kind: 'failed', detail: this.unreachable };
    return { kind: 'ok', value: this.shardBytes(), etag: null };
  }

  async fetchKey(key: MatchKey): Promise<FetchOutcome<CatalogueEntry>> {
    if (this.unreachable) return { kind: 'failed', detail: this.unreachable };
    const entry = this.entries.get(key);
    return entry ? { kind: 'ok', value: entry, etag: null } : { kind: 'absent' };
  }

  async fetchCollections(): Promise<FetchOutcome<readonly CatalogueCollection[]>> {
    if (this.unreachable) return { kind: 'failed', detail: this.unreachable };
    return { kind: 'ok', value: this.collections, etag: null };
  }

  /** The wire shape, not the domain shape: the twin must be refusable by the real parser. */
  private shardBytes(): string {
    return toWireShard(this.revision, this.bulk());
  }
}

function digest(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
