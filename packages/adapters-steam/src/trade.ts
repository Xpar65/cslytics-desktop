import type {
  AccountId,
  ExecutedTrade,
  SteamAuthPort,
  SteamTradePort,
  TradeHistoryCursor,
  TradeHistoryPage,
  TradeLine,
  TradeOffer,
  TradeOffersPage
} from '@cslytics/ports';
import type { HoldDurations, MutationOutcome, SendOfferRequest, TradeInventoryPage, TradeUrl } from '@cslytics/ports';
import { tradeMutationOutcome } from './trade-outcome.js';
import { cookieHeader, cookieJar, mergeSetCookies } from './market.js';
export { tradeMutationOutcome } from './trade-outcome.js';

const IECON_BASE = 'https://api.steampowered.com/IEconService';

/**
 * IEconService trade reads, authenticated with the session's own JWT.
 *
 * Valve documents a publisher Web API `key` on these methods. This app has none and registers
 * none: the JWT inside `steamLoginSecure` is passed as `access_token`, the path captured
 * live on 2026-09-09 — both methods answered HTTP 200
 * with no key registered (`fixtures/steam/contracts/ieconservice-p-reads-live.json`). Rule 2 is
 * untouched by this: a session token is not a 2FA secret, and nothing here reads a vault.
 *
 * Field names come from the captured bodies, not from the public documentation page:
 * `tradeofferid` and `tradeid` are separate, lines carry `appid`/`contextid`/`assetid`/
 * `classid`/`instanceid`/`amount`, and history reports `more` plus `total_trades` rather than a
 * cursor (`cslytics-app-docs/steam/trades.md`).
 *
 * Steam's times are epoch seconds. They become UTC ISO-8601 here, because everything downstream
 * stores UTC and a bare number invites a local-time bug that only shows up in a timezone nobody
 * on the team lives in.
 */
