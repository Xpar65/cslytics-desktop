import { STORE_DEF_INDEX_BY_NAME } from '@cslytics/catalogue';
import type { StoreSheetView } from '@cslytics/engine';
import type { CatalogueMediator } from './catalogue/mediator.js';

/**
 * The host's half of the in-game store: names and def indexes.
 *
 * The engine holds no names, so the price sheet leaves it keyed by `items_game` internal names
 * and a purchase reaches it carrying the def index the host resolved. Both halves live here, in
 * main, beside the catalogue: the generated name table answers the def index, and the catalogue
 * answers what to call it and what it looks like. An entry the table does not know is shown and
 * marked unpurchasable rather than hidden or guessed (STORE-01, ITEM-09).
 */

/** Keys, tools and coupons are `unique` quality in the GC (4); that is the quality the catalogue keys them under. */
const STORE_ITEM_QUALITY = 4;

export type EnrichedStoreEntry = StoreSheetView['entries'][number] & {
  defIndex: number | null;
  name: string;
  imageUrl: string | null;
  purchasable: boolean;
  reason: string | null;
};

export type EnrichedStoreSheet = Omit<StoreSheetView, 'entries'> & { entries: EnrichedStoreEntry[] };

export function storeDefIndex(entryKey: string): number | null {
  const found = STORE_DEF_INDEX_BY_NAME[entryKey];
  return typeof found === 'number' ? found : null;
}

/** `stattrak_swap_tool` → `Stattrak Swap Tool`; `coupon - bossyburger` → `Coupon Bossyburger`. A fallback, never a market name. */
export function humanizeStoreKey(entryKey: string): string {
  return entryKey.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function enrichStoreSheet(catalogue: CatalogueMediator, sheet: StoreSheetView | null): EnrichedStoreSheet | null {
  if (!sheet) return null;
  const rows = sheet.entries.map((entry) => {
    const defIndex = storeDefIndex(entry.entryKey);
    return { ...entry, defIndex, quality: STORE_ITEM_QUALITY, matchKey: defIndex === null ? '' : `${defIndex}::${STORE_ITEM_QUALITY}:` };
  });
  const enriched = catalogue.enrich(rows.filter((row) => row.matchKey !== ''));
  const byKey = new Map(enriched.map((row) => [row.entryKey, row]));
  return {
    ...sheet,
    entries: rows.map((row) => {
      const named = byKey.get(row.entryKey);
      const resolvedName = named && !named.unresolved ? named.name : humanizeStoreKey(row.entryKey);
      return {
        entryKey: row.entryKey,
        categoryTags: row.categoryTags,
        priceCents: row.priceCents,
        salePriceCents: row.salePriceCents,
        defIndex: row.defIndex,
        name: resolvedName,
        imageUrl: named?.imageUrl ?? null,
        purchasable: row.defIndex !== null,
        reason: row.defIndex === null ? 'No def index is known for this store entry; the name table needs regenerating' : null
      };
    })
  };
}

export type StoreBuyLineInput = { entryKey: string; quantity: number; unitPriceCents: number };

/** Every line must resolve, or the whole command is refused before it reaches the engine (STORE-10 style: zero writes). */
export function resolveStoreLines(lines: readonly StoreBuyLineInput[]): Array<StoreBuyLineInput & { defIndex: number }> {
  return lines.map((line) => {
    const defIndex = storeDefIndex(line.entryKey);
    if (defIndex === null) throw new Error(`No def index is known for store entry ${line.entryKey}`);
    return { ...line, defIndex };
  });
}
