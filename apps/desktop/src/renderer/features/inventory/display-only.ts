/**
 * Display items: held, never handled.
 *
 * A veteran coin, a service medal, a loyalty badge, a granted music kit. Steam lets nobody sell,
 * trade or move one, so the window offers no verb for it, counts nothing as available, and leaves
 * it out of Select all. It still shows where it sorts and still opens in the inspector.
 *
 * Two kinds of evidence, and either is enough:
 *
 *  - **The unit**, observed: the Game Coordinator stamps `cannot trade` (attribute 2) on it, and the
 *    engine reports that as `cannotTrade`. That is how a granted music kit is known.
 *  - **The kind**, from the catalogue: `catalogueMarketable: false` says no unit of this kind is a
 *    market item. That is how a coin or medal is known, since Valve keeps their `cannot trade` on
 *    the schema rather than the unit, and it is how one Valve adds next year is known without an
 *    update. Steam's own Community read outranks it: a unit that read holds marketable is not
 *    display-only, whatever the catalogue says, because the catalogue words a refusal and never
 *    outranks an observation (the same rule `csfloatSupport` follows).
 *
 * Derived, never stored, and a courtesy like every verdict in `item-actions.ts`: the engine refuses
 * a `cannot trade` unit itself.
 */

export type DisplayEvidence = {
  /** The engine's `cannot trade`: `1` on a unit Valve marks so; on a group, `1` only when every unit is. */
  cannotTrade?: number | boolean | null | undefined;
  /** The catalogue's word on the kind, attached by the host. `null` or absent is no claim. */
  catalogueMarketable?: boolean | null | undefined;
  /** Steam's Community `marketable` on a page row, or on a group summary the most any unit showed. */
  marketable?: number | boolean | null | undefined;
  anyMarketable?: number | boolean | null | undefined;
};

/** The predicate a blocker reads: "1 item is display only". */
export const DISPLAY_ONLY_REASON = 'display only';

/** The inspector's line when a display item is the whole selection. */
export const DISPLAY_ONLY_CAPTION = 'A display item: Steam does not let it be traded, sold or stored.';

/** What the grouped list shows in place of a count available. */
export const DISPLAY_ONLY_LABEL = 'Display only';

export function isDisplayOnly(row: DisplayEvidence): boolean {
  if (row.cannotTrade === true || row.cannotTrade === 1) return true;
  if (row.catalogueMarketable !== false) return false;
  const observedMarketable = row.marketable === 1 || row.marketable === true || row.anyMarketable === 1 || row.anyMarketable === true;
  return !observedMarketable;
}
