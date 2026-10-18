import type { EngineDatabase } from '../db/database.js';
import { CsfloatStore, type CsfloatTradeRow } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { OrderStore } from '../db/orders.js';
import { OPEN_STEP_STATES_SQL } from '../db/work.js';

/** The hops of a delivery, which name a trade; every other CSFloat hop names a listing, or nothing yet. */
const DELIVERY_HOPS: ReadonlySet<string> = new Set(['CSFLOAT_ACCEPT', 'CSFLOAT_SEND', 'CSFLOAT_NOTIFY', 'CSFLOAT_CANNOT_DELIVER']);

/**
 * Shared by Steam listing, storage and transfer admission, and checked again at dispatch.
 *
 * `account-transfer` is a send to another account the person owns, and CSFloat has no say in it
 * beyond a claim on *this* unit: an operation, a listing or a sale that names it. Neither the age
 * of the CSFloat reads nor a CSFloat row whose identity is unresolved refuses it, because both are
 * facts about the venue rather than about the item (a product decision of 2026-09-17, after a
 * transfer of an item never listed anywhere was refused with "Refresh CSFloat listings";
 * TRD-EX-17). `transfer` is the send to a CSFloat buyer, which keeps every check.
 *
 * A Steam listing is a claim like any other. The Game Coordinator keeps a listed item in the
 * inventory, so nothing about the unit's location refuses a store or a send of it
 * (`db/commitment.ts`); this does, by the one question every venue's orders answer (D5): an
 * order still standing against the holding, open on the book or sent and not yet explained.
 * `delist-to-store` is a store whose own first step cancels
 * that listing, so it is judged as a store in every other respect. A Steam listing's own purpose,
 * `steam-list`, never asks: a second listing is the `no-open-order` precondition's refusal, and a
 * reprice is a cancel of the very listing this would find. CSFloat's listing asks in
 * `csfloat-selling.ts`, under the double-listing policy.
 *
 * `ownOperation` is the caller's own work — a command id, or the id of one hop of it — which is
 * not a claim against itself: the delivery of a sale is not refused by that sale, nor a cancel by
 * the listing it cancels.
 *
 * A store does not ask how old the CSFloat reads are, any more than a send between owned accounts
 * does: the age of a venue's read is a fact about the venue, and before 2026-10-16 it failed every
 * store of a thousand-item batch that reached the send in the minutes after the stall read aged
 * out (bulk storage plan D7, BULK-01). What the record holds about the item still answers, and
 * `consent` is the claims the person chose to store it despite, frozen on the move when the
 * pre-check showed them (D9, BULK-09).
 */
export type MarketplacePurpose = 'steam-list' | 'storage' | 'delist-to-store' | 'transfer' | 'account-transfer' | 'csfloat-list';

/** A claim on an item the person may store it despite, once the pre-check has named it (bulk storage plan D9). */
export type MarketplaceConsent = 'csfloat-listed' | 'csfloat-owed' | 'trade-pledged';
export const MARKETPLACE_CONSENTS: readonly MarketplaceConsent[] = ['csfloat-listed', 'csfloat-owed', 'trade-pledged'];

/** The purposes that move an item between this account's own inventory and units, and never to anyone else. */
function storesIt(purpose: MarketplacePurpose): boolean {
  return purpose === 'storage' || purpose === 'delist-to-store';
}

export function marketplaceBlock(db: EngineDatabase, accountId: string, localId: string, purpose: MarketplacePurpose, now: string, ownOperation = '', consent: readonly MarketplaceConsent[] = []): string | null {
  const store = new CsfloatStore(db), policy = store.policy();
  const assetId = db.itemByLocalId(accountId,localId)?.asset_id ?? '';
  if (purpose === 'storage' || purpose === 'transfer' || purpose === 'account-transfer') {
    const order = new OrderStore(db).commitment(accountId,localId,assetId || null,'steam');
    if (order?.venue === 'steam' && order.first_seen_obs !== null && order.gone_obs === null) return `Item is listed on the Steam market (listing ${order.venue_order_id}); delist it first`;
    if (order?.venue === 'steam') return 'Item has a Steam sell order no walk has explained yet; refresh the market first';
  }
  const claim = csfloatClaim(db,accountId,localId,purpose,ownOperation,consent);
  if (claim) return claim;
  const ownAccounts = purpose === 'account-transfer';
  const connection = new MarketplaceStore(db).connection(accountId,'csfloat');
  if (connection && !ownAccounts && !storesIt(purpose) && (purpose !== 'steam-list' || policy.preventDuplicates)) {
    for (const surface of ['csfloat-stall','csfloat-trades']) {
      if (!store.fresh(accountId,surface,now)) return `Refresh ${surface === 'csfloat-stall' ? 'CSFloat listings' : 'CSFloat sales'} before using this item`;
    }
  }
  return null;
}

/**
 * CSFloat's claim on a unit, as the record holds it: work in flight about it, a sale owed to a
 * buyer, an advertisement still standing. The part of `marketplaceBlock` that needs no fresh walk
 * to answer, so a Steam listing's admission can ask it (XLIST-02) while the send still asks for
 * the venue's evidence to be fresh (XLIST-04). Under the cross-venue policy: with protection off
 * a live advertisement does not refuse a Steam listing (XLIST-03), and nothing else changes.
 */