export class SteamTradeAdapter implements SteamTradePort {
  constructor(
    private readonly auth: SteamAuthPort,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async getMyTradeUrl(accountId: AccountId): Promise<TradeUrl> {
    const session = await this.auth.getWebSession(accountId);
    const response = await this.community(accountId, `/profiles/${session.steamId64}/tradeoffers/privacy`);
    if (!response.ok) throw new Error(`Trade URL read failed: HTTP ${response.status}`);
    const html = (await response.text()).replaceAll('&amp;', '&');
    const matches = [...html.matchAll(/https:\/\/steamcommunity\.com\/tradeoffer\/new\/?\?partner=(\d+)&token=([A-Za-z0-9_-]+)/g)];
    const own = matches.find(match => (76561197960265728n + BigInt(match[1]!)).toString() === session.steamId64);
    if (!own) throw new Error('Trade URL is absent or belongs to another account');
    return { partnerAccountId: own[1]!, steamId64: session.steamId64, token: own[2]! };
  }

  async getHoldDurations(accountId: AccountId, partnerSteamId64: string, token: string): Promise<HoldDurations> {
    const raw = await this.get(accountId, 'GetTradeHoldDurations/v1', { steamid_target: partnerSteamId64, trade_offer_access_token: token });
    const mine = raw?.response?.my_escrow?.escrow_end_duration_seconds;
    const theirs = raw?.response?.their_escrow?.escrow_end_duration_seconds;
    if (!Number.isSafeInteger(mine) || mine < 0 || !Number.isSafeInteger(theirs) || theirs < 0) {
      throw new Error('Trade hold durations are unknown');
    }
    return { mySeconds: mine, theirSeconds: theirs };
  }

  async getTradeInventoryPage(accountId: AccountId, cursor?: string): Promise<TradeInventoryPage> {
    const session = await this.auth.getWebSession(accountId);
    const query = new URLSearchParams({ l: 'english', count: '2000', ...(cursor ? { start_assetid: cursor } : {}) });
    const response = await this.community(accountId, `/inventory/${session.steamId64}/730/2?${query}`);
    if (!response.ok) throw new Error(`Trade inventory read failed: HTTP ${response.status}`);
    const raw = await response.json() as any;
    if (raw?.success !== 1 || !Number.isSafeInteger(raw.total_inventory_count) || raw.total_inventory_count < 0
      || (raw.assets !== undefined && !Array.isArray(raw.assets)) || (raw.descriptions !== undefined && !Array.isArray(raw.descriptions))
      || (raw.more_items !== undefined && raw.more_items !== 0 && raw.more_items !== 1)) throw new Error('Malformed trade inventory');
    const descriptions = describeIndex(raw.descriptions);
    const items = array(raw.assets).map(asset => {
      const line = normalizeLine(asset);
      const desc = descriptions.get(`${line.classId}_${line.instanceId}`);
      if (line.appId !== 730 || line.contextId !== '2' || !/^\d+$/.test(line.assetId)
        || (desc?.tradable !== 0 && desc?.tradable !== 1)) throw new Error('Trade eligibility is unknown');
      return { appId: 730 as const, contextId: '2' as const, assetId: line.assetId, quantity: line.quantity,
        classId: line.classId, instanceId: line.instanceId, tradable: desc.tradable === 1,
        name: typeof desc.market_hash_name === 'string' ? desc.market_hash_name : String(desc.name ?? ''),
        // Steam's own "can this be sold on the market at all"; no GC attribute says it (holdings plan D7).
        ...(desc.marketable === 0 || desc.marketable === 1 ? { marketable: desc.marketable === 1 } : {}) };
    });
    const nextCursor = raw.more_items === 1 ? String(raw.last_assetid ?? '') : null;
    if (nextCursor !== null && (!/^\d+$/.test(nextCursor) || nextCursor === cursor || !items.length)) throw new Error('Trade inventory cursor did not advance');
    return { items, total: raw.total_inventory_count, nextCursor };
  }

  async sendOffer(accountId: AccountId, request: SendOfferRequest): Promise<MutationOutcome> {
    if (!/^\d{17}$/.test(request.partnerSteamId64) || !/^[A-Za-z0-9_-]+$/.test(request.token)
      || !request.give.length || request.give.length > 200 || new Set(request.give.map(item => item.assetId)).size !== request.give.length
      || request.give.some(item => item.appId !== 730 || item.contextId !== '2' || !/^\d+$/.test(item.assetId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
      throw new Error('Invalid transfer assets or destination');
    }
    const partner = (BigInt(request.partnerSteamId64) - 76561197960265728n).toString();
    const query = new URLSearchParams({ partner, token: request.token });
    const side = (assets: unknown[]) => ({ assets, currency: [], ready: false });
    return this.mutate(accountId, 'send', `/tradeoffer/new/send?${query}`, {
      serverid: '1', partner: request.partnerSteamId64, tradeoffermessage: request.message,
      json_tradeoffer: JSON.stringify({ newversion: true, version: 2,
        me: side(request.give.map(item => ({ appid: 730, contextid: '2', amount: item.quantity, assetid: item.assetId }))), them: side([]) }),
      captcha: '', trade_offer_create_params: JSON.stringify({ trade_offer_access_token: request.token })
    }, `/tradeoffer/new/?${query}`);
  }

  acceptOffer(accountId: AccountId, offerId: string, partnerSteamId64: string): Promise<MutationOutcome> {
    if (!/^\d+$/.test(offerId) || !/^\d{17}$/.test(partnerSteamId64)) throw new Error('Invalid trade accept identifiers');
    return this.mutate(accountId, 'accept', `/tradeoffer/${offerId}/accept`, {
      serverid: '1', tradeofferid: offerId, partner: partnerSteamId64, captcha: ''
    }, `/tradeoffer/${offerId}/`);
  }

  cancelOffer(accountId: AccountId, offerId: string): Promise<MutationOutcome> {
    if (!/^\d+$/.test(offerId)) throw new Error('Invalid trade offer identifier');
    return this.mutate(accountId, 'cancel', `/tradeoffer/${offerId}/cancel`, {}, `/tradeoffer/${offerId}/`);
  }

  /**
   * One Community request. A mutation never follows a redirect; a read follows a few within
   * steamcommunity.com.
   *
   * An account with a custom profile URL answers `/profiles/<id>/tradeoffers/privacy` with a 302 to
   * `/id/<name>/tradeoffers/privacy` (`fixtures/steam/contracts/community-profile-vanity-redirect-live.json`).
   * Under `redirect: 'error'` that was a bare `fetch failed`, so no trade link was ever stored for
   * the default test account and every transfer to it was refused "Connect the destination to obtain its
   * trade link", however often it was refreshed (2026-09-17). A hop to the sign-in page is not
   * followed: it means Steam did not accept the session, which is not a page to read a link from.
   *
   * Each hop carries the cookies the previous one set. Node's fetch keeps none across a redirect,
   * and following the 302 without them looped until the hop limit on the same account — the dance
   * `SteamMarketAdapter` already follows for `/market/`.
   */
  private async community(accountId: AccountId, path: string, fields?: Record<string, string>, referer = '/my/tradeoffers/') {
    const session = await this.auth.getWebSession(accountId);
    const jar = cookieJar(session.cookies);
    const request = (url: URL) => this.fetchImpl(url, {
      method: fields ? 'POST' : 'GET', redirect: fields ? 'error' : 'manual',
      headers: { Cookie: cookieHeader([...jar.values()]),
        Origin: 'https://steamcommunity.com', Referer: `https://steamcommunity.com${referer}`,
        'User-Agent': 'Mozilla/5.0 CSlyticsTradingDesktop/0.1',
        ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
      ...(fields ? { body: new URLSearchParams({ ...fields, sessionid: session.sessionId }) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let url = new URL(path, 'https://steamcommunity.com');
    if (fields) return request(url);
    // Paths only in these messages: a read's query can carry a trade token.
    const hops = [url.pathname];
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await request(url);
      mergeSetCookies(jar, response);
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) return response;
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.hostname !== 'steamcommunity.com') throw new Error('Steam Community redirected a trade read off the Community');
      if (next.pathname.startsWith('/login')) throw new Error('Steam Community sent a trade read to sign-in; the web session was not accepted');
      hops.push(next.pathname);
      url = next;
    }
    throw new Error(`Steam Community redirected a trade read too many times (${hops.join(' → ')})`);
  }

  private async mutate(accountId: AccountId, operation: 'send' | 'accept' | 'cancel', path: string, fields: Record<string, string>, referer: string): Promise<MutationOutcome> {
    // Steam accepts duplicate offers for the same asset. NEVER retry this HTTP call.
    try {
      const response = await this.community(accountId, path, fields, referer);
      const body = await response.json().catch(() => null);
      return tradeMutationOutcome(operation, response.status, body);
    } catch {
      // Fetch errors can contain the URL (and its trade token). Keep them out of attempts.
      return { kind: 'AMBIGUOUS', cause: 'transport', raw: { operation, error: 'trade-transport-failed' } };
    }
  }

  async getTradeOffersPage(accountId: AccountId, cursor = 0): Promise<TradeOffersPage> {
    const raw = await this.get(accountId, 'GetTradeOffers/v1', {
      get_sent_offers: '1',
      get_received_offers: '1',
      active_only: '0',
      // Descriptions name the lines no inventory walk can: the other party's items in an offer, and
      // ours before a walk has matched them. They are the same `classid_instanceid` table history sends.
      get_descriptions: '1',
      cursor: String(cursor)
    });
    const response = raw?.response;
    if (!response || typeof response !== 'object') throw new Error('GetTradeOffers returned no response object');
    const next = (response as { next_cursor?: unknown }).next_cursor;
    for (const field of ['trade_offers_sent','trade_offers_received']) {
      if ((response as any)[field] !== undefined && !Array.isArray((response as any)[field])) throw new Error('Malformed trade offers bucket');
    }
    if (next !== undefined && (!Number.isSafeInteger(next) || Number(next) < 0)) throw new Error('Malformed trade offers cursor');
    const descriptions = describeIndex((response as { descriptions?: unknown }).descriptions);
    return {
      success: true,
      sent: array((response as { trade_offers_sent?: unknown }).trade_offers_sent).map((offer) => normalizeOffer(offer, 'sent', descriptions)),
      received: array((response as { trade_offers_received?: unknown }).trade_offers_received).map((offer) => normalizeOffer(offer, 'received', descriptions)),
      // Steam sends `next_cursor: 0` on the last page. Zero is "no more", not "start again".
      nextCursor: typeof next === 'number' && next > 0 ? next : null
    };
  }

  async getTradeHistoryPage(accountId: AccountId, cursor: TradeHistoryCursor): Promise<TradeHistoryPage> {
    if (!Number.isInteger(cursor.maxTrades) || cursor.maxTrades < 1 || cursor.maxTrades > 500) {
      throw new Error('maxTrades must be between 1 and 500');
    }
    const raw = await this.get(accountId, 'GetTradeHistory/v1', {
      max_trades: String(cursor.maxTrades),
      start_after_time: String(cursor.afterTimeSeconds),
      start_after_tradeid: cursor.afterTradeId,
      navigating_back: '1',
      get_descriptions: '1',
      include_failed: '1',
      include_total: '1'
    });
    const response = raw?.response;
    if (!response || typeof response !== 'object') throw new Error('GetTradeHistory returned no response object');
    const descriptions = describeIndex((response as { descriptions?: unknown }).descriptions);
    const total = (response as { total_trades?: unknown }).total_trades;
    if (!Array.isArray((response as any).trades) && (response as any).trades !== undefined) throw new Error('Malformed trade history bucket');
    if ((response as any).more !== undefined && typeof (response as any).more !== 'boolean') throw new Error('Malformed trade history continuation');
    return {
      success: true,
      trades: array((response as { trades?: unknown }).trades).map((trade) => normalizeTrade(trade, descriptions)),
      more: (response as { more?: unknown }).more === true,
      totalTrades: typeof total === 'number' && Number.isSafeInteger(total) ? total : null
    };
  }

  private async get(accountId: AccountId, method: string, query: Record<string, string>): Promise<any> {
    const session = await this.auth.getWebSession(accountId);
    const token = accessTokenFromCookies(session.cookies);
    if (!token) throw new Error('No steamLoginSecure access token in the web session');
    const url = new URL(`${IECON_BASE}/${method}/`);
    url.searchParams.set('access_token', token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 CSlyticsTradingDesktop/0.1' },
      signal: AbortSignal.timeout(this.timeoutMs)
    }).catch(() => { throw new Error(`${method} transport failed`); });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`);
    try {
      return text.trim() ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${method} returned a malformed body`);
    }
  }
}

/**
 * The JWT inside `steamLoginSecure`, which the cookie stores as `steamid||token`.
 *
 * Exported so `tests/unit/trade-adapter.test.ts` can pin the parse without a session: the value
 * shape is the load-bearing part, and getting it wrong shows up as a 401 rather than a crash.
 */
export function accessTokenFromCookies(cookies: readonly string[]): string | null {
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== 'steamLoginSecure') continue;
    const value = decodeURIComponent(pair.slice(separator + 1).trim());
    const token = value.includes('||') ? value.slice(value.indexOf('||') + 2) : value;
    return token.includes('.') ? token : null;
  }
  return null;
}

