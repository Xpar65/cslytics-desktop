import { createHash } from 'node:crypto';
import { parseCurve, parseFxRates, parseOrderBook, parsePriceHistory, parsePriceSnapshot } from './parse.js';
import type { CurveDoc, FxRates, OrderBook, Parsed, PriceHistory, PriceSnapshot } from './types.js';

/**
 * Where market data comes from, behind one seam.
 *
 * `HttpMarketDataSource` reads Steam's anonymous order book and price series, CSlytics's FX rates,
 * and, for a signed-in desktop, CSlytics's hourly price snapshot and float curves. `OracleMarketDataSource` is its
 * deterministic twin for offline journeys. The snapshot is the paid-side source plan D1 reserved a
 * seat for; nothing above this file changes for it but the valuation's input.
 *
 * Every anonymous request leaves **without cookies** and with the desktop's own User-Agent (plan
 * D4). A cookie-bearing request changes the fingerprint rules on legacy endpoints and leaves the
 * currency of the answer an unknown, so the fetch this class is given must be a plain one, never
 * an Electron session's. The snapshot and the curves are the requests that carry a credential,
 * a bearer token, and they leave through a fetch of their own (`memberFetch`), so the free path is
 * not widened by them (portfolio prices plan D11). The two hosts are compiled in and anything else is refused.
 */

export type FetchResponseLike = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseLike>;

/** What one read produced, with what the governor needs to know about how it went. */
export type Answer<T> = {
  parsed: Parsed<T>;
  /** `null` when no response arrived at all. */
  status: number | null;
  latencyMs: number;
  etag: string | null;
};

/** The snapshot's answer carries the server's own wait on a 429, which the refresher honours (plan D10). */
export type PricesAnswer = Answer<PriceSnapshot> & { retryAfterSeconds: number | null };

/** A curve's answer: `status` 304 is the copy held, still current; a 429 carries the server's wait. */
export type CurveAnswer = Answer<CurveDoc> & { retryAfterSeconds: number | null };

/** What the snapshot request carries: the token, and the ETag of the copy held so an unchanged hour is a 304. */
export type PricesRequest = { bearer: string; etag: string | null };

export interface MarketDataSource {
  book(name: string): Promise<Answer<OrderBook>>;
  history(name: string): Promise<Answer<PriceHistory>>;
  /**
   * A float curve, behind the sign-in (pricing behind sign-in plan §5.1): a 401 or 403 is the gate's
   * to act on, a 404 an uncovered name, and a 304 the copy whose `etag` was sent, unchanged.
   */
  curve(venue: 'csfloat' | 'steam', name: string, bearer: string, etag?: string | null): Promise<CurveAnswer>;
  fx(): Promise<Answer<FxRates>>;
  /** The hourly snapshot; `status` 304 is the copy held, and a 401 or 403 is the gate's to act on. */
  prices(request: PricesRequest): Promise<PricesAnswer>;
}

export const STEAM_MARKET_HOST = 'steamcommunity.com';
export const CSLYTICS_HOST = 'api.cslytics.com';
const FREE_BASE = `https://${CSLYTICS_HOST}/free/v1`;
export const FX_RATES_URL = `${FREE_BASE}/fx-rates.json`;
/** The member namespace, behind a CSlytics sign-in (CSlytics account sign-in plan §5). */
export const MEMBER_BASE = `https://${CSLYTICS_HOST}/member/v1`;
export const STEAM_PRICES_URL = `${MEMBER_BASE}/steam/prices.json`;

/** `/market/orderbook?q=Load&qp=[730,"<name>"]` (`steamcommunity.market.orderbook`). */
export function orderBookUrl(name: string): string {
  return `https://${STEAM_MARKET_HOST}/market/orderbook?q=Load&qp=${encodeURIComponent(JSON.stringify([730, name]))}`;
}

/** `/market/actions?q=QueryPriceHistory&qp=[730,"<name>"]` (`steamcommunity.market.query-price-history`). */
export function priceHistoryUrl(name: string): string {
  return `https://${STEAM_MARKET_HOST}/market/actions?q=QueryPriceHistory&qp=${encodeURIComponent(JSON.stringify([730, name]))}`;
}

/** The CDN keys a curve by the SHA-256 of the exact UTF-8 name; case, spacing and wear suffix all count. */
export function curveNameHash(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex');
}

export function curveUrl(venue: 'csfloat' | 'steam', name: string): string {
  return `${MEMBER_BASE}/${venue}/curves/${curveNameHash(name)}.json`;
}

