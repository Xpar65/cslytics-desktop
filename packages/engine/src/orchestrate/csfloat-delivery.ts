import type { CsfloatTrade, MutationOutcome } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import {
  CSFLOAT_DELIVER, CsfloatStore, csfloatDeliveryView, type CsfloatDeliveryHop, type CsfloatDeliveryStepParams, type CsfloatDeliveryView
} from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { TransferStore } from '../db/transfers.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { executeMutation, type EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, postAttempt, surfaceEvidence } from '../kernel/evidence.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { TradeService } from '../surfaces/trades.js';
import { COMMITTING_STATUSES } from '../policy/trade-status.js';
import { TradeStore } from '../db/trades.js';
import type { Reading } from './reads.js';

export type CsfloatDeliveryServices = {
  trades: CsfloatTradeService; steamTrades: TradeService;
  /** The read broker, for the offer book. The one trade is the surface's own read (`CsfloatTradeService.syncTrade`). */
  reads: Reading;
};

/** Where each hop of a delivery sits in the chain. The order is the venue's, not a plan's. */
const HOP_ORDINAL: Record<CsfloatDeliveryHop, number> = { CSFLOAT_ACCEPT: 0, CSFLOAT_SEND: 1, CSFLOAT_NOTIFY: 2, CSFLOAT_CANNOT_DELIVER: 3 };

/** The id of one hop of a delivery, beside its command id. */
export function deliveryHopId(commandId: string, hop: CsfloatDeliveryHop): string {
  return `${commandId}:${hop}`;
}

/**
 * A sale to a CSFloat buyer, delivered hop by hop (consolidation plan D2).
 *
 * Only a user's Accept and send command creates a delivery; reads cannot create one. Its hops
 * are appended as the venue's own trade state calls for them: an accept only while the trade is
 * `queued`, then the Steam send, then telling CSFloat the offer id, and the seller's decision
 * that the sale cannot be delivered as a hop of its own, whenever they make it. The send hop stays
 * open from the moment the offer is on Steam until CSFloat has verified the sale — that is the
 * delivery, and the offer's own state is what the person sees meanwhile (`csfloatDeliveryView`).
 */
