/**
 * What a buy order restricts beyond its market name, in words any venue's filters can be put in.
 *
 * Kinds, not venues. Each venue says the same few things its own way — CSFloat's
 * `hybrid_properties` has `min_float`, `paint_seeds`, `applied_stickers` — and its reader
 * (`kernel/csfloat-buy-orders.ts`) turns them into these, so a second marketplace that filters by
 * float or by sticker reuses the kind, the naming in main and the window's piece for it, and one
 * that filters by something new adds a kind here. Steam's buy orders take a market name and
 * nothing else, so a Steam order has none.
 *
 * Values are the venue's own, and identity only: a sticker is its sticker kit id and a charm its
 * charm id, which main names from the catalogue on the way out (SYS-05). Every list keeps what the
 * venue sent, however many: an order may accept several patterns or require several stickers.
 */
export type BuyOrderFilter =
  /** The float is within the range; an end the venue left open is `null`. */
  | { kind: 'float'; min: number | null; max: number | null }
  /** The pattern (paint seed) is one of these. */
  | { kind: 'pattern'; seeds: number[] }
  /** The item carries these stickers, each by sticker kit id, with its slot when the venue names one. */
  | { kind: 'stickers'; stickers: Array<{ stickerId: number; slot: number | null }> }
  /** The item carries these charms, each by charm id. */
  | { kind: 'charms'; charms: Array<{ charmId: number }> }
  /** The charm's own pattern is within the range. */
  | { kind: 'charm-pattern'; min: number | null; max: number | null }
  /**
   * A restriction this app cannot read, named rather than hidden: the venue's key, and its value
   * as the venue sent it. An order carrying one is never changed from here.
   */
  | { kind: 'unrecognised'; key: string; value: string };

export type BuyOrderFilterKind = BuyOrderFilter['kind'];
