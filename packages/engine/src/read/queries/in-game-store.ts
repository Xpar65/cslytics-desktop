import type { EngineDatabase } from '../../db/database.js';
import { InGameStoreStore, parseItemIds, type StorePurchaseState } from '../../db/in-game-store.js';

/**
 * The in-game store's read models: what the GC will sell this account, and what this account
 * has asked to buy. Bounded and account-scoped; the engine holds no names, so an entry leaves
 * here as its `items_game` key and the host attaches a name and an image.
 */

export type StoreSheetEntryView = { entryKey: string; categoryTags: string; priceCents: number; salePriceCents: number | null };

export type StoreSheetView = {
  accountId: string;
  version: number;
  currency: number;
  currencyLabel: string;
  observedAt: string;
  parseState: 'PARSED' | 'UNPARSEABLE';
  /** Whether the observation that produced this sheet finished complete. */
  observationComplete: boolean;
  entries: StoreSheetEntryView[];
};

export type StorePurchaseLineView = { entryKey: string; defIndex: number; quantity: number; unitPriceCents: number; observedQuantity: number };

export type StorePurchaseView = {
  id: string;
  commandId: string;
  accountId: string;
  state: StorePurchaseState;
  currency: number;
  requestedTotalCents: number;
  sheetVersion: number;
  txnId: string | null;
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  lines: StorePurchaseLineView[];
};

export type StorePurchasePage = { accountId: string; rows: StorePurchaseView[]; nextCursor: string | null; stalePage: boolean };

const SHEET_ENTRY_CAP = 2_000;
const PURCHASE_PAGE = 100;

export function readStoreSheet(db: EngineDatabase, accountId: string): StoreSheetView | null {
  const store = new InGameStoreStore(db);
  const sheet = store.sheet(accountId);
  if (!sheet) return null;
  const observation = db.observation(accountId, sheet.observation_id);
  return {
    accountId,
    version: sheet.version,
    currency: sheet.currency,
    currencyLabel: sheet.currency_label,
    observedAt: sheet.observed_at,
    parseState: sheet.parse_state,
    observationComplete: observation?.complete === 1,
    entries: store.entries(accountId).slice(0, SHEET_ENTRY_CAP).map((entry) => ({
      entryKey: entry.entry_key,
      categoryTags: entry.category_tags,
      priceCents: entry.price_cents,
      salePriceCents: entry.sale_price_cents
    }))
  };
}

export function readStorePurchase(db: EngineDatabase, accountId: string, id: string): StorePurchaseView | null {
  const store = new InGameStoreStore(db);
  const row = store.purchase(id);
  if (!row || row.account_id !== accountId) return null;
  return {
    id: row.id,
    commandId: row.command_id,
    accountId: row.account_id,
    state: row.state,
    currency: row.currency,
    requestedTotalCents: row.requested_total_cents,
    sheetVersion: row.sheet_version,
    txnId: row.txn_id,
    itemIds: parseItemIds(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    lines: store.lines(row.id).map((line) => ({
      entryKey: line.entry_key,
      defIndex: line.def_index,
      quantity: line.quantity,
      unitPriceCents: line.unit_price_cents,
      observedQuantity: line.observed_quantity
    }))
  };
}

/** Newest first, one page, cursor bound to the latest purchase update so a changed row cannot slip between pages. */
export function pageStorePurchases(db: EngineDatabase, accountId: string, cursor?: string): StorePurchasePage {
  const snapshot = (db.raw().prepare('SELECT COALESCE(MAX(updated_at),\'\') AS at FROM store_purchase WHERE account_id=?').get(accountId) as { at: string }).at;
  let before: { createdAt: string; id: string } | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { accountId: string; snapshot: string; createdAt: string; id: string };
      if (decoded.accountId !== accountId || decoded.snapshot !== snapshot || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') throw new Error('stale');
      before = { createdAt: decoded.createdAt, id: decoded.id };
    } catch {
      return { accountId, rows: [], nextCursor: null, stalePage: true };
    }
  }
  const rows = (before
    ? db.raw().prepare('SELECT id FROM store_purchase WHERE account_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(accountId, before.createdAt, before.createdAt, before.id, PURCHASE_PAGE + 1)
    : db.raw().prepare('SELECT id FROM store_purchase WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(accountId, PURCHASE_PAGE + 1)
  ) as Array<{ id: string }>;
  const hasNext = rows.length > PURCHASE_PAGE;
  const page = rows.slice(0, PURCHASE_PAGE).map((row) => readStorePurchase(db, accountId, row.id)).filter((row): row is StorePurchaseView => row !== null);
  const last = page.at(-1);
  return {
    accountId,
    rows: page,
    stalePage: false,
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ accountId, snapshot, createdAt: last.createdAt, id: last.id })).toString('base64url') : null
  };
}
