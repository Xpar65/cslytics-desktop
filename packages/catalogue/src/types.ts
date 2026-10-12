/**
 * The catalogue's vocabulary.
 *
 * None of this is engine state. An entry says what an item is *called* and what it looks like,
 * which no trading decision, ledger row or recovery depends on — which is precisely why it lives
 * out here rather than in the trading database.
 */

/** `(def_index, paint_index, quality)`, rendered the way the engine renders it for its own index. */
export type MatchKey = string;

/**
 * Where an image lives, stored rather than composed.
 *
 * `econ:<hash>` is a Steam economy image, which is the overwhelming majority and the only form
 * that can be asked for at an arbitrary size. An absolute URL covers what Steam does not host —
 * 85 of 110 collection icons, on the corpus measured 2026-09-13. Composition happens in exactly
 * one place (`images.ts`), so the host that serves the bytes is a constant rather than data.
 */
export type ImageRef = string;

export type Rarity = { id: string; name: string; colour: string };

export type CatalogueEntry = {
  key: MatchKey;
  /**
   * The market name **without** its wear suffix: `StatTrak™ AK-47 | Redline`, not
   * `… (Field-Tested)`. Wear is a per-item float and is not part of the key, so folding it in here
   * would turn one entry into five.
   */
  marketHashNameBase: string;
  /** Whether the wear tier is appended to produce the real `market_hash_name`. */
  wearSuffixed: boolean;
  category: string;
  rarity: Rarity | null;
  collectionId: string | null;
  /** Doppler and Gamma Doppler carry distinct paint indices, so this is naming, not matching. */
  phase: string | null;
  minFloat: number | null;
  maxFloat: number | null;
  image: ImageRef | null;
  /**
   * `false`: no unit of this kind is a Steam market item — a coin, medal, badge, trophy or granted
   * music kit, held and never sold. `true` says only that the kind has a market name. Absent or
   * null is no claim: a generation published before the field existed, or one cached from it.
   * Only `false` is ever acted on, and only as a refusal (`isDisplayOnly` in the renderer).
   */
  marketable?: boolean | null;
};

export type CatalogueCollection = { id: string; name: string; image: ImageRef | null };

export type ShardRef = { file: string; count: number; sha256: string };

export type CatalogueIndex = {
  schema: number;
  /** The only ordering fact. A body older than the applied revision is refused, never merged. */
  revision: string;
  generatedAt: string;
  entryCount: number;
  shards: readonly ShardRef[];
  /** Advisory only. The allowlist that actually gates loading is compiled into `images.ts`. */
  imageHosts: readonly string[];
};

export type CatalogueShard = { schema: number; revision: string; entries: readonly CatalogueEntry[] };

/**
 * Why a key has no entry. Never absent, never guessed: an unresolved row still shows the item,
 * still selects, and still operates — it just reads by its identity instead of its name.
 */
export type UnresolvedReason =
  | 'not-in-revision'
  | 'never-fetched'
  | 'lookup-failed';

export type Resolved =
  | { kind: 'entry'; entry: CatalogueEntry }
  | { kind: 'unresolved'; reason: UnresolvedReason };

/** What a fetch attempt produced. A transport fact is never a verdict about the catalogue. */
export type FetchOutcome<T> =
  | { kind: 'ok'; value: T; etag: string | null }
  | { kind: 'not-modified' }
  | { kind: 'absent' }
  | { kind: 'failed'; detail: string };
