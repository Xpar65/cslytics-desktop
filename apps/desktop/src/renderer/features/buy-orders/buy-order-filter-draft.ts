import type { NamedBuyOrderFilter } from './buy-order-filters.js';

/**
 * A buy order's filters as the change editor holds them while they are typed.
 *
 * Text, not numbers: a half-typed `0.` is a state a field must be allowed to be in. Turned back
 * into the edit's constraint set only on the way out (`constraintsFromDraft`), which says in words
 * what cannot be a filter. The engine checks the same things again and is the gate; this is so the
 * person hears it while typing rather than after Save.
 */

/** A sticker or a charm picked in the editor: its definition id, and how it is shown. */
export type AccessoryPick = { id: number; name: string; imageUrl: string | null };

export type FilterDraft = {
  minFloat: string;
  maxFloat: string;
  /** Patterns as typed: `661, 670 955`. */
  seeds: string;
  minCharmPattern: string;
  maxCharmPattern: string;
  stickers: AccessoryPick[];
  charms: AccessoryPick[];
};

/** The edit route's whole filter set, as `csfloat.buyOrderEdit` carries it. `null` is none. */
export type BuyOrderConstraintsInput = {
  minFloat: number | null;
  maxFloat: number | null;
  paintSeeds: number[] | null;
  minKeychainPattern: number | null;
  maxKeychainPattern: number | null;
  appliedStickers: Array<{ sId: number }> | null;
  appliedKeychains: Array<{ sId: number }> | null;
};

const MAX_SEED = 1000;

/** The draft an order's filters start the editor at. */
export function draftFromFilters(filters: readonly NamedBuyOrderFilter[] | null): FilterDraft {
  const draft: FilterDraft = { minFloat: '', maxFloat: '', seeds: '', minCharmPattern: '', maxCharmPattern: '', stickers: [], charms: [] };
  for (const filter of filters ?? []) {
    if (filter.kind === 'float') {
      draft.minFloat = filter.min === null ? '' : String(filter.min);
      draft.maxFloat = filter.max === null ? '' : String(filter.max);
    } else if (filter.kind === 'pattern') {
      draft.seeds = filter.seeds.join(', ');
    } else if (filter.kind === 'stickers') {
      draft.stickers = filter.stickers.map((sticker) => ({ id: sticker.stickerId, name: sticker.name ?? `Sticker ${sticker.stickerId}`, imageUrl: sticker.imageUrl ?? null }));
    } else if (filter.kind === 'charms') {
      draft.charms = filter.charms.map((charm) => ({ id: charm.charmId, name: charm.name ?? `Charm ${charm.charmId}`, imageUrl: charm.imageUrl ?? null }));
    } else if (filter.kind === 'charm-pattern') {
      draft.minCharmPattern = filter.min === null ? '' : String(filter.min);
      draft.maxCharmPattern = filter.max === null ? '' : String(filter.max);
    }
  }
  return draft;
}

export type DraftReading = { constraints: BuyOrderConstraintsInput; problem: null } | { constraints: null; problem: string };

/** The draft as the edit's constraint set, or what stops it being one, in words. */
export function constraintsFromDraft(draft: FilterDraft): DraftReading {
  const fail = (problem: string): DraftReading => ({ constraints: null, problem });
  const float = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    return /^(0(\.\d*)?|1(\.0*)?|\.\d+)$/.test(trimmed) && value >= 0 && value <= 1 ? value : undefined;
  };
  const whole = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : undefined;
  };
  const minFloat = float(draft.minFloat);
  const maxFloat = float(draft.maxFloat);
  if (minFloat === undefined || maxFloat === undefined) return fail('A float is a number from 0 to 1, such as 0.15');
  if (minFloat !== null && maxFloat !== null && minFloat > maxFloat) return fail('The lowest float is above the highest');
  const tokens = draft.seeds.split(/[\s,]+/).filter(Boolean);
  if (tokens.some((token) => !/^\d+$/.test(token) || Number(token) > MAX_SEED)) return fail(`Patterns are whole numbers from 0 to ${MAX_SEED}, separated by commas`);
  const seeds = [...new Set(tokens.map(Number))];
  const minKeychainPattern = whole(draft.minCharmPattern);
  const maxKeychainPattern = whole(draft.maxCharmPattern);
  if (minKeychainPattern === undefined || maxKeychainPattern === undefined) return fail('A charm pattern is a whole number');
  if (minKeychainPattern !== null && maxKeychainPattern !== null && minKeychainPattern > maxKeychainPattern) return fail('The lowest charm pattern is above the highest');
  return { problem: null, constraints: {
    minFloat, maxFloat,
    paintSeeds: seeds.length ? seeds : null,
    minKeychainPattern, maxKeychainPattern,
    appliedStickers: draft.stickers.length ? draft.stickers.map((sticker) => ({ sId: sticker.id })) : null,
    appliedKeychains: draft.charms.length ? draft.charms.map((charm) => ({ sId: charm.id })) : null
  } };
}

/**
 * Whether two filter sets say the same thing: floats and charm patterns by value, patterns as a
 * set, stickers and charms by id counted, list order no part of it. The engine's own comparison
 * (`sameBuyOrderConstraints`) is the one that decides; this only tells the editor whether a
 * change of filters is being asked for at all.
 */
export function sameConstraints(left: BuyOrderConstraintsInput, right: BuyOrderConstraintsInput): boolean {
  const seeds = (list: readonly number[] | null): string => [...new Set(list ?? [])].sort((a, b) => a - b).join(',');
  const ids = (list: ReadonlyArray<{ sId: number }> | null): string => (list ?? []).map((entry) => entry.sId).sort((a, b) => a - b).join(',');
  return left.minFloat === right.minFloat && left.maxFloat === right.maxFloat
    && left.minKeychainPattern === right.minKeychainPattern && left.maxKeychainPattern === right.maxKeychainPattern
    && seeds(left.paintSeeds) === seeds(right.paintSeeds)
    && ids(left.appliedStickers) === ids(right.appliedStickers) && ids(left.appliedKeychains) === ids(right.appliedKeychains);
}
