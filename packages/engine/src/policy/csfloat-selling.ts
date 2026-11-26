import type { MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { CsfloatStore } from '../db/csfloat.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { TransferStore } from '../db/transfers.js';
import { WorkStore } from '../db/work.js';
import { OrderStore } from '../db/orders.js';
import { ACCOUNT_INVENTORY, ACCOUNT_MARKET, FRESHNESS, surfaceEvidence, type Surface } from '../kernel/evidence.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { COMMITTING_STATUSES } from './trade-status.js';
import { TradeStore } from '../db/trades.js';
import type { CommandAuthority } from '../db/alphabets.js';
import { CSFLOAT_INVENTORY_WAIT_REASON } from '../db/member-state.js';

export type CsfloatSellMember = { accountId: string; localId: string; priceCents: number };
/**
 * `quantity` units of one group in main inventory, each listed at `priceCents`. The engine picks
 * which, as it does for a Steam listing of a group: the window sees a group as one row and never
 * holds a unit's id.
 */
export type CsfloatSellGroupMember = { accountId: string; stackKey: string; quantity: number; priceCents: number };
/** `authority` is whose the listing is: a person's unless it says otherwise (strategy authority plan D1). */
export type CsfloatSellRequest = { commandId: string; members: readonly (CsfloatSellMember | CsfloatSellGroupMember)[]; authority?: CommandAuthority | undefined };
/** At most this many listings per command, however they were asked for: CSFloat's own batch limit. */
export const CSFLOAT_LIST_LIMIT = 100;

/**
 * Every account surface `validate` refuses a CSFloat listing on the age of, in the order it judges them.
 *
 * Admission reads these again before it judges (`CsfloatSellingService.submit`). Each is trusted
 * for five minutes, and Steam's trade inventory is read on events only, never on a timer. Judged as
 * last recorded, an eligibility refresh followed by a List six minutes later was refused against a
 * read nothing would ever renew, while the window, which reads eligibility from the last complete
 * walk, went on offering CSFloat (D-CSF-15, 2026-09-17). A surface added to `validate` belongs here
 * too, or it is refused on age again.
 *
 * CSFloat's own copy of the inventory is not here. `validate` judges it only when a recent complete
 * read holds the item, and never refuses for want of one (CSF-58): it allows 120 reads a day, and
 * reading it before every listing spent a trading account's day by mid-afternoon and then refused
 * every listing until the window rolled (2026-11-10).
 */
export const CSFLOAT_LIST_EVIDENCE: readonly Surface[] = [
  'csfloat-account-status', 'gc-inventory', 'csfloat-stall', 'csfloat-trades',
  'steam-trade-inventory', 'steam-trade-offers', 'steam-market'
];

/**
 * What a delivery's own checks judge (`CsfloatDeliveryService.validateOwnership`): CSFloat's stall
 * and sales, the item in main inventory and tradable, and Steam's offers. An accept or a nudge reads
 * these only once they have aged past their trust window, so one walk of each serves every sale of
 * a backlog. Reading every book per sale, as a person's Refresh does, spent CSFloat's sales budget
 * (~100 a few minutes) on a run of sales and then refused the very sends it was reading for (2026-10-25).
 * CSFloat's inventory is not here: a delivery never judges it, and it allows 120 reads a day.
 */
export const CSFLOAT_DELIVERY_EVIDENCE: readonly Surface[] = [
  'csfloat-account-status', 'csfloat-stall', 'csfloat-trades', 'gc-inventory', 'steam-trade-inventory', 'steam-trade-offers'
];

const MINUTE = 60_000;

/**
 * How a listing waits after CSFloat refused it because its copy of the inventory does not hold the
 * item yet (`403 code 17`), counted from its first refusal so a restart lands on the same moments.
 *
 * - `retryAtMs`: when it is sent again, each the first offset not yet passed; the last is its last chance.
 * - `deadlineMs`: when it gives up, and the item stays in main inventory.
 * - `readAtMs`: when CSFloat's copy of the inventory is read for it, once per account however many
 *   wait; each the first offset after the account's latest read of any kind. A read that shows the
 *   item sends it at once.
 * - `readEveryMs`: or, instead, a read at most this often, the first one this long into the wait.
 */
export type InventoryWait = { retryAtMs: readonly number[]; deadlineMs: number; readAtMs?: readonly number[]; readEveryMs?: number };

/**
 * The wait follows whose listing it is (decided 2026-11-11, CSF-33, CSF-62).
 *
 * A person pressed List and is watching: the copy is read 30 s, 1, 2, 4 and 8 minutes in, as a
 * listing from a storage unit always was, so the item lists within moments of CSFloat showing it;
 * the timed sends are the fallback when the day's reads are spent; and it gives up at ten minutes,
 * as it always did. One person's batch costs five reads of 120 a day.
 *
 * A strategy lists all day and nobody watches: the send is the probe. A create is one of 50,000
 * calls a day and an inventory read one of 120 (`csfloat.concept.rate-limits`), so it is sent again
 * 1, 3, 8, 18, 30, 45 and 60 minutes in and the copy is read at most every fifteen minutes; CSFloat
 * caught up with a retrieve in about two minutes (2026-09-23), so the second or third send is the
 * expected one, and most waits cost no read at all.
 */
export const INVENTORY_WAIT: Readonly<Record<CommandAuthority, InventoryWait>> = {
  HUMAN: { retryAtMs: [1, 3, 8, 10].map((minutes) => minutes * MINUTE), deadlineMs: 10 * MINUTE, readAtMs: [30_000, MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE] },
  STRATEGY: { retryAtMs: [1, 3, 8, 18, 30, 45, 60].map((minutes) => minutes * MINUTE), deadlineMs: 60 * MINUTE, readEveryMs: 15 * MINUTE }
};

/**
 * Every account surface a person's CSFloat list reads again first: the listing evidence and
 * CSFloat's own copy of the inventory, so an item CSFloat stopped holding is refused while the
 * person is still looking (CSF-23). Only when the last complete read is older than its window, and a
 * read the day's budget or a 429 refuses leaves the listing admitted on the record (CSF-58).
 */
export const CSFLOAT_PERSON_LIST_EVIDENCE: readonly Surface[] = [...CSFLOAT_LIST_EVIDENCE, 'csfloat-inventory'];
/**
 * How long after Steam's trade inventory first shows an item a complete read of CSFloat's copy that
 * still lacks it means CSFloat does not take it, rather than that the copy lags: five times the two
 * minutes CSFloat took to catch up with a retrieve (2026-09-23; the corpus records no upper bound).
 * An item that arrived more recently is admitted, and a `403 code 17` makes it wait (CSF-58).
 */
export const INVENTORY_LAG_GRACE_MS = 10 * 60_000;

/** The reason a waiting listing carries. The window shows it, and the member state reads it, so it lives with the member state. */
export { CSFLOAT_INVENTORY_WAIT_REASON } from '../db/member-state.js';

/**
 * Whether CSFloat refused a create because its copy of the inventory does not hold the item:
 * `403 {"code":17,"message":"item <asset-id> not found in your inventory"}`. The corpus calls it lag,
 * not a missing item: the same listing succeeds once the copy catches up (`csfloat.me.inventory`).
 */
export function isInventoryLag(outcome: MutationOutcome): boolean {
  if (outcome.kind !== 'DEFINITIVELY_REJECTED') return false;
  const raw = outcome.raw as { status?: unknown; code?: unknown } | null | undefined;
  return raw?.status === 403 && raw.code === 17;
}

/**
 * How old the read a reprice or delist is admitted on may be for it to need no read of its own first (CSF-57). Admission
 * and the send each judge the listing's contract on a complete read begun inside five minutes (`validateEdit`); a read
 * no older than this leaves the send a minute of that window.
 */
export const EDIT_EVIDENCE_MARGIN_MS = 240_000;
/**
 * How far before a create's attempt began a listing CSFloat stamps may still be that create's, when
 * the answer named no id: the venue's clock against the engine's (delivery retries plan D6). A
 * listing stamped earlier than this existed before the attempt and is never its product.
 */
export const CREATE_CLOCK_TOLERANCE_MS = 60_000;
/** The operation's error on that timeout, whichever wait it was. The window recognises it by this exact text. */
export const CSFLOAT_VISIBILITY_TIMEOUT_REASON = 'CSFloat did not show the item in its inventory in time; it stays in main inventory';

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
    if (storedCannotTrade(item)) throw new Error('Item is marked untradable by Steam');
    if (item.unit_kind === 'fungible' && (item.quantity !== 1 || (item.reserved_command && item.reserved_command !== ownOperation))) throw new Error('Select an available individual commodity asset');
    for (const until of [item?.tradable_after,item?.trade_protected_until]) if (until && (!Number.isFinite(Date.parse(until)) || until > now)) throw new Error(`Item is trade locked or protected until ${until}`);
    const conflict = marketplaceBlock(db,member.accountId,member.localId,'csfloat-list',now,ownOperation);
    if (conflict) throw new Error(conflict);
    const action = db.inFlightAction(member.accountId,`item:${member.localId}`);
    if (action && action.id !== new WorkStore(db).step(ownOperation)?.action_id) throw new Error('Item has an unresolved operation');
    // CSFloat's own copy of the inventory, judged on a recent complete read and never read for this
    // (CSF-58). A read that holds the item: its verdict stands. A read that does not, begun long
    // enough after Steam first showed the item for CSFloat's copy to have caught up: CSFloat does
    // not take it. Otherwise — the item arrived too recently, or no read is recent — it is admitted
    // on the Game Coordinator's and Steam's word below, and CSFloat answers a copy that lags with
    // `403 code 17`, which waits and is sent again. A failed read voids nothing: the last complete
    // one is still what CSFloat said.
    const evidence = new AssetEvidenceStore(db), steam = evidence.community(member.accountId,asset);
    const read = store.freshComplete(member.accountId,'csfloat-inventory',now,FRESHNESS['csfloat-inventory'].maxAgeMs);
    if (read) {
      const venue = evidence.csfloat(member.accountId,asset);
      const held = venue !== undefined && venue.last_seen_obs === read.id;
      const arrived = steam ? db.observation(member.accountId,steam.first_seen_obs)?.started_at : undefined;
      const caughtUp = arrived !== undefined && Date.parse(read.started_at)-Date.parse(arrived) >= INVENTORY_LAG_GRACE_MS;
      // A listing already waiting for CSFloat's copy is sent again on its own schedule, to its deadline.
      const own = ownOperation ? new WorkStore(db).step(ownOperation) : undefined;
      const waiting = own?.state === 'RETRYING' && own.reason === CSFLOAT_INVENTORY_WAIT_REASON;
      if (held ? venue.eligible !== 1 || store.associate(member.accountId,venue.item) !== member.localId : caughtUp && !waiting) {
        throw new Error('CSFloat has not confirmed this exact item as tradable');
      }
    }
    const transfers = new TransferStore(db), steamObs = transfers.fresh(member.accountId,'steam-trade-inventory',now);
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
    if (storedCannotTrade(item)) throw new Error('Item is marked untradable by Steam');
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
