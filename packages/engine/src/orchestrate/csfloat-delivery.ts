import type { CsfloatTrade, MutationOutcome } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import { CsfloatStore, type CsfloatOperation } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { TransferStore } from '../db/transfers.js';
import { executeMutation, type EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, postAttempt, surfaceEvidence } from '../kernel/evidence.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { TradeService } from '../surfaces/trades.js';
import { COMMITTING_STATUSES } from '../policy/trade-status.js';
import { TradeStore } from '../db/trades.js';
import type { Observe } from './refresh.js';

export type CsfloatDeliveryServices = {
  trades: CsfloatTradeService; steamTrades: TradeService;
  /** The governed read (`RefreshService.observe`): the budget, the breaker, then the settle. */
  observe: Observe;
};

/** Only a user's Accept and send command creates an operation. Reads cannot create one. */
export class CsfloatDeliveryService {
  protected readonly store: CsfloatStore;
  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatDeliveryServices) { this.store = new CsfloatStore(context.database); }

  queue(accountId: string, commandId: string, tradeId: string): CsfloatOperation {
    const db = this.context.database;
    return db.transaction(() => {
      const previous = this.store.operation(commandId);
      if (previous) {
        if (previous.account_id !== accountId || previous.trade_id !== tradeId || previous.kind !== 'DELIVER') throw new Error('Command id already used');
        return previous;
      }
      const existing = this.store.operations(accountId).find(o => o.kind === 'DELIVER' && o.trade_id === tradeId);
      if (existing) return existing;
      const row = this.store.trade(accountId,tradeId), connection = new MarketplaceStore(db).connection(accountId,'csfloat');
      if (!row || row.seller_steam_id !== db.account(accountId)?.steam_id64 || !['queued','pending'].includes(row.state)) throw new Error('Refresh this seller trade first');
      if (!connection?.credential_ref || connection.status !== 'CONNECTED') throw new Error('Connect CSFloat first');
      const obs = db.observation(accountId,row.observation_id), age = obs ? Date.parse(this.context.now())-Date.parse(obs.started_at) : NaN;
      if (!obs?.complete || obs.generation !== connection.generation || !(age >= 0 && age <= 300_000) || !row.local_id) throw new Error('Trade identity or observation is not current');
      const now = this.context.now();
      db.raw().prepare(`INSERT INTO csfloat_operation(id,command_id,account_id,kind,local_id,asset_id,listing_id,trade_id,generation,policy_version,state,created_at,updated_at)
        VALUES (?,?,?,'DELIVER',?,?,?,?,?,?,'QUEUED',?,?)`).run(commandId,commandId,accountId,row.local_id,row.asset_id,row.listing_id,tradeId,connection.generation,this.store.policy().version,now,now);
      return this.store.operation(commandId)!;
    });
  }

  async advance(id: string): Promise<void> {
    const initial = this.store.operation(id);
    if (!initial || initial.kind !== 'DELIVER') throw new Error('Unknown CSFloat delivery');
    await this.context.locks.run(initial.account_id,async () => {
      try { await this.step(id); }
      catch (error) { this.store.update(id,'BLOCKED',this.context.now(),error instanceof Error ? error.message : 'Delivery needs attention'); }
    });
  }

  private async step(id: string): Promise<void> {
    const db = this.context.database, op = this.store.operation(id)!;
    if (['DONE','CANCELLED'].includes(op.state)) return;
    const connection = new MarketplaceStore(db).connection(op.account_id,'csfloat'), ports = this.context.ports.csfloat;
    if (!connection?.credential_ref || connection.status !== 'CONNECTED' || connection.generation !== op.generation || !ports) throw new Error('Reconnect the original CSFloat account before continuing delivery');
    const trade = await this.services.trades.syncTrade(op.account_id,op.trade_id!);
    if (!trade || trade.sellerSteamId !== db.account(op.account_id)?.steam_id64 || trade.listingId !== op.listing_id || trade.listing.item.assetId !== op.asset_id) throw new Error('Refresh the exact seller trade before proceeding');
    const row = this.store.trade(op.account_id,op.trade_id!)!, obs = db.observation(op.account_id,row.observation_id)!;
    const currentAction = op.action_id ? db.action(op.action_id) : undefined;
    if (trade.state === 'verified') {
      if (currentAction?.state === 'AWAITING_OBSERVATION' && postAttempt(db,currentAction,obs,false)) db.resolveAction(currentAction,obs.id,true,this.context.now());
      this.store.update(id,'DONE',this.context.now()); return;
    }
    if (['failed','cancelled'].includes(trade.state)) {
      if (currentAction?.kind === 'CSFLOAT_CANNOT_DELIVER' && postAttempt(db,currentAction,obs,false)) db.resolveAction(currentAction,obs.id,true,this.context.now());
      this.store.update(id,'CANCELLED',this.context.now(),`CSFloat trade ${trade.state}`); return;
    }
    if (trade.state === 'queued') {
      this.validateOwnership(op,trade);
      const action = this.action(op,'CSFLOAT_ACCEPT');
      if (action.state === 'READY') await this.attempt(op,action,() => ports.trades.accept(op.account_id,connection.credential_ref!,trade.tradeId),() => this.validateOwnership(op,trade));
      return;
    }
    if (trade.state !== 'pending') throw new Error(`CSFloat trade state ${trade.state} needs review`);
    if (currentAction?.kind === 'CSFLOAT_ACCEPT' && currentAction.state === 'AWAITING_OBSERVATION' && postAttempt(db,currentAction,obs,false)) db.resolveAction(currentAction,obs.id,true,this.context.now());
    const send = this.findAction(op,'CSFLOAT_SEND');
    if (!send || send.state === 'READY') {
      this.validateOwnership(op,trade);
      if (!trade.tradeToken) throw new Error('CSFloat has not provided a valid buyer trade token');
      const session = await this.context.ports.auth.status(op.account_id);
      if (session.kind !== 'authenticated' || session.steamId64 !== trade.sellerSteamId) throw new Error('Sign in to the seller Steam account');
      const hold = await this.context.ports.trade.getHoldDurations(op.account_id,trade.buyerSteamId,trade.tradeToken);
      if (hold.mySeconds !== 0 || hold.theirSeconds !== 0) throw new Error('A Steam trade hold prevents delivery');
      const action = this.action(op,'CSFLOAT_SEND');
      await this.attempt(op,action,() => this.context.ports.trade.sendOffer(op.account_id,{ partnerSteamId64: trade.buyerSteamId,
        token: trade.tradeToken!, message: `CSlytics delivery ${op.id}`, give: [{ appId: 730,contextId: '2',assetId: op.asset_id!,quantity: 1 }] }),() => this.validateOwnership(op,trade));
      return;
    }
    if (send.state === 'FAILED') throw new Error('Steam rejected this send; review the sale before another action');
    await this.services.observe(op.account_id, { surface: 'steam-trade-offers', scope: { kind: 'account' } });
    const transfers = new TransferStore(db), offerObs = transfers.fresh(op.account_id,'steam-trade-offers',this.context.now());
    if (!offerObs || !postAttempt(db,send,offerObs,false)) { this.store.update(id,'AWAITING_OBSERVATION',this.context.now(),'Waiting for a complete Steam offer observation'); return; }
    const raw = transfers.attemptResponse(send.id);
    const hintedId = op.offer_id ?? (typeof raw['tradeofferid'] === 'string' ? raw['tradeofferid'] : null);
    const partner = (BigInt(trade.buyerSteamId)-76561197960265728n).toString();
    const offers = db.raw().prepare(`SELECT offer_id,raw_state,message,last_seen_obs FROM trade_offer WHERE account_id=? AND direction='SENT'
      AND counterparty_id=? AND last_seen_obs=?`).all(op.account_id,partner,offerObs.id) as Array<{ offer_id: string; raw_state: number; message: string | null; last_seen_obs: number }>;
    const matching = offers.filter(o => (hintedId ? o.offer_id === hintedId : o.message === `CSlytics delivery ${op.id}`) && this.matchesOffer(op,o.offer_id));
    if (matching.length !== 1) { this.store.update(id,'AWAITING_OBSERVATION',this.context.now(),'Send outcome is unresolved; no second offer will be sent'); return; }
    const offer = matching[0]!;
    if (![2,3,9,11].includes(offer.raw_state)) throw new Error(`Steam offer ended in state ${offer.raw_state}; review CSFloat delivery`);
    if (send.state !== 'DONE') db.resolveAction(send,offerObs.id,true,this.context.now());
    db.raw().prepare('UPDATE csfloat_operation SET offer_id=? WHERE id=?').run(offer.offer_id,id);
    const notify = this.findAction(op,'CSFLOAT_NOTIFY');
    if (trade.offerId !== offer.offer_id) {
      // The offer is on Steam, so the only step left to retry is telling CSFloat about it
      // (CSF-SEND-03). An ambiguous notification is retried once a trade read that started after
      // the attempt finished still shows no offer; a rejected one gets a fresh attempt on the next
      // user-driven step. Neither path ever sends the offer again.
      if (notify?.state === 'AWAITING_OBSERVATION' && postAttempt(db,notify,obs,true)) db.resolveAction(notify,obs.id,false,this.context.now());
      const action = this.action(op,'CSFLOAT_NOTIFY',true);
      if (action.state === 'READY') await this.attempt(op,action,() => ports.trades.notifyOffer(op.account_id,connection.credential_ref!,offer.offer_id,[op.asset_id!]),() => {
        if (!this.matchesOffer(op,offer.offer_id)) throw new Error('Steam offer changed before CSFloat notification');
      });
      return;
    }
    if (notify?.state === 'AWAITING_OBSERVATION' && postAttempt(db,notify,obs,false)) db.resolveAction(notify,obs.id,true,this.context.now());
    this.store.update(id,offer.raw_state === 9 ? 'NEEDS_CONFIRMATION' : offer.raw_state === 3 ? 'AWAITING_VERIFICATION' : 'AWAITING_BUYER',this.context.now(),
      offer.raw_state === 9 ? 'Confirm the outgoing offer in the Steam mobile app' : null);
  }

  protected validateOwnership(op: CsfloatOperation, trade: CsfloatTrade): void {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(op.account_id,'csfloat');
    if (connection?.generation !== op.generation || connection.status !== 'CONNECTED') throw new Error('CSFloat connection changed');
    if (trade.state === 'pending' && (!trade.deadlineAt || trade.deadlineAt <= now)) throw new Error('The CSFloat send deadline is missing or has elapsed');
    if (this.store.associate(op.account_id,trade.listing.item) !== op.local_id) throw new Error('Delivery item identity is unresolved');
    const item = db.itemByLocalId(op.account_id,op.local_id!);
    if (!item || item.location !== 'MAIN' || item.current_asset_id !== op.asset_id) throw new Error('Delivery item is not in main inventory');
    if (surfaceEvidence(db,op.account_id,ACCOUNT_INVENTORY,this.context.ports.clock.now()).grade !== 'SATISFIED') throw new Error('Refresh Steam inventory before delivery');
    for (const until of [item.tradable_after,item.trade_protected_until]) if (until && until > now) throw new Error('Delivery item is trade locked or protected');
    const transfers = new TransferStore(db), eligible = transfers.eligibility(op.account_id,op.asset_id!), obs = transfers.fresh(op.account_id,'steam-trade-inventory',now);
    if (!eligible || eligible.tradable !== 1 || eligible.observation_id !== obs?.id) throw new Error('Refresh Steam trade eligibility before delivery');
    if (!transfers.fresh(op.account_id,'steam-trade-offers',now)) throw new Error('Refresh Steam trade offers before delivery');
    const block = marketplaceBlock(db,op.account_id,op.local_id!,'transfer',now,op.id);
    if (block) throw new Error(block);
    if (new TradeStore(db).committedTradeAssets(op.account_id,COMMITTING_STATUSES).some(a => a.asset_id === op.asset_id)) throw new Error('Item is committed to another Steam offer');
  }

  private matchesOffer(op: CsfloatOperation, offerId: string): boolean {
    const transfers = new TransferStore(this.context.database), give = transfers.offerLines(op.account_id,offerId,'GIVE'), receive = transfers.offerLines(op.account_id,offerId,'RECEIVE');
    return give.length === 1 && receive.length === 0 && give[0]!.asset_id === op.asset_id && give[0]!.quantity === 1 && give[0]!.app_id === 730 && give[0]!.context_id === '2';
  }
  private findAction(op: CsfloatOperation, kind: string): ActionRow | undefined {
    return this.context.database.raw().prepare('SELECT * FROM action WHERE account_id=? AND kind=? AND resource_key=? ORDER BY created_at DESC LIMIT 1')
      .get(op.account_id,kind,`csfloat-delivery:${op.id}:${kind}`) as ActionRow | undefined;
  }
  /**
   * The seller's explicit decision that this sale cannot be delivered (CSF-SEND-05).
   *
   * Nothing else issues it: not a refresh, not a classified Steam send failure, not a lapsed
   * deadline. It is refused while an outgoing Steam offer for the unit is still live, because
   * CSFloat refunding a buyer who could still accept the offer would hand the item over for
   * nothing. A venue rejection leaves the delivery exactly where it was.
   */
  async cannotDeliver(id: string): Promise<void> {
    const initial = this.store.operation(id);
    if (!initial || initial.kind !== 'DELIVER') throw new Error('Unknown CSFloat delivery');
    await this.context.locks.run(initial.account_id,async () => {
      const db = this.context.database, op = this.store.operation(id)!;
      if (['DONE','CANCELLED'].includes(op.state)) throw new Error('This delivery has already ended');
      const connection = new MarketplaceStore(db).connection(op.account_id,'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || connection.status !== 'CONNECTED' || connection.generation !== op.generation || !ports) throw new Error('Reconnect the original CSFloat account before continuing delivery');
      const trade = await this.services.trades.syncTrade(op.account_id,op.trade_id!);
      if (!trade || trade.sellerSteamId !== db.account(op.account_id)?.steam_id64 || trade.listingId !== op.listing_id) throw new Error('Refresh the exact seller trade before proceeding');
      if (!['queued','pending'].includes(trade.state)) throw new Error(`CSFloat trade is already ${trade.state}`);
      const live = op.offer_id ? new TransferStore(db).offer(op.account_id,op.offer_id) : undefined;
      if (live && (COMMITTING_STATUSES as readonly string[]).includes(live.status)) throw new Error(`Cancel Steam offer ${op.offer_id} before declaring this sale undeliverable`);
      const action = this.action(op,'CSFLOAT_CANNOT_DELIVER',true);
      if (action.state !== 'READY') return;
      await this.attempt(op,action,() => ports.trades.cannotDeliver(op.account_id,connection.credential_ref!,trade.tradeId),() => {
        if (new MarketplaceStore(db).connection(op.account_id,'csfloat')?.generation !== op.generation) throw new Error('CSFloat connection changed');
      });
    });
  }

  private action(op: CsfloatOperation, kind: string, retryFailed = false): ActionRow {
    // A rejected notification or cannot-deliver may be attempted afresh; a rejected Steam send
    // may not, because whether the item can be sent at all is the user's call (CSF-SEND-05).
    const existing = this.findAction(op,kind); if (existing && !(retryFailed && existing.state === 'FAILED')) return existing;
    return this.context.database.transaction(() => {
      const db = this.context.database, now = this.context.now();
      const desired = db.upsertDesired({ accountId: op.account_id,targetKind: 'csfloat-delivery',targetId: `${op.id}:${kind}`,intent: kind,params: { tradeId: op.trade_id },basis: 'manual',now });
      const action = db.enqueueAction({ accountId: op.account_id,desiredId: desired.id,desiredVersion: desired.version,actionKind: kind,targetId: op.local_id!,
        resourceKey: `csfloat-delivery:${op.id}:${kind}`,params: { operationId: op.id, tradeId: op.trade_id,assetId: op.asset_id },now });
      db.raw().prepare('UPDATE csfloat_operation SET action_id=? WHERE id=?').run(action.id,op.id);
      return action;
    });
  }
  private async attempt(op: CsfloatOperation, action: ActionRow, call: () => Promise<MutationOutcome>, validate: () => void): Promise<void> {
    const outcome = await executeMutation(this.context,action,call,validate);
    this.store.update(op.id,outcome.kind === 'DEFINITIVELY_REJECTED' ? 'BLOCKED' : 'AWAITING_OBSERVATION',this.context.now(),outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
  }
}
