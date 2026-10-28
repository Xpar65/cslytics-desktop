import type { CsfloatTrade, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, ObservationRow } from '../db/database.js';
import type { WorkStepState } from '../db/alphabets.js';
import {
  CSFLOAT_DELIVER, CsfloatStore, csfloatDeliveryView, type CsfloatDeliveryHop, type CsfloatDeliveryStepParams, type CsfloatDeliveryView
} from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { TransferStore } from '../db/transfers.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { executeBatchMutation, executeMutation, type EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, postAttempt, surfaceEvidence } from '../kernel/evidence.js';
import { settleNotApplied } from '../kernel/not-applied.js';
import type { RetryPlan, RetryPolicy } from '../kernel/retry-policy.js';
import { marketplaceBlock } from '../kernel/marketplace-commitments.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { TradeService } from '../surfaces/trades.js';
import { COMMITTING_STATUSES } from '../policy/trade-status.js';
import { TradeStore } from '../db/trades.js';
import type { Reading } from './reads.js';
import type { Settling } from './settle.js';
import { CSFLOAT_DELIVERY_EVIDENCE } from '../policy/csfloat-selling.js';

export type CsfloatDeliveryServices = {
  trades: CsfloatTradeService; steamTrades: TradeService;
  /** The read broker, for the offer book. The one trade is the surface's own read (`CsfloatTradeService.syncTrade`). */
  reads: Reading;
  settle: Settling;
};

/** Where each hop of a delivery sits in the chain. The order is the venue's, not a plan's. */
const HOP_ORDINAL: Record<CsfloatDeliveryHop, number> = { CSFLOAT_ACCEPT: 0, CSFLOAT_SEND: 1, CSFLOAT_NOTIFY: 2, CSFLOAT_CANNOT_DELIVER: 3 };

/** The reason prefix of an accept refused because CSFloat refused its whole bulk call: it is tried again on its own (CSF-SEND-10). */
export const BULK_ACCEPT_REFUSED = 'bulk accept refused';

/**
 * How long after a send's attempt finished an offers walk must have begun before showing no offer for
 * the sale proves Steam made none (delivery retries plan D5). No capture has measured how soon a new
 * offer shows in `GetTradeOffers`; retries are a minute apart, so the grace costs nothing.
 */
export const SEND_ABSENCE_GRACE_MS = 30_000;

/**
 * The hops a press proves rather than the loop: the trade read every press makes shows an accept
 * still `queued`, and the offers walk the send demands shows no offer for the sale. They have rows
 * in `RETRY_POLICY` and no proof owner; a unit test holds the sets together.
 */
export const PRESS_PROVED_KINDS: readonly CsfloatDeliveryHop[] = ['CSFLOAT_ACCEPT', 'CSFLOAT_SEND'];

/** The id of one hop of a delivery, beside its command id. */
export function deliveryHopId(commandId: string, hop: CsfloatDeliveryHop): string {
  return `${commandId}:${hop}`;
}

/**
 * The text CSFloat's own extension puts on a delivery offer, which buyers know a CSFloat delivery by:
 * `CSFloat Trade Offer Ref #<trade id>` for one sale, and `… and N other items` when the offer carries N
 * more. The trade named is the lowest id, numeric ids compared as numbers (CSFloat's ids are 19 digits).
 */
export function csfloatOfferMessage(tradeIds: readonly string[]): string {
  if (tradeIds.length === 0) throw new Error('An offer message names at least one CSFloat trade');
  const ordered = [...tradeIds].sort(compareTradeIds);
  return `CSFloat Trade Offer Ref #${ordered[0]}${ordered.length > 1 ? ` and ${ordered.length - 1} other items` : ''}`;
}

