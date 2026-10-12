import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CsfloatItemClass } from './csfloat-item-class.js';
import type { FetchOutcome, MatchKey } from './types.js';

export type { CsfloatItemClass };

/**
 * Which kinds of item CSFloat trades, from CSFloat's own catalogue.
 *
 * `GET https://csfloat.com/api/v1/schema` is the item catalogue CSFloat's search bar is built
 * from: public, keyless, one request. Its maps are the kinds it trades — weapon finishes, stickers
 * (patches among them), charms, highlight reels, music kits, agents, collectibles and containers —
 * and there is none for a key, a tool, a name tag, a gift, sealed graffiti, a viewer pass or a
 * storage unit. On 2026-09-24 it agreed with the storage test account's own `/me/inventory` read of
 * 2026-09-22 on all thirteen non-skin items that account held: the six the read held are in it,
 * the seven it left out are not (`fixtures/csfloat/contracts/schema.json`).
 *
 * **It explains; it never permits.** Whether a unit can be listed is CSFloat's read of the
 * account's inventory, judged by the engine. This answers only *why* a read left an item out —
 * CSFloat does not trade that kind, or has not caught up with that unit — and lets the window say
 * which before anyone has refreshed eligibility. The schema moves under us: ten days took
 * `keychains` from 143 entries to 82 as highlight charms moved to `highlight_reels`. So an answer
 * here never outranks the venue's read of the unit itself.
 *
 * Presentation data, like every name and picture: host-side, and the engine never sees it.
 */

export const CSFLOAT_SCHEMA_HOST = 'csfloat.com';
export const CSFLOAT_SCHEMA_URL = `https://${CSFLOAT_SCHEMA_HOST}/api/v1/schema`;
/** How long a fetched schema stands. The site keeps its own copy (`ITEM_SCHEMA_V2`) this long. */
export const CSFLOAT_SCHEMA_TTL_MS = 4 * 60 * 60_000;

export type CsfloatSupport = 'supported' | 'unsupported';


/** A schema reduced to what answers "does CSFloat trade this kind": the ids of each kind. */
export type CsfloatKindsData = {
  version: 2;
  fetchedAt: string;
  /** The response's `last-modified`, when it sent one. */
  lastModified: string | null;
  /** Def index → its paint indexes. A knife's vanilla finish is paint `0`. */
  weapons: Record<string, number[]>;
  /** Def index → the weapon's type as CSFloat files it: `Weapons`, `Knives` or `Gloves`. */
  weaponTypes: Record<string, string>;
  /** Sticker kits, and patch kits, which CSFloat files as stickers. */
  stickers: number[];
  keychains: number[];
  highlightReels: number[];
  musicKits: number[];
  agents: number[];
  collectibles: number[];
  containers: number[];
};

type Kind = Exclude<keyof CsfloatKindsData, 'version' | 'fetchedAt' | 'lastModified' | 'weapons' | 'weaponTypes'>;
const KIND_MAPS: Readonly<Record<Kind, string>> = {
  stickers: 'stickers',
  keychains: 'keychains',
  highlightReels: 'highlight_reels',
  musicKits: 'music_kits',
  agents: 'agents',
  collectibles: 'collectibles',
  containers: 'containers'
};

/**
 * The items keyed by an attribute rather than their def index, and which attribute
 * (`KIT_ATTRIBUTES_BY_ITEM`): a sticker and a patch by 113, a charm by 299 and a highlight charm
 * also by its reel, 314, and a music kit by 166.
 */
const STICKER = 1209;
const PATCH = 4609;
const CHARM = 1355;
const MUSIC_KIT = 1314;

/**
 * The part of a schema body this app reads, or a throw.
 *
 * An empty kind is refused rather than stored: it would call every item of that kind unsupported,
 * which reads as CSFloat declining them rather than as a bad answer. A refused body leaves the
 * previous one in place.
 */
export function parseCsfloatSchema(body: unknown, fetchedAt: string, lastModified: string | null): CsfloatKindsData {
  if (!isRecord(body)) throw new Error('csfloat schema: the body is not an object');
  const rawWeapons = body['weapons'];
  if (!isRecord(rawWeapons)) throw new Error('csfloat schema: no weapons map');
  const weapons: Record<string, number[]> = {};
  const weaponTypes: Record<string, string> = {};
  for (const [def, weapon] of Object.entries(rawWeapons)) {
    if (!isIndex(def) || !isRecord(weapon) || !isRecord(weapon['paints'])) continue;
    weapons[def] = Object.keys(weapon['paints']).filter(isIndex).map(Number);
    weaponTypes[def] = typeof weapon['type'] === 'string' ? weapon['type'] : '';
  }
  const ids = (map: string): number[] => {
    const raw = body[map];
    if (!isRecord(raw)) throw new Error(`csfloat schema: no ${map} map`);
    return Object.keys(raw).filter(isIndex).map(Number);
  };
  const data: CsfloatKindsData = {
    version: 2,
    fetchedAt,
    lastModified,
    weapons,
    weaponTypes,
    stickers: ids(KIND_MAPS.stickers),
    keychains: ids(KIND_MAPS.keychains),
    highlightReels: ids(KIND_MAPS.highlightReels),
    musicKits: ids(KIND_MAPS.musicKits),
    agents: ids(KIND_MAPS.agents),
    collectibles: ids(KIND_MAPS.collectibles),
    containers: ids(KIND_MAPS.containers)
  };
  if (Object.keys(weapons).length === 0) throw new Error('csfloat schema: weapons is empty');
  for (const kind of Object.keys(KIND_MAPS) as Kind[]) {
    if (data[kind].length === 0) throw new Error(`csfloat schema: ${KIND_MAPS[kind]} is empty`);
  }
  return data;
}

