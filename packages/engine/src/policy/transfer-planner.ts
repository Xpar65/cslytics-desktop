import type { EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, surfaceEvidence } from '../kernel/evidence.js';
import { TransferStore, type TransferAsset, type TransferMember } from '../db/transfers.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { HoldingsStore } from '../db/holdings.js';
import { COMMITTING_STATUSES } from './trade-status.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { TradeStore } from '../db/trades.js';

export const MAX_TRADE_OFFER_ITEMS = 200;
export const MAX_TRANSFER_SOURCES = 31;
/** Steam's main-inventory ceiling; a retrieval hop borrows one of the source's own slots. */
const MAIN_INVENTORY_HARD_CAP = 1000;
export type TransferRequest = { commandId: string; destinationAccountId: string; members: readonly TransferMember[] };
export type TransferPlan = { destinationAccountId: string; groups: Array<{ accountId: string; assets: TransferAsset[] }>;
  blocked: Array<{ accountId: string; memberId: string; reason: string }>; quantity: number;
  /** How many of the assets sit in a storage unit and are retrieved before their offer is sent. */
  retrievals: number };
/** The renderer needs quantities and refusal reasons; dispatch assets remain in the runtime. */
export type TransferPreview = Omit<TransferPlan,'groups'> & {groups:Array<{accountId:string;quantity:number}>};

/**
 * Admission is recomputed immediately before dispatch; a preview never authorises a later send.
 *
 * A crated individual item is not refused: it is admitted as a retrieval hop (cross-account
 * transfer plan D-04, the listing chain's shape). Its lock, pledge, open-order and marketplace
 * checks are judged here; its Community tradability cannot be, because the Community inventory
 * walk shows only main inventory, so that judgement is deferred to the re-plan at dispatch, once
 * a complete observation has shown the item back in main inventory. A stack in storage is still
 * refused: no handle allocation exists for it and nothing live has ever exercised one.
 */
export class TransferPlanner {
  constructor(protected readonly context: EngineContext) {}

