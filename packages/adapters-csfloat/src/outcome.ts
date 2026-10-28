import type { CsfloatReadResult, MutationOutcome } from '@cslytics/ports';
import type { CsfloatRate, CsfloatTransportResult } from './transport.js';

/**
 * How long the venue asks for before the next request: `retry-after` when it sends one, else the
 * time to the reset its `x-ratelimit-reset` names, else nothing (`concept.rate-limits`: every
 * response carries the three headers; a 429 says "follow `reset`").
 */
export function venueWaitMs(rate: CsfloatRate): number | null {
  if (rate.retryAfterMs !== null) return rate.retryAfterMs;
  return rate.resetAtMs === null ? null : Math.max(0, rate.resetAtMs - Date.now());
}

/** The wait a throttle earns when the venue named none: the transport's own cooldown default. */
export const THROTTLE_DEFAULT_WAIT_MS = 60_000;

export function readResult<T>(result: CsfloatTransportResult, parse: (body: unknown) => T | null): CsfloatReadResult<T> {
  if (result.kind === 'failure') return { kind: 'unavailable', cause: result.cause, raw: null };
  if ([401, 403, 404].includes(result.status)) return { kind: 'rejected', status: result.status,
    reason: result.status === 401 ? 'invalid-key' : result.status === 403 ? 'forbidden' : 'not-found', raw: null };
  if (result.status === 429) return { kind: 'throttled', retryAfterMs: venueWaitMs(result.rate), raw: null };
  if (!result.ok) return { kind: 'unavailable', cause: 'transport', raw: { status: result.status } };
  const value = parse(result.body);
  return value === null ? { kind: 'unavailable', cause: 'malformed', raw: null } : { kind: 'ok', value };
}

/**
 * CSFloat's own account of a refusal: `{"code":138,"message":"your account is currently
 * suspended"}` on a listing create from a suspended account (captured 2026-09-22). The
 * code and the sentence are the only two fields read, so a refusal body can never carry a
 * token or an address into a reason string.
 */
export function venueRefusal(body: unknown): { code: number | null; message: string | null } {
  const parsed = record(body);
  const code = typeof parsed?.['code'] === 'number' && Number.isSafeInteger(parsed['code']) ? parsed['code'] : null;
  const message = typeof parsed?.['message'] === 'string' && parsed['message'].trim() ? parsed['message'].slice(0, 200) : null;
  return { code, message };
}

/** A refusal as the venue stated it: the HTTP status and the two body fields `venueRefusal` reads. */
export type CsfloatRefusal = { status: number; code: number | null; message: string | null };

type Explanation = { matches: (refusal: CsfloatRefusal) => boolean; explain: (rate: CsfloatRate) => string };

const said = (refusal: CsfloatRefusal, code: number, phrase: RegExp): boolean =>
  refusal.code === code && phrase.test(refusal.message ?? '');

/**
 * What each documented CSFloat refusal means to the person who asked, and what to do about it.
 *
 * The bodies are the incumbent's captures — `csgomarketv3/csgomarket-documentation/external-apis/
 * csfloat/csfloat-general-failure-responses.md`, the fulfillment notes it links, and the listing
 * bug of 2026-04-19 — plus this repository's own code 138 capture (`fixtures/csfloat/INDEX.md`).
 * The venue's `code` is not a taxonomy: code 4 is "item … is being traded", "invalid trade ids
 * specified" and the `cannot-deliver` refusal alike, and code 6 is both the price floor and "you
 * can only modify listed contracts". So a refusal is told apart by status, code and sentence
 * together, first match wins, and a body nothing here recognises adds nothing — a guessed
 * explanation would send a person to fix the wrong thing.
 */