function normalizeOffer(raw: any, direction: 'sent' | 'received', descriptions: Map<string, any>): TradeOffer {
  const offerId = String(raw?.tradeofferid ?? '');
  if (!offerId) throw new Error('Trade offer has no tradeofferid');
  const give = array(raw?.items_to_give).map((line) => describeLine(normalizeLine(line), descriptions));
  const receive = array(raw?.items_to_receive).map((line) => describeLine(normalizeLine(line), descriptions));
  return {
    offerId,
    ...(raw?.tradeid ? { tradeId: String(raw.tradeid) } : {}),
    counterpartyId: String(raw?.accountid_other ?? ''),
    direction,
    state: integer(raw?.trade_offer_state, 'trade_offer_state'),
    ...(typeof raw?.confirmation_method === 'number' ? { confirmationMethod: raw.confirmation_method } : {}),
    ...(seconds(raw?.escrow_end_date) ? { escrowUntil: seconds(raw.escrow_end_date)! } : {}),
    ...(seconds(raw?.expiration_time) ? { expiresAt: seconds(raw.expiration_time)! } : {}),
    ...(seconds(raw?.settlement_date) ? { settlementDate: seconds(raw.settlement_date)! } : {}),
    createdAt: seconds(raw?.time_created) ?? new Date(0).toISOString(),
    updatedAt: seconds(raw?.time_updated) ?? seconds(raw?.time_created) ?? new Date(0).toISOString(),
    ...(typeof raw?.message === 'string' && raw.message ? { message: raw.message } : {}),
    // Both buckets are written from *this* account's perspective, sent or received: a received
    // offer's `items_to_give` is still what this account would hand over.
    give,
    receive,
    raw
  };
}

