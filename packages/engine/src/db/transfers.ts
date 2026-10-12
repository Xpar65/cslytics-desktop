import type { TradeAsset, TradeInventoryItem } from '@cslytics/ports';
import type { EngineDatabase, ObservationRow } from './database.js';

export type TransferMember = { accountId: string; localId?: string; stackKey?: string; quantity?: number; casketId?: string | null };
/**
 * One frozen asset of a batch. `pendingRetrieval` names an individual item admitted while it sat
 * in a storage unit: the batch retrieves it first and sends only once a complete observation
 * shows it in main inventory. A GC casket move keeps the asset id, so freezing it here is safe.
 */
export type TransferAsset = TradeAsset & { localId: string; stableKey: string | null; unitKind?: 'individual' | 'fungible'; defIndex: number; quality: number; sourceQuantity: number;
  pendingRetrieval?: boolean; casketId?: string };
export type TransferBatch = {
  command_id: string; account_id: string; destination_account_id: string; send_action_id: string;
  accept_action_id: string | null; cancel_action_id: string | null; offer_id: string | null;
  state: string; reason: string | null; assets_json: string; destination_baseline_json: string;
  accepted_at: string | null; accepted_obs: number | null; completed_source_obs: number | null; completed_destination_obs: number | null;
  /** The `RETRIEVE_FROM_CASKET` actions this batch must prove before its send; `[]` for a batch sent from main inventory. */
  retrieve_action_ids_json: string;
};
export type EligibilityRow = { account_id: string; asset_id: string; quantity: number; tradable: number; name: string; observation_id: number; marketable: number | null };
export type ObservedOffer = { offer_id: string; trade_id: string | null; account_id: string; direction: string;
  counterparty_id: string; raw_state: number; status: string; last_seen_obs: number; updated_at: string; message: string | null; escrow_until: string | null };
export const FINISHED_TRANSFERS = ['DONE','ENDED','FAILED'] as const;

/** SQLite operations shared by transfer policy, surface and read models. Runtime is the only writer. */
export class TransferStore {
  constructor(readonly db: EngineDatabase) {}

  batches(commandId?: string): TransferBatch[] {
    return this.db.raw().prepare(`SELECT * FROM transfer_batch ${commandId ? 'WHERE command_id=?' : ''} ORDER BY command_id,account_id`)
      .all(...(commandId ? [commandId] : [])) as TransferBatch[];
  }
  update(batch: TransferBatch, fields: Partial<Omit<TransferBatch, 'command_id' | 'account_id'>>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    this.db.transaction(()=>{
      this.db.raw().prepare(`UPDATE transfer_batch SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE command_id=? AND account_id=?`)
        .run(...entries.map(([,value]) => value ?? null), batch.command_id, batch.account_id);
      this.progress(batch.command_id);
    });
  }
  eligibility(accountId: string, assetId: string): EligibilityRow | undefined {
    return this.db.raw().prepare('SELECT * FROM trade_inventory_item WHERE account_id=? AND asset_id=?').get(accountId,assetId) as EligibilityRow | undefined;
  }
  publishEligibility(accountId: string, items: readonly TradeInventoryItem[], observationId: number): void {
    this.db.raw().prepare('DELETE FROM trade_inventory_item WHERE account_id=?').run(accountId);
    // `marketable` is Steam's own answer to "can this be sold on the market at all" (holdings
    // plan D7); a description that does not say leaves it NULL, which is unknown, never "no".
    const insert = this.db.raw().prepare(`INSERT INTO trade_inventory_item(account_id,asset_id,quantity,tradable,name,class_id,instance_id,observation_id,marketable)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const item of items) insert.run(accountId,item.assetId,item.quantity,item.tradable ? 1 : 0,item.name,item.classId,item.instanceId,observationId,item.marketable === undefined ? null : item.marketable ? 1 : 0);
  }
  fresh(accountId: string, surface: string, now: string, maxAgeMs = 300_000): ObservationRow | undefined {
    const obs = this.db.latestObservationForScope(accountId, 'account', null, surface);
    const age = obs ? Date.parse(now) - Date.parse(obs.started_at) : NaN;
    return obs && obs.complete && !obs.error && age >= 0 && age <= maxAgeMs ? obs : undefined;
  }
  link(accountId: string): { partner_account_id: string; token: string; observation_id: number } | undefined {
    return this.db.raw().prepare('SELECT partner_account_id,token,observation_id FROM account_trade_link WHERE account_id=?').get(accountId) as ReturnType<TransferStore['link']>;
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
    return [...this.db.raw().prepare(`SELECT current_asset_id AS id FROM item WHERE account_id=? AND location<>'MISSING' AND current_asset_id IS NOT NULL`).all(accountId)]
      .map(row => String(row.id));
  }
  progress(commandId: string): void {
    const batches = this.batches(commandId);
    if (!batches.length) return;
    for (const batch of batches) this.db.raw().prepare('UPDATE command_member SET state=? WHERE command_id=? AND account_id=?')
      .run(batch.state, commandId,batch.account_id);
    const completed = batches.filter(b => b.state === 'DONE').reduce((sum,b) => sum + assetsOf(b).reduce((n,a) => n+a.quantity,0),0);
    const state = batches.every(b => b.state === 'DONE') ? 'COMPLETE' : batches.every(finished) ? 'PARTIAL' : 'RUNNING';
    this.db.raw().prepare('UPDATE command SET state=?,observed_completed=? WHERE id=?').run(state,completed,commandId);
  }
}

export function assetsOf(batch: TransferBatch): TransferAsset[] { return JSON.parse(batch.assets_json) as TransferAsset[]; }
export function retrieveActionIdsOf(batch: TransferBatch): string[] { return JSON.parse(batch.retrieve_action_ids_json || '[]') as string[]; }
export function finished(batch: TransferBatch): boolean { return (FINISHED_TRANSFERS as readonly string[]).includes(batch.state); }
