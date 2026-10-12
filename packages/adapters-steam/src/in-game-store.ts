import { Buffer } from 'node:buffer';
import type {
  AccountId,
  MutationOutcome,
  SteamInGameStorePort,
  StoreApprovalOutcome,
  StorePriceSheetRead,
  StorePurchaseInitRequest
} from '@cslytics/ports';
import type { SteamClient, SteamClientSessionPool } from './client-session.js';
import type { SteamGcAdapter } from './gc.js';
import { decodePriceSheet, StoreSheetError } from './in-game-store-sheet.js';
import {
  CS2_APP_ID,
  decodeStoreGetUserDataResponse,
  decodeStorePurchaseCancelResponse,
  decodeStorePurchaseFinalizeResponse,
  decodeStorePurchaseInitResponse,
  encodeStoreGetUserData,
  encodeStorePurchaseCancel,
  encodeStorePurchaseFinalize,
  encodeStorePurchaseInit,
  STORE_MSG,
  STORE_RESULT_OK,
  storeResultName
} from './in-game-store-protocol.js';

/**
 * Where the account holder approves a Steam checkout.
 *
 * The adapter runs in the Engine Runtime, which has no window. The desktop's main process
 * opens Valve's checkout page in an app-owned window seeded with this account's web cookies and
 * reports what the person did; a unit test supplies a scripted host. The URL and the cookies
 * reach this seam and nothing else — never the renderer, never SQLite (STORE-05, STORE-13).
 */
export type CheckoutRequest = {
  accountId: AccountId;
  txnId: string;
  url: string;
  cookies: string[];
  timeoutMs: number;
};

export interface CheckoutHost {
  approve(request: CheckoutRequest): Promise<StoreApprovalOutcome>;
}

/**
 * `purchase_type` on each line item. 1 is the working hypothesis the purchase probe confirms
 * or corrects `[H]`.
 */
export const STORE_PURCHASE_TYPE = 1;

/**
 * The CS2 in-game store over the account's existing GC session.
 *
 * Four raw GC messages and one human step. Everything here reports an attempt: `initPurchase`
 * says the GC opened a transaction, `finalizePurchase` says the GC accepted the finalize, and
 * neither is proof of an item or a charge. Timeouts and undecodable bodies are `AMBIGUOUS`
 * (repository rule 1): an init that timed out may have opened a transaction Steam still holds.
 *
 * The checkout URL an init returns is kept in memory here, keyed by transaction, so that the
 * engine can ask for approval by transaction id and the URL never becomes a stored fact.
 */
export class SteamInGameStoreAdapter implements SteamInGameStorePort {
  private readonly checkouts = new Map<string, string>();

  constructor(
    private readonly gc: SteamGcAdapter,
    private readonly clients: SteamClientSessionPool,
    private readonly checkout: CheckoutHost,
    private readonly responseTimeoutMs = 30_000
  ) {}

  async getPriceSheet(accountId: AccountId, knownVersion = 0): Promise<StorePriceSheetRead> {
    const client = this.gc.client(accountId);
    const currency = client.wallet?.currency ?? 0;
    const payload = await this.exchange(client, STORE_MSG.StoreGetUserData, encodeStoreGetUserData(knownVersion, currency),
      STORE_MSG.StoreGetUserDataResponse, false);
    const body = decodeStoreGetUserDataResponse(payload);
    const observedAt = new Date().toISOString();
    if (body.price_sheet.length === 0) {
      if (knownVersion > 0 && body.price_sheet_version === knownVersion) {
        return { kind: 'not-modified', version: knownVersion, currency, observedAt };
      }
      throw new Error(`StoreGetUserData answered ${storeResultName(body.result)} with no price sheet`);
    }
    const sheet = await decodePriceSheet(body.price_sheet, body.price_sheet_version);
    return { kind: 'sheet', sheet, currency, observedAt };
  }

