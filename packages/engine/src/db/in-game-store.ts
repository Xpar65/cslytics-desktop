import type { EngineDatabase } from './database.js';
import { WorkStore, isSettled, type StoreLineRow, type WorkStepRow } from './work.js';

/**
 * The in-game store's rows: the last parsed price sheet per account, and each purchase as the
 * hops of its command (consolidation plan D2) with its frozen lines beside the first hop
 * (`store_line`). Every row is account-keyed (rule 8) and every price is integer minor units
 * in the account's own wallet currency; the sheet's other 36 currencies are not stored, because
 * a price in a currency this account cannot pay in is not a fact a purchase can use.
 */

/** The command kind of a purchase; its id is the purchase's id. */
export const STORE_PURCHASE = 'STORE_PURCHASE';

/** The hops of a purchase, in the order they are reached; a cancel is appended when asked for. */
export const STORE_HOPS = ['STORE_INIT', 'STORE_APPROVE', 'STORE_FINALIZE', 'STORE_CANCEL'] as const;
export type StoreHop = (typeof STORE_HOPS)[number];

/** The id of one hop of a purchase. */
export function storeHopId(purchaseId: string, hop: StoreHop): string {
  return `${purchaseId}:${hop}`;
}

/**
 * A purchase's state in its own words, read from its hops: what the person sees and what
 * `InGameStoreService.advance` dispatches on. Derived, never stored (`InGameStoreStore.purchase`).
 */
export type StorePurchaseState =
  | 'ADMITTED' | 'INITIALISING' | 'AWAITING_APPROVAL' | 'FINALISING' | 'AWAITING_OBSERVATION'
  | 'COMPLETED' | 'REJECTED' | 'CANCELLING' | 'CANCELLED' | 'UNRESOLVED';

export const STORE_PURCHASE_OPEN_STATES: readonly StorePurchaseState[] = [
  'ADMITTED', 'INITIALISING', 'AWAITING_APPROVAL', 'FINALISING', 'AWAITING_OBSERVATION', 'CANCELLING', 'UNRESOLVED'
];

export type StoreSheetRow = {
  account_id: string; observation_id: number; version: number; currency: number; currency_label: string;
  observed_at: string; entry_count: number; parse_state: 'PARSED' | 'UNPARSEABLE';
};

export type StoreEntryRow = {
  account_id: string; entry_key: string; version: number; category_tags: string; price_cents: number; sale_price_cents: number | null;
};

/** The frozen terms of a purchase, on its first hop; `txnId` is that hop's `target_id` once Steam names one. */
export type StorePurchaseParams = { purchaseId: string; currency: number; requestedTotalCents: number; sheetVersion: number; hashName: string };

/**
 * One purchase as one thing: its id is its command's, its hops' actions are named so the crash
 * matrix and the saboteurs can reach them, and `state` is the reading of the hops.
 */
export type StorePurchaseRow = {
  id: string; command_id: string; account_id: string; state: StorePurchaseState; currency: number;
  requested_total_cents: number; sheet_version: number; txn_id: string | null;
  init_action_id: string | null; finalize_action_id: string | null; cancel_action_id: string | null;
  item_ids_json: string; resolved_by_obs: number | null; created_at: string; updated_at: string; error: string | null;
};

export type StorePurchaseLineRow = StoreLineRow;

export type StoreSheetPublication = {
  observationId: number;
  version: number;
  currency: number;
  currencyLabel: string;
  observedAt: string;
  entries: Array<{ key: string; categoryTags: string; priceCents: number; salePriceCents: number | null }>;
};

export class InGameStoreStore {
  readonly work: WorkStore;
  constructor(readonly db: EngineDatabase) { this.work = new WorkStore(db); }

  sheet(accountId: string): StoreSheetRow | undefined {
    return this.db.raw().prepare('SELECT * FROM store_price_sheet WHERE account_id=?').get(accountId) as StoreSheetRow | undefined;
  }

  entries(accountId: string): StoreEntryRow[] {
    return this.db.raw().prepare('SELECT * FROM store_price_entry WHERE account_id=? ORDER BY entry_key').all(accountId) as StoreEntryRow[];
  }

  entry(accountId: string, key: string): StoreEntryRow | undefined {
    return this.db.raw().prepare('SELECT * FROM store_price_entry WHERE account_id=? AND entry_key=?').get(accountId, key) as StoreEntryRow | undefined;
  }

