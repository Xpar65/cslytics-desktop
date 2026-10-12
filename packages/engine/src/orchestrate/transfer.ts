import { randomUUID } from 'node:crypto';
import type { EngineContext } from '../kernel/context.js';
import type { ActionRow } from '../db/database.js';
import { TransferStore, assetsOf, finished, retrieveActionIdsOf, type TransferAsset, type TransferBatch, type TransferMember, type ObservedOffer } from '../db/transfers.js';
import { TransferPlanner, type TransferRequest } from '../policy/transfer-planner.js';
import type { TradeService } from '../surfaces/trades.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { StorageService } from '../surfaces/storage.js';
import { locationEvidence } from '../kernel/evidence.js';
import { AccountLock } from '../kernel/support.js';
import type { Settling } from './settle.js';
import type { Observe } from './refresh.js';

export type TransferServices = {
  planner: TransferPlanner; trades: TradeService; inventory: InventoryService; storage: StorageService;
  /** Settles on the caller's stack when a decision follows the driver's own read. */
  settle: Settling;
  /** The governed read (`RefreshService.observe`): the budget, the breaker, then the settle. */
  observe: Observe;
};

/**
 * One durable source batch per command. Only observations can advance it past a mutation.
 *
 * A batch that holds crated items starts as `RETRIEVING`: each item's `RETRIEVE_FROM_CASKET`
 * action is sent, the storage reconciler resolves it against a later complete walk, and the send
 * goes only once every hop is proved in main inventory and the Community walk has been read again
 * for the account (that surface is read on demand, never on a cadence). A refused hop fails the
 * whole batch — one source is one offer — and leaves whatever was already retrieved in main
 * inventory, exactly as the casket chain does across a crash. Other sources are untouched.
 */
export class TransferService {
  private readonly store: TransferStore;
  private readonly scheduled = new Set<string>();
  private readonly batchesLock = new AccountLock();
  private stopped = false;
  constructor(protected readonly context: EngineContext, protected readonly services: TransferServices) {
    this.store = new TransferStore(context.database);
  }

  plan(destination: string, members: readonly TransferMember[]) { return this.services.planner.plan(destination,members); }

  /** Read preparation is explicitly account scoped; tokens never cross the IPC boundary. */
  async refresh(destination: string, sources: readonly string[]): Promise<void> {
    const ids = [...new Set([destination,...sources])];
    if (ids.length < 2 || ids.length > 32 || this.context.database.knownAccountIds(ids).length !== ids.length) throw new Error('Choose owned transfer accounts');
    await this.services.trades.syncTradeLink(destination);
    for (const accountId of ids) {
      if (this.context.ports.gc.connectionStatus(accountId).state !== 'CONNECTED') await this.services.inventory.connectGc(accountId,30_000);
      // Inventory and offers through the read budget (plan D4); eligibility, hold and link are
      // admitted inside `TradeService` itself.
      await this.services.observe(accountId, { surface: 'gc-inventory', scope: { kind: 'account' } });
      await this.services.observe(accountId, { surface: 'steam-trade-offers', scope: { kind: 'account' } });
      if (accountId !== destination) {
        await this.services.trades.syncEligibility(accountId);
        await this.services.trades.syncHold(accountId,destination);
      }
    }
    await this.advance();
  }

