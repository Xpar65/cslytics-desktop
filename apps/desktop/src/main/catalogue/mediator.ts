import { join } from 'node:path';
import {
  Catalogue,
  CatalogueStore,
  CsfloatKinds,
  HttpCatalogueSource,
  commodityMatchKey,
  displayName,
  marketHashName,
  prepare,
  rank,
  type Prepared,
  cachedImageUrl,
  rawFallbackName,
  skinName,
  skinQuality,
  skinsOf,
  wearBandsFor,
  type SkinQuality,
  type CatalogueEntry,
  type CatalogueSource,
  type CatalogueStatus,
  type CsfloatItemClass,
  type CsfloatKindsRefresh,
  type CsfloatSupport,
  type MatchKey,
  type SyncOutcome
} from '@cslytics/catalogue';
import { WEAR_TIERS } from '@cslytics/ports';
import type { AppliedAccessory, AppliedKit, AppliedRequirement } from '@cslytics/engine';
import type { AccessoryFamily, NamedAccessory } from '../../shared/accessories.js';
import type { CollectionRef, CollectionTile, ItemQuality, SkinPage, SkinTile } from '../../shared/market.js';
import { buyOrderMatches, floatWindow, type BuyOrderFacets, type ResolvedBuyOrderFilter } from './buy-order-match.js';

/**
 * The join the engine cannot do.
 *
 * The engine returns identity; the catalogue knows names; this is where they meet, in the main
 * process, on a page that is already bounded. Two directions, and both matter:
 *
 *  - **Inward**, a `search` or `category` becomes a `matchKeys` list before the command is
 *    forwarded. This is the only catalogue-shaped thing allowed to reach the engine, and the
 *    empty-versus-absent distinction is preserved exactly (see `resolveFilter`).
 *  - **Outward**, a page of rows gains a name, a `cs-image:` reference and — when the catalogue
 *    does not know the item — an explicit reason, never a guess. That reference is a handle the
 *    window hands back to main, never a URL it fetches; see `main/images/cache.ts`.
 *
 * Enrichment is one pass over the page, not one lookup per row, because a page turn must not cost
 * a walk of the catalogue.
 */

export type EnrichedRow = {
  matchKey: string;
  name: string;
  marketHashName: string | null;
  category: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  collection: { id: string; name: string } | null;
  imageUrl: string | null;
  unresolved: string | null;
  minFloat: number | null;
  maxFloat: number | null;
  /**
   * Whether CSFloat trades this kind of item, from its own catalogue (`csfloat-kinds.ts`), or
   * `null` before one has been fetched. It words why CSFloat's read left an item out; it never
   * decides whether one can be listed.
   */
  csfloatSupport: CsfloatSupport | null;
  /**
   * The catalogue's `marketable` for this kind: `false` for a coin, medal, badge or granted music
   * kit, which no unit of is ever a market item; `true` when the kind has a market name; `null`
   * when the item is unresolved or the generation predates the field. Only `false` is acted on,
   * and only as a refusal — the window's `isDisplayOnly` weighs it against what Steam observed.
   */
  catalogueMarketable: boolean | null;
};

/** One market name an item is sold under: a wear tier of a skin, or the item's only name. */
export type CatalogueVariant = {
  name: string;
  /** `FN` … `BS`, or `null` for an item with no wear. */
  tier: string | null;
  label: string | null;
  /** Valve's band index, 0 to 4, matching `inventory.positions`' `wearBand`. */
  band: number | null;
  /** Every catalogue key carrying the base name: the qualities and phases sold under it. */
  keys: MatchKey[];
};

/** What `variantsOf` answers: the item's picture and kind, and each market name it is sold under. */
export type CatalogueVariants = {
  base: string;
  /** False for a name the catalogue does not hold; it is still offered as itself. */
  known: boolean;
  category: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  imageUrl: string | null;
  marketable: boolean | null;
  minFloat: number | null;
  maxFloat: number | null;
  variants: CatalogueVariant[];
  /**
   * The qualities this skin is sold in, when there is more than one: each with the market name
   * that is the same wear in it, or its first where it has no such wear. Empty for an item sold
   * one way.
   */
  qualities: ItemQuality[];
  /** The name the skin's tile carries on a grid, whatever quality this base name is. */
  skin: string;
  /** The collection it is part of, with its emblem, or `null` for an item in none. */
  collection: CollectionRef | null;
};

/** The most skins one `skins` page carries, whatever is asked for. */
export const SKIN_PAGE_MAX = 120;
/** The last page may run over by one part in this many of a page, rather than leave that few for a page of their own. */
export const SKIN_PAGE_TAIL = 5;

const QUALITY_LABEL: Readonly<Record<SkinQuality, string>> = { normal: 'Normal', stattrak: 'StatTrak™', souvenir: 'Souvenir' };
const QUALITY_ORDER: readonly SkinQuality[] = ['normal', 'stattrak', 'souvenir'];

export type { AccessoryFamily };
export type AccessorySuggestion = { id: number; name: string; imageUrl: string | null };

/** How the catalogue keys a sticker, a patch and a charm: the item family, and the attribute carrying the definition id. */
const STICKER_KEY = { defIndex: 1209, attribute: 113 } as const;
const PATCH_KEY = { defIndex: 4609, attribute: 113 } as const;
const CHARM_KEY = { defIndex: 1355, attribute: 299 } as const;
/** The tournament highlight a souvenir charm plays: the second attribute the catalogue keys a charm by. */
const CHARM_HIGHLIGHT_ATTRIBUTE = 314;
const ACCESSORY_KEYS: Readonly<Record<AccessoryFamily, { defIndex: number; attribute: number }>> = { sticker: STICKER_KEY, patch: PATCH_KEY, charm: CHARM_KEY };
/** Every sticker, patch and plain charm entry in the catalogue is econ quality 4 (measured over the 2026-09-13 revision). */
const ACCESSORY_QUALITY = 4;

/**
 * A stickers or charms filter's entries, each with the catalogue keys its definition id may be.
 *
 * A charm id is a charm. A sticker id is a sticker *or a patch*: CSFloat names both by one sticker
 * kit id, the same filter carries either (an agent's order requires patches in it), and its own
 * site looks the id up as whichever it is (`idToStickerOrPatch`). So a sticker filter's id is
 * tried as a sticker first and then as a patch.
 */