/** A stored schema, answering by catalogue key. */
export class CsfloatKindIndex {
  private readonly weapons: Map<number, Set<number>>;
  private readonly weaponTypes: Map<number, string>;
  private readonly kinds: Record<Kind, Set<number>>;

  constructor(readonly data: CsfloatKindsData) {
    this.weapons = new Map(Object.entries(data.weapons).map(([def, paints]) => [Number(def), new Set(paints)]));
    this.weaponTypes = new Map(Object.entries(data.weaponTypes).map(([def, type]) => [Number(def), type]));
    this.kinds = Object.fromEntries((Object.keys(KIND_MAPS) as Kind[]).map((kind) => [kind, new Set(data[kind])])) as Record<Kind, Set<number>>;
  }

  /**
   * What the item a catalogue key names is, in CSFloat's classes, or `null` for a key that is not
   * one. The market name is asked only of a container, because CSFloat tells a souvenir package
   * from any other container by exactly that: the name says `Souvenir Package`.
   */
  itemClass(key: MatchKey, marketHashName: string): CsfloatItemClass | null {
    const parsed = parseKey(key);
    if (!parsed) return null;
    const { def, paint, kit } = parsed;
    if (paint !== null || this.weapons.has(def)) {
      // CSFloat's own test (its buy-order dialog, 2026-09-14): a gun is a weapon that is neither.
      const type = this.weaponTypes.get(def);
      if (type === undefined) return 'other';
      return type === 'Knives' ? 'knife' : type === 'Gloves' ? 'gloves' : 'gun';
    }
    if (def === STICKER) return 'sticker';
    if (def === PATCH) return 'patch';
    if (def === MUSIC_KIT) return 'music-kit';
    if (def === CHARM) return kit.has(314) ? 'highlight-charm' : 'charm';
    if (this.kinds.agents.has(def)) return 'agent';
    if (this.kinds.containers.has(def)) return marketHashName.includes('Souvenir Package') ? 'souvenir-package' : 'container';
    if (this.kinds.collectibles.has(def)) return 'collectible';
    return 'other';
  }

  /**
   * Whether CSFloat trades the kind a catalogue key (`def:paint:quality:kit`) names, or `null`
   * when the key does not carry what that kind is filed by.
   *
   * A finish is answered by its weapon's paints; a sticker or patch by its kit; a charm by its
   * highlight reel when it has one and its kit when not; a music kit by its music id; a knife with
   * no finish by its vanilla paint; anything else by its def index among agents, collectibles and
   * containers. Quality plays no part: a StatTrak or souvenir copy is the same kind.
   */
  support(key: MatchKey): CsfloatSupport | null {
    const parsed = parseKey(key);
    if (!parsed) return null;
    const { def, paint, kit } = parsed;
    const answer = (found: boolean): CsfloatSupport => (found ? 'supported' : 'unsupported');
    const byKit = (kind: Kind, attribute: number): CsfloatSupport | null => {
      const id = kit.get(attribute);
      return id === undefined ? null : answer(this.kinds[kind].has(id));
    };
    if (paint !== null) return answer(this.weapons.get(def)?.has(paint) ?? false);
    if (def === STICKER || def === PATCH) return byKit('stickers', 113);
    if (def === CHARM) return kit.has(314) ? byKit('highlightReels', 314) : byKit('keychains', 299);
    if (def === MUSIC_KIT) return byKit('musicKits', 166);
    const weapon = this.weapons.get(def);
    if (weapon) return answer(weapon.has(0));
    return answer(this.kinds.agents.has(def) || this.kinds.collectibles.has(def) || this.kinds.containers.has(def));
  }
}

/**
 * The one request, to the one URL.
 *
 * The catalogue transport's rules hold here too (`source.ts`): no redirects, no credential of any
 * kind — the schema is public, and the account's CSFloat key has no business on it — and a
 * transport fact is never a verdict, so every failure leaves the stored schema where it was.
 */