  async submit(request: TransferRequest) {
    const db = this.context.database;
    // No await inside this admission transaction: two sources targeting the same remaining
    // slot see the first command's durable quantity before either reaches the network.
    db.transaction(() => {
      const prior = db.command(request.commandId);
      if (prior) {
        const previous = this.store.batches(request.commandId);
        if (prior.kind !== 'ACCOUNT_TRANSFER' || previous.some(b => b.destination_account_id !== request.destinationAccountId)) throw new Error('Command identity already used');
        return;
      }
      const plan = this.services.planner.plan(request.destinationAccountId,request.members);
      if (plan.blocked.length) throw new Error(plan.blocked.map(b => `${b.accountId}: ${b.reason}`).join('; '));
      const now = this.context.now();
      db.insertCommand({ id: request.commandId, correlation_id: randomUUID(), kind: 'ACCOUNT_TRANSFER', state: 'ADMITTED',
        reject_reason: null, created_at: now, preparing: 0, manifest_token: null, observed_completed: 0 });
      const baseline = JSON.stringify(this.store.assetBaseline(request.destinationAccountId));
      for (const group of plan.groups) {
        const goal = db.upsertDesired({ accountId: group.accountId, targetKind: 'transfer', targetId: request.commandId,
          intent: 'TRANSFER_TO', params: { destinationAccountId: request.destinationAccountId }, basis: 'manual', now });
        const action = db.enqueueAction({ accountId: group.accountId, desiredId: goal.id, desiredVersion: goal.version,
          actionKind: 'trade.send', targetId: request.commandId, resourceKey: `transfer:${request.commandId}`,
          params: { destinationAccountId: request.destinationAccountId, message: `CSlytics transfer ${request.commandId}`, give: group.assets }, now });
        // One retrieve hop per crated asset, queued through the storage surface so it carries the
        // same preconditions, slot reservation and reconciliation as any other casket move. The
        // basis names this command: it is what lets the hop past the batch's own pledge
        // (`kernel/context.ts`), and nothing else.
        const retrieves = group.assets.filter(asset => asset.pendingRetrieval).map(asset => {
          const retrieve = this.services.storage.queueRetrieve(group.accountId,asset.localId,asset.casketId!,`transfer:${request.commandId}`);
          db.reserveMainSlot(group.accountId,retrieve.id);
          return retrieve.id;
        });
        db.raw().prepare(`INSERT INTO transfer_batch(command_id,account_id,destination_account_id,send_action_id,state,reason,assets_json,destination_baseline_json,retrieve_action_ids_json)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(request.commandId,group.accountId,request.destinationAccountId,action.id,
            retrieves.length ? 'RETRIEVING' : 'READY',retrieves.length ? `Retrieving ${retrieves.length} from storage before sending` : null,
            JSON.stringify(group.assets),baseline,JSON.stringify(retrieves));
        for (const asset of group.assets) db.insertCommandMember({ command_id: request.commandId, account_id: group.accountId,
          member_id: asset.localId, stack_key: null, quantity: asset.quantity, destination: request.destinationAccountId,
          price_receive_cents: null, state: 'READY', action_id: action.id, input_json: JSON.stringify(asset) });
      }
    });
    await this.advance(request.commandId);
    return db.command(request.commandId)!;
  }

  /** Signals only schedule work, outside the emitting transaction and call stack. */
  schedule(accountId: string): void {
    if (this.stopped || this.scheduled.has(accountId)) return;
    this.scheduled.add(accountId);
    setImmediate(() => {
      this.scheduled.delete(accountId);
      if (this.stopped) return;
      void this.advance(undefined,accountId).catch(() => { /* Persisted batch retains its evidence and can be re-observed. */ });
    });
  }
  stop(): void { this.stopped = true; }

  async advance(commandId?: string, accountId?: string): Promise<void> {
    const batches = this.store.batches(commandId).filter(b => !finished(b) && (!accountId || b.account_id === accountId || b.destination_account_id === accountId));
    await Promise.all(batches.map(batch => this.batchesLock.run(`${batch.account_id}:${batch.command_id}`, async () => {
      const current = this.store.batches(batch.command_id).find(b => b.account_id === batch.account_id)!;
      if (finished(current)) return;
      try { await this.advanceBatch(current); }
      catch (error) { this.store.update(current,{ reason: error instanceof Error ? error.message : 'Transfer needs review' }); }
      this.store.progress(batch.command_id);
    })));
  }

  protected async advanceBatch(batch: TransferBatch): Promise<void> {
    const db = this.context.database;
    const action = db.action(batch.send_action_id)!;
    if (action.state === 'READY') {
      if (!(await this.advanceRetrievals(batch))) return;
      if (batch.state === 'RETRIEVING') {
        this.store.update(batch,{ state: 'READY', reason: 'Retrieved; sending' });
        batch = { ...batch, state: 'READY' };
      }
      if (this.needsEligibility(batch)) await this.services.trades.syncEligibility(batch.account_id);
      const validate = () => this.validateSend(batch);
      validate();
      const outcome = await this.context.locks.run(batch.account_id,() => this.services.trades.sendOffer(action,validate));
      this.store.update(batch,{ state: outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION',
        reason: outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : outcome.kind === 'AMBIGUOUS' ? 'Send outcome unknown; observe before taking further action' : 'Waiting for Steam to show the offer' });
      if (outcome.kind === 'DEFINITIVELY_REJECTED') return;
    }
    if (db.action(batch.send_action_id)?.state === 'FAILED') { this.store.update(batch,{state:'FAILED',reason:action.error}); return; }
    const offer = this.correlatedOffer(batch);
    if (!offer) return; // U6 is unclosed: even an empty complete walk NEVER enables a retry.
    const offerObs = db.observation(batch.account_id,offer.last_seen_obs)!;
    const attempted = db.latestAttempt(batch.send_action_id);
    if (!attempted || offerObs.started_at < attempted.started_at) return;
    if (action.state !== 'DONE') db.resolveAction(db.action(action.id)!,offer.last_seen_obs,true,this.context.now());
    this.store.update(batch,{ offer_id: offer.offer_id });
    batch = { ...batch, offer_id: offer.offer_id };
    if ([1,4,5,6,7,8,10].includes(offer.raw_state)) {
      this.store.update(batch,{state:'ENDED',reason:`Offer ${offer.status.toLowerCase()}`});
      if (batch.cancel_action_id && offer.raw_state === 6) db.resolveAction(db.action(batch.cancel_action_id)!,offer.last_seen_obs,true,this.context.now());
      return;
    }
    if (batch.cancel_action_id && [2,9].includes(offer.raw_state)) {
      const cancel = db.action(batch.cancel_action_id)!;
      if (cancel.state === 'READY') await this.context.locks.run(batch.account_id,() => this.dispatchCancel(batch,cancel));
      return;
    }
    if (offer.raw_state === 9) { this.store.update(batch,{state:'NEEDS_CONFIRMATION',reason:'Confirm this offer on the sender’s phone'}); return; }
    if (offer.raw_state === 11) { this.store.update(batch,{state:'ESCROW',reason:`Steam is holding the trade${offer.escrow_until ? ` until ${offer.escrow_until}` : ''}`}); return; }
    if (offer.raw_state === 3) {
      if (!batch.accepted_at) {
        this.store.update(batch,{accepted_at:offerObs.finished_at,accepted_obs:offerObs.id});
        batch = { ...batch, accepted_at:offerObs.finished_at,accepted_obs:offerObs.id };
      }
      this.store.update(batch,{state:'AWAITING_DELIVERY',reason:'Waiting for complete inventories on both accounts'});
      if (batch.accept_action_id) {
        const accepted = this.store.offer(batch.destination_account_id,offer.offer_id);
        if (accepted?.raw_state === 3) db.resolveAction(db.action(batch.accept_action_id)!,accepted.last_seen_obs,true,this.context.now());
      }
      this.reconcileDelivery(batch,offer);
      return;
    }
    if (offer.raw_state !== 2) return;
    if (!this.mayAccept(batch,offer)) { this.store.update(batch,{state:'ACTIVE',reason:'Waiting for the destination to observe this exact offer'}); return; }
    // No source lock is held while acquiring the destination. Opposing transfers cannot
    // deadlock, and a slow source send cannot hold up another source's send to this account.
    await this.context.locks.run(batch.destination_account_id,async () => {
      const existing = batch.accept_action_id ? db.action(batch.accept_action_id)! : undefined;
      if (existing && existing.state !== 'READY') {
        const response = this.store.attemptResponse(existing.id);
        const confirmation = response.needs_mobile_confirmation === true || response.needs_mobile_app_confirmation === true || response.needs_email_confirmation === true;
        this.store.update(batch,{state:existing.state === 'FAILED' ? 'ACCEPT_BLOCKED' : confirmation ? 'ACCEPT_CONFIRMATION' : 'ACCEPTING',
          reason:existing.error ?? (confirmation ? 'Confirm acceptance on the destination account' : 'Waiting for acceptance to be observed')});
        return; // Recovered RUNNING and ambiguous acceptance are never retried.
      }
      const destinationSession = await this.context.ports.auth.status(batch.destination_account_id);
      const destinationIdentity = db.listAccounts().find(a=>a.id===batch.destination_account_id)!;
      if (destinationSession.kind !== 'authenticated' || destinationSession.steamId64 !== destinationIdentity.steam_id64) {
        this.store.update(batch,{state:'ACTIVE',reason:'Connect the destination account to accept this offer'});return;
      }
      const accept = existing ?? this.queueOfferAction(batch,'trade.accept',batch.destination_account_id,offer.offer_id);
      await this.services.trades.acceptOffer(accept,() => {
        const current = this.store.offer(batch.account_id,offer.offer_id);
        if (!current || current.raw_state !== 2 || !this.mayAccept(batch,current)) throw new Error('Offer changed before acceptance');
      });
    });
  }

  /**
   * The retrieval stage. True when there is nothing left to prove: every hop's action is `DONE`
   * and a fresh complete walk, started after that hop's attempt, shows its item in main
   * inventory. A `READY` hop is sent; anything in flight waits for the storage reconciler, which
   * is the only thing that resolves a casket move (rule 1). Isolated so a saboteur can skip the
   * observation gate.
   */
  protected async advanceRetrievals(batch: TransferBatch): Promise<boolean> {
    const db = this.context.database;
    const ids = retrieveActionIdsOf(batch);
    if (!ids.length) return true;
    // A casket move is resolved only by a settle, which follows every walk a turn later; an advance
    // woken by the walk itself settles now, as the casket chain's transit observation does.
    if (ids.some(id => db.action(id)?.state === 'AWAITING_OBSERVATION')) this.services.settle.settleNow(batch.account_id);
    for (const id of ids) {
      const retrieve = db.action(id);
      if (!retrieve) { this.failBeforeSend(batch,'Retrieve action is missing; review the transfer'); return false; }
      if (retrieve.state === 'FAILED') { this.failBeforeSend(batch,`Retrieve refused: ${retrieve.error ?? 'no reason given'}`); return false; }
      if (retrieve.state === 'READY') {
        const outcome = await this.context.locks.run(batch.account_id,() => this.services.storage.execute(retrieve.id));
        if (outcome.kind === 'DEFINITIVELY_REJECTED') { this.failBeforeSend(batch,`Retrieve refused: ${outcome.reason}`); return false; }
        db.markSlotSubmitted(batch.account_id,retrieve.id);
        this.store.update(batch,{ state: 'RETRIEVING', reason: 'Waiting for the retrieved item to be observed in main inventory' });
        return false;
      }
      if (retrieve.state !== 'DONE') {
        this.store.update(batch,{ state: 'RETRIEVING', reason: 'Waiting for the retrieved item to be observed in main inventory' });
        return false;
      }
      const evidence = locationEvidence(db,batch.account_id,retrieve.target_id,'MAIN',this.context.ports.clock.now(),retrieve);
      if (evidence.grade === 'SATISFIED') continue;
      this.store.update(batch,{ state: 'RETRIEVING',
        reason: evidence.grade === 'UNSATISFIED' ? evidence.reason : 'Waiting for a complete inventory observation of the retrieved item' });
      return false;
    }
    return true;
  }

  /**
   * A chained batch needs the Community walk read again after its retrievals: the walk that
   * admitted the batch could not show a crated item, and nothing reads that surface on a cadence.
   * One read per advance at most, and none once every asset is covered by the latest fresh walk.
   */
  protected needsEligibility(batch: TransferBatch): boolean {
    if (!retrieveActionIdsOf(batch).length) return false;
    const latest = this.store.fresh(batch.account_id,'steam-trade-inventory',this.context.now());
    return assetsOf(batch).some(asset => {
      const row = this.store.eligibility(batch.account_id,asset.assetId);
      return !row || !latest || row.observation_id !== latest.id;
    });
  }

  /** A batch that cannot reach its send: the send and every unsent hop are failed with the reason, and their slots released. */
  private failBeforeSend(batch: TransferBatch, reason: string): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      for (const id of retrieveActionIdsOf(batch)) {
        const retrieve = db.action(id);
        if (retrieve?.state === 'READY') { db.setActionState(retrieve.id,'FAILED',now,reason); db.releaseSlot(batch.account_id,retrieve.id,false); }
      }
      const send = db.action(batch.send_action_id);
      if (send && send.state === 'READY') db.setActionState(send.id,'FAILED',now,reason);
      this.store.update(batch,{ state: 'FAILED', reason });
    });
  }

  protected validateSend(batch: TransferBatch): void {
    const assets = assetsOf(batch);
    const plan = this.services.planner.plan(batch.destination_account_id,this.replanMembers(batch,assets),batch.command_id);
    if (plan.blocked.length) throw new Error(plan.blocked.map(b => b.reason).join('; '));
    // The re-plan admits a crated item as a hop, as admission did; dispatch never sends one.
    if (plan.groups.some(g => g.assets.some(a => a.pendingRetrieval))) throw new Error('Retrieve the item before sending');
    const expected = assets.map(a => `${a.assetId}:${a.quantity}`).sort().join('|');
    const actual = plan.groups.flatMap(g => g.assets).map(a => `${a.assetId}:${a.quantity}`).sort().join('|');
    if (expected !== actual) throw new Error('Selected assets changed; review the transfer');
  }

  /**
   * What the send re-plans. A unit of one is re-planned as the very unit admitted, a case as much
   * as a skin: re-planning a case by its group could pick a different case than the one the person
   * chose, and `validateSend` would then refuse a send nothing had changed (TRD-EX-21). Only a unit
   * holding several is re-planned by group and quantity, collapsed per group (TRD-EX-15).
   */
  protected replanMembers(batch: TransferBatch, assets: readonly TransferAsset[]): TransferMember[] {
    const merged = new Map<string,TransferMember>();
    for (const asset of assets) {
      const groupKey = asset.unitKind === 'fungible' && asset.sourceQuantity > 1
        ? this.context.database.itemByAssetId(batch.account_id,asset.assetId)?.group_key ?? ''
        : null;
      const member: TransferMember = groupKey === null
        ? { accountId:batch.account_id,localId:asset.localId }
        : { accountId:batch.account_id,stackKey:groupKey,quantity:asset.quantity };
      const key = member.localId ?? member.stackKey!;
      const previous = merged.get(key);
      merged.set(key, previous ? { ...member,quantity:(previous.quantity ?? 1)+(member.quantity ?? 1) } : member);
    }
    return [...merged.values()];
  }

  protected correlatedOffer(batch: TransferBatch): ObservedOffer | undefined {
    const response = this.store.attemptResponse(batch.send_action_id);
    const knownId = batch.offer_id ?? (typeof response.tradeofferid === 'string' ? response.tradeofferid : null);
    const partner = this.context.database.listAccounts().find(a => a.id === batch.destination_account_id)!;
    const candidates = knownId ? [this.store.offer(batch.account_id,knownId)].filter((v): v is ObservedOffer => !!v)
      : this.context.database.raw().prepare('SELECT * FROM trade_offer WHERE account_id=? AND message=?').all(batch.account_id,`CSlytics transfer ${batch.command_id}`) as ObservedOffer[];
    const matching = candidates.filter(offer => offer.direction === 'SENT' && offer.counterparty_id === account32(partner.steam_id64)
      && this.linesMatch(batch,offer.account_id,offer.offer_id,'GIVE',Boolean(knownId) && offer.raw_state === 8)
      && !this.store.offerLines(offer.account_id,offer.offer_id,'RECEIVE').length);
    return matching.length === 1 ? matching[0] : undefined;
  }

  protected mayAccept(batch: TransferBatch, offer: ObservedOffer): boolean {
    if (!batch.offer_id || offer.offer_id !== batch.offer_id || !this.context.database.latestAttempt(batch.send_action_id)) return false;
    const source = this.context.database.listAccounts().find(a => a.id === batch.account_id);
    const dest = this.context.database.listAccounts().find(a => a.id === batch.destination_account_id);
    const incoming = this.store.offer(batch.destination_account_id,offer.offer_id);
    if (!source || !dest || !incoming || incoming.direction !== 'RECEIVED' || incoming.counterparty_id !== account32(source.steam_id64) || incoming.raw_state !== 2) return false;
    const sourceObs = this.store.fresh(batch.account_id,'steam-trade-offers',this.context.now());
    const destObs = this.store.fresh(batch.destination_account_id,'steam-trade-offers',this.context.now());
    if (!sourceObs || !destObs || sourceObs.id !== offer.last_seen_obs || destObs.id !== incoming.last_seen_obs) return false;
    return this.store.offerLines(batch.destination_account_id,offer.offer_id,'GIVE').length === 0 && this.linesMatch(batch,batch.destination_account_id,offer.offer_id,'RECEIVE');
  }

  private linesMatch(batch: TransferBatch, accountId: string, offerId: string, side: 'GIVE' | 'RECEIVE', allowMissing = false): boolean {
    const lines = this.store.offerLines(accountId,offerId,side), expected = assetsOf(batch);
    return lines.length === expected.length && new Set(lines.map(line=>line.asset_id)).size === expected.length
      && lines.every(line => line.app_id === 730 && line.context_id === '2' && (allowMissing || JSON.parse(line.attributes_json).missing !== true)
      && expected.some(a => a.assetId === line.asset_id && a.quantity === line.quantity));
  }

  protected reconcileDelivery(batch: TransferBatch, offer: ObservedOffer): void {
    const db = this.context.database;
    const source = this.store.fresh(batch.account_id,'gc-inventory',this.context.now());
    const destination = this.store.fresh(batch.destination_account_id,'gc-inventory',this.context.now());
    if (!source || !destination || !batch.accepted_at || source.id <= (batch.accepted_obs ?? 0) || destination.id <= (batch.accepted_obs ?? 0)
      || source.started_at <= batch.accepted_at || destination.started_at <= batch.accepted_at) return;
    const baseline = new Set(JSON.parse(batch.destination_baseline_json) as string[]);
    for (const asset of assetsOf(batch)) {
      const source = db.itemByAssetId(batch.account_id,asset.assetId);
      // A partial send of a stacked SO row leaves the row behind, lighter by what was sent.
      if (source && source.location !== 'MISSING' && (asset.unitKind !== 'fungible' || source.quantity > asset.sourceQuantity - asset.quantity)) return;
      // The receipt names the id the unit arrived under, for a case exactly as for a skin. A skin
      // with no receipt yet may still be recognised on the destination by its fingerprint; a case
      // cannot be, and waits (holdings plan D5).
      const line = offer.trade_id
        ? db.raw().prepare(`SELECT new_asset_id FROM trade_line WHERE account_id=? AND trade_id=? AND side='GIVE' AND asset_id=? AND new_asset_id IS NOT NULL`)
          .get(batch.account_id,offer.trade_id,asset.assetId) as { new_asset_id: string } | undefined
        : undefined;
      const received = line ? db.itemByAssetId(batch.destination_account_id,line.new_asset_id) : undefined;
      if (received) {
        if (received.location !== 'MAIN' || received.last_seen_obs !== destination.id || received.quantity < asset.quantity
          || received.def_index !== asset.defIndex || received.quality !== asset.quality || baseline.has(received.current_asset_id!) || received.current_asset_id === asset.assetId) return;
      } else if (asset.unitKind !== 'fungible' && asset.stableKey) {
        const candidates = db.items(batch.destination_account_id).filter(item => item.stable_key === asset.stableKey && item.location === 'MAIN'
          && item.current_asset_id && item.current_asset_id !== asset.assetId && !baseline.has(item.current_asset_id) && item.local_id !== asset.localId);
        if (candidates.length !== 1 || candidates[0]!.last_seen_obs !== destination.id) return;
      } else return;
    }
    db.transaction(()=>{
      this.store.update(batch,{state:'DONE',reason:null,completed_source_obs:source.id,completed_destination_obs:destination.id});
      if(offer.trade_id) for(const account of [batch.account_id,batch.destination_account_id]) this.services.trades.postObservedDelivery(account,offer.trade_id);
    });
  }

  async cancel(commandId: string, accountId: string): Promise<void> {
    const batch = this.store.batches(commandId).find(b => b.account_id === accountId);
    if (!batch) throw new Error('Unknown owned transfer');
    await this.batchesLock.run(`${batch.account_id}:${batch.command_id}`,async () => this.context.locks.run(accountId,async () => {
      const current = this.store.batches(commandId).find(b => b.account_id === accountId)!;
      if (finished(current) || current.cancel_action_id) return;
      const send = this.context.database.action(current.send_action_id)!;
      if (send.state === 'READY' && !this.context.database.latestAttempt(send.id)) {
        // Unsent hops stop with it; a hop already in flight is left to the storage reconciler,
        // because an ambiguous casket move is never re-sent and its item stays where it is observed.
        this.failBeforeSend(current,'Stopped before sending'); return;
      }
      const offer = this.correlatedOffer(current);
      if (!offer || ![2,9].includes(offer.raw_state)) throw new Error('Observe a live offer before cancelling');
      const action = this.queueOfferAction(current,'trade.cancel',accountId,offer.offer_id);
      await this.dispatchCancel(current,action);
    }));
    this.store.progress(commandId);
  }

  private queueOfferAction(batch: TransferBatch, kind: string, accountId: string, offerId: string): ActionRow {
    return this.context.database.transaction(() => {
      const now = this.context.now();
      const goal = this.context.database.upsertDesired({accountId,targetKind:kind,targetId:offerId,intent:kind,params:{},basis:'owned-transfer',now});
      const partner = this.context.database.listAccounts().find(a => a.id === batch.account_id)!;
      const action = this.context.database.enqueueAction({accountId,desiredId:goal.id,desiredVersion:goal.version,actionKind:kind,
        targetId:offerId,resourceKey:`${kind}:${offerId}`,params:{offerId,partnerSteamId64:partner.steam_id64},now});
      this.store.update(batch,kind === 'trade.accept' ? {accept_action_id:action.id,state:'ACCEPTING',reason:'Accepting on the destination account'}
        : {cancel_action_id:action.id,state:'CANCELLING',reason:'Waiting for cancellation to be observed'});
      return action;
    });
  }

  private async dispatchCancel(batch: TransferBatch, action: ActionRow): Promise<void> {
    const { offerId } = this.context.database.actionParams(action) as { offerId: string };
    const outcome = await this.services.trades.cancelOffer(action,() => {
      const fresh = this.store.offer(batch.account_id,offerId);
      if (!fresh || ![2,9].includes(fresh.raw_state)) throw new Error('Offer changed before cancellation');
    });
    if (outcome.kind === 'DEFINITIVELY_REJECTED') this.store.update(batch,{reason:'Cancellation refused; observing the offer',state:'CANCEL_BLOCKED'});
  }
}

function account32(steamId64: string): string { return (BigInt(steamId64) - 76561197960265728n).toString(); }