function accessoryKeys(filter: Record<string, unknown>): Array<{ keys: MatchKey[]; entry: Record<string, unknown> }> {
  const kind = filter['kind'] === 'stickers' ? { list: 'stickers', id: 'stickerId', families: [STICKER_KEY, PATCH_KEY] }
    : filter['kind'] === 'charms' ? { list: 'charms', id: 'charmId', families: [CHARM_KEY] } : null;
  const list = kind ? filter[kind.list] : null;
  if (!kind || !Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).map((entry) => ({
    keys: kind.families.map((family) => commodityMatchKey({ defIndex: family.defIndex, quality: ACCESSORY_QUALITY, kit: `${family.attribute}=${String(entry[kind.id])}` })),
    entry
  }));
}

/** A souvenir charm, the kind that plays a tournament highlight, is econ quality 12 and keyed by its highlight too. */
const SOUVENIR_QUALITY = 12;

/**
 * The catalogue keys an applied accessory may be, likeliest first, each with the family it would be.
 *
 * A sticker slot holds a sticker on a weapon and a patch on an agent, and the slot does not say
 * which, so its kit is tried as both, as a buy-order filter's is. A charm is keyed by its kit, and
 * by its highlight when it plays one: a highlight charm is a different item per highlight, at
 * souvenir quality.
 */
function appliedKeys(accessory: AppliedAccessory): Array<{ family: AccessoryFamily; key: MatchKey }> {
  if (accessory.kind === 'sticker-slot') {
    return ([['sticker', STICKER_KEY], ['patch', PATCH_KEY]] as const).map(([family, at]) => ({
      family,
      key: commodityMatchKey({ defIndex: at.defIndex, quality: ACCESSORY_QUALITY, kit: `${at.attribute}=${accessory.kitId}` })
    }));
  }
  const kit = accessory.highlight === null
    ? `${CHARM_KEY.attribute}=${accessory.kitId}`
    : `${CHARM_KEY.attribute}=${accessory.kitId},${CHARM_HIGHLIGHT_ATTRIBUTE}=${accessory.highlight}`;
  const qualities = accessory.highlight === null ? [ACCESSORY_QUALITY, SOUVENIR_QUALITY] : [SOUVENIR_QUALITY, ACCESSORY_QUALITY];
  return qualities.map((quality) => ({ family: 'charm' as const, key: commodityMatchKey({ defIndex: CHARM_KEY.defIndex, quality, kit }) }));
}

/** The sticker sealed in a sticker-slab charm, as the sticker item itself is keyed. */
function wrappedStickerKey(accessory: AppliedAccessory): MatchKey | null {
  if (accessory.kind !== 'charm-slot' || accessory.wrappedKitId === null) return null;
  return commodityMatchKey({ defIndex: STICKER_KEY.defIndex, quality: ACCESSORY_QUALITY, kit: `${STICKER_KEY.attribute}=${accessory.wrappedKitId}` });
}

/**
 * A sticker slab's market name, from its sticker's: `Sticker Slab | Crown (Foil)` holds
 * `Sticker | Crown (Foil)`. Two slabs in a CSFloat listings capture of 2026-08-11 were named so.
 */
