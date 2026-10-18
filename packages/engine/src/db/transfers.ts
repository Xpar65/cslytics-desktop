import type { TradeAsset } from '@cslytics/ports';
import type { EngineDatabase, ObservationRow } from './database.js';
import { WorkStore, isSettled, type TransferDetailRow, type WorkStepRow } from './work.js';

export type TransferMember = { accountId: string; localId?: string; stackKey?: string; quantity?: number; casketId?: string | null };
/**
 * One frozen asset of a transfer. `pendingRetrieval` names an individual item admitted while it
 * sat in a storage unit: the transfer retrieves it first and sends only once a complete
 * observation shows it in main inventory. A GC casket move keeps the asset id, so freezing it
 * here is safe. The frozen asset is the member's `input_json` (consolidation plan D15).
 */
export type TransferAsset = TradeAsset & { localId: string; stableKey: string | null; unitKind?: 'individual' | 'fungible'; defIndex: number; quality: number; sourceQuantity: number;
  pendingRetrieval?: boolean; casketId?: string };

/** The command kind of a send between two owned accounts. */
export const ACCOUNT_TRANSFER = 'ACCOUNT_TRANSFER';

/**
 * One source's part of a transfer, read as one thing from its hops (consolidation plan D2).
 *
 * The record keeps a step per hop — the retrieves of its crated items, the send, the destination's
 * accept, a cancel — and `transfer_detail` beside the send hop. What a caller asks is "where is
 * this transfer", answered here in the words the transfer always had: the hop with attention
 * decides, and the offer the send put up says what Steam waits for. `send_action_id` is the send
 * hop's action; `assets_json` is the source's frozen members; `retrieve_action_ids_json` is the
 * retrieve hops' actions, in hop order.
 */
export type TransferBatch = {
  command_id: string; account_id: string; destination_account_id: string; send_action_id: string;
  accept_action_id: string | null; cancel_action_id: string | null; offer_id: string | null;
  state: string; reason: string | null; assets_json: string; destination_baseline_json: string;
  accepted_at: string | null; accepted_obs: number | null; completed_source_obs: number | null; completed_destination_obs: number | null;
  /** The `RETRIEVE_FROM_CASKET` actions this transfer must prove before its send; `[]` for one sent from main inventory. */
  retrieve_action_ids_json: string;
  /** The hops behind the words above, for the service that moves them. */
  send_step_id: string;
};
export type ObservedOffer = { offer_id: string; trade_id: string | null; account_id: string; direction: string;
  counterparty_steam_id64: string; state_code: number; status: string; last_seen_obs: number; updated_at: string; message: string | null; escrow_until: string | null };
export const FINISHED_TRANSFERS = ['DONE','ENDED','FAILED'] as const;
/** Steam's own words for an offer that is over, by `state_code`. */
export const ENDED_OFFER_STATES: readonly number[] = [1,4,5,6,7,8,10];

/** The id of one hop of a source's transfer. */
export function transferHopId(commandId: string, accountId: string, hop: 'send' | 'accept' | 'cancel' | `retrieve:${string}`): string {
  return `${commandId}:${accountId}:${hop}`;
}

/** SQLite operations shared by transfer policy, surface and read models. Runtime is the only writer. */
export class TransferStore {
  constructor(readonly db: EngineDatabase) {}

  /** Every source's transfer, or one command's, as `TransferBatch`, by command then source. */
  batches(commandId?: string): TransferBatch[] {
    const sends = this.db.raw().prepare(`SELECT s.* FROM work_step s JOIN command c ON c.id=s.command_id JOIN transfer_detail d ON d.step_id=s.id
      WHERE s.kind='SEND' AND c.kind=? ${commandId ? 'AND s.command_id=?' : ''} ORDER BY s.command_id, s.account_id`)
      .all(ACCOUNT_TRANSFER, ...(commandId ? [commandId] : [])) as WorkStepRow[];
    return sends.map((send) => this.batchOf(send));
  }

  /** One source's transfer, from its send hop. */
  batch(commandId: string, accountId: string): TransferBatch | undefined {
    const send = new WorkStore(this.db).step(transferHopId(commandId, accountId, 'send'));
    return send ? this.batchOf(send) : undefined;
  }