  plan(destinationAccountId: string, members: readonly TransferMember[], ownCommand = ''): TransferPlan {
    const db = this.context.database;
    const store = new TransferStore(db), evidence = new AssetEvidenceStore(db);
    const accounts = db.listAccounts();
    const result: TransferPlan = { destinationAccountId, groups: [], blocked: [], quantity: 0, retrievals: 0 };
    const block = (accountId: string, memberId: string, reason: string) => result.blocked.push({ accountId, memberId, reason });
    if (!accounts.some(a => a.id === destinationAccountId)) block(destinationAccountId,'destination','Choose an owned destination account');
    if (!members.length || members.length > MAX_TRADE_OFFER_ITEMS * MAX_TRANSFER_SOURCES) block(destinationAccountId,'selection','Select items to transfer');
    const groups = new Map<string, TransferAsset[]>();
    const selected = new Set<string>();
    for (const member of members) {
      const key = member.localId ?? member.stackKey ?? '';
      if (!accounts.some(a => a.id === member.accountId) || member.accountId === destinationAccountId) {
        block(member.accountId,key,'Source must be a different owned account'); continue;
      }
      if (Boolean(member.localId) === Boolean(member.stackKey)) { block(member.accountId,key,'Select an item or a stack'); continue; }
      const quantity = member.quantity ?? 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || (member.localId && quantity !== 1)) { block(member.accountId,key,'Invalid transfer quantity'); continue; }
      const assets: TransferAsset[] = [];
      if (member.localId) {
        const item = db.itemByLocalId(member.accountId, member.localId);
        if (!item) { block(member.accountId,key,'Item is no longer owned'); continue; }
        // The observed location decides, never the member's own claim about it.
        const casketId = item.location === 'CASKET' && item.casket_id ? item.casket_id : null;
        const reason = this.itemRestriction(item.location,item.tradable_after,item.trade_protected_until,casketId !== null);
        if (reason) { block(member.accountId,key,reason); continue; }
        if (!item.asset_id) { block(member.accountId,key,'Item has no current inventory asset'); continue; }
        assets.push({ appId: 730, contextId: '2', assetId: item.asset_id, quantity: 1, localId: item.local_id,
          stableKey: item.stable_key, unitKind: item.unit_kind, defIndex: item.def_index, quality: item.quality, sourceQuantity: 1,
          ...(casketId ? { pendingRetrieval: true, casketId } : {}) });
      } else {
        let remaining = quantity;
        const units = new HoldingsStore(db).units(member.accountId,member.stackKey).filter(u => u.location === 'MAIN' && u.asset_id);
        if (member.casketId) { block(member.accountId,key,'A stack in storage cannot be sent; retrieve it before sending'); continue; }
        for (const unit of units) {
          if (remaining <= 0) break;
          const reason = this.assetRestriction(member.accountId,unit.asset_id!,unit.local_id,ownCommand);
          if (reason || (unit.reserved_command && unit.reserved_command !== ownCommand)) continue;
          const taken = Math.min(remaining,unit.quantity);
          assets.push({ appId: 730, contextId: '2', assetId: unit.asset_id!, quantity: taken, localId: unit.local_id,
            stableKey: unit.stable_key, unitKind: unit.unit_kind, defIndex: unit.def_index, quality: unit.quality, sourceQuantity: unit.quantity });
          remaining -= taken;
        }
        if (remaining) {
          const first = units[0];
          block(member.accountId,key, first ? this.assetRestriction(member.accountId,first.asset_id!,first.local_id,ownCommand) ?? 'Not enough available tradable quantity'
            : 'Item is not in main inventory; retrieve or delist it before sending'); continue;
        }
      }
      for (const asset of assets) {
        const pending = asset.pendingRetrieval === true;
        const reason = this.assetRestriction(member.accountId,asset.assetId,asset.localId,ownCommand,pending);
        if (reason) { block(member.accountId,key,reason); continue; }
        if (!pending && (evidence.community(member.accountId,asset.assetId)?.quantity ?? 0) < asset.quantity) {
          block(member.accountId,key,'Steam inventory quantity changed; refresh before sending'); continue;
        }
        const assetKey = `${member.accountId}:${asset.assetId}`;
        if (selected.has(assetKey)) { block(member.accountId,key,'Item selected more than once'); continue; }
        selected.add(assetKey);
        const group = groups.get(member.accountId) ?? []; group.push(asset); groups.set(member.accountId,group);
        result.quantity += asset.quantity;
        if (pending) result.retrievals += 1;
      }
    }
    if (groups.size > MAX_TRANSFER_SOURCES) block(destinationAccountId,'selection','Too many source accounts');
    for (const [accountId,assets] of groups) {
      if (assets.length > MAX_TRADE_OFFER_ITEMS) block(accountId,'selection',`Select at most ${MAX_TRADE_OFFER_ITEMS} assets per source account`);
      if (surfaceEvidence(db,accountId,ACCOUNT_INVENTORY,this.context.ports.clock.now()).grade !== 'SATISFIED') block(accountId,'inventory','Refresh the source inventory before sending');
      const offers = store.fresh(accountId,'steam-trade-offers',this.context.now());
      if (!offers) block(accountId,'offers','Refresh source trade offers before sending');
      const hold = store.hold(accountId,destinationAccountId);
      const holdObs = hold && db.observation(accountId,hold.observation_id);
      const holdAge = holdObs ? Date.parse(this.context.now()) - Date.parse(holdObs.started_at) : NaN;
      if (!hold || !holdObs?.complete || holdObs.error || !(holdAge >= 0 && holdAge <= 300_000)) block(accountId,'hold','Check trade hold durations before sending');
      else if (hold.my_seconds !== 0 || hold.their_seconds !== 0) block(accountId,'hold',`Trade hold: sender ${hold.my_seconds}s, destination ${hold.their_seconds}s`);
      const budget = this.budgetReason(accountId,destinationAccountId,ownCommand);
      if (budget) block(accountId,'budget',budget);
      // A retrieval lands in the source's own main inventory first, so it needs a slot there —
      // beside whatever other retrievals and incoming transfers already hold one.
      const retrievals = assets.filter(a => a.pendingRetrieval).length;
      if (retrievals && db.countMainItems(accountId) + db.reservedMainSlots(accountId) + retrievals > MAIN_INVENTORY_HARD_CAP) {
        block(accountId,'room','Source inventory has no room to retrieve into');
      }
      result.groups.push({ accountId,assets });
    }
    if (surfaceEvidence(db,destinationAccountId,ACCOUNT_INVENTORY,this.context.ports.clock.now()).grade !== 'SATISFIED') block(destinationAccountId,'capacity','Refresh the destination inventory to check available room');
    // Revalidation replaces only the source batches being checked. Other sources in the
    // same command still reserve their destination slots, as do storage retrievals.
    const ownSlots = ownCommand ? store.batches(ownCommand).filter(b => b.destination_account_id === destinationAccountId
      && groups.has(b.account_id) && !['DONE','ENDED','FAILED'].includes(b.state))
      .reduce((sum,b) => sum + (JSON.parse(b.assets_json) as TransferAsset[]).reduce((n,a) => n+a.quantity,0),0) : 0;
    if (db.countMainItems(destinationAccountId) + db.reservedMainSlots(destinationAccountId) - ownSlots + result.quantity > MAIN_INVENTORY_HARD_CAP) {
      block(destinationAccountId,'capacity','Destination inventory does not have enough room');
    }
    if (!store.link(destinationAccountId)) block(destinationAccountId,'link','Connect the destination to obtain its trade link');
    return result;
  }

  /**
   * What the item's own row refuses. `retrievable` admits a crated item as a retrieval hop; a
   * listed item is never one, because a delist is a different chain with its own confirmation.
   */
  protected itemRestriction(location: string, tradableAfter: string | null, protectedUntil: string | null, retrievable = false): string | null {
    if (location !== 'MAIN' && !(retrievable && location === 'CASKET')) {
      return location === 'CASKET' ? 'Item is in storage; retrieve it before sending' : 'Item is not in main inventory; delist it before sending';
    }
    for (const [date,label] of [[tradableAfter,'Trade locked'],[protectedUntil,'Trade protected']] as const) {
      if (date && (!Number.isFinite(Date.parse(date)) || date > this.context.now())) return `${label} until ${date}`;
    }
    return null;
  }

  /**
   * What the asset refuses. `pendingRetrieval` skips only the Community-tradability judgement,
   * which cannot be made for an item the Community walk does not show; the re-plan at dispatch
   * makes it once the item is observed in main inventory.
   */
  protected assetRestriction(accountId: string, assetId: string, localId: string, ownCommand: string, pendingRetrieval = false): string | null {
    const db = this.context.database, store = new TransferStore(db), evidence = new AssetEvidenceStore(db);
    const marketplace = marketplaceBlock(db,accountId,localId,'account-transfer',this.context.now());
    if (marketplace) return marketplace;
    // The Game Coordinator's `cannot trade` on the unit itself, which no Community read can lift
    // and which a crated item carries too, so it is judged before the deferred tradability below.
    if (storedCannotTrade(db.itemByAssetId(accountId,assetId))) return 'Item is marked untradable by Steam';
    if (!pendingRetrieval) {
      const row = evidence.community(accountId,assetId);
      // Require a positive current description even for cases and coins. An expired cooldown
      // never upgrades tradable=0; only a subsequent Steam observation can do that.
      const latest = store.fresh(accountId,'steam-trade-inventory',this.context.now());
      if (!row || !latest || row.last_seen_obs !== latest.id) return 'Tradability unknown; refresh trade eligibility';
      const unit = db.itemByAssetId(accountId,assetId);
      if (unit?.unit_kind === 'fungible') {
        // A group unit carries the same two lock columns a skin does; the individual path
        // checked them before asking here.
        for (const until of [unit.trade_protected_until,unit.tradable_after]) {
          if (until && (!Number.isFinite(Date.parse(until)) || until > this.context.now())) return `Trade locked or protected until ${until}`;
        }
      }
      if (row.tradable !== 1) return `${row.name || 'Item'} is not tradable on Steam`;
    }
    const inflight = db.inFlightAction(accountId,`item:${localId}`);
    if (inflight) return 'Item has an unresolved operation';
    const pledged = new TradeStore(db).committedTradeAssets(accountId,COMMITTING_STATUSES).find(p => p.asset_id === assetId && p.offer_id !== `command:${ownCommand}`);
    if (pledged) return 'Item is already committed to a trade';
    const order = db.raw().prepare(`SELECT 1 FROM venue_order WHERE account_id=? AND local_id=? AND side='SELL' AND state NOT LIKE 'ENDED_%'`).get(accountId,localId);
    if (order) return 'Item has an open or unexplained sell order';
    return null;
  }

  protected budgetReason(accountId: string, destination: string, ownCommand: string): string | null {
    const db = this.context.database;
    const steamId = db.listAccounts().find(a => a.id === destination)?.steam_id64;
    if (!steamId || !/^\d{17}$/.test(steamId)) return 'Invalid destination identity';
    const live = db.raw().prepare(`SELECT offer_id,counterparty_steam_id64 FROM trade_offer WHERE account_id=? AND direction='SENT' AND state_code IN (2,9)`).all(accountId) as Array<{ offer_id: string; counterparty_steam_id64: string }>;
    const pending = new TransferStore(db).batches().filter(b => b.account_id === accountId && b.command_id !== ownCommand && !['DONE','ENDED','FAILED'].includes(b.state)
      && !live.some(o => o.offer_id === b.offer_id));
    if (live.length + pending.length >= 20 || live.filter(o => o.counterparty_steam_id64 === steamId).length + pending.filter(b => b.destination_account_id === destination).length >= 4) return 'Active trade offer budget reached';
    return null;
  }
}
