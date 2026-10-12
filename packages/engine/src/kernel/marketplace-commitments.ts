import type { EngineDatabase } from '../db/database.js';
import { CsfloatStore, type CsfloatContract, type CsfloatTradeRow } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { OPEN_LISTING_STATUSES } from '../db/steam-listing.js';

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
 * (`db/steam-listing.ts`); this does. `delist-to-store` is a store whose own first step cancels
 * that listing, so it is judged as a store in every other respect. A Steam listing's own purpose,
 * `steam-list`, never asks: a second listing is the `no-open-order` precondition's refusal, and a
 * reprice is a cancel of the very listing this would find. CSFloat's listing asks in
 * `csfloat-selling.ts`, under the double-listing policy.
 */
export function marketplaceBlock(db: EngineDatabase, accountId: string, localId: string, purpose: 'steam-list' | 'storage' | 'delist-to-store' | 'transfer' | 'account-transfer' | 'csfloat-list', now: string, ownOperation = ''): string | null {
  const store = new CsfloatStore(db), policy = store.policy();
  const assetId = db.itemByLocalId(accountId,localId)?.current_asset_id ?? '';
  if (purpose === 'storage' || purpose === 'transfer' || purpose === 'account-transfer') {
    const listing = db.raw().prepare(`SELECT listing_id FROM market_listing WHERE account_id=? AND (local_id=? OR asset_id=?) AND status IN ${OPEN_LISTING_STATUSES} LIMIT 1`)
      .get(accountId,localId,assetId) as { listing_id: string } | undefined;
    if (listing) return `Item is listed on the Steam market (listing ${listing.listing_id}); delist it first`;
  }
  const own = store.operation(ownOperation);
  const operations = db.raw().prepare(`SELECT id,kind FROM csfloat_operation WHERE account_id=? AND (local_id=? OR asset_id=?)
    AND id<>? AND state NOT IN ('DONE','FAILED','CANCELLED')`).all(accountId,localId,assetId,ownOperation) as Array<{ id: string; kind: string }>;
  if (operations.some(op => op.kind !== 'CREATE' || purpose !== 'steam-list' || policy.preventDuplicates)) return 'Item has an unresolved CSFloat operation';
  const ownAccounts = purpose === 'account-transfer';
  // An unresolved row could be any unit, so it refuses every unit — except a move between owned accounts.
  const unresolved = ownAccounts ? '' : ' OR local_id IS NULL';
  const contracts = db.raw().prepare(`SELECT * FROM csfloat_contract WHERE account_id=? AND state NOT IN ('delisted','cancelled','refunded')
    AND (local_id=? OR asset_id=?${unresolved})`).all(accountId,localId,assetId) as CsfloatContract[];
  const trades = db.raw().prepare(`SELECT * FROM csfloat_trade WHERE account_id=? AND seller_steam_id=? AND state NOT IN ('verified','failed','cancelled')
    AND (local_id=? OR asset_id=?${unresolved})`).all(accountId,db.account(accountId)?.steam_id64 ?? '',localId,assetId) as CsfloatTradeRow[];
  const pledged = trades.find(t => t.trade_id !== own?.trade_id);
  if (pledged) return `Item is owed to a CSFloat buyer (trade ${pledged.trade_id})`;
  for (const contract of contracts) {
    if (contract.listing_id === own?.listing_id) continue;
    const settled = contract.state === 'sold' && db.raw().prepare(`SELECT 1 FROM csfloat_trade WHERE account_id=? AND listing_id=? AND state IN ('verified','failed','cancelled')`).get(accountId,contract.listing_id);
    if (settled) continue;
    if (purpose === 'steam-list' && !policy.preventDuplicates && contract.state === 'listed') continue;
    return contract.local_id === null ? `CSFloat listing ${contract.listing_id} has unresolved item identity`
      : `Item is committed to CSFloat listing ${contract.listing_id} (${contract.state})`;
  }
  const connection = new MarketplaceStore(db).connection(accountId,'csfloat');
  if (connection && !ownAccounts && (purpose !== 'steam-list' || policy.preventDuplicates)) {
    for (const surface of ['csfloat-stall','csfloat-trades']) {
      if (!store.fresh(accountId,surface,now)) return `Refresh ${surface === 'csfloat-stall' ? 'CSFloat listings' : 'CSFloat sales'} before using this item`;
    }
  }
  return null;
}

/**
 * Every asset of this account a CSFloat operation still in flight, a listing not ended, or an own
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
    SELECT asset_id FROM csfloat_operation WHERE account_id=? AND asset_id IS NOT NULL AND state NOT IN ('DONE','FAILED','CANCELLED')
    UNION SELECT asset_id FROM csfloat_contract WHERE account_id=? AND state NOT IN ('delisted','cancelled','refunded')
    UNION SELECT asset_id FROM csfloat_trade WHERE account_id=? AND state NOT IN ('verified','failed','cancelled')
      AND seller_steam_id=(SELECT steam_id64 FROM account WHERE id=?)
  `).all(accountId,accountId,accountId,accountId) as Array<{ asset_id: string }>;
  return new Set(rows.map(row => row.asset_id));
}