  /** Replaces the sheet whole: a parsed sheet is the GC's current list, never a merge with the old one. */
  publishSheet(accountId: string, publication: StoreSheetPublication): void {
    this.db.transaction(() => {
      this.db.raw().prepare(`INSERT INTO store_price_sheet(account_id,observation_id,version,currency,currency_label,observed_at,entry_count,parse_state)
        VALUES (?,?,?,?,?,?,?,'PARSED') ON CONFLICT(account_id) DO UPDATE SET observation_id=excluded.observation_id,version=excluded.version,
        currency=excluded.currency,currency_label=excluded.currency_label,observed_at=excluded.observed_at,entry_count=excluded.entry_count,parse_state='PARSED'`)
        .run(accountId, publication.observationId, publication.version, publication.currency, publication.currencyLabel, publication.observedAt, publication.entries.length);
      this.db.raw().prepare('DELETE FROM store_price_entry WHERE account_id=?').run(accountId);
      const insert = this.db.raw().prepare('INSERT INTO store_price_entry(account_id,entry_key,version,category_tags,price_cents,sale_price_cents) VALUES (?,?,?,?,?,?)');
      for (const entry of publication.entries) insert.run(accountId, entry.key, publication.version, entry.categoryTags, entry.priceCents, entry.salePriceCents);
    });
  }

  /**
   * A sheet that could not be parsed keeps the previous entries visible and admits nothing:
   * the row says UNPARSEABLE, and the entries it still shows carry their old version.
   */
  markUnparseable(accountId: string, observationId: number, observedAt: string): void {
    const existing = this.sheet(accountId);
    if (existing) {
      this.db.raw().prepare('UPDATE store_price_sheet SET parse_state=\'UNPARSEABLE\',observation_id=?,observed_at=? WHERE account_id=?')
        .run(observationId, observedAt, accountId);
      return;
    }
    this.db.raw().prepare(`INSERT INTO store_price_sheet(account_id,observation_id,version,currency,currency_label,observed_at,entry_count,parse_state)
      VALUES (?,?,0,0,'',?,0,'UNPARSEABLE')`).run(accountId, observationId, observedAt);
  }

  // ---------------------------------------------------------------- purchases, read from their hops

  hop(purchaseId: string, kind: StoreHop): WorkStepRow | undefined {
    return this.work.step(storeHopId(purchaseId, kind));
  }

  purchase(id: string): StorePurchaseRow | undefined {
    const init = this.hop(id, 'STORE_INIT');
    if (!init) return undefined;
    const command = this.db.command(id);
    if (command?.kind !== STORE_PURCHASE) return undefined;
    const approve = this.hop(id, 'STORE_APPROVE'), finalize = this.hop(id, 'STORE_FINALIZE'), cancel = this.hop(id, 'STORE_CANCEL');
    const params = this.work.params<StorePurchaseParams>(init);
    const itemIds = finalize ? (this.work.params<{ itemIds?: string[] } | null>(finalize)?.itemIds ?? []) : [];
    const { state, error } = this.words(id, init, approve, finalize, cancel);
    const hops = [init, approve, finalize, cancel].filter((hop): hop is WorkStepRow => hop !== undefined);
    const settled = hops.find((hop) => hop.state === 'DONE' && hop.observation_id !== null);
    return {
      id, command_id: id, account_id: init.account_id, state, currency: params.currency, requested_total_cents: params.requestedTotalCents,
      sheet_version: params.sheetVersion, txn_id: init.target_id, init_action_id: init.action_id, finalize_action_id: finalize?.action_id ?? null,
      cancel_action_id: cancel?.action_id ?? null, item_ids_json: JSON.stringify(itemIds),
      resolved_by_obs: state === 'COMPLETED' || state === 'CANCELLED' || state === 'REJECTED' ? (finalize?.observation_id ?? cancel?.observation_id ?? init.observation_id ?? settled?.observation_id ?? null) : null,
      created_at: init.created_at, updated_at: hops.map((hop) => hop.updated_at).sort().at(-1)!, error
    };
  }

