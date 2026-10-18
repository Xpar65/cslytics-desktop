import type { EngineContext } from '../kernel/context.js';
import { CsfloatStore } from '../db/csfloat.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { TransferStore } from '../db/transfers.js';
import { WorkStore } from '../db/work.js';
import { OrderStore } from '../db/orders.js';
import { ACCOUNT_INVENTORY, ACCOUNT_MARKET, surfaceEvidence, type Surface } from '../kernel/evidence.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { COMMITTING_STATUSES } from './trade-status.js';
import { TradeStore } from '../db/trades.js';

export type CsfloatSellMember = { accountId: string; localId: string; priceCents: number };
/**
 * `quantity` units of one group in main inventory, each listed at `priceCents`. The engine picks
 * which, as it does for a Steam listing of a group: the window sees a group as one row and never
 * holds a unit's id.
 */
export type CsfloatSellGroupMember = { accountId: string; stackKey: string; quantity: number; priceCents: number };
export type CsfloatSellRequest = { commandId: string; members: readonly (CsfloatSellMember | CsfloatSellGroupMember)[] };
/** At most this many listings per command, however they were asked for: CSFloat's own batch limit. */
export const CSFLOAT_LIST_LIMIT = 100;

/**
 * Every account surface `validate` judges a CSFloat listing by, in the order it judges them.
 *
 * Admission reads these again before it judges (`CsfloatSellingService.submit`). Each is trusted
 * for five minutes, and two of them — CSFloat's inventory and Steam's trade inventory — are read on
 * events only, never on a timer. Judged as last recorded, an eligibility refresh followed by a List
 * six minutes later was refused against a read nothing would ever renew, while the window, which
 * reads eligibility from the last complete walk, went on offering CSFloat (D-CSF-15, 2026-09-17).
 * A surface added to `validate` belongs here too, or it is refused on age again.
 */
export const CSFLOAT_LIST_EVIDENCE: readonly Surface[] = [
  'csfloat-account-status', 'gc-inventory', 'csfloat-stall', 'csfloat-trades', 'csfloat-inventory',
  'steam-trade-inventory', 'steam-trade-offers', 'steam-market'
];

/**
 * When CSFloat's copy of the inventory is read while a retrieved item waits to be listed: offsets
 * from the observation that proved it loose. Per account, shared by every waiting operation, never
 * per item — each read spends one of about 120 a day (fixtures/csfloat/INDEX.md). On 2026-09-23 a
 * retrieved skin was missing at +30 s and present at +122 s, so the third read is the expected hit.
 */
export const VISIBILITY_READ_OFFSETS_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 480_000];
/** How long a retrieved item may wait for CSFloat to see it before the listing fails. */
export const VISIBILITY_DEADLINE_MS = 600_000;
/** The operation's error on that timeout. The window recognises it by this exact text. */
export const CSFLOAT_VISIBILITY_TIMEOUT_REASON = 'CSFloat did not show the item within 10 minutes; it stays in main inventory';

export class CsfloatSellingPolicy {
  constructor(protected readonly context: EngineContext) {}

  /**
   * Why the venue would refuse a new listing from this account, or null.
   *
   * A suspension is judged from the last `/me`, and it ends only when a later `/me` says so
   * (`csfloatRestriction`): once the clock passes `suspended_until` with nothing read since, the
   * account is *stale*, still refused, and told to refresh — CSFloat's own `code 138` is what a
   * listing sent on the strength of the calendar would get back.
   */
  protected restriction(accountId: string, now: string): string | null {
    const restriction = new MarketplaceStore(this.context.database).restriction(accountId, now);
    if (!restriction || restriction.state === 'ended') return null;
    return restriction.state === 'stale'
      ? `CSFloat suspended this account until ${restriction.until}; refresh the CSFloat connection to confirm it has ended`
      : `CSFloat has suspended this account until ${restriction.until}`;
  }