export class CsfloatDeliveryService {
  protected readonly store: CsfloatStore;
  protected readonly work: WorkStore;
  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatDeliveryServices) {
    this.store = new CsfloatStore(context.database);
    this.work = new WorkStore(context.database);
  }

  queue(accountId: string, commandId: string, tradeId: string): CsfloatDeliveryView {
    const db = this.context.database;
    return db.transaction(() => {
      if (db.command(commandId)) {
        const previous = this.view(commandId);
        if (!previous || previous.account_id !== accountId || previous.trade_id !== tradeId) throw new Error('Command id already used');
        return previous;
      }
      const existing = db.raw().prepare(`SELECT s.command_id AS commandId FROM work_step s JOIN command c ON c.id=s.command_id
        WHERE s.account_id=? AND c.kind=? AND s.target_id=? ORDER BY s.created_at LIMIT 1`).get(accountId,CSFLOAT_DELIVER,tradeId) as { commandId: string } | undefined;
      if (existing) return this.view(existing.commandId)!;
      const row = this.store.trade(accountId,tradeId), connection = new MarketplaceStore(db).connection(accountId,'csfloat');
      if (!row || row.seller_steam_id !== db.account(accountId)?.steam_id64 || !['queued','pending'].includes(row.state_word)) throw new Error('Refresh this seller trade first');
      if (!connection?.credential_ref || connection.status !== 'CONNECTED') throw new Error('Connect CSFloat first');
      const obs = db.observation(accountId,row.observation_id), age = obs ? Date.parse(this.context.now())-Date.parse(obs.started_at) : NaN;
      if (!obs?.complete || obs.generation !== connection.generation || !(age >= 0 && age <= 300_000) || !row.local_id) throw new Error('Trade identity or observation is not current');
      const now = this.context.now();
      const params: CsfloatDeliveryStepParams = { operationId: commandId, tradeId, listingId: row.listing_id, assetId: row.asset_id,
        generation: connection.generation, policyVersion: this.store.policy().version };
      this.work.adoptCommand(commandId, CSFLOAT_DELIVER, now);
      // The first hop the trade's state calls for; the rest follow as the venue reaches them.
      this.hop(commandId, accountId, row.local_id, row.state_word === 'queued' ? 'CSFLOAT_ACCEPT' : 'CSFLOAT_SEND', params, now);
      return this.view(commandId)!;
    });
  }

  /** The delivery as one thing, in the words the work panel speaks. */
  view(commandId: string): CsfloatDeliveryView | undefined {
    return csfloatDeliveryView(this.context.database, commandId);
  }

  async advance(id: string): Promise<void> {
    const initial = this.view(id);
    if (!initial) throw new Error('Unknown CSFloat delivery');
    await this.context.locks.run(initial.account_id,async () => {
      try { await this.step(id); }
      catch (error) { this.block(id, error instanceof Error ? error.message : 'Delivery needs attention'); }
    });
  }

  /**
   * Why the delivery is not moving, on the hop it stopped at: the latest open hop, else the hop
   * that failed. A queued hop with a reason reads as blocked until the next user-driven pass
   * clears it.
   */
  private block(id: string, reason: string): void {
    const steps = [...this.work.steps(id)].reverse();
    const target = steps.find(step => !isSettled(step)) ?? steps.find(step => step.state === 'FAILED');
    const now = this.context.now();
    if (target) this.work.update(target.id, { reason }, now);
    else if (steps[0]) this.context.database.addEvent(steps[0].account_id,'csfloat-delivery-blocked',{ operationId: id, reason },now);
  }

  private async step(id: string): Promise<void> {
    const db = this.context.database, now = () => this.context.now();
    const first = this.work.steps(id)[0];
    if (!first) return;
    const params = this.paramsOf(first), accountId = first.account_id, localId = first.local_id!;
    const view = this.view(id)!;
    if (['DONE','CANCELLED'].includes(view.state)) return;
    const connection = new MarketplaceStore(db).connection(accountId,'csfloat'), ports = this.context.ports.csfloat;
    if (!connection?.credential_ref || connection.status !== 'CONNECTED' || connection.generation !== params.generation || !ports) throw new Error('Reconnect the original CSFloat account before continuing delivery');
    const trade = await this.services.trades.syncTrade(accountId,params.tradeId);
    if (!trade || trade.sellerSteamId !== db.account(accountId)?.steam_id64 || trade.listingId !== params.listingId || trade.listing.item.assetId !== params.assetId) throw new Error('Refresh the exact seller trade before proceeding');
    const row = this.store.trade(accountId,params.tradeId)!, obs = db.observation(accountId,row.observation_id)!;
    const hop = (kind: CsfloatDeliveryHop) => this.work.step(deliveryHopId(id,kind));
    const resolveOpen = (step: WorkStepRow | undefined, applied: boolean): void => {
      const action = step?.action_id ? db.action(step.action_id) : undefined;
      if (action?.state === 'AWAITING_OBSERVATION' && postAttempt(db,action,obs,!applied)) db.resolveAction(action,obs.id,applied,now());
    };
    if (trade.state === 'verified') {
      db.transaction(() => {
        for (const kind of ['CSFLOAT_ACCEPT','CSFLOAT_SEND','CSFLOAT_NOTIFY'] as const) {
          const step = hop(kind);
          if (!step || isSettled(step)) continue;
          resolveOpen(step,true);
          this.work.settle(step.id,'DONE',obs.id,now());
        }
      });
      return;
    }
    if (['failed','cancelled'].includes(trade.state)) {
      db.transaction(() => {
        const decision = hop('CSFLOAT_CANNOT_DELIVER');
        if (decision && !isSettled(decision)) { resolveOpen(decision,true); this.work.settle(decision.id,'DONE',obs.id,now()); }
        for (const kind of ['CSFLOAT_ACCEPT','CSFLOAT_SEND','CSFLOAT_NOTIFY'] as const) {
          const step = hop(kind);
          if (step && !isSettled(step)) this.work.settle(step.id,'STOPPED',obs.id,now(),`CSFloat trade ${trade.state}`);
        }
      });
      return;
    }
    if (trade.state === 'queued') {
      this.validateOwnership(first,params,trade);
      const accept = this.hop(id,accountId,localId,'CSFLOAT_ACCEPT',params,now());
      const action = this.hopAction(accept,params,false);
      if (action.state === 'READY') await this.attempt(accept,action,() => ports.trades.accept(accountId,connection.credential_ref!,trade.tradeId),() => this.validateOwnership(first,params,trade));
      return;
    }
    if (trade.state !== 'pending') throw new Error(`CSFloat trade state ${trade.state} needs review`);
    // Accepted, by this app or outside it: an accept hop of ours is proved by this read.
    const accept = hop('CSFLOAT_ACCEPT');
    if (accept && !isSettled(accept)) db.transaction(() => { resolveOpen(accept,true); this.work.settle(accept.id,'DONE',obs.id,now()); });
    let send = hop('CSFLOAT_SEND');
    const sendAction = send?.action_id ? db.action(send.action_id) : undefined;
    if (!send || (send.state === 'QUEUED' && (!sendAction || sendAction.state === 'READY'))) {
      this.validateOwnership(first,params,trade);
      if (!trade.tradeToken) throw new Error('CSFloat has not provided a valid buyer trade token');
      const session = await this.context.ports.auth.status(accountId);
      if (session.kind !== 'authenticated' || session.steamId64 !== trade.sellerSteamId) throw new Error('Sign in to the seller Steam account');
      const hold = await this.context.ports.trade.getHoldDurations(accountId,trade.buyerSteamId,trade.tradeToken);
      if (hold.mySeconds !== 0 || hold.theirSeconds !== 0) throw new Error('A Steam trade hold prevents delivery');
      send = this.hop(id,accountId,localId,'CSFLOAT_SEND',params,now());
      const action = this.hopAction(send,params,false);
      await this.attempt(send,action,() => this.context.ports.trade.sendOffer(accountId,{ partnerSteamId64: trade.buyerSteamId,
        token: trade.tradeToken!, message: `CSlytics delivery ${id}`, give: [{ appId: 730,contextId: '2',assetId: params.assetId,quantity: 1 }] }),() => this.validateOwnership(first,params,trade));
      return;
    }
    // A rejected Steam send is never retried on its own: whether the item can be sent at all is
    // the user's call (CSF-SEND-05).
    if (send.state === 'FAILED' || sendAction?.state === 'FAILED') throw new Error('Steam rejected this send; review the sale before another action');
    if (!sendAction) throw new Error('The send has no action; review the sale');
    await this.services.reads.need(accountId, { ref: { surface: 'steam-trade-offers', scope: { kind: 'account' } }, startedAfter: now(), priority: 'work' });
    const transfers = new TransferStore(db), offerObs = transfers.fresh(accountId,'steam-trade-offers',now());
    if (!offerObs || !postAttempt(db,sendAction,offerObs,false)) { this.work.update(send.id,{ state: 'AWAITING_OBSERVATION', reason: 'Waiting for a complete Steam offer observation' },now()); return; }
    const raw = transfers.attemptResponse(sendAction.id);
    const hintedId = send.offer_id ?? (typeof raw['tradeofferid'] === 'string' ? raw['tradeofferid'] : null);
    const offers = db.raw().prepare(`SELECT offer_id,state_code,message,last_seen_obs FROM trade_offer WHERE account_id=? AND direction='SENT'
      AND counterparty_steam_id64=? AND last_seen_obs=?`).all(accountId,trade.buyerSteamId,offerObs.id) as Array<{ offer_id: string; state_code: number; message: string | null; last_seen_obs: number }>;
    const matching = offers.filter(o => (hintedId ? o.offer_id === hintedId : o.message === `CSlytics delivery ${id}`) && this.matchesOffer(accountId,params.assetId,o.offer_id));
    if (matching.length !== 1) { this.work.update(send.id,{ state: 'AWAITING_OBSERVATION', reason: 'Send outcome is unresolved; no second offer will be sent' },now()); return; }
    const offer = matching[0]!;
    if (![2,3,9,11].includes(offer.state_code)) throw new Error(`Steam offer ended in state ${offer.state_code}; review CSFloat delivery`);
    if (sendAction.state !== 'DONE') db.resolveAction(sendAction,offerObs.id,true,now());
    // The offer is on Steam. The hop stays open until CSFloat verifies the sale; what Steam waits
    // for meanwhile is read from the offer, and a phone tap is the one thing said here.
    this.work.update(send.id,{ offer_id: offer.offer_id, state: 'AWAITING_OBSERVATION',
      reason: offer.state_code === 9 ? 'Confirm the outgoing offer in the Steam mobile app' : null },now());
    const notify = hop('CSFLOAT_NOTIFY');
    if (trade.offerId !== offer.offer_id) {
      // The offer is on Steam, so the only hop left to retry is telling CSFloat about it
      // (CSF-SEND-03). An ambiguous notification is retried once a trade read that started after
      // the attempt finished still shows no offer; a rejected one gets a fresh attempt on the next
      // user-driven pass. Neither path ever sends the offer again.
      resolveOpen(notify,false);
      const step = this.hop(id,accountId,localId,'CSFLOAT_NOTIFY',params,now());
      const action = this.hopAction(step,params,true);
      if (action.state === 'READY') await this.attempt(step,action,() => ports.trades.notifyOffer(accountId,connection.credential_ref!,offer.offer_id,[params.assetId]),() => {
        if (!this.matchesOffer(accountId,params.assetId,offer.offer_id)) throw new Error('Steam offer changed before CSFloat notification');
      });
      return;
    }
    if (notify && !isSettled(notify)) db.transaction(() => { resolveOpen(notify,true); this.work.settle(notify.id,'DONE',obs.id,now()); });
  }

  protected validateOwnership(first: WorkStepRow, params: CsfloatDeliveryStepParams, trade: CsfloatTrade): void {
    const db = this.context.database, now = this.context.now(), accountId = first.account_id, localId = first.local_id!;
    const connection = new MarketplaceStore(db).connection(accountId,'csfloat');
    if (connection?.generation !== params.generation || connection.status !== 'CONNECTED') throw new Error('CSFloat connection changed');
    if (trade.state === 'pending' && (!trade.deadlineAt || trade.deadlineAt <= now)) throw new Error('The CSFloat send deadline is missing or has elapsed');
    if (this.store.associate(accountId,trade.listing.item) !== localId) throw new Error('Delivery item identity is unresolved');
    const item = db.itemByLocalId(accountId,localId);
    if (!item || item.location !== 'MAIN' || item.asset_id !== params.assetId) throw new Error('Delivery item is not in main inventory');
    if (surfaceEvidence(db,accountId,ACCOUNT_INVENTORY,this.context.ports.clock.now()).grade !== 'SATISFIED') throw new Error('Refresh Steam inventory before delivery');
    for (const until of [item.tradable_after,item.trade_protected_until]) if (until && until > now) throw new Error('Delivery item is trade locked or protected');
    const transfers = new TransferStore(db), eligible = new AssetEvidenceStore(db).community(accountId,params.assetId), obs = transfers.fresh(accountId,'steam-trade-inventory',now);
    if (!eligible || eligible.tradable !== 1 || eligible.last_seen_obs !== obs?.id) throw new Error('Refresh Steam trade eligibility before delivery');
    if (!transfers.fresh(accountId,'steam-trade-offers',now)) throw new Error('Refresh Steam trade offers before delivery');
    const block = marketplaceBlock(db,accountId,localId,'transfer',now,first.command_id);
    if (block) throw new Error(block);
    if (new TradeStore(db).committedTradeAssets(accountId,COMMITTING_STATUSES).some(a => a.asset_id === params.assetId)) throw new Error('Item is committed to another Steam offer');
  }

  private matchesOffer(accountId: string, assetId: string, offerId: string): boolean {
    const transfers = new TransferStore(this.context.database), give = transfers.offerLines(accountId,offerId,'GIVE'), receive = transfers.offerLines(accountId,offerId,'RECEIVE');
    return give.length === 1 && receive.length === 0 && give[0]!.asset_id === assetId && give[0]!.quantity === 1 && give[0]!.app_id === 730 && give[0]!.context_id === '2';
  }

  protected paramsOf(step: WorkStepRow): CsfloatDeliveryStepParams {
    return this.work.params<CsfloatDeliveryStepParams>(step);
  }

  /** The hop of this kind, appended if the delivery has not reached it before. */
  private hop(commandId: string, accountId: string, localId: string, kind: CsfloatDeliveryHop, params: CsfloatDeliveryStepParams, now: string): WorkStepRow {
    return this.work.step(deliveryHopId(commandId,kind))
      ?? this.work.insert({ id: deliveryHopId(commandId,kind), commandId, accountId, ordinal: HOP_ORDINAL[kind], kind, localId, targetId: params.tradeId, params, now });
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
    const initial = this.view(id);
    if (!initial) throw new Error('Unknown CSFloat delivery');
    await this.context.locks.run(initial.account_id,async () => {
      const db = this.context.database, view = this.view(id)!, first = this.work.steps(id)[0]!, params = this.paramsOf(first);
      const accountId = first.account_id;
      if (['DONE','CANCELLED'].includes(view.state)) throw new Error('This delivery has already ended');
      const connection = new MarketplaceStore(db).connection(accountId,'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || connection.status !== 'CONNECTED' || connection.generation !== params.generation || !ports) throw new Error('Reconnect the original CSFloat account before continuing delivery');
      const trade = await this.services.trades.syncTrade(accountId,params.tradeId);
      if (!trade || trade.sellerSteamId !== db.account(accountId)?.steam_id64 || trade.listingId !== params.listingId) throw new Error('Refresh the exact seller trade before proceeding');
      if (!['queued','pending'].includes(trade.state)) throw new Error(`CSFloat trade is already ${trade.state}`);
      const send = this.work.step(deliveryHopId(id,'CSFLOAT_SEND'));
      const live = send?.offer_id ? new TransferStore(db).offer(accountId,send.offer_id) : undefined;
      if (live && (COMMITTING_STATUSES as readonly string[]).includes(live.status)) throw new Error(`Cancel Steam offer ${send!.offer_id} before declaring this sale undeliverable`);
      const decision = this.hop(id,accountId,first.local_id!,'CSFLOAT_CANNOT_DELIVER',params,this.context.now());
      const action = this.hopAction(decision,params,true);
      if (action.state !== 'READY') return;
      await this.attempt(decision,action,() => ports.trades.cannotDeliver(accountId,connection.credential_ref!,trade.tradeId),() => {
        if (new MarketplaceStore(db).connection(accountId,'csfloat')?.generation !== params.generation) throw new Error('CSFloat connection changed');
      });
    });
  }

  /**
   * The action that carries a hop, made when the hop is first reached. A rejected notification or
   * cannot-deliver may be attempted afresh, under a new action on the same hop; a rejected Steam
   * send may not, because whether the item can be sent at all is the user's call (CSF-SEND-05).
   */
  private hopAction(step: WorkStepRow, params: CsfloatDeliveryStepParams, retryFailed: boolean): ActionRow {
    const db = this.context.database;
    const existing = step.action_id ? db.action(step.action_id) : undefined;
    if (existing && !(retryFailed && existing.state === 'FAILED')) return existing;
    return db.transaction(() => {
      const now = this.context.now();
      const action = db.enqueueAction({ accountId: step.account_id, stepId: step.id, actionKind: step.kind, targetId: step.local_id!,
        resourceKey: `csfloat-delivery:${step.command_id}:${step.kind}`, params: { operationId: step.command_id, tradeId: params.tradeId, assetId: params.assetId }, now });
      this.work.update(step.id,{ action_id: action.id, state: 'QUEUED', reason: null },now);
      return action;
    });
  }

  private async attempt(step: WorkStepRow, action: ActionRow, call: () => Promise<MutationOutcome>, validate: () => void): Promise<void> {
    const outcome = await executeMutation(this.context,action,call,validate);
    this.work.setState(step.id,outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION',this.context.now(),outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
  }
}