  private batchOf(send: WorkStepRow): TransferBatch {
    const work = new WorkStore(this.db);
    const detail = work.transferDetail(send.id)!;
    const hops = work.steps(send.command_id, send.account_id);
    const retrieves = hops.filter((hop) => hop.kind === 'RETRIEVE' && hop.ordinal < send.ordinal);
    const cancel = work.step(transferHopId(send.command_id, send.account_id, 'cancel'));
    const accept = work.step(transferHopId(send.command_id, send.account_id, 'accept'));
    const assets = this.assets(send.command_id, send.account_id);
    const { state, reason } = this.words(send, retrieves, accept, cancel);
    return {
      command_id: send.command_id, account_id: send.account_id, destination_account_id: detail.destination_account_id,
      send_action_id: send.action_id!, accept_action_id: accept?.action_id ?? null, cancel_action_id: cancel?.action_id ?? null,
      offer_id: send.offer_id, state, reason, assets_json: JSON.stringify(assets), destination_baseline_json: detail.destination_baseline_json,
      accepted_at: detail.accepted_at, accepted_obs: detail.accepted_obs, completed_source_obs: detail.completed_source_obs,
      completed_destination_obs: detail.completed_destination_obs,
      retrieve_action_ids_json: JSON.stringify(retrieves.map((hop) => hop.action_id).filter((id): id is string => id !== null)),
      send_step_id: send.id
    };
  }

  /**
   * The transfer's state in its own words, from the hop that has attention: a hop that failed; a
   * retrieve still open; the send, by the offer Steam shows; a cancel or an accept in flight.
   */
  private words(send: WorkStepRow, retrieves: WorkStepRow[], accept: WorkStepRow | undefined, cancel: WorkStepRow | undefined): { state: string; reason: string | null } {
    const offer = send.offer_id ? this.offer(send.account_id, send.offer_id) : undefined;
    const ended = offer !== undefined && ENDED_OFFER_STATES.includes(offer.state_code);
    if (send.state === 'DONE') return { state: 'DONE', reason: null };
    if (isSettled(send) && ended) return { state: 'ENDED', reason: send.reason ?? `Offer ${offer.status.toLowerCase()}` };
    const failed = [...retrieves, send].find((hop) => hop.state === 'FAILED');
    if (failed) return { state: 'FAILED', reason: failed.reason };
    if (send.state === 'STOPPED') return { state: 'FAILED', reason: send.reason };
    if (retrieves.some((hop) => !isSettled(hop))) return { state: 'RETRIEVING', reason: send.reason ?? 'Waiting for the retrieved item to be observed in main inventory' };
    if (send.state === 'QUEUED') return { state: 'READY', reason: send.reason };
    if (cancel && !isSettled(cancel)) return { state: 'CANCELLING', reason: cancel.reason ?? 'Waiting for cancellation to be observed' };
    if (cancel?.state === 'FAILED') return { state: 'CANCEL_BLOCKED', reason: cancel.reason };
    if (!offer) return { state: 'AWAITING_OBSERVATION', reason: send.reason };
    if (offer.state_code === 9) return { state: 'NEEDS_CONFIRMATION', reason: send.reason ?? 'Confirm this offer on the sender’s phone' };
    if (offer.state_code === 11) return { state: 'ESCROW', reason: send.reason };
    if (offer.state_code === 3) return { state: 'AWAITING_DELIVERY', reason: send.reason ?? 'Waiting for complete inventories on both accounts' };
    if (accept) {
      if (accept.state === 'FAILED') return { state: 'ACCEPT_BLOCKED', reason: accept.reason };
      if (!isSettled(accept)) {
        const response = accept.action_id ? this.attemptResponse(accept.action_id) : {};
        const confirmation = response.needs_mobile_confirmation === true || response.needs_mobile_app_confirmation === true || response.needs_email_confirmation === true;
        return confirmation ? { state: 'ACCEPT_CONFIRMATION', reason: 'Confirm acceptance on the destination account' }
          : { state: 'ACCEPTING', reason: accept.reason ?? (accept.state === 'QUEUED' ? 'Accepting on the destination account' : 'Waiting for acceptance to be observed') };
      }
    }
    return { state: 'ACTIVE', reason: send.reason };
  }