export async function fetchCsfloatSchema(fetchImpl: typeof fetch, timeoutMs: number, now: () => Date): Promise<FetchOutcome<CsfloatKindsData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(CSFLOAT_SCHEMA_URL, {
      method: 'GET',
      headers: new Headers({ Accept: 'application/json' }),
      redirect: 'manual',
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) return { kind: 'failed', detail: `redirected with ${response.status}` };
    if (!response.ok) return { kind: 'failed', detail: `HTTP ${response.status}` };
    const text = await response.text();
    return { kind: 'ok', value: parseCsfloatSchema(JSON.parse(text), now().toISOString(), response.headers.get('last-modified')), etag: null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { kind: 'failed', detail: aborted ? 'timeout' : error instanceof Error ? error.message : 'transport error' };
  } finally {
    clearTimeout(timer);
  }
}

export type CsfloatKindsRefresh =
  | { kind: 'applied'; fetchedAt: string }
  | { kind: 'current'; fetchedAt: string }
  | { kind: 'unreachable'; detail: string };

const FILE = 'csfloat-kinds.json';

/**
 * CSFloat's kinds, kept beside the catalogue (`userData/catalogue/csfloat-kinds.json`).
 *
 * A rebuildable cache like the catalogue's own, written the same way — a complete file under a
 * temporary name, then renamed into place — so a run that dies mid-write keeps the last one. Until
 * a schema has ever been fetched every answer is `null`, which the window reads as "not known",
 * never as "unsupported".
 */
export class CsfloatKinds {
  private index: CsfloatKindIndex | null = null;
  private inflight: Promise<CsfloatKindsRefresh> | null = null;

  constructor(
    private readonly directory: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 45_000,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The stored schema, if there is a readable one. A damaged file is ignored and fetched again. */
  async open(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(join(this.directory, FILE), 'utf8')) as unknown;
      if (isKindsData(stored)) this.index = new CsfloatKindIndex(stored);
    } catch { /* none yet, or unreadable: the next refresh writes one */ }
  }

  /** Fetches when the stored schema is older than the TTL, or there is none. One fetch at a time. */
  refresh(force = false): Promise<CsfloatKindsRefresh> {
    const held = this.index?.data.fetchedAt;
    if (!force && held && this.now().getTime() - Date.parse(held) < CSFLOAT_SCHEMA_TTL_MS) return Promise.resolve({ kind: 'current', fetchedAt: held });
    this.inflight ??= this.fetchAndStore().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  support(key: MatchKey): CsfloatSupport | null {
    return this.index?.support(key) ?? null;
  }

  itemClass(key: MatchKey, marketHashName: string): CsfloatItemClass | null {
    return this.index?.itemClass(key, marketHashName) ?? null;
  }

  status(): { fetchedAt: string | null; lastModified: string | null } {
    return { fetchedAt: this.index?.data.fetchedAt ?? null, lastModified: this.index?.data.lastModified ?? null };
  }

  private async fetchAndStore(): Promise<CsfloatKindsRefresh> {
    const outcome = await fetchCsfloatSchema(this.fetchImpl, this.timeoutMs, this.now);
    if (outcome.kind !== 'ok') return { kind: 'unreachable', detail: outcome.kind === 'failed' ? outcome.detail : outcome.kind };
    await writeAtomic(join(this.directory, FILE), JSON.stringify(outcome.value));
    this.index = new CsfloatKindIndex(outcome.value);
    return { kind: 'applied', fetchedAt: outcome.value.fetchedAt };
  }
}

async function writeAtomic(target: string, body: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, body, 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function isKindsData(value: unknown): value is CsfloatKindsData {
  // An older version is fetched again rather than read: it lacks what this one answers.
  if (!isRecord(value) || value['version'] !== 2 || typeof value['fetchedAt'] !== 'string' || !isRecord(value['weapons']) || !isRecord(value['weaponTypes'])) return false;
  const numbers = (list: unknown): boolean => Array.isArray(list) && list.length > 0 && list.every((id) => Number.isSafeInteger(id));
  return Object.values(value['weapons']).every((paints) => Array.isArray(paints))
    && (Object.keys(KIND_MAPS) as Kind[]).every((kind) => numbers(value[kind]));
}

/**
 * A catalogue key's parts, or `null` for one that is not a key: `paint` is null for an item with no
 * finish, and `kit` holds the identity attributes by index.
 */
function parseKey(key: MatchKey): { def: number; paint: number | null; kit: Map<number, number> } | null {
  const parts = key.split(':');
  if (parts.length !== 4) return null;
  const [defText, paintText, , kitText] = parts as [string, string, string, string];
  if (!isIndex(defText) || (paintText !== '' && !isIndex(paintText))) return null;
  const kit = new Map<number, number>();
  for (const pair of kitText.split(',').filter(Boolean)) {
    const [attribute, value] = pair.split('=');
    if (attribute !== undefined && value !== undefined && isIndex(attribute) && isIndex(value)) kit.set(Number(attribute), Number(value));
  }
  return { def: Number(defText), paint: paintText === '' ? null : Number(paintText), kit };
}

function isIndex(value: string): boolean {
  return /^\d{1,9}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
