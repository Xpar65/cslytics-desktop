import { randomUUID } from 'node:crypto';
import type { EngineContext } from '../kernel/context.js';
import type { ActionRow } from '../db/database.js';
import {
  ACCOUNT_TRANSFER, ENDED_OFFER_STATES, TransferStore, assetsOf, finished, transferHopId,
  type TransferAsset, type TransferBatch, type TransferMember, type ObservedOffer
} from '../db/transfers.js';
import { HOP_NOT_REACHED, WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { TransferPlanner, type TransferRequest } from '../policy/transfer-planner.js';
import type { TradeService } from '../surfaces/trades.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { StorageService } from '../surfaces/storage.js';
import { unrestrictedKey } from '../kernel/identity.js';
import { AccountLock } from '../kernel/support.js';
import type { Reading } from './reads.js';

/**
 * The command service, as the one driver of a chain's hops (cross-account transfer plan D-04): a
 * source's retrieves are its stage, dispatched once and continued by the walks that settle them.
 */
export type Driving = {
  /** Drives the command's open stage through its rounds, as a hand retrieve is driven; resolves when the pass ends. */
  dispatch(commandId: string): Promise<unknown>;
  /** The commands a dispatch is running for right now. */
  dispatching(): readonly string[];
};

export type TransferServices = {
  planner: TransferPlanner; trades: TradeService; inventory: InventoryService; storage: StorageService;
  /** The read broker: every read here is a need it answers. */
  reads: Reading;
  /** The one sequencer of casket moves: a crated member's retrieve is its hop, never this service's own loop. */
  commands: Driving;
};

/**
 * One offer per source account of a command, as hops (consolidation plan D2). Only observations
 * can advance a hop past a mutation.
 *
 * A source's hops are its crated items' retrieves, then the send, then — under the destination
 * account, which is the one that acts — the accept, and a cancel when the person asks for one.
 * The send hop is the transfer: it stays open from the offer being on Steam until both complete
 * Game Coordinator inventories prove the delivery, and what Steam waits for meanwhile (the phone,
 * the other account, escrow) is read from the offer. `TransferStore.batches` reads the hops back
 * as one thing, in the words the transfer always had.
 *
 * A source that holds crated items retrieves first. Each crated member's retrieve is its own hop
 * at ordinal 0, with the storage surface's admission and the same action a hand retrieve gets, and
 * `CommandService` drives them as it drives a listing's retrieves (plan D-04): one pass sends every
 * hop of the stage, a unit walk that has lapsed is read before anything is sent rather than
 * refused, the round is proved by its own reads, and a hop proved not applied goes again under its
 * retry row. This service only asks whether that stage is over: the send goes once every retrieve
 * hop is `DONE`, which only an observation writes, and the Community walk has been read again for
 * the account (that surface is read on demand, never on a cadence). A refused hop fails the whole
 * source — one source is one offer — and leaves whatever was already retrieved in main inventory,
 * exactly as the casket chain does across a crash. Other sources are untouched.
 *
 * Until 2026-10-30 this service ran the retrieves itself, one per wake, and a retrieve whose unit
 * walk had lapsed threw the read it was owed into a reason on the send hop, which the panel could
 * not show while a retrieve hop was open: six crated stickers sat "Queued" with nothing asking for
 * the walk, for ever.
 */
/** Offer states in which Steam lists the given items as `missing`: they left the sender. Accepted, invalid items, in escrow. */
const ITEMS_LEFT_STATES: readonly number[] = [3, 8, 11];

/** Where a source's retrieve stage is, as the send hop sees it. */
type RetrievalStage = { kind: 'proved' } | { kind: 'open' } | { kind: 'failed'; hop: WorkStepRow; reason: string };

export class TransferService {
  private readonly store: TransferStore;
  private readonly work: WorkStore;
  private readonly scheduled = new Set<string>();
  private readonly batchesLock = new AccountLock();
  private stopped = false;
  constructor(protected readonly context: EngineContext, protected readonly services: TransferServices) {
    this.store = new TransferStore(context.database);
    this.work = new WorkStore(context.database);
  }

  plan(destination: string, members: readonly TransferMember[]) { return this.services.planner.plan(destination,members); }

  /** Read preparation is explicitly account scoped; tokens never cross the IPC boundary. */
  async refresh(destination: string, sources: readonly string[]): Promise<void> {
    const ids = [...new Set([destination,...sources])];
    if (ids.length < 2 || ids.length > 32 || this.context.database.knownAccountIds(ids).length !== ids.length) throw new Error('Choose owned transfer accounts');
    await this.services.trades.syncTradeLink(destination);
    for (const accountId of ids) {
      if (this.context.ports.gc.connectionStatus(accountId).state !== 'CONNECTED') await this.services.inventory.connectGc(accountId,30_000);
      // The person's own reads: inventory, offers and the Community trade inventory as needs of the
      // broker; the hold and the link are the surface's own, under the venue's budget (plan D12).
      const startedAfter = this.context.now();
      const person = (surface: 'gc-inventory' | 'steam-trade-offers' | 'steam-trade-inventory') =>
        this.services.reads.need(accountId, { ref: { surface, scope: { kind: 'account' } }, startedAfter, priority: 'person' });
      await person('gc-inventory');
      await person('steam-trade-offers');
      if (accountId !== destination) {
        await person('steam-trade-inventory');
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
        if (prior.kind !== ACCOUNT_TRANSFER || previous.some(b => b.destination_account_id !== request.destinationAccountId)) throw new Error('Command identity already used');
        return;
      }
      const plan = this.services.planner.plan(request.destinationAccountId,request.members);
      if (plan.blocked.length) throw new Error(plan.blocked.map(b => `${b.accountId}: ${b.reason}`).join('; '));
      const now = this.context.now();
      db.insertCommand({ id: request.commandId, correlation_id: randomUUID(), kind: ACCOUNT_TRANSFER, state: 'ADMITTED',
        reject_reason: null, created_at: now, preparing: 0, manifest_token: null, observed_completed: 0 });
      const baseline = JSON.stringify(this.store.assetBaseline(request.destinationAccountId));
      for (const group of plan.groups) {
        const common = { commandId: request.commandId, accountId: group.accountId, now };
        // One retrieve hop per crated asset, each the first hop of its own member (ordinal 0), with
        // the storage surface's admission, slot reservation and reconciliation as any other casket
        // move; the command service drives the stage (D-04). The hop's command is what lets its
        // action past the command's own pledge (`kernel/context.ts`).
        for (const asset of group.assets.filter(candidate => candidate.pendingRetrieval)) {
          const hop = this.work.insert({ ...common, id: transferHopId(request.commandId, group.accountId, `retrieve:${asset.localId}`), ordinal: 0, kind: 'RETRIEVE',
            localId: asset.localId, params: { casketId: asset.casketId, assetId: asset.assetId, destinationAccountId: request.destinationAccountId } });
          const action = this.services.storage.queueRetrieveStep(group.accountId, asset.localId, asset.casketId!, hop.id);
          db.reserveMainSlot(group.accountId, action.id);
          this.work.attachAction(hop.id, action.id, now);
        }
        // The send is about the whole source and names no holding: it follows every retrieve.
        const send = this.work.insert({ ...common, id: transferHopId(request.commandId, group.accountId, 'send'), ordinal: 1, kind: 'SEND',
          params: { destinationAccountId: request.destinationAccountId } });
        const action = db.enqueueAction({ accountId: group.accountId, stepId: send.id,
          actionKind: 'trade.send', targetId: request.commandId, resourceKey: `transfer:${request.commandId}`,
          params: { destinationAccountId: request.destinationAccountId, message: `CSlytics transfer ${request.commandId}`, give: group.assets }, now });
        this.work.attachAction(send.id, action.id, now);
        this.work.insertTransferDetail({ step_id: send.id, account_id: group.accountId, destination_account_id: request.destinationAccountId,
          destination_baseline_json: baseline, accepted_at: null, accepted_obs: null, completed_source_obs: null, completed_destination_obs: null });
        for (const asset of group.assets) db.insertCommandMember({ command_id: request.commandId, account_id: group.accountId,
          local_id: asset.localId, stack_key: null, quantity: asset.quantity, destination: request.destinationAccountId,
          price_receive_cents: null, state: 'QUEUED', input_json: JSON.stringify(asset) });
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
      void this.advance(undefined,accountId).catch(() => { /* The hops keep their evidence and can be re-observed. */ });
    });
  }
  stop(): void { this.stopped = true; }

  async advance(commandId?: string, accountId?: string): Promise<void> {
    const batches = this.store.batches(commandId).filter(b => this.open(b) && (!accountId || b.account_id === accountId || b.destination_account_id === accountId));
    await Promise.all(batches.map(batch => this.batchesLock.run(`${batch.account_id}:${batch.command_id}`, async () => {
      const current = this.store.batch(batch.command_id, batch.account_id)!;
      if (!this.open(current)) return;
      try { await this.advanceBatch(current); }
      catch (error) { this.say(current, error instanceof Error ? error.message : 'Transfer needs review'); }
      this.store.progress(batch.command_id);
    })));
  }

  /**
   * Whether a source's transfer still has something for this service to do. Its words may already
   * say `FAILED` while its send hop is open: a retrieve the command service refused fails the source
   * the moment it is read, and the send, its pledge and the destination's room are still this
   * service's to let go (`failBeforeSend`).
   */
  private open(batch: TransferBatch): boolean {
    return !finished(batch) || !isSettled(this.sendHop(batch));
  }

  /** Why the transfer is not moving, on its send hop. */
  private say(batch: TransferBatch, reason: string | null): void {
    this.work.update(batch.send_step_id, { reason }, this.context.now());
  }

  protected async advanceBatch(batch: TransferBatch): Promise<void> {
    const db = this.context.database;
    const action = db.action(batch.send_action_id)!;
    if (action.state === 'READY') {
      const stage = this.retrievals(batch);
      if (stage.kind === 'failed') { this.failBeforeSend(batch, stage.reason, stage.hop); return; }
      if (stage.kind === 'open') { this.retrieve(batch); return; }
      if (this.needsEligibility(batch)) {
        await this.services.reads.need(batch.account_id, { ref: { surface: 'steam-trade-inventory', scope: { kind: 'account' } }, startedAfter: this.context.now(), priority: 'work' });
      }
      const validate = () => this.validateSend(batch);
      validate();
      const outcome = await this.context.locks.run(batch.account_id,() => this.services.trades.sendOffer(action,validate));
      if (outcome.kind === 'DEFINITIVELY_REJECTED') { this.work.failHop(this.sendHop(batch), outcome.reason, this.context.now()); return; }
      this.work.setState(batch.send_step_id, 'AWAITING_OBSERVATION', this.context.now(),
        outcome.kind === 'AMBIGUOUS' ? 'Send outcome unknown; observe before taking further action' : 'Waiting for Steam to show the offer');
    }
    if (db.action(batch.send_action_id)?.state === 'FAILED') { this.work.failHop(this.sendHop(batch), action.error ?? 'Send failed', this.context.now()); return; }
    const offer = this.correlatedOffer(batch);
    if (!offer) return; // U6 is unclosed: even an empty complete walk NEVER enables a retry.
    const offerObs = db.observation(batch.account_id,offer.last_seen_obs)!;
    const attempted = db.latestAttempt(batch.send_action_id);
    if (!attempted || offerObs.started_at < attempted.started_at) return;
    if (action.state !== 'DONE') db.resolveAction(db.action(action.id)!,offer.last_seen_obs,true,this.context.now());
    if (batch.offer_id !== offer.offer_id) this.work.update(batch.send_step_id, { offer_id: offer.offer_id }, this.context.now());
    batch = { ...batch, offer_id: offer.offer_id };
    if (ENDED_OFFER_STATES.includes(offer.state_code)) { this.endOffer(batch, offer); return; }
    const cancel = this.work.step(transferHopId(batch.command_id, batch.account_id, 'cancel'));
    if (cancel?.action_id && [2,9].includes(offer.state_code)) {
      const action = db.action(cancel.action_id)!;
      if (action.state === 'READY') await this.context.locks.run(batch.account_id,() => this.dispatchCancel(batch,cancel,action));
      return;
    }
    if (offer.state_code === 9) { this.say(batch, 'Confirm this offer on the sender’s phone'); return; }
    if (offer.state_code === 11) { this.say(batch, `Steam is holding the trade${offer.escrow_until ? ` until ${offer.escrow_until}` : ''}`); return; }
    if (offer.state_code === 3) {
      if (!batch.accepted_at) {
        this.work.updateTransferDetail(batch.send_step_id, { accepted_at: offerObs.finished_at, accepted_obs: offerObs.id });
        batch = { ...batch, accepted_at:offerObs.finished_at,accepted_obs:offerObs.id };
      }
      this.say(batch, 'Waiting for complete inventories on both accounts');
      const accept = this.work.step(transferHopId(batch.command_id, batch.account_id, 'accept'));
      if (accept?.action_id && !isSettled(accept)) {
        const accepted = this.store.offer(batch.destination_account_id,offer.offer_id);
        if (accepted?.state_code === 3) db.transaction(() => {
          const acceptAction = db.action(accept.action_id!)!;
          if (acceptAction.state !== 'DONE') db.resolveAction(acceptAction,accepted.last_seen_obs,true,this.context.now());
          this.work.settle(accept.id, 'DONE', accepted.last_seen_obs, this.context.now());
        });
      }
      this.reconcileDelivery(batch,offer);
      return;
    }
    if (offer.state_code !== 2) return;
    if (!this.mayAccept(batch,offer)) { this.say(batch, 'Waiting for the destination to observe this exact offer'); return; }
    this.say(batch, null);
    // No source lock is held while acquiring the destination. Opposing transfers cannot
    // deadlock, and a slow source send cannot hold up another source's send to this account.
    await this.context.locks.run(batch.destination_account_id,async () => {
      const accept = this.work.step(transferHopId(batch.command_id, batch.account_id, 'accept'));
      const existing = accept?.action_id ? db.action(accept.action_id)! : undefined;
      if (accept && existing && existing.state !== 'READY') {
        // Recovered RUNNING and ambiguous acceptance are never retried; the hop reflects the action.
        this.work.reflectAction(accept, this.context.now());
        return;
      }
      const destinationSession = await this.context.ports.auth.status(batch.destination_account_id);
      const destinationIdentity = db.listAccounts().find(a=>a.id===batch.destination_account_id)!;
      if (destinationSession.kind !== 'authenticated' || destinationSession.steamId64 !== destinationIdentity.steam_id64) {
        this.say(batch, 'Connect the destination account to accept this offer');return;
      }
      const hop = accept ?? this.hop(batch, 'accept', batch.destination_account_id, offer.offer_id);
      const action = existing ?? this.hopAction(batch, hop, 'trade.accept', offer.offer_id);
      const outcome = await this.services.trades.acceptOffer(action,() => {
        const current = this.store.offer(batch.account_id,offer.offer_id);
        if (!current || current.state_code !== 2 || !this.mayAccept(batch,current)) throw new Error('Offer changed before acceptance');
      });
      this.work.setState(hop.id, outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION', this.context.now(),
        outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
    });
  }

  /** The offer is over on Steam: the send hop with it, the person's cancel proved, the rest never reached. */
  private endOffer(batch: TransferBatch, offer: ObservedOffer): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      const cancel = this.work.step(transferHopId(batch.command_id, batch.account_id, 'cancel'));
      const ours = cancel?.action_id && offer.state_code === 6;
      if (ours) {
        const action = db.action(cancel.action_id!)!;
        if (action.state !== 'DONE') db.resolveAction(action,offer.last_seen_obs,true,now);
        this.work.settle(cancel.id, 'DONE', offer.last_seen_obs, now);
      }
      // Cancelled on the person's word is stopped; declined, expired or invalid is the transfer failing.
      this.work.settle(batch.send_step_id, ours ? 'STOPPED' : 'FAILED', offer.last_seen_obs, now, `Offer ${offer.status.toLowerCase()}`);
      const accept = this.work.step(transferHopId(batch.command_id, batch.account_id, 'accept'));
      if (accept && !isSettled(accept)) this.work.settle(accept.id, 'STOPPED', offer.last_seen_obs, now, `Offer ${offer.status.toLowerCase()}`);
      if (cancel && !isSettled(cancel) && !ours) this.work.settle(cancel.id, 'STOPPED', offer.last_seen_obs, now, `Offer ${offer.status.toLowerCase()}`);
    });
  }

  /**
   * The retrieve stage as the send sees it, from the hops alone: proved when every retrieve hop is
   * `DONE`, which only an observation writes (the storage reconciler's, on a walk or the item's own
   * event begun after the attempt); failed on the first hop that failed; open otherwise. A hop still
   * open is the command service's to move, never this service's. Isolated so a saboteur can take a
   * request that went out for the item having moved, or salvage the loose half of a failed source.
   */
  protected retrievals(batch: TransferBatch): RetrievalStage {
    const hops = this.retrieveHops(batch).map(hop => this.work.reflectAction(hop, this.context.now()));
    const failed = hops.find(hop => hop.state === 'FAILED');
    if (failed) return { kind: 'failed', hop: failed, reason: `Retrieve refused: ${failed.reason ?? 'no reason given'}` };
    return hops.every(hop => hop.state === 'DONE') ? { kind: 'proved' } : { kind: 'open' };
  }

  /**
   * Hands an open retrieve stage to the command service, once: its dispatch sends every hop of the
   * stage, asks for the reads the hops are judged on, proves the round and ends; the walks that
   * settle the hops wake this service through `wakeDrivers`, and so does the end of the dispatch.
   */
  private retrieve(batch: TransferBatch): void {
    if (this.services.commands.dispatching().includes(batch.command_id)) return;
    const wake = () => this.schedule(batch.account_id);
    void this.services.commands.dispatch(batch.command_id).then(wake, wake);
  }

  /**
   * A chained source needs the Community walk read again after its retrievals: the walk that
   * admitted the transfer could not show a crated item, and nothing reads that surface on a
   * cadence. One read per advance at most, and none once every asset is covered by the latest
   * fresh walk.
   */
  protected needsEligibility(batch: TransferBatch): boolean {
    if (!this.retrieveHops(batch).length) return false;
    const latest = this.store.fresh(batch.account_id,'steam-trade-inventory',this.context.now()), evidence = new AssetEvidenceStore(this.context.database);
    return assetsOf(batch).some(asset => {
      const row = evidence.community(batch.account_id,asset.assetId);
      return !row || !latest || row.last_seen_obs !== latest.id;
    });
  }

  /**
   * A source that cannot reach its send: the hop that stopped it is failed with the reason, the
   * hops after it are never reached, and every unsent retrieve's action is failed with its slot
   * released. Without a hop to blame, the send is the hop that failed.
   */
  private failBeforeSend(batch: TransferBatch, reason: string, hop?: WorkStepRow): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      for (const retrieve of this.retrieveHops(batch)) {
        const action = retrieve.action_id ? db.action(retrieve.action_id) : undefined;
        if (action?.state === 'READY') { db.setActionState(action.id,'FAILED',now,reason); db.releaseSlot(batch.account_id,action.id,false); }
      }
      const send = db.action(batch.send_action_id);
      if (send && send.state === 'READY') db.setActionState(send.id,'FAILED',now,reason);
      const sendHop = this.sendHop(batch);
      // The blamed hop may already carry its own failure, written by the service that sent it.
      if (!hop) this.work.failHop(sendHop, reason, now);
      else if (hop.state !== 'FAILED') this.work.failHop(hop, reason, now);
      // The send is about the whole source and names no item, so the member-scoped stop above
      // does not reach it; nor the other retrieves never sent.
      if (hop && !isSettled(this.work.step(sendHop.id)!)) this.work.settle(sendHop.id, 'STOPPED', null, now, HOP_NOT_REACHED);
      for (const retrieve of this.retrieveHops(batch)) {
        const action = retrieve.action_id ? db.action(retrieve.action_id) : undefined;
        if (retrieve.id !== hop?.id && !isSettled(retrieve) && action?.state === 'FAILED' && !db.latestAttempt(action.id)) this.work.settle(retrieve.id, 'STOPPED', null, now, HOP_NOT_REACHED);
      }
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

  /**
   * The offer this batch sent. Its id is known from the send's reply once there is one; the lines
   * must still be exactly the frozen assets. A line Steam marks `missing` has left the sender's
   * inventory, which an offer whose trade executed (accepted, or held in escrow) or whose items went
   * (invalid items) says of every line: the item is still the one sent. Before 2026-10-15 only the
   * last was allowed, so an accepted transfer stopped correlating the moment Steam marked its lines
   * missing, and sat "Accepted, waiting for both inventories" for ever (D-07, live).
   */
  protected correlatedOffer(batch: TransferBatch): ObservedOffer | undefined {
    const response = this.store.attemptResponse(batch.send_action_id);
    const knownId = batch.offer_id ?? (typeof response.tradeofferid === 'string' ? response.tradeofferid : null);
    const partner = this.context.database.listAccounts().find(a => a.id === batch.destination_account_id)!;
    const candidates = knownId ? [this.store.offer(batch.account_id,knownId)].filter((v): v is ObservedOffer => !!v)
      : this.context.database.raw().prepare('SELECT * FROM trade_offer WHERE account_id=? AND message=?').all(batch.account_id,`CSlytics transfer ${batch.command_id}`) as ObservedOffer[];
    const matching = candidates.filter(offer => offer.direction === 'SENT' && offer.counterparty_steam_id64 === partner.steam_id64
      && this.linesMatch(batch,offer.account_id,offer.offer_id,'GIVE',Boolean(knownId) && ITEMS_LEFT_STATES.includes(offer.state_code))
      && !this.store.offerLines(offer.account_id,offer.offer_id,'RECEIVE').length);
    return matching.length === 1 ? matching[0] : undefined;
  }

  protected mayAccept(batch: TransferBatch, offer: ObservedOffer): boolean {
    if (!batch.offer_id || offer.offer_id !== batch.offer_id || !this.context.database.latestAttempt(batch.send_action_id)) return false;
    const source = this.context.database.listAccounts().find(a => a.id === batch.account_id);
    const dest = this.context.database.listAccounts().find(a => a.id === batch.destination_account_id);
    const incoming = this.store.offer(batch.destination_account_id,offer.offer_id);
    if (!source || !dest || !incoming || incoming.direction !== 'RECEIVED' || incoming.counterparty_steam_id64 !== source.steam_id64 || incoming.state_code !== 2) return false;
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

  /**
   * Delivery, proved by both inventories (plan D-09): a complete walk of each account begun after
   * the acceptance was observed, the given units gone from the source, and each unit found on the
   * destination. A unit is found by the receipt — the id Steam says it arrived under — for either
   * kind; a skin with no receipt yet by its fingerprint (holdings plan D5); fungible units with no
   * receipt yet by count: units of their group, less its lock, that the destination did not hold at
   * admission and that the same walk shows, at least as many as were sent. Steam withholds the
   * receipt for the seven days of trade protection (corpus `ieconservice.get-trade-history`, read
   * 2026-10-02), so a transfer of cases or stickers that waited for it read "Accepted, waiting for
   * both inventories" for a week, with both inventories walked every thirty seconds meanwhile
   * (2026-10-30, live).
   */
  protected reconcileDelivery(batch: TransferBatch, offer: ObservedOffer): void {
    const db = this.context.database;
    const source = this.store.fresh(batch.account_id,'gc-inventory',this.context.now());
    const destination = this.store.fresh(batch.destination_account_id,'gc-inventory',this.context.now());
    if (!source || !destination || !batch.accepted_at || source.id <= (batch.accepted_obs ?? 0) || destination.id <= (batch.accepted_obs ?? 0)
      || source.started_at <= batch.accepted_at || destination.started_at <= batch.accepted_at) return;
    const baseline = new Set(JSON.parse(batch.destination_baseline_json) as string[]);
    const given = new Set(assetsOf(batch).map(asset => asset.assetId));
    // The fungible units no receipt names yet, as how many of each group must have arrived.
    const counted = new Map<string, number>();
    for (const asset of assetsOf(batch)) {
      const source = db.itemByAssetId(batch.account_id,asset.assetId);
      // A partial send of a stacked SO row leaves the row behind, lighter by what was sent.
      if (source && source.location !== 'MISSING' && (asset.unitKind !== 'fungible' || source.quantity > asset.sourceQuantity - asset.quantity)) return;
      // The receipt names the id the unit arrived under, for a case exactly as for a skin.
      const line = offer.trade_id
        ? db.raw().prepare(`SELECT new_asset_id FROM trade_line WHERE account_id=? AND trade_id=? AND side='GIVE' AND asset_id=? AND new_asset_id IS NOT NULL`)
          .get(batch.account_id,offer.trade_id,asset.assetId) as { new_asset_id: string } | undefined
        : undefined;
      const received = line ? db.itemByAssetId(batch.destination_account_id,line.new_asset_id) : undefined;
      if (received) {
        if (received.location !== 'MAIN' || received.last_seen_obs !== destination.id || received.quantity < asset.quantity
          || received.def_index !== asset.defIndex || received.quality !== asset.quality || baseline.has(received.asset_id!) || received.asset_id === asset.assetId) return;
      } else if (asset.unitKind !== 'fungible' && asset.stableKey) {
        const candidates = db.items(batch.destination_account_id).filter(item => item.stable_key === asset.stableKey && item.location === 'MAIN'
          && item.asset_id && item.asset_id !== asset.assetId && !baseline.has(item.asset_id) && item.local_id !== asset.localId);
        if (candidates.length !== 1 || candidates[0]!.last_seen_obs !== destination.id) return;
      } else if (asset.unitKind === 'fungible' && asset.stableKey) {
        const group = unrestrictedKey(asset.stableKey);
        counted.set(group, (counted.get(group) ?? 0) + asset.quantity);
      } else return;
    }
    if (counted.size) {
      // Two cases cannot be told apart, so which holding arrived is not asked; that enough new units
      // of the group did is, of the same walk, outside the baseline frozen at admission. The lock a
      // trade puts on an arrival is a different group key, so the groups are compared without it.
      const arrived = new Map<string, number>();
      for (const item of db.items(batch.destination_account_id)) {
        if (item.unit_kind !== 'fungible' || item.location !== 'MAIN' || !item.asset_id || item.last_seen_obs !== destination.id
          || baseline.has(item.asset_id) || given.has(item.asset_id)) continue;
        const group = unrestrictedKey(item.group_key);
        if (counted.has(group)) arrived.set(group, (arrived.get(group) ?? 0) + item.quantity);
      }
      for (const [group, quantity] of counted) if ((arrived.get(group) ?? 0) < quantity) return;
    }
    db.transaction(()=>{
      const now = this.context.now();
      this.work.updateTransferDetail(batch.send_step_id, { completed_source_obs: source.id, completed_destination_obs: destination.id });
      this.work.settle(batch.send_step_id, 'DONE', destination.id, now);
      const accept = this.work.step(transferHopId(batch.command_id, batch.account_id, 'accept'));
      if (accept && !isSettled(accept)) this.work.settle(accept.id, 'DONE', destination.id, now);
      if(offer.trade_id) for(const account of [batch.account_id,batch.destination_account_id]) this.services.trades.postObservedDelivery(account,offer.trade_id);
    });
  }

  async cancel(commandId: string, accountId: string): Promise<void> {
    const batch = this.store.batch(commandId, accountId);
    if (!batch) throw new Error('Unknown owned transfer');
    await this.batchesLock.run(`${batch.account_id}:${batch.command_id}`,async () => this.context.locks.run(accountId,async () => {
      const current = this.store.batch(commandId, accountId)!;
      if (finished(current) || current.cancel_action_id) return;
      const send = this.context.database.action(current.send_action_id)!;
      if (send.state === 'READY' && !this.context.database.latestAttempt(send.id)) {
        // Unsent hops stop with it; a hop already in flight is left to the storage reconciler,
        // because an ambiguous casket move is never re-sent and its item stays where it is observed.
        this.stopBeforeSend(current); return;
      }
      const offer = this.correlatedOffer(current);
      if (!offer || ![2,9].includes(offer.state_code)) throw new Error('Observe a live offer before cancelling');
      const hop = this.hop(current, 'cancel', accountId, offer.offer_id);
      const action = this.hopAction(current, hop, 'trade.cancel', offer.offer_id);
      await this.dispatchCancel(current, hop, action);
    }));
    this.store.progress(commandId);
  }

  /** Stopped on the person's word before anything was sent: every unsent hop stops, every slot comes back. */
  private stopBeforeSend(batch: TransferBatch): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      for (const hop of [...this.retrieveHops(batch), this.sendHop(batch)]) {
        const action = hop.action_id ? db.action(hop.action_id) : undefined;
        if (action?.state === 'READY') {
          db.setActionState(action.id,'FAILED',now,'Stopped before sending');
          if (hop.kind === 'RETRIEVE') db.releaseSlot(batch.account_id,action.id,false);
        }
        if (!isSettled(hop) && (hop.kind === 'SEND' || action?.state === 'FAILED')) this.work.settle(hop.id, 'STOPPED', null, now, 'Stopped before sending');
      }
    });
  }

  private sendHop(batch: TransferBatch): WorkStepRow {
    return this.work.step(batch.send_step_id)!;
  }

  /** The retrieve hops before the send, in hop order. */
  private retrieveHops(batch: TransferBatch): WorkStepRow[] {
    const send = this.sendHop(batch);
    return this.work.steps(batch.command_id, batch.account_id).filter(hop => hop.kind === 'RETRIEVE' && hop.ordinal < send.ordinal);
  }

  /** The accept or cancel hop of a source's transfer, appended under the account that acts when first reached. */
  private hop(batch: TransferBatch, kind: 'accept' | 'cancel', accountId: string, offerId: string): WorkStepRow {
    const id = transferHopId(batch.command_id, batch.account_id, kind);
    const send = this.sendHop(batch);
    return this.work.step(id) ?? this.work.insert({ id, commandId: batch.command_id, accountId, ordinal: send.ordinal + (kind === 'accept' ? 1 : 2),
      kind: kind === 'accept' ? 'ACCEPT' : 'CANCEL', targetId: offerId, offerId, params: { sourceAccountId: batch.account_id, destinationAccountId: batch.destination_account_id },
      now: this.context.now() });
  }

  private hopAction(batch: TransferBatch, hop: WorkStepRow, kind: 'trade.accept' | 'trade.cancel', offerId: string): ActionRow {
    return this.context.database.transaction(() => {
      const now = this.context.now();
      const partner = this.context.database.listAccounts().find(a => a.id === batch.account_id)!;
      const action = this.context.database.enqueueAction({ accountId: hop.account_id, stepId: hop.id, actionKind: kind,
        targetId: offerId, resourceKey: `${kind}:${offerId}`, params: { offerId, partnerSteamId64: partner.steam_id64 }, now });
      this.work.attachAction(hop.id, action.id, now);
      return action;
    });
  }

  private async dispatchCancel(batch: TransferBatch, hop: WorkStepRow, action: ActionRow): Promise<void> {
    const { offerId } = this.context.database.actionParams(action) as { offerId: string };
    const outcome = await this.services.trades.cancelOffer(action,() => {
      const fresh = this.store.offer(batch.account_id,offerId);
      if (!fresh || ![2,9].includes(fresh.state_code)) throw new Error('Offer changed before cancellation');
    });
    this.work.setState(hop.id, outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION', this.context.now(),
      outcome.kind === 'DEFINITIVELY_REJECTED' ? 'Cancellation refused; observing the offer' : 'Waiting for cancellation to be observed');
  }
}