export class HttpMarketDataSource implements MarketDataSource {
  /**
   * `memberFetch` carries the bearer token to the member namespace and nothing else; without one
   * the snapshot goes out through the plain fetch, which a test or a tool may want, and which main
   * never does.
   */
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly options: { userAgent: string; timeoutMs?: number; memberFetch?: FetchLike }
  ) {}

  book(name: string): Promise<Answer<OrderBook>> {
    return this.get(orderBookUrl(name), (status, body, etag) => parseOrderBook(status, body, etag));
  }

  history(name: string): Promise<Answer<PriceHistory>> {
    return this.get(priceHistoryUrl(name), (status, body) => parsePriceHistory(status, body));
  }

  async curve(venue: 'csfloat' | 'steam', name: string, bearer: string, etag: string | null = null): Promise<CurveAnswer> {
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
    if (etag !== null) headers['If-None-Match'] = etag;
    const { answer, response } = await this.read(curveUrl(venue, name), this.options.memberFetch ?? this.fetchImpl, headers, (status, body) => parseCurve(status, body));
    return { ...answer, retryAfterSeconds: retryAfter(response) };
  }

  fx(): Promise<Answer<FxRates>> {
    return this.get(FX_RATES_URL, (status, body) => parseFxRates(status, body));
  }

  async prices(request: PricesRequest): Promise<PricesAnswer> {
    const headers: Record<string, string> = { Authorization: `Bearer ${request.bearer}` };
    if (request.etag !== null) headers['If-None-Match'] = request.etag;
    const { answer, response } = await this.read(STEAM_PRICES_URL, this.options.memberFetch ?? this.fetchImpl, headers, (status, body) => parsePriceSnapshot(status, body));
    return { ...answer, retryAfterSeconds: retryAfter(response) };
  }

  private async get<T>(url: string, parse: (status: number, body: unknown, etag: string | null) => Parsed<T>): Promise<Answer<T>> {
    return (await this.read(url, this.fetchImpl, {}, parse)).answer;
  }

  private async read<T>(
    url: string, fetchImpl: FetchLike, extra: Record<string, string>, parse: (status: number, body: unknown, etag: string | null) => Parsed<T>
  ): Promise<{ answer: Answer<T>; response: FetchResponseLike | null }> {
    const host = new URL(url).hostname;
    if (host !== STEAM_MARKET_HOST && host !== CSLYTICS_HOST) {
      throw new Error(`market-data: refused ${host}`);
    }
    const started = Date.now();
    let response: FetchResponseLike;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json', ...extra },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
      });
    } catch (error) {
      return { answer: { parsed: { kind: 'unknown', detail: `transport: ${error instanceof Error ? error.message : String(error)}` }, status: null, latencyMs: Date.now() - started, etag: null }, response: null };
    }
    const etag = response.headers.get('etag');
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      return { answer: { parsed: { kind: 'unknown', detail: `HTTP ${response.status}, body is not JSON` }, status: response.status, latencyMs: Date.now() - started, etag }, response };
    }
    return { answer: { parsed: parse(response.status, body, etag), status: response.status, latencyMs: Date.now() - started, etag }, response };
  }
}

/** `Retry-After` in seconds, when the server named one; a date form is read as seconds from now. */
function retryAfter(response: FetchResponseLike | null): number | null {
  const header = response?.headers.get('retry-after');
  if (header === null || header === undefined) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * The world an Oracle source answers from. A name not set answers a deterministic synthetic book
 * so a journey gets values without seeding every name; `absent`, a status or a transport failure
 * are set by name when a journey needs them. Every request is recorded for assertions.
 */
export type OracleAnswer<T> = { kind: 'value'; value: T } | { kind: 'absent' } | { kind: 'status'; status: number } | { kind: 'transport' };

export class OracleMarketWorld {
  readonly books = new Map<string, OracleAnswer<OrderBook>>();
  /** Names whose book moves on every read: each read answers the next book, then the first again. */
  readonly cycles = new Map<string, { books: readonly OrderBook[]; next: number }>();
  readonly histories = new Map<string, OracleAnswer<PriceHistory>>();
  readonly curves = new Map<string, OracleAnswer<CurveDoc>>();
  fx: OracleAnswer<FxRates> = { kind: 'value', value: { base: 'USD', asOf: '2026-10-13', stale: false, rates: { USD: 1, AUD: 1.5, EUR: 0.9, GBP: 0.8, JPY: 150 } } };
  /**
   * The member snapshot. Unset, the route answers 404, which the refresher reports as the API's
   * fault; a status models the gate's answers (401, 403, 429); a value is answered with an ETag
   * made of its generation, so a request carrying that ETag gets the 304 the real route gives.
   */
  prices: OracleAnswer<PriceSnapshot> | null = null;
  /** The `Retry-After` a 429 names, in seconds; `null` names none. */
  pricesRetryAfterSeconds: number | null = null;
  /** The currency every synthetic book is priced in; 21 is AUD. */
  defaultCurrency = 21;
  /**
   * Strict: a name that was not set answers `absent`, the way the market answers a name that is
   * not an item. Lenient (the default) answers every name with a synthetic book, which is handy
   * for a journey that cares about totals and useless for one that must catch a misspelled name.
   */
  strict = false;
  latencyMs = 5;
  /** Every request; a curve's carries the bearer it was sent with, so a test can see one was. */
  readonly requests: Array<{ kind: 'book' | 'history' | 'curve' | 'fx' | 'prices'; name: string | null; bearer?: string }> = [];

  /** A book whose prices follow from the name, so a journey can predict a total it never seeded. */
  syntheticBook(name: string): OrderBook {
    const seed = Array.from(name).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 100_000, 7);
    const ask = 100 + (seed % 5_000);
    const bid = Math.max(1, ask - 1 - (seed % 40));
    return {
      currency: this.defaultCurrency,
      highestBidCents: bid,
      lowestAskCents: ask,
      bidUnits: 30,
      askUnits: 12,
      bids: [{ priceCents: bid, quantity: 10 }, { priceCents: bid - 1, quantity: 20 }],
      asks: [{ priceCents: ask, quantity: 2 }, { priceCents: ask + 1, quantity: 10 }],
      etag: `oracle-${seed}`
    };
  }

  setBook(name: string, book: OrderBook): void { this.books.set(name, { kind: 'value', value: book }); }
  setCycle(name: string, books: readonly OrderBook[]): void {
    if (books.length === 0) throw new Error('a cycle needs at least one book');
    this.cycles.set(name, { books, next: 0 });
  }
  setAbsent(name: string): void { this.books.set(name, { kind: 'absent' }); }
  setStatus(name: string, status: number): void { this.books.set(name, { kind: 'status', status }); }
  setTransportFailure(name: string): void { this.books.set(name, { kind: 'transport' }); }
}