const EXPLANATIONS: readonly Explanation[] = [
  // 429 `{"code":20,"message":"too many requests, try again later"}`. Nothing was processed; the
  // incumbent stops sending for the account until the reset the headers name.
  { matches: throttled,
    explain: (rate) => `CSFloat is rate limiting this account and nothing was sent.${retryHint(rate)}` },
  // 401 `{"code":1,"message":"invalid api key"}`: the key, not the request.
  { matches: (r) => r.status === 401 || r.code === 1,
    explain: () => 'CSFloat did not accept this account\'s API key. Reconnect CSFloat on the account\'s page under Settings.' },
  // 403 `{"code":17,"message":"item <asset_id> not found in your inventory"}`: CSFloat's copy of the
  // Steam inventory is behind, or the item is not tradable yet (the 2026-04-19 listing bug; the
  // incumbent's `CSFLOAT_INVENTORY_LAG`).
  { matches: (r) => said(r, 17, /not found in your inventory/i),
    explain: () => 'CSFloat cannot see this item in the Steam inventory: it is usually not tradable yet, or CSFloat\'s copy of the inventory is behind. Refresh eligibility on the account\'s CSFloat page and list it again.' },
  // `{"code":138,"message":"your account is currently suspended"}` on a create; `/me` stays 200.
  { matches: (r) => r.code === 138,
    explain: () => 'CSFloat has suspended this account. Its CSFloat page under Settings shows when the suspension ends.' },
  // 422 `{"code":3,"message":"insufficient balance"}` on a buy-order edit whose total was more than
  // the available balance `/me` last showed (captured 2026-09-24).
  { matches: (r) => said(r, 3, /insufficient balance/i),
    explain: () => 'This account\'s CSFloat balance does not cover the order: the most to pay each, times how many are wanted, is more than it holds. Add funds on CSFloat or ask for less.' },
  // 422 `{"code":6,"message":"minimum allowed price is $0.03 USD"}`.
  { matches: (r) => said(r, 6, /minimum allowed price/i),
    explain: () => 'The price is below CSFloat\'s floor. Raise it and list again.' },
  // 422 `{"code":6,"message":"you can only modify listed contracts"}`: a reprice or cancel of a
  // listing the venue no longer holds as listed (seen on a reprice, 2026-05-14).
  { matches: (r) => said(r, 6, /only modify listed contracts/i),
    explain: () => 'CSFloat no longer holds this listing as listed: it may have sold or been delisted. Refresh the stall before repricing or cancelling it.' },
  // `{"code":4,"message":"item <asset_id> is being traded"}`: a relist while a trade is in flight.
  { matches: (r) => said(r, 4, /is being traded/i),
    explain: () => 'CSFloat still has a trade in flight for this item. Wait for that trade to finish before listing it again.' },
  // 400 `{"code":4,"message":"buyer appears to be able to receive trade offers, …"}`: CSFloat
  // refuses `cannot-deliver` when its own check of the buyer disagrees (observed 2026-07-26).
  { matches: (r) => said(r, 4, /able to receive trade offers/i),
    explain: () => 'CSFloat believes the buyer can receive trade offers, so it will not end the sale. The Steam send failed for another reason; send the offer again.' },
  // `{"code":4,"message":"invalid trade ids specified"}` and `{"code":15,"message":"trade not in
  // pending state"}`: the trade is not where this app last saw it.
  { matches: (r) => said(r, 4, /invalid trade ids/i) || said(r, 15, /not in pending state/i),
    explain: () => 'CSFloat no longer has this trade where the app last saw it. Refresh sales before acting on it.' },
  { matches: (r) => r.status === 404,
    explain: () => 'CSFloat no longer has this listing or trade. Refresh the stall before trying again.' },
  { matches: (r) => r.status === 403,
    explain: () => 'CSFloat does not allow this account to do that. Check the account\'s readiness on its CSFloat page under Settings.' }
];

function retryHint(rate: CsfloatRate): string {
  const wait = venueWaitMs(rate);
  return wait === null || wait <= 0 ? ' Try again later.' : ` Try again in ${Math.ceil(wait / 1000)} seconds.`;
}

/** A 429, or the venue's own code for one: nothing was processed, and the headers say when to ask again. */
function throttled(refusal: CsfloatRefusal): boolean {
  return refusal.status === 429 || refusal.code === 20;
}

/**
 * The reason a person reads for a refusal.
 *
 * The venue's own words come first, exactly as captured — "HTTP 400" on its own once sent someone
 * to look for a network problem when the account was suspended — and the explanation follows only
 * when the body is one the catalogue knows.
 */
export function explainRefusal(refusal: CsfloatRefusal, rate: CsfloatRate): string {
  const code = refusal.code === null ? '' : `, code ${refusal.code}`;
  const head = `CSFloat refused the request (HTTP ${refusal.status}${code})${refusal.message ? `: ${refusal.message}` : ''}`;
  const known = EXPLANATIONS.find((entry) => entry.matches(refusal));
  return known ? `${head.replace(/\.$/, '')}. ${known.explain(rate)}` : head;
}

/**
 * Keep response facts small: full trade bodies can contain a buyer's private trade token.
 *
 * A throttle is a refusal of the moment, never of the request: nothing was processed, and the
 * venue's headers say when the same request may be made again. It carries that wait, so the
 * engine can hold the work until then rather than file it as failed. The transport's own
 * cooldown answers a 429 without calling the venue at all, with the remainder of its wait.
 */
export function mutationResult(result: CsfloatTransportResult, accepted: (body: unknown) => boolean): MutationOutcome {
  if (result.kind === 'failure') return { kind: 'AMBIGUOUS', cause: result.cause === 'timeout' ? 'timeout' : 'transport', raw: null };
  if ([400, 401, 403, 404, 409, 422, 429].includes(result.status)) {
    const refusal = { status: result.status, ...venueRefusal(result.body) };
    const reason = explainRefusal(refusal, result.rate);
    const wait = throttled(refusal) ? { retryAfterMs: venueWaitMs(result.rate) ?? THROTTLE_DEFAULT_WAIT_MS } : {};
    return { kind: 'DEFINITIVELY_REJECTED', reason, raw: { status: result.status, ...(refusal.code === null ? {} : { code: refusal.code }) }, ...wait };
  }
  if (!result.ok || !accepted(result.body)) return { kind: 'AMBIGUOUS', cause: 'unclassified', raw: { status: result.status } };
  const body = record(result.body);
  return { kind: 'SUBMITTED', evidence: 'CSFloat acknowledged the attempt; observation required', raw: { status: result.status, ...(typeof body?.['id'] === 'string' ? { id: body['id'] } : {}) } };
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function id(value: unknown): string | null { return typeof value === 'string' && /^\d+$/.test(value) ? value : null; }
export function timestamp(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
