import type { EngineDatabase } from './database.js';

/**
 * The in-game store's rows: the last parsed price sheet per account, and each purchase with
 * its frozen lines. Every row is account-keyed (rule 8) and every price is integer minor units
 * in the account's own wallet currency; the sheet's other 36 currencies are not stored, because
 * a price in a currency this account cannot pay in is not a fact a purchase can use.
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

export type StorePurchaseRow = {
  id: string; command_id: string; account_id: string; state: StorePurchaseState; currency: number;
  requested_total_cents: number; sheet_version: number; txn_id: string | null;
  init_action_id: string | null; finalize_action_id: string | null; cancel_action_id: string | null;
  item_ids_json: string; resolved_by_obs: number | null; created_at: string; updated_at: string; error: string | null;
};

export type StorePurchaseLineRow = {
  purchase_id: string; account_id: string; line_index: number; entry_key: string; def_index: number;
  quantity: number; unit_price_cents: number; baseline_quantity: number; observed_quantity: number;
};

export type StoreSheetPublication = {
  observationId: number;
  version: number;
  currency: number;
  currencyLabel: string;
  observedAt: string;
  entries: Array<{ key: string; categoryTags: string; priceCents: number; salePriceCents: number | null }>;
};

export class InGameStoreStore {
  constructor(readonly db: EngineDatabase) {}

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

  purchase(id: string): StorePurchaseRow | undefined {
    return this.db.raw().prepare('SELECT * FROM store_purchase WHERE id=?').get(id) as StorePurchaseRow | undefined;
  }

  purchases(accountId: string): StorePurchaseRow[] {
    return this.db.raw().prepare('SELECT * FROM store_purchase WHERE account_id=? ORDER BY created_at,id').all(accountId) as StorePurchaseRow[];
  }

  purchasesByCommand(commandId: string): StorePurchaseRow[] {
    return this.db.raw().prepare('SELECT * FROM store_purchase WHERE command_id=? ORDER BY id').all(commandId) as StorePurchaseRow[];
  }

  openPurchases(accountId: string): StorePurchaseRow[] {
    const marks = STORE_PURCHASE_OPEN_STATES.map(() => '?').join(',');
    return this.db.raw().prepare(`SELECT * FROM store_purchase WHERE account_id=? AND state IN (${marks}) ORDER BY created_at,id`)
      .all(accountId, ...STORE_PURCHASE_OPEN_STATES) as StorePurchaseRow[];
  }

  lines(purchaseId: string): StorePurchaseLineRow[] {
    return this.db.raw().prepare('SELECT * FROM store_purchase_line WHERE purchase_id=? ORDER BY line_index').all(purchaseId) as StorePurchaseLineRow[];
  }

  insertPurchase(row: Omit<StorePurchaseRow, 'updated_at'>): void {
    this.db.raw().prepare(`INSERT INTO store_purchase(id,command_id,account_id,state,currency,requested_total_cents,sheet_version,txn_id,
      init_action_id,finalize_action_id,cancel_action_id,item_ids_json,resolved_by_obs,created_at,updated_at,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.command_id, row.account_id, row.state, row.currency, row.requested_total_cents, row.sheet_version, row.txn_id,
        row.init_action_id, row.finalize_action_id, row.cancel_action_id, row.item_ids_json, row.resolved_by_obs, row.created_at, row.created_at, row.error);
  }

  insertLine(row: StorePurchaseLineRow): void {
    this.db.raw().prepare(`INSERT INTO store_purchase_line(purchase_id,account_id,line_index,entry_key,def_index,quantity,unit_price_cents,baseline_quantity,observed_quantity)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.purchase_id, row.account_id, row.line_index, row.entry_key, row.def_index, row.quantity, row.unit_price_cents, row.baseline_quantity, row.observed_quantity);
  }

  update(id: string, patch: Partial<Pick<StorePurchaseRow, 'state' | 'txn_id' | 'init_action_id' | 'finalize_action_id' | 'cancel_action_id' | 'item_ids_json' | 'resolved_by_obs' | 'error'>>, now: string): void {
    const columns = Object.keys(patch) as Array<keyof typeof patch>;
    const sets = [...columns.map((column) => `${column}=?`), 'updated_at=?'];
    this.db.raw().prepare(`UPDATE store_purchase SET ${sets.join(',')} WHERE id=?`).run(...columns.map((column) => patch[column] ?? null), now, id);
  }

  setObservedQuantity(purchaseId: string, lineIndex: number, quantity: number): void {
    this.db.raw().prepare('UPDATE store_purchase_line SET observed_quantity=? WHERE purchase_id=? AND line_index=?').run(quantity, purchaseId, lineIndex);
  }

  /** Units of one def index in main inventory, of either kind, by quantity. */
  mainQuantityOfDef(accountId: string, defIndex: number): number {
    const items = this.db.raw().prepare(`SELECT COALESCE(SUM(quantity),0) AS n FROM item WHERE account_id=? AND def_index=? AND location='MAIN'`)
      .get(accountId, defIndex) as { n: number };
    return items.n;
  }

  /** Where one asset id is now, and the observation that last saw it there. */
  assetSeen(accountId: string, assetId: string): { defIndex: number; location: string; lastSeenObs: number } | undefined {
    const item = this.db.raw().prepare('SELECT def_index, location, last_seen_obs FROM item WHERE account_id=? AND current_asset_id=?')
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
