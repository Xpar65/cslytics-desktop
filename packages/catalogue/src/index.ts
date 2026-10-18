import { attributeValue, commodityMatchKey, keyHash, kitToken, matchKey, KIT_ATTRIBUTES_BY_ITEM, KIT_ATTRIBUTES_BY_QUALITY } from './keys.js';
import { displayName, marketHashName, qualityLabel, rawFallbackName, wearTier } from './names.js';
import { imageUrl, cachedImageUrl, parseCachedImageUrl, resizedImageUrl, IMAGE_HOSTS, IMAGE_SCHEME, IMAGE_SIZES, isLoadableRef, ECON_IMAGE_HOST, STEAM_CDN_HOST, AVATAR_IMAGE_HOST, STEAM_MARKET_HOST, steamMarketListingUrl, steamProfileUrl } from './images.js';
import { CatalogueParseError, isNewerRevision, parseEntry, parseIndex, parseShard, toWireEntry, toWireShard, SUPPORTED_SCHEMA } from './parse.js';
import { CatalogueStore, MemoryCatalogueStore, type CatalogueStoreLike, type Miss, type StoredGeneration } from './store.js';
import { CATALOGUE_BASE, CATALOGUE_HOST, HttpCatalogueSource, OracleCatalogueSource, type CatalogueSource } from './source.js';
import { CSFLOAT_SCHEMA_HOST, CSFLOAT_SCHEMA_TTL_MS, CSFLOAT_SCHEMA_URL, CsfloatKindIndex, CsfloatKinds, fetchCsfloatSchema, parseCsfloatSchema, type CsfloatItemClass, type CsfloatKindsData, type CsfloatKindsRefresh, type CsfloatSupport } from './csfloat-kinds.js';
import { prepare, rank, score, SUGGEST_THRESHOLD, type Prepared } from './suggest.js';
import { wearBandsFor, normWindow, EQUALITY_TOLERANCE, type NormPredicate, type WearBand } from './bands.js';
import { realToNorm, normToReal, type PaintRange } from './float.js';
import type { CatalogueCollection, CatalogueEntry, MatchKey, Resolved, UnresolvedReason } from './types.js';

export {
  matchKey, commodityMatchKey, keyHash, kitToken, attributeValue,
  KIT_ATTRIBUTES_BY_ITEM, KIT_ATTRIBUTES_BY_QUALITY,
  displayName, marketHashName, rawFallbackName, wearTier, qualityLabel,
  imageUrl, cachedImageUrl, parseCachedImageUrl, resizedImageUrl, isLoadableRef, IMAGE_HOSTS, IMAGE_SCHEME, IMAGE_SIZES, ECON_IMAGE_HOST, STEAM_CDN_HOST, AVATAR_IMAGE_HOST,
  STEAM_MARKET_HOST, steamMarketListingUrl, steamProfileUrl,
  CatalogueParseError, isNewerRevision, parseEntry, parseIndex, parseShard, toWireEntry, toWireShard, SUPPORTED_SCHEMA,
  CatalogueStore, MemoryCatalogueStore,
  HttpCatalogueSource, OracleCatalogueSource, CATALOGUE_BASE, CATALOGUE_HOST,
  CsfloatKinds, CsfloatKindIndex, fetchCsfloatSchema, parseCsfloatSchema, CSFLOAT_SCHEMA_HOST, CSFLOAT_SCHEMA_URL, CSFLOAT_SCHEMA_TTL_MS,
  prepare, rank, score, SUGGEST_THRESHOLD, wearBandsFor, normWindow, EQUALITY_TOLERANCE,
  realToNorm, normToReal
};
export type { CatalogueSource, CatalogueStoreLike, Miss, StoredGeneration, Prepared, NormPredicate, WearBand, PaintRange, CsfloatItemClass, CsfloatKindsData, CsfloatKindsRefresh, CsfloatSupport };
export type * from './types.js';

/** How long a key the server did not know is left alone before asking again. */
const MISS_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
/** How many unknown keys one resolve pass will ask about. Bounds a cold cache's first scroll. */
export const RESOLVE_BATCH = 40;
/** How many of the best-scoring item names are reordered by what the user holds. */
export const HOLDINGS_CANDIDATES = 200;

