import type {
  AccountId,
  BillingAddress,
  BuyOrderId,
  BuyOrderRequest,
  BuyOrderStatus,
  MarketBuyOrder,
  MarketListing,
  MutationOutcome,
  MyListingsPage,
  MyHistoryPage,
  NotModified,
  OrderBook,
  OrderBookLevel,
  SteamAuthPort,
  SteamMarketPort,
  TaxRate,
  Wallet
} from '@cslytics/ports';

const MARKET_BASE = 'https://steamcommunity.com/market';

export class SteamMarketAdapter implements SteamMarketPort {
  constructor(
    private readonly auth: SteamAuthPort,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async getMyHistoryPage(accountId: AccountId, start: number, count: number): Promise<MyHistoryPage> {
    const response = await this.request(accountId, `${MARKET_BASE}/myhistory/render/?norender=1&start=${start}&count=${count}`, {
      headers: { Accept: '*/*', Referer: `${MARKET_BASE}/` }
    });
    const raw = await parseJson(response);
    if (!response.ok || (raw?.success !== true && raw?.success !== 1) || !Array.isArray(raw.events)
      || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0) throw new Error(`myhistory failed or malformed: HTTP ${response.status}`);
    return {
      success: true, start: Number(raw.start ?? start), totalCount: raw.total_count,
      events: raw.events.map((event: any) => {
        if (typeof event.listingid !== 'string' || !event.listingid || !Number.isInteger(event.event_type)
          || !Number.isFinite(event.time_event) || event.time_event < 0) throw new Error('Malformed market history event');
        const purchaseId = typeof event.purchaseid === 'string' ? event.purchaseid : undefined;
        return {
          eventId: [event.listingid, purchaseId ?? '', event.event_type, event.time_event, event.time_event_fraction ?? 0].join(':'),
          listingId: event.listingid, ...(purchaseId ? { purchaseId } : {}), eventType: event.event_type,
          occurredAt: new Date(event.time_event * 1000 + Math.floor(Number(event.time_event_fraction ?? 0) / 1_000_000)).toISOString(),
          raw: { event, listing: raw.listings?.[event.listingid] ?? null,
            purchase: purchaseId ? raw.purchases?.[`${event.listingid}_${purchaseId}`] ?? null : null }
        };
      })
    };
  }

  async getMyListingsPage(accountId: AccountId, start: number, count: number): Promise<MyListingsPage> {
    const response = await this.request(accountId, `${MARKET_BASE}/mylistings/render/?norender=1&start=${start}&count=${count}&l=&query=`, {
      headers: { Accept: '*/*', Referer: `${MARKET_BASE}/` }
    });
    const raw = await parseJson(response);
    if (!response.ok || raw?.success !== true) throw new Error(`mylistings failed: HTTP ${response.status}`);
    const assets = raw.assets ?? {};
    const mapListing = (listing: any): MarketListing => normalizeListing(listing, assets);
    return {
      success: true,
      start: Number(raw.start ?? start),
      totalCount: Number(raw.total_count),
      listings: array(raw.listings).map(mapListing),
      listingsOnHold: array(raw.listings_on_hold).map(mapListing),
      listingsToConfirm: array(raw.listings_to_confirm).map(mapListing),
      numActiveListings: Number(raw.num_active_listings ?? 0),
      buyOrders: array(raw.buy_orders).map(normalizeBuyOrder)
    };
  }

  async createSellListing(accountId: AccountId, assetId: string, priceReceiveCents: number): Promise<MutationOutcome> {
    if (!Number.isInteger(priceReceiveCents) || priceReceiveCents <= 0) {
      return { kind: 'DEFINITIVELY_REJECTED', reason: 'price-must-be-positive-integer-cents', raw: null };
    }
    const session = await this.auth.getWebSession(accountId);
    const body = form({
      sessionid: session.sessionId,
      appid: 730,
      contextid: 2,
      assetid: assetId,
      amount: 1,
      price: priceReceiveCents
    });
    try {
      const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/sellitem/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `https://steamcommunity.com/profiles/${session.steamId64}/inventory`
        },
        body
      });
      const raw = await parseJson(response);
      if (raw?.success === true) {
        return { kind: 'SUBMITTED', evidence: raw.needs_mobile_confirmation ? 'awaiting-phone-confirmation' : 'sellitem-accepted', raw };
      }
      const message = String(raw?.message ?? '');
      if (message.includes('no longer in your inventory') || message.includes('not allowed to be traded')) {
        return { kind: 'DEFINITIVELY_REJECTED', reason: 'item-unavailable-or-unmarketable', raw };
      }
      // "The price entered plus the sum of outstanding listings (…) and your current Steam Wallet
      // balance of (…) exceed the maximum wallet balance of (…)". A definite no that nothing about
      // this listing can change; read as ambiguous it was retried once and parked the goal as a
      // retry limit, which told the person nothing (live 2026-09-15, steam/market-listings.md).
      if (message.includes('exceed the maximum wallet balance')) {
        return { kind: 'DEFINITIVELY_REJECTED', reason: `wallet-balance-cap: ${message}`, raw };
      }
      return { kind: 'AMBIGUOUS', cause: raw ? 'unclassified' : 'malformed', raw };
    } catch (error) {
      return ambiguous(error);
    }
  }

  async removeListing(accountId: AccountId, listingId: string): Promise<MutationOutcome> {
    const session = await this.auth.getWebSession(accountId);
    try {
      const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/removelisting/${encodeURIComponent(listingId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${MARKET_BASE}/`
        },
        body: form({ sessionid: session.sessionId })
      });
      const text = await response.text();
      if (response.ok && text.trim() === '[]') return { kind: 'SUBMITTED', evidence: 'removelisting-http-200', raw: [] };
      // A 502 can mean unknown, already sold, or a venue failure. Never guess or retry it blind.
      return { kind: 'AMBIGUOUS', cause: response.ok ? 'unclassified' : 'transport', raw: { status: response.status, body: text } };
    } catch (error) {
      return ambiguous(error);
    }
  }

  async createBuyOrder(accountId: AccountId, request: BuyOrderRequest): Promise<MutationOutcome> {
    const session = await this.auth.getWebSession(accountId);
    const billing = request.billing;
    const fields: Record<string, string | number> = {
      sessionid: session.sessionId,
      currency: request.currency,
      appid: request.appId,
      // The name as it is. Form encoding already sends each space as `+`. Substituting `+`
      // first sent `%2B`, so Steam looked up
      // `AK-47+|+Redline+(Field-Tested)` and answered code 42 every time (live, 2026-10-11).
      market_hash_name: request.marketHashName,
      price_total: request.priceTotalCents,
      quantity: request.quantity
    };
    // The billing block in the order Steam's own purchase form sends it.
    optional(fields, 'first_name', billing.firstName);
    optional(fields, 'last_name', billing.lastName);
    optional(fields, 'billing_address', billing.address1);
    optional(fields, 'billing_address_two', billing.address2);
    optional(fields, 'billing_country', billing.country);
    optional(fields, 'billing_city', billing.city);
    fields['billing_state'] = billing.state;
    optional(fields, 'billing_postal_code', billing.postalCode);
    fields['save_my_address'] = 0;
    fields['tradefee_tax'] = request.tradeFeeTax;
    fields['confirmation'] = request.confirmationId ?? 0;
    try {
      const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/createbuyorder/`, {
        method: 'POST',
        headers: marketPostHeaders(request.marketHashName),
        body: form(fields)
      });
      const raw = await parseJson(response);
      const success = Number(raw?.success);
      if (success === 1 || raw?.need_confirmation === true) {
        return { kind: 'SUBMITTED', evidence: raw?.need_confirmation ? 'buy-order-awaiting-phone-confirmation' : 'createbuyorder-accepted', raw };
      }
      if ([2, 29, 107].includes(success)) return { kind: 'DEFINITIVELY_REJECTED', reason: `steam-code-${success}`, raw };
      if ([10, 40, 429].includes(success) || response.status === 429) return { kind: 'AMBIGUOUS', cause: 'transport', raw };
      return { kind: 'AMBIGUOUS', cause: raw ? 'unclassified' : 'malformed', raw };
    } catch (error) {
      return ambiguous(error);
    }
  }

  async cancelBuyOrder(accountId: AccountId, buyOrderId: BuyOrderId): Promise<MutationOutcome> {
    const session = await this.auth.getWebSession(accountId);
    try {
      const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/cancelbuyorder/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${MARKET_BASE}/`
        },
        body: form({ sessionid: session.sessionId, buy_orderid: buyOrderId })
      });
      const raw = await parseJson(response);
      if (Number(raw?.success) === 1) return { kind: 'SUBMITTED', evidence: 'cancelbuyorder-accepted', raw };
      if (Number(raw?.success) === 29) return { kind: 'DEFINITIVELY_REJECTED', reason: 'unknown-or-completed-order', raw };
      return { kind: 'AMBIGUOUS', cause: raw ? 'unclassified' : 'malformed', raw };
    } catch (error) {
      return ambiguous(error);
    }
  }

  async getBuyOrderStatus(accountId: AccountId, buyOrderId: BuyOrderId): Promise<BuyOrderStatus> {
    const session = await this.auth.getWebSession(accountId);
    const url = `${MARKET_BASE}/getbuyorderstatus/?sessionid=${encodeURIComponent(session.sessionId)}&buy_orderid=${encodeURIComponent(buyOrderId)}`;
    const response = await this.requestWithSession(session.cookies, url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${MARKET_BASE}/` }
    });
    const raw = await parseJson(response);
    if (!response.ok || Number(raw?.success) !== 1) throw new Error(`getbuyorderstatus failed: HTTP ${response.status}`);
    return {
      active: Boolean(raw.active),
      purchased: Number(raw.purchased ?? 0),
      quantity: Number(raw.quantity ?? 0),
      quantityRemaining: Number(raw.quantity_remaining ?? 0)
    };
  }

  async getTradeFeeTaxRate(accountId: AccountId, billing: BillingAddress): Promise<TaxRate> {
    const session = await this.auth.getWebSession(accountId);
    const query = new URLSearchParams({ sessionid: session.sessionId, appid: '730', billing_state: billing.state });
    optionalQuery(query, 'billing_country', billing.country);
    optionalQuery(query, 'billing_city', billing.city);
    optionalQuery(query, 'billing_postal_code', billing.postalCode);
    const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/gettradefeetaxrate/?${query}`, {
      headers: { Referer: `${MARKET_BASE}/` }
    });
    const raw = await parseJson(response);
    // Live on 2026-10-11 every answer was `{"success":false,"tradefee_addtax":0,"tradefee_taxrate":0}`,
    // on a US and an AU wallet, with and without a billing country and postcode
    // (fixtures/steam/contracts/gettradefeetaxrate.json). `success` is not the verdict; the two
    // tax fields are, so a body that carries them is Steam's answer. Only a body without them is
    // malformed. Requiring `success: true`, as the 2026-09-07 example did, refused every buy order.
    const rate = Number(raw?.tradefee_taxrate);
    if (!response.ok || raw?.tradefee_addtax === undefined || !Number.isFinite(rate)) {
      throw new Error(`gettradefeetaxrate failed: HTTP ${response.status}`);
    }
    return { addTax: Boolean(Number(raw.tradefee_addtax)), rate };
  }

  async getWallet(accountId: AccountId): Promise<Wallet> {
    const response = await this.request(accountId, `${MARKET_BASE}/`, { headers: { Referer: `${MARKET_BASE}/` } });
    const html = await response.text();
    if (!response.ok) throw new Error(`wallet market page failed: HTTP ${response.status}`);
    const match = html.match(/g_rgWalletInfo\s*=\s*(\{[\s\S]*?\});/);
    if (!match?.[1]) throw new Error('wallet info missing from market page');
    const raw = JSON.parse(match[1]);
    return {
      balanceCents: Number(raw.wallet_balance),
      delayedBalanceCents: Number(raw.wallet_delayed_balance ?? 0),
      currency: Number(raw.wallet_currency),
      observedAt: new Date().toISOString()
    };
  }

  async getOrderBook(accountId: AccountId, hashName: string, etag?: string): Promise<OrderBook | NotModified> {
    const session = await this.auth.getWebSession(accountId);
    const qp = encodeURIComponent(JSON.stringify([730, hashName]));
    const headers: Record<string, string> = {
      'x-valve-request-type': 'queryAction',
      Referer: `${MARKET_BASE}/orderbook`
    };
    if (etag) headers['If-None-Match'] = etag;
    const response = await this.requestWithSession(session.cookies, `${MARKET_BASE}/orderbook?q=Load&qp=${qp}`, { headers });
    if (response.status === 304) return etag ? { kind: 'not-modified', etag } : { kind: 'not-modified' };
    const raw = await parseJson(response);
    // The levels sit under `data.data`, beside `data.success` (live 2026-10-11,
    // fixtures/steam/contracts/orderbook.json). Reading them one level up produced NaN levels
    // without an error, so a book that does not parse to finite numbers is refused, not returned.
    const data = raw?.data?.data;
    if (!response.ok || raw?.data?.success !== true || !data) throw new Error(`orderbook failed: HTTP ${response.status}`);
    const responseEtag = response.headers.get('etag') ?? undefined;
    const result: OrderBook = {
      kind: 'order-book',
      currency: Number(data.eCurrency),
      highestBuyCents: Number(data.amtMaxBuyOrder ?? 0),
      lowestSellCents: Number(data.amtMinSellOrder ?? 0),
      buy: cumulativeLevels(data.rgCompactBuyOrders),
      sell: cumulativeLevels(data.rgCompactSellOrders)
    };
    if (![result.currency, result.highestBuyCents, result.lowestSellCents].every(Number.isFinite)) {
      throw new Error('orderbook answered without finite currency or prices');
    }
    if (responseEtag) result.etag = responseEtag;
    return result;
  }

  private async request(accountId: string, url: string, init: RequestInit): Promise<Response> {
    const session = await this.auth.getWebSession(accountId);
    return this.requestWithSession(session.cookies, url, init);
  }

  private async requestWithSession(cookies: string[], url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') return this.getFollowingCommunityRedirects(cookies, url, init);
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookieHeader(cookies));
    headers.set('User-Agent', 'Mozilla/5.0 CSlyticsTradingDesktop/0.1');
    return this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /**
   * Node's fetch does not persist `Set-Cookie` across redirects. Steam's market homepage
   * answers that way (set a country/session cookie, then bounce), which turns a valid web
   * session into `redirect count exceeded` and looks like a missing wallet. JSON XHR
   * endpoints do not do this dance, which is why `mylistings` can succeed while `/market/`
   * fails. Only GET is followed, and only onto steamcommunity.com — a POST redirect is
   * never replayed.
   */
  private async getFollowingCommunityRedirects(cookies: string[], url: string, init: RequestInit): Promise<Response> {
    const jar = cookieJar(cookies);
    let current = url;
    for (let hop = 0; hop < 8; hop += 1) {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookieHeader([...jar.values()]));
      headers.set('User-Agent', 'Mozilla/5.0 CSlyticsTradingDesktop/0.1');
      const response = await this.fetchImpl(current, {
        ...init,
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      mergeSetCookies(jar, response);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || !isSteamCommunityHost(next.hostname)) {
        throw new Error(`Steam redirected off community to ${next.hostname}`);
      }
      current = next.toString();
    }
    throw new Error('Steam redirected too many times');
  }
}

function normalizeListing(listing: any, assets: any): MarketListing {
  const rawAsset = listing.asset ?? findAsset(assets, listing);
  const price = Number(listing.price ?? 0);
  const fee = Number(listing.fee ?? 0);
  const result: MarketListing = {
    listingId: String(listing.listingid),
    asset: {
      appId: Number(rawAsset?.appid ?? 730),
      assetId: String(rawAsset?.assetid ?? rawAsset?.id),
      marketHashName: String(rawAsset?.market_hash_name ?? rawAsset?.market_name ?? '')
    },
    priceReceiveCents: price,
    feeCents: fee,
    buyerPriceCents: price + fee,
    currency: Number(listing.currencyid ?? 0),
    active: Boolean(listing.active ?? true)
  };
  if (listing.status != null) result.status = Number(listing.status);
  return result;
}

function findAsset(assets: any, listing: any): any {
  const appId = String(listing.asset?.appid ?? 730);
  const contextId = String(listing.asset?.contextid ?? 2);
  const assetId = String(listing.asset?.id ?? listing.asset?.assetid ?? '');
  return assets?.[appId]?.[contextId]?.[assetId] ?? assets?.[appId]?.[assetId] ?? {};
}

function normalizeBuyOrder(order: any): MarketBuyOrder {
  return {
    buyOrderId: String(order.buy_orderid),
    appId: Number(order.appid ?? 730),
    hashName: String(order.hash_name ?? order.description?.market_hash_name ?? ''),
    currency: Number(order.wallet_currency ?? 0),
    priceCents: Number(order.price ?? 0),
    quantity: Number(order.quantity ?? 0),
    quantityRemaining: Number(order.quantity_remaining ?? order.quantity ?? 0)
  };
}

function cumulativeLevels(raw: unknown): OrderBookLevel[] {
  if (!Array.isArray(raw)) return [];
  // Steam sends the book flat, price then quantity; a trailing price with no quantity is dropped.
  const pairs = Array.from({ length: Math.floor(raw.length / 2) }, (_, level) => [Number(raw[2 * level]), Number(raw[2 * level + 1])] as const);
  let total = 0;
  return pairs.map(([priceCents, quantity]) => ({ priceCents, cumulativeQuantity: (total += quantity) }));
}

function marketPostHeaders(hashName: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Referer: `${MARKET_BASE}/listings/730/${encodeURIComponent(hashName)}`,
    Origin: 'https://steamcommunity.com'
  };
}

function form(values: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
}

export function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

export function cookieJar(cookies: string[]): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of cookies) mergeCookiePair(jar, cookie);
  return jar;
}

export function mergeSetCookies(jar: Map<string, string>, response: Response): void {
  const header = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const cookie of header) mergeCookiePair(jar, cookie);
}

function mergeCookiePair(jar: Map<string, string>, cookie: string): void {
  const pair = cookie.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  if (separator < 1) return;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name) jar.set(name, `${name}=${value}`);
}

function isSteamCommunityHost(hostname: string): boolean {
  return hostname === 'steamcommunity.com' || hostname.endsWith('.steamcommunity.com');
}

async function parseJson(response: Response): Promise<any | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function ambiguous(error: unknown): MutationOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const cause = lower.includes('timeout') || lower.includes('aborted')
    ? 'timeout'
    : lower.includes('json') ? 'malformed' : 'transport';
  return { kind: 'AMBIGUOUS', cause, raw: message };
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function optional(target: Record<string, string | number>, key: string, value: string | undefined): void {
  if (value !== undefined) target[key] = value;
}

function optionalQuery(target: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) target.set(key, value);
}
