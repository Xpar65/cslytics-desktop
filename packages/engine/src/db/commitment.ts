/**
 * Whether a holding is committed to a sell order, and whether it is listed on the Steam Community
 * Market. Two questions, one table, asked here and nowhere else (consolidation plan D5).
 *
 * Listing is not a place. The Game Coordinator keeps a listed item in the inventory, destroying
 * and re-creating it under the same asset id as the listing goes live, and drops it only when it
 * sells (`cs2-gc/inventory.so-cache` in the shared corpus, captured 2026-09-15). So an item's
 * `location` is where the GC holds it, which a listing never changes, and "listed" is a second,
 * separate fact: an open `venue_order` row the market walk wrote that names the item. Every
 * question of the form "is this item on the market?" is asked here, and never of `item.location`.
 *
 * An order names its holding by the row a walk bound it to (`local_id`) and by the asset id the
 * venue reported or the request sent (`asset_id`). Both are asked: a listing walked before its
 * item was is bound by neither until a later walk, and the asset id is the one a list → cancel
 * round-trip keeps (rule 3). Each probe is written to match one index, `order_resource` or
 * `order_asset`, which is why there are two `EXISTS` rather than one `OR`.
 */

/** A sell order still standing against the holding: open on the venue, sent and not yet seen, or ended with no explanation. */
const COMMITTED = "o.side='SELL' AND o.state NOT LIKE 'ENDED_%'";

/** A sell listing the venue's last complete walk of its book showed: Steam's market walk, CSFloat's stall walk. */
function listedOn(venue: 'steam' | 'csfloat'): string {
  return `o.venue='${venue}' AND o.side='SELL' AND o.first_seen_obs IS NOT NULL AND o.gone_obs IS NULL`;
}

/** A Steam sell listing the last complete market walk showed, in any of Steam's three buckets. */
const STEAM_LISTED = listedOn('steam');

function names(alias: string, predicate: string): string {
  return `(EXISTS (SELECT 1 FROM venue_order o WHERE o.account_id=${alias}.account_id AND o.local_id=${alias}.local_id AND ${predicate})
    OR EXISTS (SELECT 1 FROM venue_order o WHERE o.account_id=${alias}.account_id AND o.asset_id=${alias}.asset_id AND ${predicate}))`;
}

/**
 * SQL that is true when a sell order commits the `item` row aliased `alias`: open, submitted and
 * unobserved, or ended without explanation. The one admission question a second sell of the same
 * holding is refused by (order lifecycle D16). Narrowed to one venue, it is that venue's own
 * refusal of a second order; the other venue's claim is the cross-venue policy's to apply, which a
 * person may switch off (`kernel/marketplace-commitments.ts`, XLIST-03).
 */
export function committedSql(alias: string, venue?: 'steam' | 'csfloat'): string {
  return names(alias, venue ? `o.venue='${venue}' AND ${COMMITTED}` : COMMITTED);
}

/** SQL that is true when an open Steam listing names the `item` row aliased `alias`. */
export function steamListedSql(alias: string): string {
  return names(alias, STEAM_LISTED);
}

/**
 * SQL that is true when a CSFloat listing the last complete stall walk showed names the `item` row
 * aliased `alias`: the row the Listings page shows for it. A fact to show beside the item, as
 * `steamListedSql` is; whether a second sell of it is refused is `committedSql`'s question.
 */
export function csfloatListedSql(alias: string): string {
  return names(alias, listedOn('csfloat'));
}

/** The Steam-listed predicate over a `venue_order` row aliased `o`, for a query that already has the row. */
export const STEAM_LISTED_SQL = STEAM_LISTED;
/** The committed predicate over a `venue_order` row aliased `o`. */
export const COMMITTED_SQL = COMMITTED;
