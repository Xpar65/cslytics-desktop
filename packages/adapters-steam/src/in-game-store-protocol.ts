import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

// protobufjs is CommonJS with named typings; `createRequire` is what keeps its runtime shape and
// its types in agreement under NodeNext, where a namespace import can lose `Type` at runtime.
const require = createRequire(import.meta.url);
const protobuf = require('protobufjs') as typeof import('protobufjs');

/**
 * The GC store messages, defined in code rather than loaded from a `.proto` file.
 *
 * `globaloffensive` ships these protos but its generated `CGCStorePurchaseInit_LineItem` is a
 * generation behind (no `supplemental_data`, cost as uint32), and loading a `.proto` from disk
 * inside a packaged utility process is one more asset to ship. Ten small messages with the
 * wire numbers written out are easier to audit against the fixture than either.
 *
 * Ids: `globaloffensive/language.js`.
 */
export const STORE_MSG = {
  StoreGetUserData: 2500,
  StoreGetUserDataResponse: 2501,
  StorePurchaseFinalize: 2504,
  StorePurchaseFinalizeResponse: 2505,
  StorePurchaseCancel: 2506,
  StorePurchaseCancelResponse: 2507,
  StorePurchaseQueryTxn: 2508,
  StorePurchaseQueryTxnResponse: 2509,
  StorePurchaseInit: 2510,
  StorePurchaseInitResponse: 2511,
  ClientWelcome: 4004
} as const;

export const CS2_APP_ID = 730;

/**
 * Store responses carry `EResult`, not `EGCMsgResponse`: the live `StoreGetUserDataResponse`
 * of 2026-09-13 answered `result: 1` beside a 5,864-byte sheet. Under `EGCMsgResponse` that
 * same `1` would read as `Denied`. Only the store-relevant names are spelled out; anything
 * else keeps its number.
 */
export const STORE_RESULT_OK = 1;
export const STORE_RESULT_NAME: Readonly<Record<number, string>> = {
  1: 'OK', 2: 'Fail', 3: 'NoConnection', 8: 'InvalidParam', 9: 'FileNotFound', 10: 'Busy', 11: 'InvalidState',
  15: 'AccessDenied', 16: 'Timeout', 20: 'ServiceUnavailable', 21: 'NotLoggedOn', 25: 'LimitExceeded',
  26: 'Revoked', 27: 'Expired', 28: 'AlreadyRedeemed', 29: 'DuplicateRequest', 33: 'AccountNotFeatured',
  36: 'InsufficientPrivilege', 42: 'InvalidAmount', 43: 'LimitExceededAmount', 84: 'RateLimitExceeded'
};

export function storeResultName(result: number): string {
  return STORE_RESULT_NAME[result] ?? `EResult ${result}`;
}

type FieldSpec = readonly [name: string, id: number, type: string, rule?: 'repeated'];

const root = new protobuf.Root();

function define(name: string, fields: readonly FieldSpec[]): protobuf.Type {
  const type = new protobuf.Type(name);
  for (const [fieldName, id, fieldType, rule] of fields) {
    type.add(new protobuf.Field(fieldName, id, fieldType, rule));
  }
  root.add(type);
  return type;
}

const LineItem = define('CGCStorePurchaseInit_LineItem', [
  ['item_def_id', 1, 'uint32'],
  ['quantity', 2, 'uint32'],
  ['cost_in_local_currency', 3, 'uint64'],
  ['purchase_type', 4, 'uint32'],
  ['supplemental_data', 5, 'uint64']
]);

const StoreGetUserData = define('CMsgStoreGetUserData', [
  ['price_sheet_version', 1, 'fixed32'],
  ['currency', 2, 'int32']
]);

const StoreGetUserDataResponse = define('CMsgStoreGetUserDataResponse', [
  ['result', 1, 'int32'],
  ['currency_deprecated', 2, 'int32'],
  ['country_deprecated', 3, 'string'],
  ['price_sheet_version', 4, 'fixed32'],
  ['price_sheet', 8, 'bytes']
]);

const StorePurchaseInit = define('CMsgGCStorePurchaseInit', [
  ['country', 1, 'string'],
  ['language', 2, 'int32'],
  ['currency', 3, 'int32'],
  ['line_items', 4, 'CGCStorePurchaseInit_LineItem', 'repeated']
]);

const StorePurchaseInitResponse = define('CMsgGCStorePurchaseInitResponse', [
  ['result', 1, 'int32'],
  ['txn_id', 2, 'uint64'],
  ['url', 3, 'string'],
  ['item_ids', 4, 'uint64', 'repeated']
]);