function normalizeTrade(raw: any, descriptions: Map<string, any>): ExecutedTrade {
  const tradeId = String(raw?.tradeid ?? '');
  if (!tradeId) throw new Error('Trade history row has no tradeid');
  return {
    tradeId,
    counterpartySteamId64: String(raw?.steamid_other ?? ''),
    status: integer(raw?.status, 'status'),
    initiatedAt: seconds(raw?.time_init) ?? new Date(0).toISOString(),
    ...(seconds(raw?.time_mod) ? { updatedAt: seconds(raw.time_mod)! } : {}),
    ...(seconds(raw?.time_settlement) ? { settledAt: seconds(raw.time_settlement)! } : {}),
    given: array(raw?.assets_given).map((line) => describeLine(normalizeLine(line), descriptions)),
    received: array(raw?.assets_received).map((line) => describeLine(normalizeLine(line), descriptions)),
    raw
  };
}

function normalizeLine(raw: any): TradeLine {
  if (!Number.isSafeInteger(Number(raw?.amount)) || Number(raw.amount) < 1 || !raw?.assetid || !raw?.contextid) throw new Error('Malformed trade asset or quantity');
  return {
    appId: integer(raw?.appid, 'appid'),
    contextId: String(raw?.contextid ?? ''),
    assetId: String(raw?.assetid ?? ''),
    classId: String(raw?.classid ?? ''),
    instanceId: String(raw?.instanceid ?? '0'),
    quantity: Number.isSafeInteger(Number(raw?.amount)) && Number(raw?.amount) > 0 ? Number(raw.amount) : 1,
    ...(raw?.new_assetid ? { newAssetId: String(raw.new_assetid) } : {}),
    ...(raw?.missing === true ? { missing: true } : {})
  };
}

/** Descriptions are keyed `${classid}_${instanceid}`, exactly as inventory bodies are. */
function describeLine(line: TradeLine, descriptions: Map<string, any>): TradeLine {
  const description = descriptions.get(`${line.classId}_${line.instanceId}`);
  if (!description) return line;
  return {
    ...line,
    ...(typeof description.market_hash_name === 'string' ? { marketHashName: description.market_hash_name } : {}),
    ...(typeof description.type === 'string' ? { type: description.type } : {}),
    ...(description.tradable !== undefined ? { tradable: Boolean(description.tradable) } : {}),
    ...(description.marketable !== undefined ? { marketable: Boolean(description.marketable) } : {})
  };
}

function describeIndex(raw: unknown): Map<string, any> {
  const index = new Map<string, any>();
  for (const entry of array(raw)) {
    if (entry?.classid === undefined) continue;
    index.set(`${String(entry.classid)}_${String(entry.instanceid ?? '0')}`, entry);
  }
  return index;
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Trade field ${field} is not an integer`);
  return parsed;
}

/** Epoch seconds to UTC ISO-8601. Zero and absent both mean "Steam did not say". */
function seconds(value: unknown): string | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return new Date(parsed * 1000).toISOString();
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}