export class OracleMarketDataSource implements MarketDataSource {
  constructor(private readonly world: OracleMarketWorld) {}

  async book(name: string): Promise<Answer<OrderBook>> {
    this.world.requests.push({ kind: 'book', name });
    const cycle = this.world.cycles.get(name);
    if (cycle) {
      const book = cycle.books[cycle.next % cycle.books.length]!;
      cycle.next += 1;
      return this.answer({ kind: 'value', value: book });
    }
    const answer = this.world.books.get(name) ?? (this.world.strict ? { kind: 'absent' as const } : { kind: 'value' as const, value: this.world.syntheticBook(name) });
    return this.answer(answer);
  }

  async history(name: string): Promise<Answer<PriceHistory>> {
    this.world.requests.push({ kind: 'history', name });
    const answer = this.world.histories.get(name) ?? (this.world.strict ? { kind: 'absent' as const } : {
      kind: 'value' as const,
      value: { currency: this.world.defaultCurrency, points: Array.from({ length: 30 }, (_, index) => ({ time: 1_760_000_000 + index * 86_400, medianCents: 1_000 + index * 10, purchases: 5 })) }
    });
    return this.answer(answer);
  }

  async curve(venue: 'csfloat' | 'steam', name: string, bearer: string, etag: string | null = null): Promise<CurveAnswer> {
    this.world.requests.push({ kind: 'curve', name: `${venue}:${name}`, bearer });
    // The member route's gate: no token is a 401, as the API answers it, before any name is looked up.
    if (bearer === '') return { ...this.answer<CurveDoc>({ kind: 'status', status: 401 }), retryAfterSeconds: null };
    const held = this.world.curves.get(`${venue}:${name}`) ?? { kind: 'absent' as const };
    if (held.kind === 'value') {
      // The validator is over the document, as the API's is over its bytes.
      const tag = `"oracle-curve-${held.value.computedAt ?? ''}"`;
      if (etag === tag) return { parsed: { kind: 'unknown', detail: 'HTTP 304' }, status: 304, latencyMs: this.world.latencyMs, etag: tag, retryAfterSeconds: null };
      return { ...this.answer(held), etag: tag, retryAfterSeconds: null };
    }
    return { ...this.answer<CurveDoc>(held), retryAfterSeconds: null };
  }

  async fx(): Promise<Answer<FxRates>> {
    this.world.requests.push({ kind: 'fx', name: null });
    return this.answer(this.world.fx);
  }

  async prices(request: PricesRequest): Promise<PricesAnswer> {
    this.world.requests.push({ kind: 'prices', name: request.etag });
    const latencyMs = this.world.latencyMs;
    const held = this.world.prices;
    if (held === null) return { parsed: { kind: 'absent' }, status: 404, latencyMs, etag: null, retryAfterSeconds: null };
    if (held.kind === 'value') {
      const etag = `"oracle-prices-${held.value.generatedAt}"`;
      if (request.etag === etag) return { parsed: { kind: 'unknown', detail: 'HTTP 304' }, status: 304, latencyMs, etag, retryAfterSeconds: null };
      return { ...this.answer(held), etag, retryAfterSeconds: null };
    }
    const answer = this.answer<PriceSnapshot>(held);
    return { ...answer, retryAfterSeconds: answer.status === 429 ? this.world.pricesRetryAfterSeconds : null };
  }

  private answer<T>(answer: OracleAnswer<T>): Answer<T> {
    const latencyMs = this.world.latencyMs;
    switch (answer.kind) {
      case 'value': return { parsed: { kind: 'ok', value: answer.value }, status: 200, latencyMs, etag: null };
      case 'absent': return { parsed: { kind: 'absent' }, status: 200, latencyMs, etag: null };
      case 'status': return { parsed: { kind: 'unknown', detail: `HTTP ${answer.status}` }, status: answer.status, latencyMs, etag: null };
      case 'transport': return { parsed: { kind: 'unknown', detail: 'transport: oracle' }, status: null, latencyMs, etag: null };
    }
  }
}
