import type {
  AccountId,
  AccountOrderBook,
  Ambiguous,
  BillingAddress,
  BuyOrderId,
  BuyOrderRequest,
  BuyOrderStatus,
  MarketActionAnswer,
  MarketBuyOrder,
  MarketHistoryAction,
  MarketListing,
  MutationOutcome,
  MyHistoryActionsPage,
  MyListingsPage,
  MyHistoryPage,
  SteamAuthPort,
  SteamMarketPort,
  TaxRate,
  Wallet
} from '@cslytics/ports';
import { MARKET_ACTION_TIMEOUT_MS, listingPriceChangeAnswer } from '@cslytics/ports';
import { orderBookUrl, parseOrderBook } from '@cslytics/market-data';

const MARKET_BASE = 'https://steamcommunity.com/market';

/** How long a wallet's stated market minimum stands before it is asked for again, and how soon after a read that learned none. */
const MARKET_MINIMUM_TTL_MS = 6 * 60 * 60_000;
const MARKET_MINIMUM_RETRY_MS = 60 * 60_000;

/** How much of an answer that is not JSON is kept in an outcome: enough to say what it was, never a whole page. */
const ACTION_BODY_TEXT_LIMIT = 2_000;

/**
 * How long a `QueryMyHistory` page may take. Shorter than the adapter's other reads: nothing
 * waits on a listing time, and a read that hangs holds the account's web lane while it does.
 */
export const QUERY_MY_HISTORY_TIMEOUT_MS = 10_000;

export class SteamMarketAdapter implements SteamMarketPort {
  constructor(
    private readonly auth: SteamAuthPort,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    private readonly historyActionsTimeoutMs = QUERY_MY_HISTORY_TIMEOUT_MS
  ) {}