  validate(member: CsfloatSellMember, ownOperation = ''): string {
    const { database: db } = this.context, store = new CsfloatStore(db), now = this.context.now();
    this.validateAccount(member);
    const item = db.itemByLocalId(member.accountId,member.localId);
    const asset = item?.asset_id;
    if (!asset || item.location !== 'MAIN') throw new Error('Retrieve the item into main inventory before listing');
    // The Game Coordinator's own `cannot trade` on the unit, before anything a venue says: no read
    // of either inventory can make a granted music kit tradable.
    if (storedCannotTrade(item.attributes_json)) throw new Error('Item is marked untradable by Steam');
    if (item.unit_kind === 'fungible' && (item.quantity !== 1 || (item.reserved_command && item.reserved_command !== ownOperation))) throw new Error('Select an available individual commodity asset');
    for (const until of [item?.tradable_after,item?.trade_protected_until]) if (until && (!Number.isFinite(Date.parse(until)) || until > now)) throw new Error(`Item is trade locked or protected until ${until}`);
    const conflict = marketplaceBlock(db,member.accountId,member.localId,'csfloat-list',now,ownOperation);
    if (conflict) throw new Error(conflict);
    const action = db.inFlightAction(member.accountId,`item:${member.localId}`);
    if (action && action.id !== new WorkStore(db).step(ownOperation)?.action_id) throw new Error('Item has an unresolved operation');
    if (!store.fresh(member.accountId,'csfloat-inventory',now)) throw new Error('Refresh CSFloat inventory eligibility first');
    const evidence = new AssetEvidenceStore(db), venue = evidence.csfloat(member.accountId,asset);
    if (!venue || venue.eligible !== 1 || store.associate(member.accountId,venue.item) !== member.localId) throw new Error('CSFloat has not confirmed this exact item as tradable');
    const transfers = new TransferStore(db), steamObs = transfers.fresh(member.accountId,'steam-trade-inventory',now), steam = evidence.community(member.accountId,asset);
    if (!steamObs || !steam || steam.last_seen_obs !== steamObs.id || steam.tradable !== 1) throw new Error('Steam tradability must be positively observed');
    // Steam's own "can this be sold at all" (holdings plan D7): a unit Steam calls unmarketable is
    // not offered on any venue. Unknown stays allowed, as tradability above requires a positive read.
    if (steam.marketable === 0) throw new Error('Item is not marketable on Steam');
    if (!transfers.fresh(member.accountId,'steam-trade-offers',now)) throw new Error('Refresh Steam trade offers first');
    if (new TradeStore(db).committedTradeAssets(member.accountId,COMMITTING_STATUSES).some(a => a.asset_id === asset)) throw new Error('Item is already committed to a Steam trade');
    if (surfaceEvidence(db,member.accountId,ACCOUNT_MARKET,this.context.ports.clock.now()).grade !== 'SATISFIED') throw new Error('Refresh Steam listings first');
    // An ended Steam order is explained; one open on the book or not yet explained is a competing advertisement (D5).
    if (store.policy().preventDuplicates && new OrderStore(db).commitment(member.accountId,member.localId,asset,'steam')) throw new Error('Item already has a Steam listing or unresolved sell order');
    return asset;
  }

  /**
   * Admission for an item that is still in a storage unit: everything `validate` asks that can be
   * true of a crated item, now.
   *
   * What cannot be true yet is deferred to the send, where `validate` runs in full: the item in
   * main inventory, CSFloat's read showing it tradable, and Steam's trade inventory saying the
   * same. Neither venue can see inside a unit, so asking them now would refuse every crated item.
   * Only individual items, for now: whether a casket retrieve keeps a unit's asset id has never
   * been measured (item attribution plan, H1 / G-20), and this hop freezes the id it will send.
   */
  validateForRetrieve(member: CsfloatSellMember): { assetId: string; casketId: string } {
    const { database: db } = this.context, now = this.context.now();
    this.validateAccount(member);
    const item = db.itemByLocalId(member.accountId,member.localId);
    if (item?.unit_kind === 'fungible') throw new Error('Only individual items can be listed from storage');
    if (!item?.asset_id || item.location !== 'CASKET' || !item.casket_id) throw new Error('Item is not in a storage unit');
    if (storedCannotTrade(item.attributes_json)) throw new Error('Item is marked untradable by Steam');
    const asset = item.asset_id;
    for (const until of [item.tradable_after,item.trade_protected_until]) if (until && (!Number.isFinite(Date.parse(until)) || until > now)) throw new Error(`Item is trade locked or protected until ${until}`);
    const conflict = marketplaceBlock(db,member.accountId,member.localId,'csfloat-list',now);
    if (conflict) throw new Error(conflict);
    if (db.inFlightAction(member.accountId,`item:${member.localId}`)) throw new Error('Item has an unresolved operation');
    if (!new TransferStore(db).fresh(member.accountId,'steam-trade-offers',now)) throw new Error('Refresh Steam trade offers first');
    if (new TradeStore(db).committedTradeAssets(member.accountId,COMMITTING_STATUSES).some(a => a.asset_id === asset)) throw new Error('Item is already committed to a Steam trade');
    if (surfaceEvidence(db,member.accountId,ACCOUNT_MARKET,this.context.ports.clock.now()).grade !== 'SATISFIED') throw new Error('Refresh Steam listings first');
    if (new CsfloatStore(db).policy().preventDuplicates && new OrderStore(db).commitment(member.accountId,member.localId,asset,'steam')) throw new Error('Item already has a Steam listing or unresolved sell order');
    return { assetId: asset, casketId: item.casket_id };
  }

  /** The price, the connection, the account's standing and a fresh Steam inventory: true of any member. */
  private validateAccount(member: CsfloatSellMember): void {
    const { database: db } = this.context, store = new CsfloatStore(db), now = this.context.now();
    if (!Number.isSafeInteger(member.priceCents) || member.priceCents < 3) throw new Error('CSFloat listing price must be at least 3 USD cents');
    const connection = new MarketplaceStore(db).connection(member.accountId,'csfloat');
    if (connection?.status !== 'CONNECTED' || !connection.credential_ref || !store.fresh(member.accountId,'csfloat-account-status',now)) throw new Error('Refresh the CSFloat account connection first');
    const restricted = this.restriction(member.accountId, now);
    if (restricted) throw new Error(restricted);
    if (surfaceEvidence(db,member.accountId,ACCOUNT_INVENTORY,this.context.ports.clock.now()).grade !== 'SATISFIED') throw new Error('Refresh Steam inventory first');
  }
}