export type SyncOutcome =
  | { kind: 'applied'; revision: string; entries: number }
  | { kind: 'current'; revision: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable'; detail: string };

/**
 * What the filter bar shows under the cursor, grouped the way the bar groups it.
 *
 * `items` are base names, which a chip carries as text and the mediator resolves back to keys.
 * `keywords` are the catalogue's own vocabulary — its categories and its rarity grades — so the
 * bar never offers a filter this generation cannot satisfy.
 */
export type CatalogueSuggestions = {
  /**
   * `owned` is present only when the caller passed holdings: how many of them the item's chip would
   * match, which is what the list is ordered by.
   */
  items: Array<{ name: string; category: string; image: string | null; keys: number; owned?: number }>;
  collections: Array<{ id: string; name: string }>;
  keywords: Array<{ kind: 'item' | 'rarity'; text: string; label: string; rarityId?: string }>;
};

export type CatalogueStatus = {
  revision: string | null;
  fetchedAt: string | null;
  entries: number;
  misses: number;
  /** True once a sync has failed since the last success, so the window can badge it as stale. */
  stale: boolean;
};

/**
 * The catalogue, as the host sees it.
 *
 * Everything here is about what an item is *called*. Nothing here may decide what a command acts
 * on: the engine addresses items by identity and has never heard of this package, which is what
 * makes a remote data source safe to depend on. `check:deps` keeps that true.
 *
 * Two failure rules shape the whole class:
 *
 *  - **An unreachable server subtracts a name, never an item.** A failed, empty or malformed sync
 *    leaves the applied generation exactly where it was. A fetch that did not happen is not
 *    evidence that an item does not exist — the same rule the trading side applies to Steam.
 *  - **An unknown key is unresolved, never guessed.** No nearest def-index, no same-paint
 *    substitute. An unresolved row still shows, still selects and still operates.
 */
export class Catalogue {
  private entries = new Map<MatchKey, CatalogueEntry>();
  private collections = new Map<string, CatalogueCollection>();
  private searchIndex: Array<{ key: MatchKey; haystack: string; category: string }> = [];
  private misses = new Map<MatchKey, Miss>();
  private revision: string | null = null;
  private fetchedAt: string | null = null;
  private nameIndex: Array<{ prepared: Prepared; value: { name: string; category: string; image: string | null; keys: number } }> = [];
  private collectionIndex: Array<{ prepared: Prepared; value: { id: string; name: string } }> = [];
  private categoryIndex: Array<{ prepared: Prepared; value: string }> = [];
  private rarityIndex: Array<{ prepared: Prepared; value: { id: string; name: string; colour: string } }> = [];
  private suggestBuiltAt = -1;
  private suggestBuiltFor: string | null = null;
  private etag: string | null = null;
  private stale = false;

  constructor(
    private readonly source: CatalogueSource,
    private readonly store: CatalogueStoreLike = new MemoryCatalogueStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Bring the last stored generation into memory. Never fetches. */
  async open(): Promise<void> {
    const stored = await this.store.load();
    if (stored) this.adopt(stored);
    for (const miss of await this.store.loadMisses()) this.misses.set(miss.key, miss);
  }

  status(): CatalogueStatus {
    return { revision: this.revision, fetchedAt: this.fetchedAt, entries: this.entries.size, misses: this.misses.size, stale: this.stale };
  }

  /**
   * Fetch and apply a newer generation, or leave everything alone.
   *
   * The order matters and mirrors how the API publishes: every shard is fetched and verified
   * *before* anything is adopted, so a shard that fails in the middle leaves the previous
   * generation current rather than half of two.
   */
  async sync(): Promise<SyncOutcome> {
    const index = await this.source.fetchIndex(this.etag);
    if (index.kind === 'not-modified') {
      this.fetchedAt = this.now().toISOString();
      this.stale = false;
      return { kind: 'current', revision: this.revision ?? '' };
    }
    if (index.kind === 'failed' || index.kind === 'absent') {
      this.stale = true;
      return { kind: 'unreachable', detail: index.kind === 'failed' ? index.detail : 'index absent' };
    }
    if (!isNewerRevision(index.value.revision, this.revision)) {
      this.stale = false;
      return { kind: 'current', revision: this.revision ?? index.value.revision };
    }

    const staged: CatalogueEntry[] = [];
    for (const ref of index.value.shards) {
      const shard = await this.source.fetchShard(ref);
      if (shard.kind !== 'ok') {
        this.stale = true;
        return { kind: 'unreachable', detail: `shard ${ref.file}: ${shard.kind === 'failed' ? shard.detail : shard.kind}` };
      }
      try {
        staged.push(...parseShard(shard.value, ref, index.value.revision).entries);
      } catch (error) {
        // A malformed generation is refused whole. Merging the shards that did parse would publish
        // a catalogue nobody ever built, and it would look complete.
        this.stale = true;
        return { kind: 'refused', reason: error instanceof Error ? error.message : 'shard refused' };
      }
    }

    const collections = await this.source.fetchCollections(null);
    const generation: StoredGeneration = {
      revision: index.value.revision,
      fetchedAt: this.now().toISOString(),
      etag: index.etag,
      entries: staged,
      collections: collections.kind === 'ok' ? collections.value : []
    };
    this.adopt(generation);
    // A key that was missing may exist in this revision; the ones that still do not will be
    // re-recorded on their next lookup, with their backoff reset by the publication.
    for (const key of [...this.misses.keys()]) if (this.entries.has(key)) this.misses.delete(key);
    await this.store.save(generation);
    await this.store.saveMisses([...this.misses.values()]);
    this.stale = false;
    return { kind: 'applied', revision: generation.revision, entries: staged.length };
  }

  lookup(key: MatchKey): Resolved {
    const entry = this.entries.get(key);
    if (entry) return { kind: 'entry', entry };
    return { kind: 'unresolved', reason: this.unresolvedReason(key) };
  }

  /** Resolve many at once, which is how every caller should ask: one pass, no per-row work. */
  resolveAll(keys: Iterable<MatchKey>): Map<MatchKey, Resolved> {
    const out = new Map<MatchKey, Resolved>();
    for (const key of keys) if (!out.has(key)) out.set(key, this.lookup(key));
    return out;
  }

  collection(id: string | null): CatalogueCollection | null {
    return id === null ? null : this.collections.get(id) ?? null;
  }

  /**
   * Names to identity keys.
   *
   * Returns `[]` for a term that matches nothing, and that is not the same as returning
   * `undefined`. The caller passes this straight to the engine as `matchKeys`, where an empty
   * array means "no row qualifies" and an absent one means "no name filter" — conflating them
   * makes a search for something nobody owns display the entire inventory.
   */
  search(term: string, category?: string): MatchKey[] {
    const needle = searchTerm(term);
    const wanted = category?.trim() ?? '';
    const out: MatchKey[] = [];
    for (const row of this.searchIndex) {
      if (wanted && row.category !== wanted) continue;
      if (needle && !row.haystack.includes(needle)) continue;
      out.push(row.key);
    }
    return out;
  }

  /** Every category the current generation actually uses, so the UI offers no dead option. */
  categories(): string[] {
    return [...new Set(this.searchIndex.map((row) => row.category))].filter(Boolean).sort();
  }

  /**
   * Every rarity the current generation uses, so the filter bar offers no dead grade.
   *
   * Ordered by the order rarities are graded in, which the colour does not carry — the list is
   * built from what entries actually hold, then sorted by first appearance of the name.
   */
  rarities(): Array<{ id: string; name: string; colour: string }> {
    const out = new Map<string, { id: string; name: string; colour: string }>();
    for (const entry of this.entries.values()) if (entry.rarity && !out.has(entry.rarity.id)) out.set(entry.rarity.id, entry.rarity);
    return [...out.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Every collection, for the suggestion groups and for a collection chip's key set. */
  collectionList(): Array<{ id: string; name: string }> {
    return [...this.collections.values()]
      .map((collection) => ({ id: collection.id, name: collection.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Every entry in the applied generation. The caller filters; this package holds no opinion. */
  allEntries(): CatalogueEntry[] {
    return [...this.entries.values()];
  }

  /** The entries that have a float range, which are the only ones a normalised float can exist for. */
  floatEntries(): CatalogueEntry[] {
    return [...this.entries.values()].filter((entry) => entry.minFloat !== null && entry.maxFloat !== null);
  }

  /**
   * The keys of every kind the catalogue says is never a market item: coins, medals, badges,
   * granted music kits. Main hands them to the engine as identity keys to leave out of a selection,
   * the same shape a name filter's `matchKeys` already has.
   */
  unmarketableKeys(): MatchKey[] {
    return [...this.entries.values()].filter((entry) => entry.marketable === false).map((entry) => entry.key);
  }

  /**
   * What the filter bar offers while the user is still typing.
   *
   * Answered from memory, in the main process, against the same index `search` uses — one IPC
   * round trip, no network. Items are deduplicated by their base name, because five wear tiers of
   * one skin are one thing a person meant to type, not five suggestions.
   */
  suggest(text: string, limit = 8, holdings?: ReadonlyMap<MatchKey, number>): CatalogueSuggestions {
    const needle = text.trim();
    if (!needle) return { items: [], collections: [], keywords: [] };
    const bounded = Math.min(25, Math.max(1, Math.trunc(limit) || 8));
    this.rebuildSuggestIndex();

    const items = holdings
      ? this.rankByHoldings(needle, bounded, holdings)
      : rank(needle, this.nameIndex, bounded).map((row) => ({ name: row.name, category: row.category, image: row.image, keys: row.keys }));
    const collections = rank(needle, this.collectionIndex, Math.min(5, bounded));
    const keywords: CatalogueSuggestions['keywords'] = [
      ...rank(needle, this.categoryIndex, 3).map((category) => ({ kind: 'item' as const, text: category, label: category })),
      ...rank(needle, this.rarityIndex, 3).map((rarity) => ({ kind: 'rarity' as const, text: rarity.name, label: rarity.name, rarityId: rarity.id }))
    ];
    return { items, collections, keywords };
  }

  /**
   * The item suggestions, the ones the user holds first.
   *
   * A suggestion's weight is how many of `holdings` its chip would match, so it is measured with
   * the chip's own rule, `search`: the general `Galil AR` matches every Galil held and stays at the
   * top, and `Galil AR | Chatterbox` counts the StatTrak and Souvenir copies too. Holding nothing
   * that matches leaves today's order, which is also where unheld suggestions go.
   *
   * Only a real match is lifted: every word typed must appear in the name. Otherwise a sticker that
   * happens to carry the typed letters in order would jump the skins the user meant, because the
   * scorer admits scattered letters. The order is decided among the best `HOLDINGS_CANDIDATES` by
   * score, which bounds the work per keystroke and keeps a one-letter needle from ranking noise.
   */
  private rankByHoldings(needle: string, limit: number, holdings: ReadonlyMap<MatchKey, number>): CatalogueSuggestions['items'] {
    const words = fold(needle).split(/\s+/).filter(Boolean);
    // A holding a candidate could match carries every word too, so the scan narrows here once.
    const held = this.searchIndex.flatMap((row) => {
      const quantity = holdings.get(row.key);
      return quantity && words.every((word) => row.haystack.includes(word)) ? [{ haystack: row.haystack, quantity }] : [];
    });
    return rank(needle, this.nameIndex, HOLDINGS_CANDIDATES)
      .map((row, position) => {
        const name = fold(row.name);
        const term = searchTerm(row.name);
        const owned = words.every((word) => name.includes(word))
          ? held.reduce((sum, holding) => (holding.haystack.includes(term) ? sum + holding.quantity : sum), 0)
          : 0;
        return { row, position, owned };
      })
      .sort((left, right) => right.owned - left.owned || left.position - right.position)
      .slice(0, limit)
      .map(({ row, owned }) => ({ name: row.name, category: row.category, image: row.image, keys: row.keys, owned }));
  }

  /**
   * The suggestion indexes, built once per generation rather than per keystroke.
   *
   * `rebuildSearchIndex` runs on every adopt and on every resolved miss; this hangs off the same
   * moment by checking the row count it was built at, so a keystroke never walks the catalogue.
   */
  private rebuildSuggestIndex(): void {
    if (this.suggestBuiltAt === this.entries.size && this.suggestBuiltFor === this.revision) return;
    const byName = new Map<string, { name: string; category: string; image: string | null; keys: number }>();
    for (const entry of this.entries.values()) {
      const name = entry.phase ? `${entry.marketHashNameBase} — ${entry.phase}` : entry.marketHashNameBase;
      const existing = byName.get(name);
      if (existing) existing.keys += 1;
      else byName.set(name, { name, category: entry.category, image: cachedImageUrl(entry.image), keys: 1 });
    }
    this.nameIndex = [...byName.values()].map((value) => ({ prepared: prepare(value.name), value }));
    this.collectionIndex = this.collectionList().map((value) => ({ prepared: prepare(value.name), value }));
    this.categoryIndex = this.categories().map((value) => ({ prepared: prepare(value), value }));
    this.rarityIndex = this.rarities().map((value) => ({ prepared: prepare(value.name), value }));
    this.suggestBuiltAt = this.entries.size;
    this.suggestBuiltFor = this.revision;
  }

  /**
   * Record that a key had no entry, so it is asked about once and then left alone.
   *
   * Without this, a cold store on a large inventory turns the first scroll into one request per
   * visible row, repeated on every render — a denial of service against our own API, written by us.
   */
  noteMiss(key: MatchKey, reason: UnresolvedReason = 'not-in-revision'): void {
    const at = this.now().toISOString();
    const existing = this.misses.get(key);
    this.misses.set(key, existing
      ? { ...existing, lastAttempt: at, attempts: existing.attempts + 1, reason }
      : { key, firstSeen: at, lastAttempt: at, attempts: 1, reason });
  }

  /** Keys worth asking the server about right now, newest miss first, bounded. */
  dueForResolve(limit = RESOLVE_BATCH): MatchKey[] {
    const now = this.now().getTime();
    return [...this.misses.values()]
      .filter((miss) => {
        const waited = now - Date.parse(miss.lastAttempt);
        const backoff = MISS_BACKOFF_MS[Math.min(miss.attempts - 1, MISS_BACKOFF_MS.length - 1)] ?? 0;
        return Number.isFinite(waited) ? waited >= backoff : true;
      })
      .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen))
      .slice(0, limit)
      .map((miss) => miss.key);
  }

  /**
   * Ask the server about keys the current generation does not hold.
   *
   * This is the path that makes a skin released today identifiable today, on a build from March.
   * A 404 is a real answer — the catalogue genuinely does not know this key yet — and is recorded
   * as a miss with a backoff. A transport failure is not an answer and changes nothing.
   */
  async resolveMissing(keys: readonly MatchKey[]): Promise<{ resolved: number; missing: number; failed: number }> {
    const wanted = [...new Set(keys)].filter((key) => !this.entries.has(key)).slice(0, RESOLVE_BATCH);
    let resolved = 0;
    let missing = 0;
    let failed = 0;
    for (const key of wanted) {
      const outcome = await this.source.fetchKey(key);
      if (outcome.kind === 'ok') {
        this.entries.set(outcome.value.key, outcome.value);
        this.misses.delete(outcome.value.key);
        resolved += 1;
      } else if (outcome.kind === 'absent') {
        this.noteMiss(key, 'not-in-revision');
        missing += 1;
      } else {
        this.noteMiss(key, 'lookup-failed');
        failed += 1;
      }
    }
    if (resolved > 0 && this.revision !== null) {
      this.rebuildSearchIndex();
      await this.store.save({
        revision: this.revision,
        fetchedAt: this.fetchedAt ?? this.now().toISOString(),
        etag: this.etag,
        entries: [...this.entries.values()],
        collections: [...this.collections.values()]
      });
    }
    await this.store.saveMisses([...this.misses.values()]);
    return { resolved, missing, failed };
  }

  private unresolvedReason(key: MatchKey): UnresolvedReason {
    if (this.revision === null) return 'never-fetched';
    return this.misses.get(key)?.reason ?? 'not-in-revision';
  }

  private adopt(generation: StoredGeneration): void {
    this.entries = new Map(generation.entries.map((entry) => [entry.key, entry]));
    this.collections = new Map(generation.collections.map((collection) => [collection.id, collection]));
    this.revision = generation.revision;
    this.fetchedAt = generation.fetchedAt;
    this.etag = generation.etag;
    this.rebuildSearchIndex();
  }

  private rebuildSearchIndex(): void {
    this.searchIndex = [...this.entries.values()].map((entry) => ({
      key: entry.key,
      haystack: fold(`${entry.marketHashNameBase} ${entry.phase ?? ''} ${entry.category}`),
      category: entry.category
    }));
  }
}

/** Case- and accent-insensitive, so `stattrak` finds `StatTrak™` and `karambit` finds `Karambit`. */
function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * A name as `search` looks for it. A suggestion names a phase as `★ Karambit | Doppler — Phase 2`,
 * and the index holds the phase after a space, so the dash goes or a chosen phase matches nothing.
 */
function searchTerm(value: string): string {
  return fold(value).replace(/\s+—\s+/g, ' ');
}
export { STORE_DEF_INDEX_BY_NAME, STORE_NAMES_GENERATED_AT } from './store-names.generated.js';
