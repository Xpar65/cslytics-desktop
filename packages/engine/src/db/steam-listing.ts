/**
 * Whether an item is listed on the Steam Community Market.
 *
 * Listing is not a place. The Game Coordinator keeps a listed item in the inventory, destroying
 * and re-creating it under the same asset id as the listing goes live, and drops it only when it
 * sells (`cs2-gc/inventory.so-cache` in the shared corpus, captured 2026-09-15). So an item's
 * `location` is where the GC holds it, which a listing never changes, and "listed" is a second,
 * separate fact: an open row in `market_listing` that names the item. Every question of the form
 * "is this item on the market?" is asked here, and never of `item.location`.
 *
 * A listing names its item by the row a walk bound it to (`local_id`) and by the asset id Steam
 * reported (`asset_id`). Both are asked: a listing walked before its item was is bound by neither
 * until a later walk, and the asset id is the one a list → cancel round-trip keeps (rule 3).
 */

/** A listing that is still on the market: live, held by Steam, or waiting on the phone. */
export const OPEN_LISTING_STATUSES = "('ACTIVE','ON_HOLD','PENDING_CONFIRMATION')";

/**
 * SQL that is true when an open Steam listing names the `item` row aliased `alias`.
 *
 * Two `EXISTS` rather than one `OR`, so each probe is answered by its own partial index
 * (`market_listing_open_local`, `market_listing_open_asset`).
 */
export function steamListedSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM market_listing listed WHERE listed.account_id=${alias}.account_id AND listed.local_id=${alias}.local_id AND listed.status IN ${OPEN_LISTING_STATUSES})
    OR EXISTS (SELECT 1 FROM market_listing listed WHERE listed.account_id=${alias}.account_id AND listed.asset_id=${alias}.current_asset_id AND listed.status IN ${OPEN_LISTING_STATUSES}))`;
}