function slabName(stickerName: string): string {
  return `Sticker Slab | ${stickerName.replace(/^Sticker \| /, '')}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

type IdentityRow = {
  matchKey?: unknown;
  defIndex?: unknown;
  paintIndex?: unknown;
  quality?: unknown;
  paintWear?: unknown;
  minWear?: unknown;
};

export class CatalogueMediator {
  readonly catalogue: Catalogue;
  /** Which kinds CSFloat trades, kept beside the catalogue and read with it. */
  readonly csfloat: CsfloatKinds;

  constructor(userDataDirectory: string, source?: CatalogueSource, csfloatSchemaFetch?: typeof fetch) {
    this.catalogue = new Catalogue(
      source ?? new HttpCatalogueSource(),
      new CatalogueStore(join(userDataDirectory, 'catalogue'))
    );
    this.csfloat = new CsfloatKinds(join(userDataDirectory, 'catalogue'), csfloatSchemaFetch);
  }

  async open(): Promise<void> {
    await Promise.all([this.catalogue.open(), this.csfloat.open()]);
  }

  /** CSFloat's catalogue again, when the one held is older than its four hours. */
  refreshCsfloatKinds(): Promise<CsfloatKindsRefresh> {
    return this.csfloat.refresh();
  }

  status(): CatalogueStatus {
    return this.catalogue.status();
  }

  /**
   * Turn a renderer filter into an engine filter.
   *
   * The returned object never carries `search`, `category` or `chips`: they are resolved here
   * and removed, so a command that reaches the engine cannot contain a name even by accident.
   *
   * The two empty cases stay distinct, and this is the most dangerous line in the file. A term
   * that matched nothing yields `matchKeys: []`, which the engine reads as "no row qualifies". If
   * this returned `undefined` instead, a search for an item nobody owns would display the entire
   * inventory — plausible, silent, and wrong.
   */
  resolveFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!filter) return undefined;
    const { search, category, chips, excludeDisplayOnly, ...rest } = filter as {
      search?: string;
      category?: string;
      chips?: unknown;
      excludeDisplayOnly?: unknown;
    } & Record<string, unknown>;
    const host = resolveHostChips(this.catalogue, {
      search: typeof search === 'string' ? search : '',
      category: typeof category === 'string' ? category : '',
      chips: Array.isArray(chips) ? chips : []
    });
    const next: Record<string, unknown> = { ...rest };
    if (host.matchKeys !== undefined) next.matchKeys = host.matchKeys;
    if (host.wearBands !== undefined) next.wearBands = host.wearBands;
    // "Has stickers" arrives already decided; a sticker by name is resolved here into the kits it is.
    if (host.applied !== undefined) next.applied = [...(Array.isArray(rest['applied']) ? rest['applied'] as AppliedRequirement[] : []), ...host.applied];
    if (excludeDisplayOnly === true || rest.tradableOnly === true) {
      // What nothing may act on, in the two halves only each side knows: the kinds the catalogue
      // says are never market items, and the units the engine itself sees marked `cannot trade`.
      // A Tradable filter asks the same of what it shows, so a coin with no lock is not in it.
      const unmarketable = this.catalogue.unmarketableKeys();
      if (unmarketable.length > 0) next.excludeMatchKeys = unmarketable;
      next.excludeCannotTrade = true;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  /**
   * The same resolution for the Listings page, with `search` left where it is.
   *
   * A listing carries the venue's own name for its item, so a typed name there is answered by the
   * engine from observed evidence and is not a catalogue question (`shared/api.ts`). Every chip is,
   * and goes through `resolveFilter` exactly as an inventory chip does.
   */
  resolveListingFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!filter) return undefined;
    const { search, ...rest } = filter;
    const next = { ...(this.resolveFilter(rest) ?? {}), ...(search === undefined ? {} : { search }) };
    return Object.keys(next).length > 0 ? next : undefined;
  }

  /** Every category the current generation actually uses, so the UI offers no dead option. */
  categories(): string[] {
    return this.catalogue.categories();
  }

  rarities(): Array<{ id: string; name: string }> {
    return this.catalogue.rarities();
  }

  collections(): Array<{ id: string; name: string }> {
    return this.catalogue.collectionList();
  }

  /**
   * `holdings` orders the item suggestions by what the user holds; see `HoldingCounts`. `browse`
   * is the Items page asking for the names it can show everything under, weapons among them.
   */
  suggest(text: string, limit?: number, holdings?: ReadonlyMap<string, number>, browse?: boolean): ReturnType<Catalogue['suggest']> {
    return this.catalogue.suggest(text, limit, holdings, browse);
  }

  /**
   * Every collection with something to browse, the newest release first: what the Items page
   * lists before anything is asked for. Each row's `skins` is the number of tiles its chip shows,
   * counted by the rule the tiles are kept by.
   */
  collectionTiles(): CollectionTile[] {
    return this.catalogue.browseCollections().map((collection) => ({
      ...emblemOf(collection),
      skins: collection.skins,
      releaseDate: collection.releaseDate ?? null,
      kind: collection.kind
    }));
  }

  private skinsFor: string | null = null;
  private skinsRows: SkinTile[] = [];

  /**
   * One page of the skins the Items page's chips name: a weapon, a type, a collection, a grade,
   * together or alone, resolved by the rule an inventory filter's chips are (`resolveHostChips`).
   *
   * One row per skin, whatever qualities, phases and wears it is sold in, the rarest first. The
   * whole list is built once per set of chips and catalogue generation and then sliced, so the
   * window scrolling on asks for the next page and nothing is sorted again. No chips is no skins:
   * the page shows this only once something is asked, and the whole catalogue is not an answer.
   *
   * A page is `limit` skins, and the last may run a fifth over: a handful left behind would be a
   * page of their own, shown only after a scroll for two tiles. Fifty-two AWPs asked for fifty at a
   * time are one page.
   */
  skins(chips: readonly unknown[], offset: number, limit: number): SkinPage {
    const status = this.catalogue.status();
    const asked = `${status.revision ?? ''}:${status.entries}:${JSON.stringify(chips)}`;
    if (asked !== this.skinsFor) {
      const keys = resolveHostChips(this.catalogue, { search: '', category: '', chips: [...chips] }).matchKeys ?? [];
      // `skinsOf` keeps what a market sells: a coin or a weapon with no finish has no page worth
      // opening, so it is no tile, by the rule the count beside the name was made with.
      const entries = keys.flatMap((key) => {
        const found = this.catalogue.lookup(key);
        return found.kind === 'entry' ? [found.entry] : [];
      });
      this.skinsRows = skinsOf(entries).map((skin) => ({ name: skin.name, category: skin.category, rarity: skin.rarity, imageUrl: cachedImageUrl(skin.image) }));
      this.skinsFor = asked;
    }
    const start = Math.min(Math.max(0, Math.trunc(offset) || 0), this.skinsRows.length);
    const size = Math.min(SKIN_PAGE_MAX, Math.max(1, Math.trunc(limit) || SKIN_PAGE_MAX));
    const full = Math.min(this.skinsRows.length, start + size);
    const end = this.skinsRows.length - full <= Math.floor(size / SKIN_PAGE_TAIL) ? this.skinsRows.length : full;
    return { total: this.skinsRows.length, skins: this.skinsRows.slice(start, end), next: end < this.skinsRows.length ? end : null };
  }

  /**
   * Attach names to a bounded page.
   *
   * Keys are deduplicated first, so a page of a hundred rows holding three distinct items costs
   * three lookups. Keys the catalogue does not hold are recorded as misses here — once, on the
   * page that revealed them — which is what turns "a new skin appeared" into one batched question
   * later rather than a request per render.
   */
  enrich<T extends IdentityRow>(rows: readonly T[]): Array<T & EnrichedRow> {
    const keys = new Set<MatchKey>();
    for (const row of rows) if (typeof row.matchKey === 'string') keys.add(row.matchKey);
    const resolved = this.catalogue.resolveAll(keys);
    for (const [key, result] of resolved) if (result.kind === 'unresolved') this.catalogue.noteMiss(key, result.reason);

    return rows.map((row) => {
      const key = typeof row.matchKey === 'string' ? row.matchKey : '';
      const result = resolved.get(key);
      const wear = typeof row.paintWear === 'number' ? row.paintWear : typeof row.minWear === 'number' ? row.minWear : null;
      const identity = {
        defIndex: typeof row.defIndex === 'number' ? row.defIndex : 0,
        paintIndex: typeof row.paintIndex === 'number' ? row.paintIndex : null,
        quality: typeof row.quality === 'number' ? row.quality : 0,
        paintWear: wear
      };
      if (!result || result.kind === 'unresolved') {
        return {
          ...row,
          matchKey: key,
          name: rawFallbackName(identity),
          marketHashName: null,
          category: null,
          rarity: null,
          collection: null,
          imageUrl: null,
          unresolved: result?.kind === 'unresolved' ? result.reason : 'never-fetched',
          minFloat: null,
          maxFloat: null,
          csfloatSupport: key ? this.csfloat.support(key) : null,
          catalogueMarketable: null
        };
      }
      const entry = result.entry;
      const collection = this.catalogue.collection(entry.collectionId);
      return {
        ...row,
        matchKey: key,
        name: displayName(entry, wear),
        // A kind with no market has no market page: naming one would offer a dead Steam Market link.
        // The bare market name, never the display name: Steam has one name for every Doppler phase,
        // and a phase in it is a name no order book, curve or market page knows.
        marketHashName: entry.marketable === false ? null : marketHashName(entry, wear),
        category: entry.category,
        rarity: entry.rarity,
        collection: collection ? { id: collection.id, name: collection.name } : null,
        imageUrl: cachedImageUrl(entry.image),
        unresolved: null,
        minFloat: entry.minFloat,
        maxFloat: entry.maxFloat,
        csfloatSupport: this.csfloat.support(key),
        catalogueMarketable: entry.marketable ?? null
      };
    });
  }

  /**
   * Attach a picture to rows that carry a market name and no identity.
   *
   * A buy order is for a `market_hash_name`, not for an item this app holds, so there is no
   * identity key to resolve and `enrich` has nothing to ask. The catalogue's base names are the
   * market name without its wear tier, and a picture belongs to a finish rather than to a wear,
   * so the name less its tier finds it. A name the catalogue does not hold gets no picture and
   * records no miss: a miss is a key to ask the server about, and there is none.
   */
  enrichByName<T extends { hashName?: unknown }>(rows: readonly T[]): Array<T & { imageUrl: string | null }> {
    return rows.map((row) => {
      const entry = this.entryByName(row.hashName);
      return { ...row, imageUrl: entry ? cachedImageUrl(entry.image) : null };
    });
  }

  /** The catalogue entry a market name is, less its wear tier; `undefined` for a name it does not hold. */
  private entryByName(hashName: unknown): CatalogueEntry | undefined {
    return this.nameIndex().get(fold(stripWearTier(typeof hashName === 'string' ? hashName : '')));
  }

  /**
   * A `buyOrders.read` page: each order's picture by its market name (`enrichByName`), and a name
   * and picture for every sticker and charm its filters require.
   *
   * A filter carries the venue's definition id, which is the attribute the catalogue keys that
   * family by (`KIT_ATTRIBUTES_BY_ITEM`: a sticker is item 1209 keyed by attribute 113, a charm
   * item 1355 by attribute 299). So a filter's sticker is resolved as the sticker item itself would
   * be, one batch per page, and a key the catalogue lacks is a miss like any other — asked about
   * later, and shown meanwhile by its id rather than a guessed name.
   *
   * Each order also says what it is for, in CSFloat's classes (`csfloatItem`, `csfloat-kinds.ts`):
   * its market name's catalogue key, sorted by CSFloat's own schema. That is what decides which
   * filters a change may set, as CSFloat's own edit dialog decides. `null` when either the
   * catalogue does not hold the name or no CSFloat schema has been fetched.
   */
  enrichBuyOrders<T extends { hashName?: unknown; filters?: unknown }>(rows: readonly T[]): Array<T & { imageUrl: string | null; csfloatItem: CsfloatItemClass | null }> {
    const named = this.enrichByName(rows).map((row) => {
      const entry = this.entryByName(row.hashName);
      return { ...row, csfloatItem: entry ? this.csfloat.itemClass(entry.key, String(row.hashName)) : null };
    });
    // Two lists per row carry accessories: the order's filters, and those a pending change asked for.
    const listOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
    const pendingOf = (row: T): Record<string, unknown> | null => {
      const pending = (row as Record<string, unknown>)['editPending'];
      return typeof pending === 'object' && pending !== null ? pending as Record<string, unknown> : null;
    };
    const found = named.flatMap((row) => [...listOf(row.filters), ...listOf(pendingOf(row)?.['filters'])].flatMap(accessoryKeys));
    if (found.length === 0) return named;
    const resolved = this.catalogue.resolveAll(new Set(found.flatMap(({ keys }) => keys)));
    const hitOf = (keys: readonly MatchKey[]): CatalogueEntry | null => {
      for (const key of keys) {
        const result = resolved.get(key);
        if (result?.kind === 'entry') return result.entry;
      }
      return null;
    };
    // A miss is noted once per id, under its first reading: a sticker id that is a patch is not a
    // sticker the server has never heard of.
    for (const { keys } of found) {
      const first = resolved.get(keys[0]!);
      if (!hitOf(keys) && first?.kind === 'unresolved') this.catalogue.noteMiss(keys[0]!, first.reason);
    }
    const nameList = (value: unknown): unknown => (Array.isArray(value) ? listOf(value).map((filter) => {
      const entries = accessoryKeys(filter);
      if (entries.length === 0) return filter;
      const list = filter['kind'] === 'stickers' ? 'stickers' : 'charms';
      return { ...filter, [list]: entries.map(({ keys, entry }) => {
        const hit = hitOf(keys);
        return { ...entry, name: hit ? displayName(hit, null) : null, imageUrl: hit ? cachedImageUrl(hit.image) : null };
      }) };
    }) : value);
    return named.map((row) => {
      const pending = pendingOf(row);
      return { ...row, filters: nameList(row.filters), ...(pending ? { editPending: { ...pending, filters: nameList(pending['filters']) } } : {}) };
    });
  }

  /**
   * An `inventory.accessories` answer with a name and a picture on every sticker, patch and charm.
   *
   * The engine answers with kit ids, which are the attribute the catalogue keys each family by, so
   * an applied sticker is resolved as the sticker item itself would be: one batch for the whole
   * answer, and a kit the catalogue lacks is a miss like any other, asked about later and shown
   * meanwhile by its id. A sticker slab is the exception. Every slab is one charm kit, which the
   * catalogue does not hold, and what tells two apart is the sticker inside, so a slab is named
   * and pictured from that sticker and notes no miss.
   *
   * Each one leaves here with the market name its reference price is asked by and none yet: the
   * catalogue holds no price, and main's market side fills it in from the snapshot (`priceAccessories`).
   */
  nameAccessories<T extends { accessories: readonly AppliedAccessory[] }>(rows: readonly T[]): Array<Omit<T, 'accessories'> & { accessories: NamedAccessory[] }> {
    const applied = rows.flatMap((row) => row.accessories);
    const resolved = this.catalogue.resolveAll(new Set(applied.flatMap((accessory) => {
      const wrapped = wrappedStickerKey(accessory);
      return [...appliedKeys(accessory).map(({ key }) => key), ...(wrapped === null ? [] : [wrapped])];
    })));
    const entryAt = (key: MatchKey | null): CatalogueEntry | null => {
      const result = key === null ? undefined : resolved.get(key);
      return result?.kind === 'entry' ? result.entry : null;
    };
    const named = (accessory: AppliedAccessory): NamedAccessory => {
      const sticker = entryAt(wrappedStickerKey(accessory));
      if (sticker) {
        const name = slabName(displayName(sticker, null));
        return { ...accessory, family: 'charm', name, marketHashName: name, imageUrl: cachedImageUrl(sticker.image), referencePrice: null };
      }
      const candidates = appliedKeys(accessory);
      for (const { family, key } of candidates) {
        const entry = entryAt(key);
        if (!entry) continue;
        return {
          ...accessory, family, name: displayName(entry, null),
          marketHashName: entry.marketable === false ? null : marketHashName(entry, null),
          imageUrl: cachedImageUrl(entry.image),
          referencePrice: null
        };
      }
      // Noted under its first reading, as a buy-order filter's is: a kit that is a patch is not a
      // sticker the server has never heard of.
      const first = candidates[0]!;
      const miss = resolved.get(first.key);
      if (miss?.kind === 'unresolved') this.catalogue.noteMiss(first.key, miss.reason);
      return { ...accessory, family: first.family, name: null, marketHashName: null, imageUrl: null, referencePrice: null };
    };
    return rows.map((row) => ({ ...row, accessories: row.accessories.map(named) }));
  }

  /**
   * Which orders of a `buyOrders.read` page a Buy orders filter keeps, as `matches` on each row.
   *
   * The chips are the Listings bar's and go through `resolveListingFilter`, so a skin type, a
   * rarity, a collection or StatTrak means what it means on every other bar. Each order is then
   * matched by what it would buy (`buy-order-match.ts`): the entries its market name is, the
   * stickers and charms it requires, the floats its wear tier and float range allow, and the
   * patterns it names. Rows are flagged rather than dropped, because the page counts the whole book
   * — what each venue holds, what an account's orders commit against its balance — whatever the
   * bar is narrowing.
   */
  markBuyOrderMatches<T extends Record<string, unknown>>(rows: readonly T[], filter: Record<string, unknown> | undefined): Array<T & { matches?: boolean }> {
    if (!filter) return [...rows];
    const resolved = (this.resolveListingFilter(filter) ?? {}) as ResolvedBuyOrderFilter;
    const byName = this.nameKeys();
    return rows.map((row) => {
      const hashName = typeof row['hashName'] === 'string' ? row['hashName'] : '';
      const filters = Array.isArray(row['filters']) ? row['filters'] as Array<Record<string, unknown>> : [];
      const float = filters.find((entry) => entry['kind'] === 'float');
      const pattern = filters.find((entry) => entry['kind'] === 'pattern');
      const facets: BuyOrderFacets = {
        hashName,
        buyOrderId: typeof row['buyOrderId'] === 'string' ? row['buyOrderId'] : '',
        keys: [...(byName.get(fold(stripWearTier(hashName))) ?? []), ...filters.flatMap((entry) => accessoryKeys(entry).flatMap(({ keys }) => keys))],
        floats: floatWindow(hashName, float ? { min: numberOrNull(float['min']), max: numberOrNull(float['max']) } : null),
        seeds: pattern && Array.isArray(pattern['seeds']) ? (pattern['seeds'] as unknown[]).filter((seed): seed is number => typeof seed === 'number') : null
      };
      return { ...row, matches: buyOrderMatches(facets, resolved) };
    });
  }

  private accessoryIndexFor: string | null = null;
  private accessoryIndexEntries: Record<AccessoryFamily, Array<{ prepared: Prepared; value: AccessorySuggestion }>> = { sticker: [], patch: [], charm: [] };

  /**
   * Stickers, patches or charms whose name matches what was typed, each with the definition id a
   * buy-order filter names it by — the attribute the catalogue keys that family by (`STICKER_KEY`,
   * `PATCH_KEY`, `CHARM_KEY`). The change editor's pickers ask this; ranked as the filter bar's suggestions are,
   * from an index built once per catalogue generation, never per keystroke.
   */
  accessories(family: AccessoryFamily, text: string, limit = 8): AccessorySuggestion[] {
    const needle = text.trim();
    if (!needle) return [];
    const status = this.catalogue.status();
    const generation = `${status.revision ?? ''}:${status.entries}`;
    if (generation !== this.accessoryIndexFor) {
      const next: typeof this.accessoryIndexEntries = { sticker: [], patch: [], charm: [] };
      for (const entry of this.catalogue.allEntries()) {
        for (const [name, key] of Object.entries(ACCESSORY_KEYS) as Array<[AccessoryFamily, { defIndex: number; attribute: number }]>) {
          const prefix = `${key.defIndex}::${ACCESSORY_QUALITY}:${key.attribute}=`;
          if (!entry.key.startsWith(prefix)) continue;
          const id = Number(entry.key.slice(prefix.length));
          if (!Number.isSafeInteger(id)) continue;
          const shown = displayName(entry, null);
          next[name].push({ prepared: prepare(shown), value: { id, name: shown, imageUrl: cachedImageUrl(entry.image) } });
        }
      }
      this.accessoryIndexEntries = next;
      this.accessoryIndexFor = generation;
    }
    return rank(needle, this.accessoryIndexEntries[family], Math.min(25, Math.max(1, Math.trunc(limit) || 8)));
  }

  /**
   * Attach names to `work.open` and `waiting.open` rows.
   *
   * Item work is named by identity, as `enrich` names a page. Work about a buy order carries the
   * order's `hashName` and no identity, so it is named by that with a picture by name, as the Buy
   * orders page does — never through `enrich`, which would call it `Def 0` and note a miss for a
   * key no item ever had.
   */
  enrichWork<T extends IdentityRow & { hashName?: unknown }>(rows: readonly T[]): Array<T & EnrichedRow> {
    const isOrder = (row: T): boolean => typeof row.hashName === 'string';
    const items = this.enrich(rows.filter((row) => !isOrder(row)));
    const orders = this.enrichByName(rows.filter(isOrder));
    let item = 0, order = 0;
    return rows.map((row) => {
      if (!isOrder(row)) return items[item++]!;
      const named = orders[order++]!;
      const hashName = row.hashName as string;
      return {
        ...named, matchKey: '', name: hashName || 'A buy order', marketHashName: hashName || null,
        category: null, rarity: null, collection: null, unresolved: null, minFloat: null, maxFloat: null, csfloatSupport: null,
        catalogueMarketable: null
      };
    });
  }

  /**
   * Attach names to trades-page rows: a list row (by its first item), an item line, an item group,
   * or a CSFloat trade the entry carried.
   *
   * A line is named three ways and never a fourth. One that resolved to an identity is named from
   * the catalogue like any inventory row; if the catalogue does not know that key yet, Steam's own
   * market name for the line says more than a raw `Def 7 · Paint 282`. One that carries only a market
   * name — the other party's item in an offer, or a line no walk matched — is named and pictured by
   * that name, and records no miss, because there is no key to ask the server about. One with
   * neither is "Unknown item" with an explicit reason, never an invented identity.
   *
   * `enrichWork` is not reused: it treats any row carrying a market name as a buy order.
   */
  enrichTradeItems<T extends IdentityRow & { hashName?: unknown }>(rows: readonly T[]): Array<T & EnrichedRow> {
    const keyed = (row: T): boolean => typeof row.matchKey === 'string' && row.matchKey !== '';
    const named = this.enrich(rows.filter(keyed));
    let index = 0;
    return rows.map((row) => {
      const hashName = typeof row.hashName === 'string' && row.hashName !== '' ? row.hashName : null;
      if (keyed(row)) {
        const result = named[index++]!;
        return result.unresolved && hashName ? { ...result, ...this.namedByMarket(hashName) } : result;
      }
      if (hashName) return { ...row, matchKey: '', ...this.namedByMarket(hashName) };
      return {
        ...row, matchKey: '', name: 'Unknown item', marketHashName: null, category: null, rarity: null, collection: null,
        imageUrl: null, unresolved: 'no-identity', minFloat: null, maxFloat: null, csfloatSupport: null, catalogueMarketable: null
      };
    });
  }

  /** `trades.list` rows: each by its first item, and the second item it previews when it has one. */
  enrichTradeRows<T extends IdentityRow & { hashName?: unknown; second?: unknown }>(rows: readonly T[]): Array<T & EnrichedRow> {
    const previewOf = (row: T): (IdentityRow & { hashName?: unknown }) | null =>
      row.second !== null && typeof row.second === 'object' ? row.second as IdentityRow & { hashName?: unknown } : null;
    const seconds = this.enrichTradeItems(rows.flatMap((row) => { const preview = previewOf(row); return preview ? [preview] : []; }));
    let index = 0;
    return this.enrichTradeItems(rows).map((row, at) => (previewOf(rows[at]!) ? { ...row, second: seconds[index++] } : row));
  }

  /** One `trades.entry` answer: the entry by its first item, its groups, and the CSFloat trades it carried. */
  enrichTradeEntry<T extends IdentityRow & { hashName?: unknown; groups?: unknown; csfloat?: unknown }>(entry: T): T & EnrichedRow {
    const [named] = this.enrichTradeItems([entry]);
    return {
      ...named!,
      ...(Array.isArray(entry.groups) ? { groups: this.enrichTradeItems(entry.groups as Array<IdentityRow & { hashName?: unknown }>) } : {}),
      ...(Array.isArray(entry.csfloat) ? { csfloat: this.enrichTradeItems(entry.csfloat as Array<IdentityRow & { hashName?: unknown }>) } : {})
    };
  }

  /**
   * The market names one item is sold under, for the Items page's wear switch.
   *
   * `name` is what the filter bar suggested (`AK-47 | Redline`, or `★ Karambit | Doppler — Phase 2`
   * with its phase) or a market name already (`… (Field-Tested)`); both reach the same entries. A
   * wear-suffixed skin is one market name per tier its float range reaches, from the catalogue's
   * own range and Valve's fixed thresholds, so a skin that cannot be Factory New offers no Factory
   * New page. Anything else is one name. A Doppler's phases share one market name, as `enrich`
   * spells them; the phase only picks the picture. A name the catalogue does not know is still
   * offered as itself, unknown, because Steam may well know it.
   *
   * A skin sold in more than one quality also names each (`qualities`): StatTrak™ and Souvenir are
   * base names of their own, and the browse grid shows a skin once, so the page is where a person
   * steps from one to the other. Each opens at the wear the page is on, where that quality has it.
   */
  variantsOf(name: string): CatalogueVariants {
    const alone = this.variantsAlone(name);
    const bases = alone.known ? this.skinBases().get(fold(skinName(alone.base))) ?? [] : [];
    // The tile a grid shows for this skin is named for its normal quality where it has one, which
    // is the first of its base names; a page of the StatTrak™ copy is still that tile.
    const own = { ...alone, skin: bases[0] ?? alone.base };
    if (!own.known) return { ...own, qualities: [] };
    if (bases.length < 2) return { ...own, qualities: [] };
    const wear = WEAR_SUFFIX.exec(name.split(' — ')[0]!.trim())?.[1] ?? null;
    return {
      ...own,
      qualities: bases.map((base) => {
        const sibling = base === own.base ? own : this.variantsAlone(base);
        const quality = skinQuality(base);
        return {
          id: quality,
          label: QUALITY_LABEL[quality],
          name: (sibling.variants.find((variant) => variant.label !== null && variant.label === wear) ?? sibling.variants[0]!).name,
          current: base === own.base
        };
      })
    };
  }

  /** `variantsOf` for one base name on its own, without the other qualities of its skin. */
  private variantsAlone(name: string): Omit<CatalogueVariants, 'qualities' | 'skin'> {
    const [plain, phase] = name.split(' — ');
    const base = stripWearTier(plain!.trim());
    const entries = (this.nameKeys().get(fold(base)) ?? [])
      .map((key) => this.catalogue.lookup(key))
      .flatMap((result) => (result.kind === 'entry' ? [result.entry] : []));
    if (entries.length === 0) {
      return { base: plain!.trim(), known: false, category: null, rarity: null, imageUrl: null, marketable: null, minFloat: null, maxFloat: null, collection: null, variants: [{ name: plain!.trim(), tier: null, label: null, band: null, keys: [] }] };
    }
    const pictured = (phase ? entries.find((entry) => entry.phase === phase.trim() && entry.image) : undefined)
      ?? entries.find((entry) => entry.image) ?? entries[0]!;
    const keys = entries.map((entry) => entry.key);
    const marketBase = entries[0]!.marketHashNameBase;
    const floats = entries.filter((entry) => entry.minFloat !== null && entry.maxFloat !== null);
    const minFloat = floats.length ? Math.min(...floats.map((entry) => entry.minFloat!)) : null;
    const maxFloat = floats.length ? Math.max(...floats.map((entry) => entry.maxFloat!)) : null;
    const variants: CatalogueVariant[] = entries.some((entry) => entry.wearSuffixed)
      ? WEAR_TIERS.filter((tier, index) => {
          const low = index === 0 ? 0 : WEAR_TIERS[index - 1]!.max;
          // No range published: every tier is offered rather than guessing which are impossible.
          return minFloat === null || maxFloat === null || (low < maxFloat && tier.max > minFloat);
        }).map((tier) => ({ name: `${marketBase} (${tier.label})`, tier: tier.code, label: tier.label, band: tier.band, keys }))
      : [{ name: marketBase, tier: null, label: null, band: null, keys }];
    return {
      base: marketBase,
      known: true,
      category: pictured.category,
      rarity: pictured.rarity,
      imageUrl: cachedImageUrl(pictured.image),
      marketable: entries.every((entry) => entry.marketable === false) ? false : entries.some((entry) => entry.marketable === true) ? true : null,
      minFloat,
      maxFloat,
      collection: emblemOf(this.catalogue.collection(entries.find((entry) => entry.collectionId)?.collectionId ?? null)),
      variants
    };
  }

  /** A name, picture, rarity and float range for a market name, from the catalogue entry it is a wear of. */
  private namedByMarket(hashName: string): Omit<EnrichedRow, 'matchKey'> {
    const entry = this.entryByName(hashName);
    const collection = entry ? this.catalogue.collection(entry.collectionId) : undefined;
    return {
      name: hashName,
      marketHashName: hashName,
      category: entry?.category ?? null,
      rarity: entry?.rarity ?? null,
      collection: collection ? { id: collection.id, name: collection.name } : null,
      imageUrl: entry ? cachedImageUrl(entry.image) : null,
      unresolved: null,
      minFloat: entry?.minFloat ?? null,
      maxFloat: entry?.maxFloat ?? null,
      csfloatSupport: null,
      catalogueMarketable: entry?.marketable ?? null
    };
  }

  private nameIndexFor: string | null = null;
  private nameIndexEntries = new Map<string, CatalogueEntry>();
  private nameIndexKeys = new Map<string, MatchKey[]>();
  private nameIndexSkins = new Map<string, string[]>();

  /** Base name to entry, rebuilt when the catalogue generation changes and never per row. */
  private nameIndex(): Map<string, CatalogueEntry> {
    const status = this.catalogue.status();
    const generation = `${status.revision ?? ''}:${status.entries}`;
    if (generation === this.nameIndexFor) return this.nameIndexEntries;
    const next = new Map<string, CatalogueEntry>();
    const keys = new Map<string, MatchKey[]>();
    const skins = new Map<string, string[]>();
    for (const entry of this.catalogue.allEntries()) {
      // The base names one skin is sold under, one per quality, the ordinary one first.
      const skin = fold(skinName(entry.marketHashNameBase));
      const bases = skins.get(skin);
      if (!bases) skins.set(skin, [entry.marketHashNameBase]);
      else if (!bases.includes(entry.marketHashNameBase)) {
        bases.push(entry.marketHashNameBase);
        bases.sort((left, right) => QUALITY_ORDER.indexOf(skinQuality(left)) - QUALITY_ORDER.indexOf(skinQuality(right)));
      }
      // Five wear tiers share one base, and so do the Doppler phases, which differ only in
      // picture: any entry with a picture will do, and the first with one is kept.
      const key = fold(entry.marketHashNameBase);
      const held = next.get(key);
      if (!held || (held.image === null && entry.image !== null)) next.set(key, entry);
      // Every entry is kept for matching, though: an order for a Doppler is an order for each phase.
      keys.set(key, [...(keys.get(key) ?? []), entry.key]);
    }
    this.nameIndexEntries = next;
    this.nameIndexKeys = keys;
    this.nameIndexSkins = skins;
    this.nameIndexFor = generation;
    return next;
  }

  /** A skin, by its normal quality's folded base name, to every base name it is sold under. */
  private skinBases(): Map<string, string[]> {
    this.nameIndex();
    return this.nameIndexSkins;
  }

  /** Base name to every catalogue key that carries it, from the same generation-guarded pass. */
  private nameKeys(): Map<string, MatchKey[]> {
    this.nameIndex();
    return this.nameIndexKeys;
  }

  /**
   * Ask the server about keys this generation never had. Bounded, batched, backed off.
   *
   * Answers whether anything was actually learned, because the caller has to tell the window: a
   * key resolved after the page was already sent is a row still wearing a raw fallback name and an
   * empty picture until something refetches it.
   */
  async resolvePending(): Promise<boolean> {
    const due = this.catalogue.dueForResolve();
    if (due.length === 0) return false;
    const outcome = await this.catalogue.resolveMissing(due);
    return outcome.resolved > 0;
  }

  async sync(): Promise<SyncOutcome> {
    return this.catalogue.sync();
  }
}

type HostChip = {
  kind?: unknown;
  text?: unknown;
  rarityId?: unknown;
  quality?: unknown;
  op?: unknown;
  value?: unknown;
};

/**
 * The kits a set of catalogue keys names, as an applied filter takes them: a sticker or a patch by
 * its sticker kit, a charm by its charm kit and, for a souvenir charm, its highlight. Every other
 * key is not something applied to an item, and names no kit.
 */
export function appliedKits(keys: readonly string[]): AppliedKit[] {
  const kits: AppliedKit[] = [];
  for (const key of keys) {
    const [def, , , kit = ''] = key.split(':');
    const values = new Map(kit.split(',').map((pair) => pair.split('=') as [string, string]));
    const id = (attribute: number): number | undefined => {
      const value = Number(values.get(String(attribute)));
      return Number.isSafeInteger(value) ? value : undefined;
    };
    if (def === String(STICKER_KEY.defIndex) || def === String(PATCH_KEY.defIndex)) {
      const kitId = id(STICKER_KEY.attribute);
      if (kitId !== undefined) kits.push({ slot: 'sticker-slot', kitId });
    } else if (def === String(CHARM_KEY.defIndex)) {
      const kitId = id(CHARM_KEY.attribute);
      const highlight = id(CHARM_HIGHLIGHT_ATTRIBUTE);
      if (kitId !== undefined) kits.push({ slot: 'charm-slot', kitId, ...(highlight === undefined ? {} : { highlight }) });
    }
  }
  return kits;
}

function resolveHostChips(catalogue: Catalogue, input: { search: string; category: string; chips: unknown[] }): {
  matchKeys?: string[];
  wearBands?: ReturnType<typeof wearBandsFor>;
  applied?: AppliedRequirement[];
} {
  const chips = input.chips.filter((row): row is HostChip => Boolean(row) && typeof row === 'object');
  const knownCategories = new Set(catalogue.categories());
  const nameTerms: string[] = [];
  const categoryTerms: string[] = [];
  const qualities: Array<'stattrak' | 'souvenir' | 'normal'> = [];
  const rarityIds: string[] = [];
  const collectionNames: string[] = [];
  const weaponNames: string[] = [];
  const norms: Array<{ op: '>' | '>=' | '<' | '<=' | '='; value: number }> = [];
  const applied: AppliedRequirement[] = [];

  const search = input.search.trim();
  const category = input.category.trim();
  if (search) nameTerms.push(search);
  if (category) categoryTerms.push(category);

  for (const chip of chips) {
    const kind = typeof chip.kind === 'string' ? chip.kind : '';
    const text = typeof chip.text === 'string' ? chip.text.trim() : '';
    if (kind === 'item' || kind === 'name') {
      if (text && knownCategories.has(text)) categoryTerms.push(text);
      else if (text) nameTerms.push(text);
    } else if (kind === 'category' && (chip.quality === 'stattrak' || chip.quality === 'souvenir' || chip.quality === 'normal')) {
      qualities.push(chip.quality);
    } else if (kind === 'rarity') {
      // The bar can only send a grade *name*; ids live here. An exact fold first, then a
      // containment match, because "Mil-Spec" and "Mil-Spec Grade" are the same grade and a chip
      // that resolves to nothing would silently drop the filter rather than narrow it.
      const id = typeof chip.rarityId === 'string'
        ? chip.rarityId
        : catalogue.rarities().find((row) => foldIncludes(row.name, text) || foldIncludes(text, row.name))?.id;
      if (id) rarityIds.push(id);
      // A rarity the catalogue does not know matches nothing, which is not the same as no filter.
      else if (text) rarityIds.push(`unknown-rarity:${text}`);
    } else if (kind === 'collection' && text) {
      collectionNames.push(text);
    } else if (kind === 'weapon' && text) {
      // A weapon by its exact name, every skin of it: `AWP` is the rifle, where the same letters
      // typed as a name would also find the sticker that has them.
      weaponNames.push(text);
    } else if (kind === 'type' && text) {
      // A category said as one, so it is never weighed as a name the way an `item` chip's text is.
      categoryTerms.push(text);
    } else if (kind === 'norm' && (chip.op === '>' || chip.op === '>=' || chip.op === '<' || chip.op === '<=' || chip.op === '=') && typeof chip.value === 'number') {
      norms.push({ op: chip.op, value: chip.value });
    } else if (kind === 'applied' && text) {
      // A sticker, patch or charm by name: each chip is one requirement, and a name that is none of
      // them is `kits: []`, which matches nothing rather than dropping the filter. It never narrows
      // what the item itself is, so it adds nothing to `matchKeys`.
      applied.push({ kits: appliedKits(catalogue.search(text)) });
    }
  }

  const hostAsked = nameTerms.length + categoryTerms.length + qualities.length + rarityIds.length + collectionNames.length + weaponNames.length > 0;
  let keys: string[] | undefined;
  const union = (sets: string[][]): string[] => [...new Set(sets.flat())];
  const intersect = (left: string[], right: string[]): string[] => {
    const keep = new Set(right);
    return left.filter((key) => keep.has(key));
  };

  // Two names are either one, and so are two categories, but a name beside a category is that name
  // within it: `Sticker` and one sticker is that sticker. A union of the two was every sticker.
  const named = nameTerms.length ? union(nameTerms.map((term) => catalogue.search(term))) : undefined;
  const typed = categoryTerms.length ? union(categoryTerms.map((term) => catalogue.search('', term))) : undefined;
  if (named && typed) keys = intersect(named, typed);
  else keys = named ?? typed;
  if (weaponNames.length) {
    const weaponKeys = union(weaponNames.map((name) => catalogue.weaponKeys(name)));
    keys = keys ? intersect(keys, weaponKeys) : weaponKeys;
  }
  if (rarityIds.length) {
    const rarityKeys = catalogue.allEntries().filter((entry) => entry.rarity && rarityIds.includes(entry.rarity.id)).map((entry) => entry.key);
    keys = keys ? intersect(keys, rarityKeys) : rarityKeys;
  }
  if (collectionNames.length) {
    const collections = catalogue.collectionList();
    const ids = new Set(
      collectionNames.flatMap((name) => collections.filter((row) => foldIncludes(row.name, name)).map((row) => row.id))
    );
    const collectionKeys = catalogue.allEntries().filter((entry) => entry.collectionId && ids.has(entry.collectionId)).map((entry) => entry.key);
    keys = keys ? intersect(keys, collectionKeys) : collectionKeys;
  }
  if (qualities.length) {
    const qualityKeys = catalogue.allEntries().filter((entry) => qualities.some((quality) => matchesQuality(entry.marketHashNameBase, quality))).map((entry) => entry.key);
    keys = keys ? intersect(keys, qualityKeys) : qualityKeys;
  }

  const restrict = keys ? new Set(keys) : undefined;
  const wearBands = norms.length ? wearBandsFor(catalogue.floatEntries(), norms, restrict) : undefined;
  return {
    ...(hostAsked || keys ? { matchKeys: keys ?? [] } : {}),
    ...(wearBands ? { wearBands } : {}),
    ...(applied.length ? { applied } : {})
  };
}

/**
 * A collection as a page names it. Its emblem is asked for at the largest list size: an emblem is
 * a file of one size whatever is asked, and the box that draws one is wider than a skin's.
 */
function emblemOf(collection: { id: string; name: string; image: string | null }): CollectionRef;
function emblemOf(collection: { id: string; name: string; image: string | null } | null): CollectionRef | null;
function emblemOf(collection: { id: string; name: string; image: string | null } | null): CollectionRef | null {
  return collection ? { id: collection.id, name: collection.name, imageUrl: cachedImageUrl(collection.image, 256) } : null;
}

function matchesQuality(name: string, quality: 'stattrak' | 'souvenir' | 'normal'): boolean {
  const stattrak = /stattrak/i.test(name);
  const souvenir = /souvenir/i.test(name);
  if (quality === 'stattrak') return stattrak;
  if (quality === 'souvenir') return souvenir;
  return !stattrak && !souvenir;
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function foldIncludes(haystack: string, needle: string): boolean {
  return fold(haystack).includes(fold(needle));
}

/** The wear a market name ends in, as Steam writes it. */
const WEAR_SUFFIX = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;

/** `AK-47 | Redline (Field-Tested)` → `AK-47 | Redline`: the catalogue's base name, which a picture belongs to. */
function stripWearTier(name: string): string {
  return name.replace(WEAR_SUFFIX, '');
}