  /** What each account's wallet last stated as its market minimum (`null`: asked, none learned), and when it was asked. */
  private readonly marketMinimums = new Map<string, { currency: number; cents: number | null; askedAt: number }>();

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
        const listingAsset = raw.listings?.[event.listingid]?.asset;
        const assetId = typeof listingAsset?.id === 'string' && listingAsset.id ? listingAsset.id : undefined;
        return {
          eventId: [event.listingid, purchaseId ?? '', event.event_type, event.time_event, event.time_event_fraction ?? 0].join(':'),
          listingId: event.listingid, ...(purchaseId ? { purchaseId } : {}), ...(assetId ? { assetId } : {}), eventType: event.event_type,
          occurredAt: new Date(event.time_event * 1000 + Math.floor(Number(event.time_event_fraction ?? 0) / 1_000_000)).toISOString(),
          raw: { event, listing: raw.listings?.[event.listingid] ?? null,
            purchase: purchaseId ? raw.purchases?.[`${event.listingid}_${purchaseId}`] ?? null : null,
            // The asset's description, from the `assets` map beside the events, when the body carries one.
            asset: assetDescription(raw, raw.listings?.[event.listingid]?.asset) }
        };
      })
    };
  }

  /**
   * The 2026 market's own history read, `GET /market/actions?q=QueryMyHistory`, the same log as
   * `myhistory/render` with the moment each listing went live (corpus
   * `steamcommunity.market.query-my-history`). Times are unix milliseconds; a listing time of zero
   * or none is left unset. A refused page pair is HTTP 400 with `eResult` 8 and throws
   * `query-my-history-refused`; anything else that is not a page throws as malformed, so an empty
   * page is only ever one Steam sent as a page.
   */
  async getMyHistoryActionsPage(accountId: AccountId, start: number, count: number): Promise<MyHistoryActionsPage> {
    const url = `${MARKET_BASE}/actions?q=QueryMyHistory&qp=${encodeURIComponent(JSON.stringify([start, count]))}`;
    const response = await this.request(accountId, url, {
      headers: { Accept: 'application/json', Referer: `${MARKET_BASE}/history`, 'x-valve-request-type': 'queryAction' }
    }, this.historyActionsTimeoutMs);
    const raw = await parseJson(response);
    const data = raw?.data;
    if (response.status === 400 && Number(data?.eResult) === 8) throw new Error('query-my-history-refused');
    if (!response.ok) throw new Error(`QueryMyHistory failed: HTTP ${response.status}`);
    if (!data || Number(data.eResult) !== 1 || typeof data.bMore !== 'boolean' || !Array.isArray(data.rgEvents)) {
      throw new Error(`QueryMyHistory malformed: HTTP ${response.status}`);
    }
    return { start, count, more: data.bMore, events: data.rgEvents.map(historyAction) };
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

  /**
   * Changes a listing's price in place with the 2026 market's own mutation,
   * `UpdateSellListingPrice` (corpus `steamcommunity.market.update-sell-listing-price`): the
   * listing id, the new seller price in integer cents, and the listing's `currencyid`, which is
   * the wallet currency's code plus 2000. The listing keeps its id.
   *
   * Steam refuses in the body, under HTTP 200. `eResult` 1 with `eUpdateResult` 1 is an accepted
   * change, and `nPrice` is the price Steam says the listing is at as it answers. With
   * `bRequiresConfirmation` it is a lower price that waits for its confirmation, and `nPrice` is
   * the old price the listing stays at. Without it the change applied at once, and it is answered
   * `price-updated` only when `nPrice` is the very price that was sent: `price-updated` is Steam
   * stating the listing is now at that price, so an accepted answer that names another price, or
   * none, or something that is not a whole number, is ambiguous with its body kept.
   *
   * `eUpdateResult` 84 with `csecCooldown` is the listing's five-minute cooldown, the one refusal
   * read as definite, and the seconds are the venue's own word on when to ask again. Every other
   * code is kept in `raw` and answered as ambiguous: the market page gives them meanings (the
   * listing is busy, its price cannot be changed, the wallet would overflow), and this adapter
   * holds none of them to be proof that nothing changed.
   */
  async updateListingPrice(accountId: AccountId, listingId: string, priceReceiveCents: number, currency: number): Promise<MutationOutcome> {
    if (!Number.isInteger(priceReceiveCents) || priceReceiveCents <= 0) {
      return { kind: 'DEFINITIVELY_REJECTED', reason: 'price-must-be-positive-integer-cents', raw: null };
    }
    if (!listingId.trim()) return { kind: 'DEFINITIVELY_REJECTED', reason: 'listing-id-required', raw: null };
    const currencyId = listingCurrencyId(currency);
    if (currencyId === null) return { kind: 'DEFINITIVELY_REJECTED', reason: 'currency-must-be-a-steam-currency-code', raw: null };
    const session = await this.auth.getWebSession(accountId);
    const answer = await this.marketMutation(session.cookies, 'UpdateSellListingPrice', [listingId, priceReceiveCents, currencyId]);
    if ('kind' in answer) return answer;
    const { raw, data } = answer;
    const row = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const result = row['eResult'];
    const update = row['eUpdateResult'];
    // Only a body with `eResult`, and with `eUpdateResult` beside an `eResult` of 1, is this call's answer.
    if (!Number.isInteger(result) || (result === 1 && !Number.isInteger(update))) return { kind: 'AMBIGUOUS', cause: 'malformed', raw };
    const said = listingPriceChangeAnswer(raw);
    if (result === 1 && update === 1) {
      if (said.confirmation) return { kind: 'SUBMITTED', evidence: 'price-change-awaiting-confirmation', raw };
      // Applied at once only on Steam's own word for it: the answer names the price that was sent.
      if (said.priceReceiveCents === priceReceiveCents) return { kind: 'SUBMITTED', evidence: 'price-updated', raw };
      return { kind: 'AMBIGUOUS', cause: 'unclassified', raw };
    }
    if (result === 1 && update === 84 && said.cooldownSeconds !== null && said.cooldownSeconds >= 0) {
      return { kind: 'DEFINITIVELY_REJECTED', reason: 'cooldown', retryAfterMs: said.cooldownSeconds * 1_000, raw };
    }
    return { kind: 'AMBIGUOUS', cause: 'unclassified', raw };
  }

  /**
   * Drops a lower price that waits for its confirmation, with `DiscardSellListingPriceChange`
   * (corpus `steamcommunity.market.update-sell-listing-price`). Steam answers the bare code 1
   * when it took the discard; any other answer is ambiguous, with a code kept when it gave one.
   */
  async discardListingPriceChange(accountId: AccountId, listingId: string): Promise<MutationOutcome> {
    if (!listingId.trim()) return { kind: 'DEFINITIVELY_REJECTED', reason: 'listing-id-required', raw: null };
    const session = await this.auth.getWebSession(accountId);
    const answer = await this.marketMutation(session.cookies, 'DiscardSellListingPriceChange', [listingId]);
    if ('kind' in answer) return answer;
    if (answer.data === 1) return { kind: 'SUBMITTED', evidence: 'price-change-discarded', raw: answer.raw };
    return { kind: 'AMBIGUOUS', cause: listingPriceChangeAnswer(answer.raw).venueCode === null ? 'malformed' : 'unclassified', raw: answer.raw };
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
      // A create Steam will not place without a tap answers 22, with HTTP 406, and the id of the
      // confirmation it is waiting for. The order does not exist yet: it is placed by the same
      // request sent again with `confirmation=<id>` once the tap is made (corpus
      // `steamcommunity.market.createbuyorder`, captured 2026-10-11).
      if (success === 1 || raw?.need_confirmation === true) {
        return { kind: 'SUBMITTED', evidence: raw?.need_confirmation ? 'buy-order-awaiting-phone-confirmation' : 'createbuyorder-accepted', raw };
      }
      // 29 on the first request is "an order for this name is already open": nothing was placed.
      // On the request sent again after a tap it can be this very order, placed by the tap or by
      // an answer that was lost, so only a walk of the book can say whose it is.
      if (success === 29 && request.confirmationId !== undefined) return { kind: 'AMBIGUOUS', cause: 'unclassified', raw };
      if ([2, 29].includes(success)) return { kind: 'DEFINITIVELY_REJECTED', reason: `steam-code-${success}`, raw };
      // 107's own words are "double check whether or not your order has actually been created";
      // it has also answered every create once standing orders reached a multiple of the wallet.
      // Either way it is not proof that nothing was placed, so the walk decides.
      if (success === 107) return { kind: 'AMBIGUOUS', cause: 'unclassified', raw };
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
    const wallet = walletFromMarketPage(html);
    const marketMinimumCents = wallet.marketMinimumCents ?? await this.marketMinimum(accountId, wallet.currency);
    return { ...wallet, ...(marketMinimumCents === null ? {} : { marketMinimumCents }), observedAt: new Date().toISOString() };
  }

  /**
   * The wallet's `wallet_market_minimum`, from `GET /market/userbillinginfo`, or `null` when it
   * could not be learned. The 2026 market page's wallet query carries a balance and a currency and
   * no fee figure; this route's `wallet_info` is the object the page's own sell and order dialogs
   * take their minimum from (captured 2026-11-23).
   *
   * The minimum belongs to a currency's fee table and moves rarely, so it is asked for at most
   * every six hours an account, hourly while Steam does not answer, and remembered in between. It
   * never fails the wallet read: without it the fee table in `@cslytics/ports` answers.
   *
   * The same body carries the account's billing address. Only `wallet_info` is read, and the body
   * is neither kept nor logged.
   */
  private async marketMinimum(accountId: AccountId, currency: number): Promise<number | null> {
    const now = Date.now();
    const known = this.marketMinimums.get(accountId);
    const fresh = known && known.currency === currency && now - known.askedAt < (known.cents === null ? MARKET_MINIMUM_RETRY_MS : MARKET_MINIMUM_TTL_MS);
    if (fresh) return known.cents;
    let cents: number | null = null;
    try {
      const response = await this.request(accountId, `${MARKET_BASE}/userbillinginfo`, { headers: { Accept: '*/*', Referer: `${MARKET_BASE}/` } });
      if (response.ok) cents = marketMinimumFromBillingInfo(await parseJson(response), currency);
    } catch {
      cents = null;
    }
    // A minimum learned earlier for this currency outlives a read that failed to learn one.
    if (cents === null && known && known.currency === currency && known.cents !== null) {
      this.marketMinimums.set(accountId, { ...known, askedAt: now - MARKET_MINIMUM_TTL_MS + MARKET_MINIMUM_RETRY_MS });
      return known.cents;
    }
    this.marketMinimums.set(accountId, { currency, cents, askedAt: now });
    return cents;
  }

  /**
   * The account's own read of the 2026 order book, the one price read that carries a session
   * (portfolio and pricing plan D5, D17): the URL and the parser are the anonymous read's
   * (`@cslytics/market-data`), the cookies are the account's, so an answer pinned to the wallet is
   * in the wallet's currency. `eCurrency` is read from the body and never assumed. A name with no
   * market answers `success:false` and is `null` here, never a zero; anything else that is not a
   * book throws, because an empty book would read as a market with nothing in it.
   */
  async getOrderBook(accountId: AccountId, marketHashName: string): Promise<AccountOrderBook | null> {
    const response = await this.request(accountId, orderBookUrl(marketHashName), {
      headers: { Accept: 'application/json', Referer: `${MARKET_BASE}/`, 'x-valve-request-type': 'queryAction' }
    });
    const parsed = parseOrderBook(response.status, await parseJson(response), response.headers.get('etag'));
    if (parsed.kind === 'absent') return null;
    if (parsed.kind !== 'ok') throw new Error(`orderbook failed: HTTP ${response.status}: ${parsed.detail}`);
    return { ...parsed.value, observedAt: new Date().toISOString() };
  }


  /**
   * One mutation on the 2026 market's action route (corpus `steamcommunity.concept.market-actions`):
   * `POST /market/actions` with the JSON body `{ m, mp }` and the header the market page sends with
   * every mutation. The session's cookies alone authorise it; there is no `sessionid` field or
   * header. A redirect is Steam saying the session is gone, so it is neither followed nor replayed.
   *
   * The route refuses a request that names no language before it reads the action: an empty answer
   * with a refusal status, whatever the body asked for. So the request carries `Accept-Language`,
   * and the `Sec-Fetch-*` headers a browser sends with the page's own fetch.
   *
   * Answers the body of an HTTP 200 JSON answer that carries `data`, for the caller to classify, or
   * the ambiguity itself: a status that is not 200, a redirect and a failed connection are
   * `transport`, a body that is not that JSON is `malformed`, and no answer in time is `timeout`.
   * A refusal is in the body under HTTP 200, so no other status is ever read as one. It gives up
   * no later than `MARKET_ACTION_TIMEOUT_MS`, the bound the port promises its callers.
   */
  private async marketMutation(
    cookies: string[],
    name: string,
    params: readonly (string | number)[],
    timeoutMs = Math.min(this.timeoutMs, MARKET_ACTION_TIMEOUT_MS)
  ): Promise<{ raw: MarketActionAnswer; data: unknown } | Ambiguous> {
    try {
      const response = await this.requestWithSession(cookies, `${MARKET_BASE}/actions`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json; charset=utf-8',
          Origin: 'https://steamcommunity.com',
          Referer: `${MARKET_BASE}/activelistings`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'x-valve-request-type': 'mutationAction'
        },
        body: JSON.stringify({ m: name, mp: params })
      }, timeoutMs);
      // A runtime that hides a redirect it did not follow reports it as status 0; one that shows it reports the 3xx.
      if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
        return { kind: 'AMBIGUOUS', cause: 'transport', raw: { status: response.status, body: null, redirected: true } satisfies MarketActionAnswer };
      }
      const text = await response.text();
      let body: unknown;
      let parsed = false;
      try { body = JSON.parse(text); parsed = true; } catch { body = text.slice(0, ACTION_BODY_TEXT_LIMIT); }
      const raw: MarketActionAnswer = { status: response.status, body };
      if (response.status !== 200) return { kind: 'AMBIGUOUS', cause: 'transport', raw };
      if (!parsed || body === null || typeof body !== 'object' || !('data' in body)) return { kind: 'AMBIGUOUS', cause: 'malformed', raw };
      return { raw, data: (body as { data: unknown }).data };
    } catch (error) {
      return ambiguous(error);
    }
  }

  private async request(accountId: string, url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const session = await this.auth.getWebSession(accountId);
    return this.requestWithSession(session.cookies, url, init, timeoutMs);
  }

  private async requestWithSession(cookies: string[], url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') return this.getFollowingCommunityRedirects(cookies, url, init, timeoutMs);
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookieHeader(cookies));
    headers.set('User-Agent', 'Mozilla/5.0 CSlyticsTradingDesktop/0.1');
    return this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  /**
   * Node's fetch does not persist `Set-Cookie` across redirects. Steam's market homepage
   * answers that way (set a country/session cookie, then bounce), which turns a valid web
   * session into `redirect count exceeded` and looks like a missing wallet. JSON XHR
   * endpoints do not do this dance, which is why `mylistings` can succeed while `/market/`
   * fails. Only GET is followed, and only onto steamcommunity.com — a POST redirect is
   * never replayed.
   */
  private async getFollowingCommunityRedirects(cookies: string[], url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
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
        signal: AbortSignal.timeout(timeoutMs)
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

/** The key the 2026 market page gives its query of the signed-in account's wallet. */
const WALLET_QUERY_KEY = 'CurrentUserWalletDetails';

/** How deep the page's JSON is searched for that query: it sits four levels down, one of them a JSON string. */
const WALLET_QUERY_MAX_DEPTH = 10;

/**
 * The wallet a market page carries, in either shape Steam has served (corpus
 * `steamcommunity.market.wallet-info`).
 *
 * Until 2026-11-23 the page set `g_rgWalletInfo`, amounts as strings of integer minor units. The 2026
 * market page has no such variable: its server-rendered state is one JSON script, and the wallet is
 * the page's own query keyed `CurrentUserWalletDetails` (`balance`, `delayed_balance`,
 * `currency_code`), held in a JSON string of queries inside it. `g_rgWalletInfo` is read first, so a
 * page that still carries it reads exactly as before.
 *
 * A page with neither is the signed-out page, or one Steam changed again, and throws: the engine takes
 * a wallet read as proof the session is signed in, so an absent wallet is never an empty one. On the
 * 2026 page the same holds for a query that did not load, an account with no wallet, and an amount or
 * currency that is not a whole number: the figure displayed beside them is formatted text, never read.
 */
export function walletFromMarketPage(html: string): Omit<Wallet, 'observedAt'> {
  const legacy = html.match(/g_rgWalletInfo\s*=\s*(\{[\s\S]*?\});/);
  if (legacy?.[1]) {
    const raw = JSON.parse(legacy[1]);
    const marketMinimumCents = minorUnits(raw.wallet_market_minimum);
    return {
      balanceCents: Number(raw.wallet_balance),
      delayedBalanceCents: Number(raw.wallet_delayed_balance ?? 0),
      currency: Number(raw.wallet_currency),
      ...(marketMinimumCents !== null && marketMinimumCents >= 1 ? { marketMinimumCents } : {})
    };
  }
  const query = pageWalletQuery(html);
  if (!query) throw new Error('wallet info missing from market page');
  const state = query['state'] as { status?: unknown; data?: unknown } | null | undefined;
  const data = state?.data as Record<string, unknown> | null | undefined;
  if (state?.status !== 'success' || !data || typeof data !== 'object') throw new Error('wallet query on the market page did not load');
  if (data['has_wallet'] === false) throw new Error('market page says the account has no Steam wallet');
  const balanceCents = minorUnits(data['balance']);
  const delayedBalanceCents = data['delayed_balance'] == null ? 0 : minorUnits(data['delayed_balance']);
  const currency = minorUnits(data['currency_code']);
  if (balanceCents === null || delayedBalanceCents === null || currency === null || currency === 0) {
    throw new Error('wallet query on the market page is malformed');
  }
  return { balanceCents, delayedBalanceCents, currency };
}

/**
 * `wallet_info.wallet_market_minimum` out of a `GET /market/userbillinginfo` body, in whole cents,
 * for the wallet in `currency`; `null` for a body without one, a minimum under one cent, or a
 * `wallet_info` in another currency, whose minimum would be another fee table's. Nothing else in
 * the body is read.
 */
export function marketMinimumFromBillingInfo(body: unknown, currency: number): number | null {
  const info = body && typeof body === 'object' ? (body as Record<string, unknown>)['wallet_info'] : null;
  if (!info || typeof info !== 'object') return null;
  const wallet = info as Record<string, unknown>;
  if (minorUnits(wallet['wallet_currency']) !== currency) return null;
  const minimum = minorUnits(wallet['wallet_market_minimum']);
  return minimum !== null && minimum >= 1 ? minimum : null;
}

/** A whole, non-negative number given as itself or as a string of digits; anything else is null. */
function minorUnits(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** The wallet query among the page's JSON scripts, wherever the page keeps its queries, or null. */
function pageWalletQuery(html: string): Record<string, unknown> | null {
  for (const script of html.matchAll(/<script\b[^>]*\btype="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const text = script[1];
    if (!text || !text.includes(WALLET_QUERY_KEY)) continue;
    const found = walletQueryIn(text, 0);
    if (found) return found;
  }
  return null;
}

/**
 * The query keyed `CurrentUserWalletDetails` inside a JSON value. The page nests JSON inside JSON
 * strings (the queries are one), so a string that names the key and opens like JSON is parsed and
 * searched in turn; every other string is left alone.
 */
function walletQueryIn(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > WALLET_QUERY_MAX_DEPTH) return null;
  if (typeof value === 'string') {
    if (!value.includes(WALLET_QUERY_KEY) || !/^\s*[{[]/.test(value)) return null;
    try {
      return walletQueryIn(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = walletQueryIn(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const key = record['queryKey'];
  if (Array.isArray(key) && key[0] === WALLET_QUERY_KEY) return record;
  for (const entry of Object.values(record)) {
    const found = walletQueryIn(entry, depth + 1);
    if (found) return found;
  }
  return null;
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

/**
 * One `QueryMyHistory` event as the port carries it. The listing id is a string and stays one (a
 * 19-digit id is not a JavaScript number); `time_event` and `time_listing` are unix milliseconds.
 */
function historyAction(event: any): MarketHistoryAction {
  const listingId = event?.listing?.listingid;
  if (typeof listingId !== 'string' || !listingId || !Number.isInteger(event.event_type)
    || !Number.isSafeInteger(event.time_event) || event.time_event < 0) throw new Error('QueryMyHistory malformed: an event without a listing, a type or a time');
  const listedMs = event.time_listing;
  const units = Number(event.listing?.asset?.original_amount);
  const hashName = event.description?.market_hash_name;
  return {
    listingId,
    eventType: event.event_type,
    occurredAt: new Date(event.time_event).toISOString(),
    ...(Number.isSafeInteger(listedMs) && listedMs > 0 ? { listedAt: new Date(listedMs).toISOString() } : {}),
    ...(event.listing?.asset?.original_amount !== undefined && Number.isSafeInteger(units) ? { listingUnits: units } : {}),
    ...(typeof hashName === 'string' && hashName ? { hashName } : {}),
    raw: event
  };
}

/** The description of a listing's asset in a response's `assets` map, keyed by app, context and id; null when the body has none. */
function assetDescription(raw: any, asset: any): any {
  if (!asset || typeof asset !== 'object') return null;
  return raw?.assets?.[String(asset.appid)]?.[String(asset.contextid)]?.[String(asset.id)] ?? null;
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

/**
 * The `currencyid` a listing states for a wallet currency: Steam's currency code plus 2000 (2021
 * for AUD's 21). Takes the bare code or the listing's own form of it; `null` for a number that is
 * neither.
 */
function listingCurrencyId(currency: number): number | null {
  if (!Number.isInteger(currency)) return null;
  const code = currency > 2000 ? currency - 2000 : currency;
  return code > 0 && code < 2000 ? 2000 + code : null;
}

function ambiguous(error: unknown): Ambiguous {
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
