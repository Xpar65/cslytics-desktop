import { convert, unitPrice, type Figure, type FxRates, type StoredPrice } from '@cslytics/market-data';
import { baseCurrencyOf, type AppliedValueSettings, type DesktopSettings } from '../../shared/api.js';
import type { AppliedValue, AppliedValuePart, NamedAccessory, NamedHoldingAccessories } from '../../shared/accessories.js';

/**
 * A reference price on each sticker, patch and charm applied to an item, and what the stickers and
 * the charm are estimated to add to the item they are on.
 *
 * The reference price is the one the portfolio gives the same name held as an item of its own: the
 * mid of the book in CSlytics's hourly snapshot, in US dollars, converted once to the base currency
 * for showing. Nothing is read for it. The snapshot is already on this computer and covers
 * stickers, patches, charms and sticker slabs by market name, so a page of items costs one read of
 * the cache and no request, and nothing an account holds is named to anyone. Without a snapshot
 * this desktop may price from (no sign-in, no feature, a generation too old) nothing has a
 * reference price, and the window shows what it showed before.
 *
 * Steam's book is not a price for everything. Its market holds no listing above its price ceiling,
 * so a sticker that sells for more elsewhere has buy orders here and nothing listed. In the snapshot
 * of 2026-11-23, 168 of 10,433 stickers had no listing, and the dearest of them were the Katowice
 * 2014 holos, each with a buy order near the ceiling and no sale in thirty days. For such a name
 * the highest buy order is carried as what it is, a floor (`ReferencePrice`), and the estimate
 * leaves the sticker out. A reference price for those has to come from a venue that lists them.
 *
 * What is applied is worth less than its reference price, because a sticker cannot be moved to
 * another item. We measured what buyers paid on top of the plain item, on sales in October and
 * November 2026, as a share of that price: about a tenth for stickers, about a fifth when four or
 * more were the same sticker, and about four fifths for a charm, which can be taken off again.
 * Those are the defaults of the three shares in Settings. It is a rough figure on purpose: cheap
 * stickers add a smaller share than dear ones and a scraped sticker less than a clean one, and
 * neither is modelled. So the estimate is shown beside what it describes and enters no total.
 */

/** The snapshot's one currency (`PriceSnapshot.currency`). */
const SNAPSHOT_CURRENCY = 'USD';

/** How many of one sticker make an item "four of the same", the case buyers pay the larger share for. */
export const SAME_STICKER_COUNT = 4;

export type AppliedPricing = {
  /** The snapshot's rows for these market names; empty when no snapshot may price anything now (`MarketDataHost.coveredRows`). */
  rows: (names: readonly string[]) => ReadonlyMap<string, StoredPrice>;
  fx: () => FxRates | null;
  settings: () => DesktopSettings;
};

type Slot = Pick<NamedAccessory, 'kind' | 'family' | 'kitId'>;

/**
 * The estimate for one item, from each slot and its reference price in cents (`null` for none).
 *
 * Whether an item is four of the same is a fact about what is on it, so every sticker counts toward
 * it, priced or not; the share then applies to the reference prices of the priced ones, added. A
 * patch is in a sticker slot and is not a sticker: nothing was measured for one, and it adds
 * nothing here.
 */
export function appliedValue(
  applied: ReadonlyArray<{ accessory: Slot; cents: number | null }>,
  shares: AppliedValueSettings,
  figure: (cents: number) => Figure
): AppliedValue | null {
  const stickers = applied.filter(({ accessory }) => accessory.kind === 'sticker-slot' && accessory.family === 'sticker');
  const charms = applied.filter(({ accessory }) => accessory.kind === 'charm-slot');
  const counts = new Map<number, number>();
  for (const { accessory } of stickers) counts.set(accessory.kitId, (counts.get(accessory.kitId) ?? 0) + 1);
  const same = Math.max(0, ...counts.values()) >= SAME_STICKER_COUNT;

  const part = (rows: typeof applied, percent: number): (AppliedValuePart & { count: number; addedCents: number }) | null => {
    const priced = rows.flatMap(({ cents }) => (cents === null ? [] : [cents]));
    if (priced.length === 0) return null;
    const referenceCents = priced.reduce((sum, cents) => sum + cents, 0);
    const addedCents = Math.round(referenceCents * percent / 100);
    return { reference: figure(referenceCents), percent, added: figure(addedCents), count: priced.length, addedCents };
  };
  const stickerPart = part(stickers, same ? shares.sameStickerPercent : shares.mixedStickerPercent);
  const charmPart = part(charms, shares.charmPercent);
  if (stickerPart === null && charmPart === null) return null;
  return {
    // Added in the snapshot's currency and converted once, never as two converted figures added.
    added: figure((stickerPart?.addedCents ?? 0) + (charmPart?.addedCents ?? 0)),
    stickers: stickerPart === null ? null : { reference: stickerPart.reference, percent: stickerPart.percent, added: stickerPart.added, count: stickerPart.count, same },
    charm: charmPart === null ? null : { reference: charmPart.reference, percent: charmPart.percent, added: charmPart.added },
    unpriced: [...stickers, ...charms].filter(({ cents }) => cents === null).length
  };
}

/**
 * The catalogue's answer for a page of holdings with a reference price on every slot the snapshot
 * covers, and each holding's estimate. One read of the cache for every distinct name on the page.
 */
export function priceAccessories(
  pricing: AppliedPricing,
  held: ReadonlyArray<{ localId: string; accessories: readonly NamedAccessory[] }>
): NamedHoldingAccessories[] {
  const names = [...new Set(held.flatMap((row) => row.accessories.flatMap((accessory) => (accessory.marketHashName === null ? [] : [accessory.marketHashName]))))];
  const rows = names.length === 0 ? new Map<string, StoredPrice>() : pricing.rows(names);
  if (rows.size === 0) return held.map((row) => ({ localId: row.localId, accessories: row.accessories.map((accessory) => ({ ...accessory, referencePrice: null })), appliedValue: null }));
  const settings = pricing.settings();
  const base = baseCurrencyOf(settings);
  const fx = pricing.fx();
  const figure = (cents: number): Figure => ({
    native: { cents, currency: SNAPSHOT_CURRENCY },
    converted: base === SNAPSHOT_CURRENCY ? null : convert(cents, SNAPSHOT_CURRENCY, base, fx)
  });
  const priceOf = (name: string | null): ReturnType<typeof unitPrice> => {
    const row = name === null ? undefined : rows.get(name);
    // A name Steam says does not exist has a row and no price: unknown, never zero.
    return row === undefined || row.absent ? null : unitPrice(row);
  };
  return held.map((row) => {
    const applied = row.accessories.map((accessory) => ({ accessory, price: priceOf(accessory.marketHashName) }));
    return {
      localId: row.localId,
      accessories: applied.map(({ accessory, price }) => ({
        ...accessory,
        referencePrice: price === null ? null : { figure: figure(price.cents), basis: price.basis }
      })),
      // A buy order with no listing is a floor, not a reference price (`ReferencePrice`): shown on its own, counted nowhere.
      appliedValue: appliedValue(applied.map(({ accessory, price }) => ({ accessory, cents: price === null || price.basis === 'bid-only' ? null : price.cents })), settings.appliedValue, figure)
    };
  });
}