  async initPurchase(accountId: AccountId, request: StorePurchaseInitRequest): Promise<MutationOutcome> {
    const client = this.liveClient(accountId);
    if (!client) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    const body = encodeStorePurchaseInit({
      country: '',
      language: request.language,
      currency: request.currency,
      line_items: request.lines.map((line) => ({
        item_def_id: line.itemDefId,
        quantity: line.quantity,
        cost_in_local_currency: line.costInLocalCurrencyCents,
        purchase_type: STORE_PURCHASE_TYPE,
        supplemental_data: 0
      }))
    });
    let payload: Buffer;
    try {
      payload = await this.exchange(client, STORE_MSG.StorePurchaseInit, body, STORE_MSG.StorePurchaseInitResponse, true);
    } catch (error) {
      return ambiguous(error);
    }
    let decoded: ReturnType<typeof decodeStorePurchaseInitResponse>;
    try {
      decoded = decodeStorePurchaseInitResponse(payload);
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: 'malformed', raw: message(error) };
    }
    const raw = { result: decoded.result, txnId: decoded.txn_id, itemIds: decoded.item_ids };
    if (decoded.result !== STORE_RESULT_OK || decoded.txn_id === '0' || decoded.txn_id === '') {
      return { kind: 'DEFINITIVELY_REJECTED', reason: `store-init-${storeResultName(decoded.result)}`, raw };
    }
    this.checkouts.set(checkoutKey(accountId, decoded.txn_id), decoded.url);
    return {
      kind: 'SUBMITTED',
      evidence: 'StorePurchaseInitResponse named a transaction; nothing is charged or delivered until it is approved and finalised',
      raw
    };
  }

  async awaitApproval(accountId: AccountId, txnId: string, timeoutMs: number): Promise<StoreApprovalOutcome> {
    const url = this.checkouts.get(checkoutKey(accountId, txnId));
    if (!url) {
      // A restart forgets the URL on purpose: it was never stored. The transaction is still
      // Steam's, and the engine's answer is to cancel it rather than to guess a page.
      throw new Error('No checkout is open for this transaction in this process; cancel the purchase and submit it again');
    }
    const web = await this.clients.getWebSession(accountId);
    return this.checkout.approve({ accountId, txnId, url, cookies: web.cookies, timeoutMs });
  }

  async finalizePurchase(accountId: AccountId, txnId: string): Promise<MutationOutcome> {
    const client = this.liveClient(accountId);
    if (!client) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    let payload: Buffer;
    try {
      payload = await this.exchange(client, STORE_MSG.StorePurchaseFinalize, encodeStorePurchaseFinalize(txnId),
        STORE_MSG.StorePurchaseFinalizeResponse, true);
    } catch (error) {
      return ambiguous(error);
    }
    let decoded: ReturnType<typeof decodeStorePurchaseFinalizeResponse>;
    try {
      decoded = decodeStorePurchaseFinalizeResponse(payload);
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: 'malformed', raw: message(error) };
    }
    const raw = { result: decoded.result, itemIds: decoded.item_ids };
    if (decoded.result !== STORE_RESULT_OK) {
      return { kind: 'DEFINITIVELY_REJECTED', reason: `store-finalize-${storeResultName(decoded.result)}`, raw };
    }
    this.checkouts.delete(checkoutKey(accountId, txnId));
    return {
      kind: 'SUBMITTED',
      evidence: 'StorePurchaseFinalizeResponse accepted; the items are proven only by a later inventory observation',
      raw
    };
  }

  async cancelPurchase(accountId: AccountId, txnId: string): Promise<MutationOutcome> {
    const client = this.liveClient(accountId);
    if (!client) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    let payload: Buffer;
    try {
      // The exchange races the event and the job reply, so whichever way the GC routes the
      // cancel response is fine.
      payload = await this.exchange(client, STORE_MSG.StorePurchaseCancel, encodeStorePurchaseCancel(txnId),
        STORE_MSG.StorePurchaseCancelResponse, true);
    } catch (error) {
      return ambiguous(error);
    }
    let decoded: ReturnType<typeof decodeStorePurchaseCancelResponse>;
    try {
      decoded = decodeStorePurchaseCancelResponse(payload);
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: 'malformed', raw: message(error) };
    }
    const raw = { result: decoded.result };
    if (decoded.result !== STORE_RESULT_OK) {
      return { kind: 'DEFINITIVELY_REJECTED', reason: `store-cancel-${storeResultName(decoded.result)}`, raw };
    }
    this.checkouts.delete(checkoutKey(accountId, txnId));
    return { kind: 'SUBMITTED', evidence: 'StorePurchaseCancelResponse accepted; the reservation returns only on later wallet and inventory evidence', raw };
  }

  private liveClient(accountId: AccountId): SteamClient | null {
    try {
      return this.gc.client(accountId);
    } catch {
      return null;
    }
  }

  /**
   * One request, one reply, whichever way the GC routes it.
   *
   * The reply to `StoreGetUserData` arrives as a plain `receivedFromGC` event (captured
   * 2026-09-13, `route: event`); other replies may come through the job callback. Both paths
   * are watched and the first one wins, so a routing difference between
   * message types never looks like a timeout.
   */
  private exchange(client: SteamClient, sendType: number, body: Buffer, replyType: number, asJob: boolean): Promise<Buffer> {
    const send = client.sendToGC?.bind(client);
    if (!send) return Promise.reject(new Error('This Steam client cannot send Game Coordinator messages'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (payload: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener('receivedFromGC', onEvent);
        resolve(Buffer.from(payload));
      };
      const onEvent = (appid: number, msgType: number, payload: Buffer): void => {
        if (appid === CS2_APP_ID && msgType === replyType) finish(payload);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.removeListener('receivedFromGC', onEvent);
        reject(new Error(`GC message ${replyType} timeout after ${this.responseTimeoutMs}ms`));
      }, this.responseTimeoutMs);
      client.on('receivedFromGC', onEvent);
      try {
        send(CS2_APP_ID, sendType, {}, body, asJob
          ? (_appid: number, msgType: number, payload: Buffer) => { if (msgType === replyType) finish(payload); }
          : undefined);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        client.removeListener('receivedFromGC', onEvent);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

function checkoutKey(accountId: AccountId, txnId: string): string {
  return `${accountId}:${txnId}`;
}

function ambiguous(error: unknown): MutationOutcome {
  const text = message(error);
  return { kind: 'AMBIGUOUS', cause: /timeout/i.test(text) ? 'timeout' : 'transport', raw: text };
}

function message(error: unknown): string {
  if (error instanceof StoreSheetError) return `${error.stage}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