/** CSFloat trade ids in the venue's order: numeric ids by value, before any other, which sort as text. */
export function compareTradeIds(a: string, b: string): number {
  const numeric = /^\d+$/;
  const an = numeric.test(a), bn = numeric.test(b);
  if (an && bn) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
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

  /**
   * The evidence an accept or a nudge is judged on, read only where it has aged past its trust
   * window and then settled. Every delivery of the account shares the walks: forty sales nudged in
   * a row cost one walk of each book, not forty (CSF-SEND-07).
   */
  async readEvidence(accountId: string): Promise<void> {
    await this.services.reads.ensureFresh(accountId, CSFLOAT_DELIVERY_EVIDENCE, 'person');
    await this.services.settle.settled(accountId);
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

  /**
   * Accepts the queued sales of these deliveries in one CSFloat call (`POST /trades/bulk/accept`), each delivery
   * judged and given its attempt as a single accept would be (CSF-SEND-10). A delivery whose trade is not queued, or
   * a batch of one, is left to `advance`. A call CSFloat refuses whole (one buyer backing out refuses every id) is
   * recorded as `BULK_ACCEPT_REFUSED`, and the next `advance` of each sale tries it again on its own. Answers the
   * deliveries the call carried.
   */
  async acceptQueued(accountId: string, ids: readonly string[]): Promise<Set<string>> {
    const carried = new Set<string>();
    await this.context.locks.run(accountId,async () => {
      const db = this.context.database, now = () => this.context.now();
      const batch: Array<{ id: string; accept: WorkStepRow; action: ActionRow; tradeId: string; validate: () => void }> = [];
      let credential: string | null = null;
      for (const id of ids) {
        try {
          const loaded = await this.load(id);
          if (!loaded || loaded.trade.state !== 'queued' || loaded.first.account_id !== accountId) continue;
          const { first, params, trade, connection } = loaded;
          this.validateOwnership(first,params,trade);
          const accept = this.hop(id,accountId,first.local_id!,'CSFLOAT_ACCEPT',params,now());
          const prior = accept.action_id ? db.action(accept.action_id) : undefined;
          // A wait CSFloat named has not passed: nothing is sent for the sale.
          if (this.venueWaitStands(prior)) continue;
          // A sale a refused batch carried goes the single way next, so a refusal that persists cannot refuse the rest again.
          if (prior?.state === 'FAILED' && (prior.error ?? '').startsWith(BULK_ACCEPT_REFUSED)) continue;
          // The trade read this press made still shows the sale queued: an accept whose answer was lost did not land (D4).
          const tradeObs = db.observation(accountId,this.store.trade(accountId,params.tradeId)!.observation_id)!;
          if (prior && this.provedAbsent(accept,prior,tradeObs,'CSFloat still shows the sale queued')?.kind === 'exhausted') continue;
          const action = this.hopAction(accept,params,false);
          if (action.state !== 'READY') continue;
          credential = connection.credential_ref!;
          batch.push({ id, accept, action, tradeId: trade.tradeId, validate: () => this.validateOwnership(first,params,trade) });
        } catch (error) {
          this.block(id, error instanceof Error ? error.message : 'Delivery needs attention');
        }
      }
      const ports = this.context.ports.csfloat;
      if (batch.length < 2 || !credential || !ports) return;
      const byAction = new Map(batch.map(entry => [entry.action.id, entry]));
      const answers = await executeBatchMutation(this.context,batch.map(({ action, validate }) => ({ action, validate })),async (actions) => {
        const byTrade = await ports.trades.acceptMany(accountId,credential!,actions.map(action => byAction.get(action.id)!.tradeId));
        const outcomes = actions.map(action => [action.id, byTrade[byAction.get(action.id)!.tradeId]] as const);
        // One refusal for every id is CSFloat refusing the call, not each sale: each is tried again on its own.
        const whole = actions.length > 1 && outcomes.every(([, outcome]) => outcome?.kind === 'DEFINITIVELY_REJECTED');
        const answered = new Map<string, MutationOutcome>();
        for (const [actionId, outcome] of outcomes) {
          if (!outcome) continue;
          answered.set(actionId, whole && outcome.kind === 'DEFINITIVELY_REJECTED' ? { ...outcome, reason: `${BULK_ACCEPT_REFUSED}: ${outcome.reason}` } : outcome);
        }
        return answered;
      });
      for (const [actionId, answer] of answers) {
        const entry = byAction.get(actionId)!;
        if (answer instanceof Error) { this.block(entry.id, answer.message); continue; }
        carried.add(entry.id);
        this.work.setState(entry.accept.id,this.stepStateFor(answer),now(),answer.kind === 'DEFINITIVELY_REJECTED' ? answer.reason : null);
      }
    });
    return carried;
  }

  /** The delivery and the one fresh read of its trade, or nothing for a delivery whose every hop has settled on an ended sale. */
  private async load(id: string) {
    const db = this.context.database;
    const first = this.work.steps(id)[0];
    if (!first) return null;
    const params = this.paramsOf(first), accountId = first.account_id;
    const view = this.view(id)!;
    // Ended at the venue is not ended here until every hop says so: a sale CSFloat refunded on its
    // own while the offer waited left its hops open for good, and the panel hides a failed sale's work.
    if (['DONE','CANCELLED'].includes(view.state) && this.work.steps(id).every(isSettled)) return null;
    const connection = new MarketplaceStore(db).connection(accountId,'csfloat'), ports = this.context.ports.csfloat;
    if (!connection?.credential_ref || connection.status !== 'CONNECTED' || connection.generation !== params.generation || !ports) throw new Error('Reconnect the original CSFloat account before continuing delivery');
    const trade = await this.services.trades.syncTrade(accountId,params.tradeId);
    if (!trade || trade.sellerSteamId !== db.account(accountId)?.steam_id64 || trade.listingId !== params.listingId || trade.listing.item.assetId !== params.assetId) throw new Error('Refresh the exact seller trade before proceeding');
    return { first, params, connection, ports, trade };
  }

  private async step(id: string): Promise<void> {
    const db = this.context.database, now = () => this.context.now();
    const loaded = await this.load(id);
    if (!loaded) return;
    const { first, params, connection, ports, trade } = loaded;
    const accountId = first.account_id, localId = first.local_id!;
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
          if (!step || isSettled(step)) continue;
          // The sale's end is what this trade read shows, and an attempt still waiting on it waits on nothing now.
          const action = step.action_id ? db.action(step.action_id) : undefined;
          if (action && ['READY','RUNNING','AWAITING_OBSERVATION'].includes(action.state)) db.setActionState(action.id,'FAILED',now(),`CSFloat trade ${trade.state}`);
          this.work.settle(step.id,'STOPPED',obs.id,now(),`CSFloat trade ${trade.state}`);
        }
      });
      return;
    }
    if (trade.state === 'queued') {
      this.validateOwnership(first,params,trade);
      const accept = this.hop(id,accountId,localId,'CSFLOAT_ACCEPT',params,now());
      const prior = accept.action_id ? db.action(accept.action_id) : undefined;
      // A wait CSFloat named (a 429, read from its rate headers) has not passed: nothing is sent.
      if (this.venueWaitStands(prior)) return;
      // The trade read this press made, complete and begun after the attempt finished, still shows the sale queued: an
      // accept whose answer was lost did not land, and the same action takes its next attempt (D4). On the press that
      // sent it the read came first, so nothing is doubled.
      if (prior && this.provedAbsent(accept,prior,obs,'CSFloat still shows the sale queued')?.kind === 'exhausted') return;
      // A sale whose bulk accept CSFloat refused whole is tried again on its own (CSF-SEND-10).
      const action = this.hopAction(accept,params,prior?.state === 'FAILED' && (prior.error ?? '').startsWith(BULK_ACCEPT_REFUSED));
      if (action.state === 'READY') await this.attempt(accept,action,() => ports.trades.accept(accountId,connection.credential_ref!,trade.tradeId),() => this.validateOwnership(first,params,trade));
      return;
    }
    if (trade.state !== 'pending') throw new Error(`CSFloat trade state ${trade.state} needs review`);
    // Accepted, by this app or outside it: an accept hop of ours is proved by this read.
    const accept = hop('CSFLOAT_ACCEPT');
    if (accept && !isSettled(accept)) db.transaction(() => { resolveOpen(accept,true); this.work.settle(accept.id,'DONE',obs.id,now()); });
    let send = hop('CSFLOAT_SEND');
    let sendAction = send?.action_id ? db.action(send.action_id) : undefined;
    // A wait the venue named has not passed: Steam's cap on outstanding offers (5 to one buyer, 30 in all) refuses the
    // moment, not the item, and clears as buyers take their offers (CSF-SEND-09). Nothing is judged or sent until then.
    if (this.venueWaitStands(sendAction)) return;
    if (send && sendAction && ['AWAITING_OBSERVATION','DONE'].includes(sendAction.state)) {
      // Any offers walk begun after the send proves it, so one walk after the last send serves every sale sent before it.
      const sentAt = db.latestAttempt(sendAction.id)?.started_at ?? now();
      await this.services.reads.need(accountId, { ref: { surface: 'steam-trade-offers', scope: { kind: 'account' } }, startedAfter: sentAt, priority: 'work' });
      const offerObs = new TransferStore(db).fresh(accountId,'steam-trade-offers',now());
      if (!offerObs || !postAttempt(db,sendAction,offerObs,false)) { this.work.update(send.id,{ state: 'AWAITING_OBSERVATION', reason: 'Waiting for a complete Steam offer observation' },now()); return; }
      const matching = this.offersOfSale(send,sendAction,params,trade.buyerSteamId,offerObs.id);
      if (matching.length > 1) { this.work.update(send.id,{ state: 'AWAITING_OBSERVATION', reason: 'More than one Steam offer matches this sale; review before anything is sent again' },now()); return; }
      if (matching.length === 0) {
        // No offer for the sale on a walk begun after the send. An offer this delivery once owned that the walk no longer
        // shows, or a walk that may have begun during the call, proves nothing, and the hop waits. A complete walk begun
        // after the attempt finished proves Steam made no offer: the one retry rule 1 permits (D5).
        if (sendAction.state !== 'AWAITING_OBSERVATION' || !this.sendProvedAbsent(sendAction,offerObs)) {
          this.work.update(send.id,{ state: 'AWAITING_OBSERVATION', reason: 'Send outcome is unresolved; no second offer will be sent' },now());
          return;
        }
        if (this.provedAbsent(send,sendAction,offerObs,'Steam shows no offer for this sale')?.kind !== 'again') return;
        send = this.work.step(send.id)!;
        sendAction = db.action(sendAction.id);
      } else {
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
        return;
      }
    }
    // Nothing on Steam for the sale: the first send, a send a walk proved absent (`READY` again, `OBSERVED_NOT_APPLIED`),
    // or one Steam refused for the moment whose wait has passed. The hop is opened before its checks, so a check that
    // refuses leaves it open with the reason. Opened after them, a refusal left an accepted sale with every hop settled:
    // no offer, nothing open, and nothing that would press it again (CSF-SEND-08; a day's sales that way, 2026-10-25).
    const resend = sendAction?.state === 'READY' && sendAction.resolution === 'OBSERVED_NOT_APPLIED', waitOver = this.venueWaitOver(sendAction);
    if (!send || resend || waitOver || (send.state === 'QUEUED' && (!sendAction || sendAction.state === 'READY'))) {
      send = this.hop(id,accountId,localId,'CSFLOAT_SEND',params,now());
      this.validateOwnership(first,params,trade);
      if (!trade.tradeToken) throw new Error('CSFloat has not provided a valid buyer trade token');
      const session = await this.context.ports.auth.status(accountId);
      if (session.kind !== 'authenticated' || session.steamId64 !== trade.sellerSteamId) throw new Error('Sign in to the seller Steam account');
      const hold = await this.context.ports.trade.getHoldDurations(accountId,trade.buyerSteamId,trade.tradeToken);
      if (hold.mySeconds !== 0 || hold.theirSeconds !== 0) throw new Error('A Steam trade hold prevents delivery');
      const action = this.hopAction(send,params,false);
      await this.attempt(send,action,() => this.context.ports.trade.sendOffer(accountId,{ partnerSteamId64: trade.buyerSteamId,
        token: trade.tradeToken!, message: this.offerMessage(trade.tradeId), give: [{ appId: 730,contextId: '2',assetId: params.assetId,quantity: 1 }] }),() => this.validateOwnership(first,params,trade));
      this.noteNamedOffer(send,action);
      return;
    }
    // A Steam send refused with no wait is never retried on its own: whether the item can be sent
    // at all is the user's call (CSF-SEND-05). A send the table ran out of keeps its proof as the reason.
    if (send.state === 'FAILED' || sendAction?.state === 'FAILED') {
      throw new Error(sendAction?.resolution === 'OBSERVED_NOT_APPLIED' ? sendAction.error ?? 'Steam shows no offer for this sale' : 'Steam rejected this send; review the sale before another action');
    }
    if (!sendAction) throw new Error('The send has no action; review the sale');
    throw new Error(`The send is ${sendAction.state.toLowerCase()}; review the sale`);
  }

  /**
   * The sent offers a walk shows for this sale: to its buyer, giving its item and nothing else, and known by
   * the id the send's answer named or by CSFloat's own offer text (CSF-SEND-11). Both are read, so an offer a
   * lost answer never named is found by its text, and one the answer did name is found whatever its text.
   */
  private offersOfSale(send: WorkStepRow, action: ActionRow, params: CsfloatDeliveryStepParams, buyerSteamId: string, observationId: number): Array<{ offer_id: string; state_code: number }> {
    const db = this.context.database, raw = new TransferStore(db).attemptResponse(action.id), message = this.offerMessage(params.tradeId);
    const hintedId = send.offer_id ?? (typeof raw['tradeofferid'] === 'string' ? raw['tradeofferid'] : null);
    const offers = db.raw().prepare(`SELECT offer_id,state_code,message FROM trade_offer WHERE account_id=? AND direction='SENT'
      AND counterparty_steam_id64=? AND last_seen_obs=?`).all(send.account_id,buyerSteamId,observationId) as Array<{ offer_id: string; state_code: number; message: string | null }>;
    return offers.filter(o => (o.offer_id === hintedId || o.message === message) && this.matchesOffer(send.account_id,params.assetId,o.offer_id));
  }

  /**
   * Whether a complete offers walk proves a send made no offer: begun after the attempt finished (`postAttempt`,
   * absence) and by at least the grace, because no capture has measured how soon a new offer shows in the walk
   * (D5). Isolated so a saboteur can take a walk begun during the send as proof.
   */
  protected sendProvedAbsent(action: ActionRow, obs: ObservationRow): boolean {
    const db = this.context.database, finished = db.latestAttempt(action.id)?.finished_at;
    return Boolean(finished) && postAttempt(db,action,obs,true) && Date.parse(obs.started_at) - Date.parse(finished!) >= SEND_ABSENCE_GRACE_MS;
  }

  /**
   * Settles a hop's attempt a complete observation begun after it proved not applied, the one way
   * (`settleNotApplied`): the action is `READY` again for the table's next send, or failed with the proof
   * and the count once the table is spent, and the hop reads the same. A send's stale offer id goes with
   * it: the next attempt's answer names its own. Answers nothing for an attempt the observation cannot judge.
   */
  private provedAbsent(step: WorkStepRow, action: ActionRow, obs: ObservationRow, what: string): RetryPlan | null {
    if (action.state !== 'AWAITING_OBSERVATION' || !postAttempt(this.context.database,action,obs,true)) return null;
    const policy = this.retryPolicy(action.kind), now = this.context.now();
    const plan = settleNotApplied(this.context,action,obs.id,what,policy ? { policy } : {});
    this.work.mirror(action.id,now);
    if (this.work.step(step.id)?.state === 'RETRYING') this.work.update(step.id,{ reason: what, ...(step.kind === 'CSFLOAT_SEND' ? { offer_id: null } : {}) },now);
    return plan;
  }

  /** The table's row for the hop's kind, when a saboteur has its own; the table is the policy otherwise. */
  protected retryPolicy(_kind: string): RetryPolicy | undefined {
    return undefined;
  }

  /** When the venue that refused the hop's action says the same request may go again; null unless it failed with a wait. */
  private venueRetryAt(action: ActionRow | undefined): string | null {
    return action?.state === 'FAILED' ? this.context.database.latestAttempt(action.id)?.retry_after ?? null : null;
  }

  private venueWaitStands(action: ActionRow | undefined): boolean {
    const at = this.venueRetryAt(action);
    return at !== null && at > this.context.now();
  }

  private venueWaitOver(action: ActionRow | undefined): boolean {
    const at = this.venueRetryAt(action);
    return at !== null && at <= this.context.now();
  }

  /** The hop's state after an answer: a refusal of the moment waits for the instant the venue named; any other refusal fails it. */
  private stepStateFor(outcome: MutationOutcome): WorkStepState {
    if (outcome.kind !== 'DEFINITIVELY_REJECTED') return 'AWAITING_OBSERVATION';
    return outcome.retryAfterMs === undefined ? 'FAILED' : 'RETRYING';
  }

  /**
   * Keeps the offer id the send's answer named on the hop, as the id the offers walk must show (the
   * next pass still proves it, by that id and the item, before anything trusts it). A delivery only
   * moves when someone presses it, so until this the hop learned its offer only on that next press,
   * and the walk in between showed an offer at Steam state 9 that no command owned: unconfirmed by
   * the engine's own confirmations and unclaimed in `waiting.open` (strategy authority and
   * confirmations plan D8, D13). Isolated so a saboteur can wait for the press as before.
   */
  protected noteNamedOffer(send: WorkStepRow, action: ActionRow): void {
    const named = new TransferStore(this.context.database).attemptResponse(action.id)['tradeofferid'];
    if (typeof named === 'string' && named && this.work.step(send.id)?.offer_id === null) this.work.update(send.id,{ offer_id: named },this.context.now());
  }

  /** The text the sale's offer carries: CSFloat's own (CSF-SEND-11), and the one a lost answer is found by. Isolated so a saboteur can sign it otherwise. */
  protected offerMessage(tradeId: string): string {
    return csfloatOfferMessage([tradeId]);
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
   * cannot-deliver may be attempted afresh, under a new action on the same hop, and so may any hop
   * the venue refused for the moment once the wait it named has passed (D1); a Steam send refused
   * with no wait may not, because whether the item can be sent at all is the user's call (CSF-SEND-05).
   */
  private hopAction(step: WorkStepRow, params: CsfloatDeliveryStepParams, retryFailed: boolean): ActionRow {
    const db = this.context.database;
    const existing = step.action_id ? db.action(step.action_id) : undefined;
    if (existing && !(existing.state === 'FAILED' && (retryFailed || this.venueWaitOver(existing)))) return existing;
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
    this.work.setState(step.id,this.stepStateFor(outcome),this.context.now(),outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
  }
}