  /** The source's frozen assets, in member order: what `assets_json` used to hold. */
  assets(commandId: string, accountId: string): TransferAsset[] {
    return (this.db.raw().prepare('SELECT input_json FROM command_member WHERE command_id=? AND account_id=? ORDER BY rowid').all(commandId, accountId) as Array<{ input_json: string | null }>)
      .flatMap((row) => row.input_json ? [JSON.parse(row.input_json) as TransferAsset] : []);
  }

  fresh(accountId: string, surface: string, now: string, maxAgeMs = 300_000): ObservationRow | undefined {
    const obs = this.db.latestObservationForScope(accountId, 'account', null, surface);
    const age = obs ? Date.parse(now) - Date.parse(obs.started_at) : NaN;
    return obs && obs.complete && !obs.error && age >= 0 && age <= maxAgeMs ? obs : undefined;
  }
  /** The account's own trade link, from its row (D14): the partner id Steam's URL wants is the SteamID64 less the account32 offset. */
  link(accountId: string): { partner_account_id: string; token: string; observation_id: number } | undefined {
    const account = this.db.account(accountId);
    if (!account?.trade_token || account.trade_token_obs === null) return undefined;
    return { partner_account_id: (BigInt(account.steam_id64) - 76561197960265728n).toString(), token: account.trade_token, observation_id: account.trade_token_obs };
  }
  hold(accountId: string, destination: string): { my_seconds: number; their_seconds: number; observation_id: number } | undefined {
    return this.db.raw().prepare('SELECT * FROM transfer_hold WHERE account_id=? AND destination_account_id=?').get(accountId,destination) as ReturnType<TransferStore['hold']>;
  }
  offer(accountId: string, offerId: string): ObservedOffer | undefined {
    return this.db.raw().prepare('SELECT * FROM trade_offer WHERE account_id=? AND offer_id=?').get(accountId,offerId) as ObservedOffer | undefined;
  }
  offerLines(accountId: string, offerId: string, side: 'GIVE' | 'RECEIVE') {
    return this.db.raw().prepare(`SELECT asset_id,quantity,app_id,context_id,attributes_json FROM trade_line WHERE account_id=? AND offer_id=? AND side=? AND line_key LIKE 'offer:%'`)
      .all(accountId,offerId,side) as Array<{ asset_id: string; quantity: number; app_id: number; context_id: string; attributes_json: string }>;
  }
  attemptResponse(actionId: string): Record<string, unknown> {
    const row = this.db.raw().prepare('SELECT response_ref FROM attempt WHERE action_id=? ORDER BY rowid DESC LIMIT 1').get(actionId) as { response_ref: string | null } | undefined;
    try { return JSON.parse(row?.response_ref ?? '{}') as Record<string, unknown>; } catch { return {}; }
  }
  assetBaseline(accountId: string): string[] {
    return [...this.db.raw().prepare(`SELECT asset_id AS id FROM item WHERE account_id=? AND location<>'MISSING' AND asset_id IS NOT NULL`).all(accountId)]
      .map(row => String(row.id));
  }
  detail(stepId: string): TransferDetailRow | undefined {
    return new WorkStore(this.db).transferDetail(stepId);
  }
  /**
   * The command's state from its sources' transfers, and each member's word from its source's.
   * A member's state is derived: the hops decide, and this is their reading written where
   * `command.read` looks (consolidation plan §4.4).
   */
  progress(commandId: string): void {
    const batches = this.batches(commandId);
    if (!batches.length) return;
    const completed = batches.filter(b => b.state === 'DONE').reduce((sum,b) => sum + assetsOf(b).reduce((n,a) => n+a.quantity,0),0);
    const state = batches.every(b => b.state === 'DONE') ? 'COMPLETE' : batches.every(finished) ? 'PARTIAL' : 'RUNNING';
    this.db.raw().prepare('UPDATE command SET state=?,observed_completed=? WHERE id=?').run(state,completed,commandId);
  }
}

export function assetsOf(batch: TransferBatch): TransferAsset[] { return JSON.parse(batch.assets_json) as TransferAsset[]; }
export function retrieveActionIdsOf(batch: TransferBatch): string[] { return JSON.parse(batch.retrieve_action_ids_json || '[]') as string[]; }
export function finished(batch: TransferBatch): boolean { return (FINISHED_TRANSFERS as readonly string[]).includes(batch.state); }
