import type { AccountId, MutationOutcome } from '../kernel.js';

/**
 * The CS2 in-game store: the Game Coordinator's price sheet and its purchase transaction.
 *
 * A purchase is three GC messages with a human step in the middle: `StorePurchaseInit` opens a
 * transaction and names a Steam checkout URL, the account holder approves that checkout, and
 * `StorePurchaseFinalize` asks the GC to deliver. Every step here reports an *attempt*; the
 * items are proved by the inventory surface and the money by the wallet surface, never by the
 * responses this port returns (repository rule 1).
 *
 * Captured live on 2026-09-13 (the capture is cited from the rationale page below):
 * the sheet is keyed by `items_game` internal item names, not def indexes; it carries every
 * currency at once; a version match returns the whole sheet again; and store responses use
 * `EResult`-style results where `1` is success. Rationale: `cslytics-app-docs/steam/in-game-store.md`.
 */

/** One purchasable entry of the sheet, keyed the way the GC keys it, priced in minor units. */
export type StorePriceEntry = {
  /** The `items_game` internal name, e.g. `stattrak_swap_tool`. The host maps it to a def index. */
  key: string;
  itemLink: string;
  categoryTags: string;
  /** Currency label (`USD`, `AUD`, …) → integer minor units. The label set is whatever the GC sent. */
  prices: Record<string, number>;
  salePrices?: Record<string, number>;
};

export type StorePriceSheet = {
  version: number;
  /** Currency label → the GC's own conversion ratio, in the sheet's fixed-point units. */
  currencies: Record<string, number>;
  entries: StorePriceEntry[];
};

export type StorePriceSheetRead =
  | { kind: 'sheet'; sheet: StorePriceSheet; currency: number; observedAt: string }
  | { kind: 'not-modified'; version: number; currency: number; observedAt: string };

export type StorePurchaseLine = {
  itemDefId: number;
  quantity: number;
  /** The total for the line — unit price times quantity — in the account's wallet currency. */
  costInLocalCurrencyCents: number;
};

export type StorePurchaseInitRequest = {
  /** Steam `ECurrencyCode`, the same integer the wallet surface reports. */
  currency: number;
  language: number;
  lines: StorePurchaseLine[];
};

/** What a `SUBMITTED` init or finalize carries in `raw`. The checkout URL is deliberately absent. */
export type StorePurchaseInitRaw = { result: number; txnId: string; itemIds: string[] };
export type StorePurchaseFinalizeRaw = { result: number; itemIds: string[] };

export type StoreApprovalOutcome =
  | { kind: 'approved'; transactionId: string | null }
  | { kind: 'declined' }
  | { kind: 'closed' }
  | { kind: 'timeout' };

export interface SteamInGameStorePort {
  /**
   * Reads the price sheet for this account's GC session. `knownVersion` is sent back to the GC;
   * the live GC answered a matching version with the full sheet again (2026-09-13), so the
   * not-modified branch exists for the protocol, not because it was seen.
   */
  getPriceSheet(accountId: AccountId, knownVersion?: number): Promise<StorePriceSheetRead>;
  initPurchase(accountId: AccountId, request: StorePurchaseInitRequest): Promise<MutationOutcome>;
  /**
   * Waits for the account holder to approve, decline or dismiss Steam's checkout for one
   * transaction. A wait, not a mutation: it sends nothing to Steam itself. The checkout URL never
   * leaves the adapter; a caller names the transaction and gets an outcome.
   */
  awaitApproval(accountId: AccountId, txnId: string, timeoutMs: number): Promise<StoreApprovalOutcome>;
  finalizePurchase(accountId: AccountId, txnId: string): Promise<MutationOutcome>;
  cancelPurchase(accountId: AccountId, txnId: string): Promise<MutationOutcome>;
}
