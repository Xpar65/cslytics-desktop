import type {
  AccountId,
  CredentialVault,
  CsfloatCredentialRef,
  CsfloatListing,
  CsfloatListingItem,
  CsfloatListingPort,
  CsfloatStallPage,
  CsfloatStallResult
} from '@cslytics/ports';
import { CsfloatTransport, requireKey, type CsfloatResponse, type CsfloatTransportResult } from './transport.js';
import { mutationResult, readResult, record } from './outcome.js';

/**
 * An account's own stall.
 *
 * The envelope is `{ data, total_count, total_price }`, captured 2026-09-11 — not the bare array
 * the older examples show, and not the `{ cursor, data }` that `GET /listings` uses. A cursor key
 * was absent on an empty book, so one is read if present and treated as "no more pages" when it
 * is not: concluding a walk from a missing field is exactly the mistake `total_count` exists to
 * catch, and the engine compares the two before it calls anything complete.
 */
export class CsfloatListingAdapter implements CsfloatListingPort {
  constructor(
    private readonly vault: CredentialVault,
    private readonly transport: CsfloatTransport = new CsfloatTransport()
  ) {}

  async getListing(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string) {
    return readResult(await this.transport.send({ accountId, method: 'GET', path: `/listings/${encodeURIComponent(listingId)}`,
      key: await requireKey(this.vault, credential) }), readListing);
  }

  async create(accountId: AccountId, credential: CsfloatCredentialRef, assetId: string, priceCents: number) {
    return mutationResult(await this.transport.send({ accountId, method: 'POST', path: '/listings',
      key: await requireKey(this.vault, credential), body: { asset_id: assetId, type: 'buy_now', price: priceCents, max_offer_discount: 0 } }),
    body => readListing(body) !== null);
  }

  async reprice(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string, priceCents: number) {
    return mutationResult(await this.transport.send({ accountId, method: 'PATCH', path: `/listings/${encodeURIComponent(listingId)}`,
      key: await requireKey(this.vault, credential), body: { price: priceCents } }),
    body => record(body)?.['id'] === listingId && record(body)?.['price'] === priceCents);
  }

  async cancel(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string) {
    return mutationResult(await this.transport.send({ accountId, method: 'DELETE', path: `/listings/${encodeURIComponent(listingId)}`,
      key: await requireKey(this.vault, credential) }), body => record(body)?.['message'] === 'contract delisted');
  }

  async getStallPage(
    accountId: AccountId,
    credential: CsfloatCredentialRef,
    remoteSteamId: string,
    cursor?: string
  ): Promise<CsfloatStallResult> {
    if (!/^\d{17}$/.test(remoteSteamId)) {
      return { kind: 'rejected', reason: 'not-found', status: 0, raw: 'stall needs a 17-digit SteamID64' };
    }
    const key = await requireKey(this.vault, credential);
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const result = await this.transport.send({
      accountId,
      method: 'GET',
      path: `/users/${remoteSteamId}/stall?${query.toString()}`,
      key
    });
    return classifyStall(result);
  }
}

export function classifyStall(result: CsfloatTransportResult): CsfloatStallResult {
  if (result.kind === 'failure') return { kind: 'unavailable', cause: result.cause, raw: result.detail };
  if (result.status === 401) return { kind: 'rejected', reason: 'invalid-key', status: 401, raw: result.body ?? result.text };
  if (result.status === 403) return { kind: 'rejected', reason: 'forbidden', status: 403, raw: result.body ?? result.text };
  if (result.status === 404) return { kind: 'rejected', reason: 'not-found', status: 404, raw: result.body ?? result.text };
  if (result.status === 429) return { kind: 'throttled', retryAfterMs: retryDelay(result), raw: result.body ?? result.text };
  if (!result.ok) return { kind: 'unavailable', cause: 'transport', raw: { status: result.status, body: result.body ?? result.text } };
  const page = readStallPage(result.body);
  return page ? { kind: 'ok', page } : { kind: 'unavailable', cause: 'malformed', raw: result.body ?? result.text.slice(0, 512) };
}

/**
 * A stall page, or null when the body is not one.
 *
 * An empty `data` array is a perfectly good page and must parse: an account with nothing listed
 * is the ordinary case, and refusing to read it would make "no listings" indistinguishable from
 * "could not read". What does *not* parse is a body with no `data` array at all — that is a
 * suspicious success, and the caller turns it into an incomplete observation rather than an
 * empty book.
 */
export function readStallPage(body: unknown): CsfloatStallPage | null {
  if (!isRecord(body) || !Array.isArray(body['data'])) return null;
  const listings: CsfloatListing[] = [];
  for (const entry of body['data']) {
    const listing = readListing(entry);
    // One unreadable row must not silently shrink the book; it fails the page instead.
    if (!listing) return null;
    listings.push(listing);
  }
  return {
    listings,
    totalCount: nonNegativeInteger(body['total_count']),
    nextCursor: typeof body['cursor'] === 'string' && body['cursor'] ? body['cursor'] : null,
    raw: body
  };
}

export function readListing(value: unknown): CsfloatListing | null {
  if (!isRecord(value)) return null;
  const id = text(value['id']);
  const price = nonNegativeInteger(value['price']);
  const item = isRecord(value['item']) ? value['item'] : null;
  const assetId = item ? text(item['asset_id']) : undefined;
  const defIndex = item ? nonNegativeInteger(item['def_index']) : null;
  const hashName = item ? text(item['market_hash_name']) : undefined;
  if (!id || price === null || !assetId || defIndex === null || !hashName) return null;
  const listing: CsfloatListing = {
    listingId: id,
    createdAt: text(value['created_at']) ?? '',
    type: text(value['type']) ?? 'unknown',
    state: text(value['state']) ?? 'unknown',
    priceCents: price,
    item: buildItem(item!, assetId, defIndex, hashName),
    raw: value
  };
  return listing;
}

export function readListingItem(value: unknown): CsfloatListingItem | null {
  if (!isRecord(value)) return null;
  const asset = text(value['asset_id']), def = nonNegativeInteger(value['def_index']), name = text(value['market_hash_name']);
  return asset && def !== null && name ? buildItem(value, asset, def, name) : null;
}

function buildItem(source: Record<string, unknown>, assetId: string, defIndex: number, marketHashName: string): CsfloatListingItem {
  const item: CsfloatListingItem = { assetId, defIndex, marketHashName };
  const paintIndex = nonNegativeInteger(source['paint_index']);
  if (paintIndex !== null) item.paintIndex = paintIndex;
  const paintSeed = nonNegativeInteger(source['paint_seed']);
  if (paintSeed !== null) item.paintSeed = paintSeed;
  if (typeof source['float_value'] === 'number' && Number.isFinite(source['float_value'])) item.floatValue = source['float_value'];
  const quality = nonNegativeInteger(source['quality']);
  if (quality !== null) item.quality = quality;
  if (typeof source['is_stattrak'] === 'boolean') item.isStatTrak = source['is_stattrak'];
  if (typeof source['is_souvenir'] === 'boolean') item.isSouvenir = source['is_souvenir'];
  const tradable = nonNegativeInteger(source['tradable']);
  if (tradable !== null) item.tradable = tradable;
  return item;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryDelay(response: CsfloatResponse): number | null {
  if (response.rate.retryAfterMs !== null) return response.rate.retryAfterMs;
  if (response.rate.resetAtMs !== null) return Math.max(0, response.rate.resetAtMs - Date.now());
  return null;
}
