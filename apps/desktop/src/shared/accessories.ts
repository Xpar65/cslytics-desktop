import type { AppliedAccessory } from '@cslytics/engine';
import type { Figure } from '@cslytics/market-data';

/**
 * What main answers about the stickers, patches and charm applied to an item. Types only: the
 * engine reads the slots by kit id (`inventory.accessories`), main names them from the catalogue
 * and gives each its reference price from CSlytics's hourly snapshot, and the window draws what it
 * is given.
 */

/** The three things an owner applies to an item. A sticker slot holds either of the first two. */
export type AccessoryFamily = 'sticker' | 'patch' | 'charm';

export type NamedAccessory = AppliedAccessory & {
  /** What the kit resolved as. An unresolved kit in a sticker slot reads `sticker`; the window words that case from `name`. */
  family: AccessoryFamily;
  /** `null` when the catalogue does not hold the kit, which the window then shows by its id. */
  name: string | null;
  /**
   * The name the accessory is sold under as an item of its own. Every price this app holds is
   * keyed by a market name, so this is what its reference price is asked by, and what the Items
   * page opens it by when it is pressed in the inspector.
   */
  marketHashName: string | null;
  imageUrl: string | null;
  /**
   * The reference price: what one sells for as an item of its own, off anything
   * (`priceAccessories` in main). An estimate, and never what it adds to the item it is on; that is
   * `AppliedValue`. `null` when none is known: no market name, no row for it, or no snapshot this
   * desktop may price from.
   */
  referencePrice: ReferencePrice | null;
};

/**
 * One accessory's reference price: Steam's book for it in CSlytics's snapshot, read as the
 * portfolio reads the same name: the mid of the lowest listing and the highest buy order, or the
 * one side the book has.
 *
 * `bid-only` is the side that is not a reference price. Nothing is listed, so the figure is the
 * highest buy order: what someone would pay today, and a floor under what the thing is worth.
 * Steam's market holds no listing above its price ceiling, so the stickers that sell for more than
 * that elsewhere are exactly the ones with buy orders and no listing here. The window says so in
 * place of a reference price, and the estimate leaves such a sticker out rather than count a share
 * of a floor.
 */
export type ReferencePrice = { figure: Figure; basis: 'mid' | 'ask-only' | 'bid-only' };

/** One part of an applied value: its reference price, the share of that a buyer pays for it applied, and the two multiplied. */
export type AppliedValuePart = {
  /** The reference prices of what is counted, added. */
  reference: Figure;
  /** The share in percent, from the settings (`AppliedValueSettings`). */
  percent: number;
  added: Figure;
};

/**
 * What the stickers and the charm on one item are estimated to add to its price: a share of their
 * reference price, the share set in Settings. Stickers take one share, or a larger one when four
 * or more of them are the same sticker; a charm, which can be taken off again, takes its own. A
 * patch is not counted. An estimate from past sales and nothing more: it is shown, and it is never
 * part of a total or of a price that is sent.
 */
export type AppliedValue = {
  /** Both parts added. */
  added: Figure;
  /** `null` when the item carries no sticker with a reference price. `count` is the stickers counted; `same` is four or more of one sticker. */
  stickers: (AppliedValuePart & { count: number; same: boolean }) | null;
  /** `null` when the item carries no charm with a reference price. */
  charm: AppliedValuePart | null;
  /** Stickers and charms on the item that had no reference price, or only a buy order and no listing, and are left out. */
  unpriced: number;
};

/** One holding's slots as a page row carries them: named, priced, and what they add; `null` when nothing on it has a reference price. */
export type NamedHoldingAccessories = { localId: string; accessories: NamedAccessory[]; appliedValue: AppliedValue | null };