const StorePurchaseFinalize = define('CMsgGCStorePurchaseFinalize', [['txn_id', 1, 'uint64']]);

const StorePurchaseFinalizeResponse = define('CMsgGCStorePurchaseFinalizeResponse', [
  ['result', 1, 'uint32'],
  ['item_ids', 2, 'uint64', 'repeated']
]);

const StorePurchaseCancel = define('CMsgGCStorePurchaseCancel', [['txn_id', 1, 'uint64']]);

const StorePurchaseCancelResponse = define('CMsgGCStorePurchaseCancelResponse', [['result', 1, 'uint32']]);

/**
 * Only the welcome fields the store needs. protobuf decoding skips unknown field numbers, so
 * a partial definition reads a full `CMsgClientWelcome` without describing the SO caches.
 */
const ClientWelcomeCurrency = define('CMsgClientWelcomeCurrency', [
  ['currency', 8, 'uint32'],
  ['txn_country_code', 11, 'string']
]);

void LineItem;

const TO_OBJECT = { longs: String, defaults: true, arrays: true } as const;

/**
 * Encodes with default-valued scalars left out: a `country` of "" or a `supplemental_data` of
 * 0 is absent rather than present-and-empty. `fromObject` rather than `verify` first, because
 * uint64 ids travel as strings and `verify` refuses those while `fromObject` converts them.
 */
function encode(type: protobuf.Type, value: Record<string, unknown>): Buffer {
  return Buffer.from(type.encode(type.fromObject(withoutDefaults(value))).finish());
}

function withoutDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === 0 || field === '' || field === '0' || field === false || field === null || field === undefined) continue;
    if (Array.isArray(field)) out[key] = field.map((item) => (item && typeof item === 'object' ? withoutDefaults(item as Record<string, unknown>) : item));
    else out[key] = field;
  }
  return out;
}

function decode<T>(type: protobuf.Type, payload: Uint8Array): T {
  return type.toObject(type.decode(payload), TO_OBJECT) as T;
}

export type StoreGetUserDataResponseBody = {
  result: number;
  currency_deprecated: number;
  country_deprecated: string;
  price_sheet_version: number;
  price_sheet: Buffer;
};

export type StorePurchaseInitResponseBody = { result: number; txn_id: string; url: string; item_ids: string[] };
export type StorePurchaseFinalizeResponseBody = { result: number; item_ids: string[] };
export type StorePurchaseCancelResponseBody = { result: number };
export type ClientWelcomeCurrencyBody = { currency: number; txn_country_code: string };

export type StorePurchaseInitBody = {
  country: string;
  language: number;
  currency: number;
  line_items: Array<{
    item_def_id: number;
    quantity: number;
    cost_in_local_currency: string | number;
    purchase_type: number;
    supplemental_data: string | number;
  }>;
};

export function encodeStoreGetUserData(priceSheetVersion: number, currency: number): Buffer {
  return encode(StoreGetUserData, { price_sheet_version: priceSheetVersion, currency });
}

export function decodeStoreGetUserDataResponse(payload: Uint8Array): StoreGetUserDataResponseBody {
  const body = decode<StoreGetUserDataResponseBody>(StoreGetUserDataResponse, payload);
  return { ...body, price_sheet: Buffer.from(body.price_sheet ?? new Uint8Array()) };
}

export function encodeStorePurchaseInit(body: StorePurchaseInitBody): Buffer {
  return encode(StorePurchaseInit, body);
}

export function decodeStorePurchaseInitResponse(payload: Uint8Array): StorePurchaseInitResponseBody {
  return decode<StorePurchaseInitResponseBody>(StorePurchaseInitResponse, payload);
}

export function encodeStorePurchaseFinalize(txnId: string): Buffer {
  return encode(StorePurchaseFinalize, { txn_id: txnId });
}

export function decodeStorePurchaseFinalizeResponse(payload: Uint8Array): StorePurchaseFinalizeResponseBody {
  return decode<StorePurchaseFinalizeResponseBody>(StorePurchaseFinalizeResponse, payload);
}

export function encodeStorePurchaseCancel(txnId: string): Buffer {
  return encode(StorePurchaseCancel, { txn_id: txnId });
}

export function decodeStorePurchaseCancelResponse(payload: Uint8Array): StorePurchaseCancelResponseBody {
  return decode<StorePurchaseCancelResponseBody>(StorePurchaseCancelResponse, payload);
}

export function decodeClientWelcomeCurrency(payload: Uint8Array): ClientWelcomeCurrencyBody {
  return decode<ClientWelcomeCurrencyBody>(ClientWelcomeCurrency, payload);
}