export function csfloatClaim(db: EngineDatabase, accountId: string, localId: string, purpose: MarketplacePurpose, ownOperation = '', consent: readonly MarketplaceConsent[] = []): string | null {
  const store = new CsfloatStore(db), policy = store.policy();
  const assetId = db.itemByLocalId(accountId,localId)?.asset_id ?? '';
  // A store the person agreed to despite a claim is not refused by that claim; nothing else is (D9).
  const despite = (claim: MarketplaceConsent): boolean => storesIt(purpose) && consent.includes(claim);
  // CSFloat work in flight about this unit, other than the caller's own command or hop (and the
  // hops before that hop, which are the same member's). A delivery's hop is a sale owed; any other
  // CSFloat hop is a listing being made, changed or ended.
  const open = db.raw().prepare(`SELECT c.kind AS commandKind, s.kind AS stepKind FROM work_step s JOIN command c ON c.id=s.command_id
    WHERE s.account_id=? AND c.kind LIKE 'CSFLOAT_%' AND s.state IN ${OPEN_STEP_STATES_SQL}
      AND (s.local_id=? OR json_extract(s.params_json,'$.assetId')=?)
      AND s.command_id<>? AND s.id<>? AND s.id NOT LIKE ?`).all(accountId,localId,assetId,ownOperation,ownOperation,`${ownOperation}:%`) as Array<{ commandKind: string; stepKind: string }>;
  if (open.some(row => (row.commandKind !== 'CSFLOAT_CREATE' || purpose !== 'steam-list' || policy.preventDuplicates)
    && !despite(DELIVERY_HOPS.has(row.stepKind) ? 'csfloat-owed' : 'csfloat-listed'))) return 'Item has an unresolved CSFloat operation';
  // A delivery's hops name the trade and carry the listing it sold; a listing's hops name the listing.
  const own = ownOperation ? db.raw().prepare(`SELECT kind, target_id, json_extract(params_json,'$.listingId') AS listing_id, json_extract(params_json,'$.tradeId') AS trade_id
    FROM work_step WHERE command_id=? OR id=?`).all(ownOperation,ownOperation) as Array<{ kind: string; target_id: string | null; listing_id: string | null; trade_id: string | null }> : [];
  const ownTrades = new Set(own.flatMap(step => [DELIVERY_HOPS.has(step.kind) ? step.target_id : null, step.trade_id].filter((id): id is string => id !== null)));
  const ownListings = new Set(own.flatMap(step => [DELIVERY_HOPS.has(step.kind) ? null : step.target_id, step.listing_id].filter((id): id is string => id !== null)));
  const ownAccounts = purpose === 'account-transfer';
  // An unresolved row could be any unit, so it refuses every unit — except a move between owned
  // accounts or into this account's own unit, which no CSFloat row can be about until it names one (D7).
  const venueBlind = ownAccounts || storesIt(purpose);
  const unresolved = venueBlind ? '' : ' OR local_id IS NULL';
  const contracts = store.standingContracts(accountId,localId,assetId,!venueBlind);
  const trades = db.raw().prepare(`SELECT * FROM csfloat_trade WHERE account_id=? AND seller_steam_id=? AND state_word NOT IN ('verified','failed','cancelled')
    AND (local_id=? OR asset_id=?${unresolved})`).all(accountId,db.account(accountId)?.steam_id64 ?? '',localId,assetId) as CsfloatTradeRow[];
  const pledged = trades.find(t => !ownTrades.has(t.trade_id));
  if (pledged && !despite('csfloat-owed')) return `Item is owed to a CSFloat buyer (trade ${pledged.trade_id})`;
  for (const contract of contracts) {
    if (ownListings.has(contract.listing_id)) continue;
    const settled = contract.state === 'sold' && db.raw().prepare(`SELECT 1 FROM csfloat_trade WHERE account_id=? AND listing_id=? AND state_word IN ('verified','failed','cancelled')`).get(accountId,contract.listing_id);
    if (settled) continue;
    if (purpose === 'steam-list' && !policy.preventDuplicates && contract.state === 'listed') continue;
    if (despite(contract.state === 'listed' ? 'csfloat-listed' : 'csfloat-owed')) continue;
    return contract.local_id === null ? `CSFloat listing ${contract.listing_id} has unresolved item identity`
      : `Item is committed to CSFloat listing ${contract.listing_id} (${contract.state})`;
  }
  return null;
}

/**
 * Every asset of this account a CSFloat hop still in flight, a listing not ended, or an own
 * sale not settled names.
 *
 * A group hands none of these out, whatever it is asked for. `marketplaceBlock` judges a unit that
 * was named; a group's units are picked, and once some of a group can sit on CSFloat, picking "the
 * first three by asset id" for a Steam listing, a store or a transfer would pick the ones CSFloat
 * holds and be refused at the send, while free units of the same group sat unasked. A listing on
 * both venues at once, where protection allows it, is something a person asks for by naming the
 * item, never something a group does on its own.
 */
export function csfloatClaimedAssets(db: EngineDatabase, accountId: string): Set<string> {
  const rows = db.raw().prepare(`
    SELECT json_extract(s.params_json,'$.assetId') AS asset_id FROM work_step s JOIN command c ON c.id=s.command_id
      WHERE s.account_id=? AND c.kind LIKE 'CSFLOAT_%' AND s.state IN ${OPEN_STEP_STATES_SQL} AND json_extract(s.params_json,'$.assetId') IS NOT NULL
    UNION SELECT v.asset_id FROM venue_order v JOIN csfloat_order x ON x.account_id=v.account_id AND x.order_id=v.order_id
      WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND x.state_word NOT IN ('delisted','cancelled','refunded') AND v.asset_id IS NOT NULL
    UNION SELECT asset_id FROM csfloat_trade WHERE account_id=? AND state_word NOT IN ('verified','failed','cancelled')
      AND seller_steam_id=(SELECT steam_id64 FROM account WHERE id=?)
  `).all(accountId,accountId,accountId,accountId) as Array<{ asset_id: string }>;
  return new Set(rows.map(row => row.asset_id));
}