  /**
   * The reading. A finalize proved by the inventory is a completed purchase; a cancel proved by
   * the inventory and the wallet is a cancelled one; a cancel in flight is cancelling; an init
   * that failed is a refusal when its money came back and an unresolved purchase when it did
   * not; any other failed hop is unresolved and waits for the person; otherwise the latest hop
   * says where the purchase is.
   */
  private words(id: string, init: WorkStepRow, approve: WorkStepRow | undefined, finalize: WorkStepRow | undefined, cancel: WorkStepRow | undefined): { state: StorePurchaseState; error: string | null } {
    if (finalize?.state === 'DONE') return { state: 'COMPLETED', error: null };
    if (cancel?.state === 'DONE') return { state: 'CANCELLED', error: null };
    if (cancel && !isSettled(cancel)) return { state: 'CANCELLING', error: cancel.reason };
    if (init.state === 'FAILED') return { state: this.reservationState(id) === 'RELEASED' ? 'REJECTED' : 'UNRESOLVED', error: init.reason };
    const failed = [cancel, finalize, approve].find((hop) => hop?.state === 'FAILED');
    if (failed) return { state: 'UNRESOLVED', error: failed.reason };
    if (finalize) {
      if (finalize.state === 'AWAITING_OBSERVATION') return { state: 'AWAITING_OBSERVATION', error: finalize.reason };
      return { state: finalize.reason && finalize.state === 'QUEUED' ? 'UNRESOLVED' : 'FINALISING', error: finalize.reason };
    }
    if (approve) {
      if (approve.state === 'DONE') return { state: 'FINALISING', error: null };
      return { state: 'AWAITING_APPROVAL', error: approve.reason };
    }
    if (init.state === 'QUEUED') return { state: init.reason ? 'UNRESOLVED' : 'ADMITTED', error: init.reason };
    if (init.state === 'SENT') return { state: 'INITIALISING', error: null };
    if (init.state === 'STOPPED') return { state: 'CANCELLED', error: init.reason };
    return { state: 'AWAITING_OBSERVATION', error: init.reason };
  }

  purchases(accountId: string): StorePurchaseRow[] {
    const ids = this.db.raw().prepare(`SELECT c.id FROM command c JOIN work_step s ON s.id=c.id || ':STORE_INIT'
      WHERE c.kind=? AND s.account_id=? ORDER BY c.created_at, c.id`).all(STORE_PURCHASE, accountId) as Array<{ id: string }>;
    return ids.map((row) => this.purchase(row.id)).filter((row): row is StorePurchaseRow => row !== undefined);
  }

  purchasesByCommand(commandId: string): StorePurchaseRow[] {
    const row = this.purchase(commandId);
    return row ? [row] : [];
  }

  /** Purchases with a hop still open or failed and no verdict yet: what reconciliation looks at. */
  openPurchases(accountId: string): StorePurchaseRow[] {
    const ids = this.db.raw().prepare(`SELECT DISTINCT s.command_id AS id FROM work_step s JOIN command c ON c.id=s.command_id
      WHERE s.account_id=? AND c.kind=? AND s.state IN ('QUEUED','SENT','AWAITING_OBSERVATION','RETRYING','FAILED') ORDER BY s.created_at, s.command_id`)
      .all(accountId, STORE_PURCHASE) as Array<{ id: string }>;
    return ids.map((row) => this.purchase(row.id))
      .filter((row): row is StorePurchaseRow => row !== undefined && (STORE_PURCHASE_OPEN_STATES as readonly string[]).includes(row.state));
  }

  lines(purchaseId: string): StorePurchaseLineRow[] {
    return this.work.storeLines(storeHopId(purchaseId, 'STORE_INIT'));
  }

  setObservedQuantity(purchaseId: string, lineIndex: number, quantity: number): void {
    this.work.setObservedQuantity(storeHopId(purchaseId, 'STORE_INIT'), lineIndex, quantity);
  }

  /** Units of one def index in main inventory, of either kind, by quantity. */
  mainQuantityOfDef(accountId: string, defIndex: number): number {
    const items = this.db.raw().prepare(`SELECT COALESCE(SUM(quantity),0) AS n FROM item WHERE account_id=? AND def_index=? AND location='MAIN'`)
      .get(accountId, defIndex) as { n: number };
    return items.n;
  }

  /** Where one asset id is now, and the observation that last saw it there. */
  assetSeen(accountId: string, assetId: string): { defIndex: number; location: string; lastSeenObs: number } | undefined {
    const item = this.db.raw().prepare('SELECT def_index, location, last_seen_obs FROM item WHERE account_id=? AND asset_id=?')
      .get(accountId, assetId) as { def_index: number; location: string; last_seen_obs: number } | undefined;
    return item ? { defIndex: item.def_index, location: item.location, lastSeenObs: item.last_seen_obs } : undefined;
  }

  reservationState(purchaseId: string): string | undefined {
    const row = this.db.raw().prepare(`SELECT state FROM reservation WHERE ref_kind='STORE_PURCHASE' AND ref_id=?`).get(purchaseId) as { state: string } | undefined;
    return row?.state;
  }

  setReservation(accountId: string, purchaseId: string, state: 'ACTIVE' | 'SUBMITTED_UNOBSERVED' | 'RELEASED' | 'CONSUMED'): void {
    this.db.raw().prepare(`UPDATE reservation SET state=? WHERE account_id=? AND ref_kind='STORE_PURCHASE' AND ref_id=?`).run(state, accountId, purchaseId);
  }
}

export function parseItemIds(row: StorePurchaseRow): string[] {
  try {
    const parsed = JSON.parse(row.item_ids_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
