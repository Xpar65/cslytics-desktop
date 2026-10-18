import { createHash } from 'node:crypto';
import { parseCurve, parseFxRates, parseOrderBook, parsePriceHistory } from './parse.js';
import type { CurveDoc, FxRates, OrderBook, Parsed, PriceHistory } from './types.js';

/**
 * Where market data comes from, behind one seam.
 *
 * `HttpMarketDataSource` reads Steam's anonymous order book and price series and CSlytics's free
 * CDN. `OracleMarketDataSource` is its deterministic twin for offline journeys. A paid source is a
 * third implementation and a setting; nothing above this file changes (plan D1).
 *
 * Every request leaves **without cookies** and with the desktop's own User-Agent (plan D4). A
 * cookie-bearing request changes the fingerprint rules on legacy endpoints and leaves the
 * currency of the answer an unknown, so the fetch this class is given must be a plain one, never
 * an Electron session's. The two hosts are compiled in and anything else is refused.
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

export interface MarketDataSource {
  book(name: string): Promise<Answer<OrderBook>>;
  history(name: string): Promise<Answer<PriceHistory>>;
  curve(venue: 'csfloat' | 'steam', name: string): Promise<Answer<CurveDoc>>;
  fx(): Promise<Answer<FxRates>>;
}

export const STEAM_MARKET_HOST = 'steamcommunity.com';
export const CSLYTICS_HOST = 'api.cslytics.com';
const FREE_BASE = `https://${CSLYTICS_HOST}/free/v1`;
export const FX_RATES_URL = `${FREE_BASE}/fx-rates.json`;

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
  return `${FREE_BASE}/${venue}/curves/${curveNameHash(name)}.json`;
}

export class HttpMarketDataSource implements MarketDataSource {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly options: { userAgent: string; timeoutMs?: number }
  ) {}

  book(name: string): Promise<Answer<OrderBook>> {
    return this.get(orderBookUrl(name), (status, body, etag) => parseOrderBook(status, body, etag));
  }

  history(name: string): Promise<Answer<PriceHistory>> {
    return this.get(priceHistoryUrl(name), (status, body) => parsePriceHistory(status, body));
  }

  curve(venue: 'csfloat' | 'steam', name: string): Promise<Answer<CurveDoc>> {
    return this.get(curveUrl(venue, name), (status, body) => parseCurve(status, body));
  }

  fx(): Promise<Answer<FxRates>> {
    return this.get(FX_RATES_URL, (status, body) => parseFxRates(status, body));
  }

  private async get<T>(url: string, parse: (status: number, body: unknown, etag: string | null) => Parsed<T>): Promise<Answer<T>> {
    const host = new URL(url).hostname;
    if (host !== STEAM_MARKET_HOST && host !== CSLYTICS_HOST) {
      throw new Error(`market-data: refused ${host}`);
    }
    const started = Date.now();
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
      });
    } catch (error) {
      return { parsed: { kind: 'unknown', detail: `transport: ${error instanceof Error ? error.message : String(error)}` }, status: null, latencyMs: Date.now() - started, etag: null };
    }
    const etag = response.headers.get('etag');
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      return { parsed: { kind: 'unknown', detail: `HTTP ${response.status}, body is not JSON` }, status: response.status, latencyMs: Date.now() - started, etag };
    }
    return { parsed: parse(response.status, body, etag), status: response.status, latencyMs: Date.now() - started, etag };
  }
}

/**
 * The world an Oracle source answers from. A name not set answers a deterministic synthetic book
 * so a journey gets values without seeding every name; `absent`, a status or a transport failure
 * are set by name when a journey needs them. Every request is recorded for assertions.
 */
export type OracleAnswer<T> = { kind: 'value'; value: T } | { kind: 'absent' } | { kind: 'status'; status: number } | { kind: 'transport' };

export class OracleMarketWorld {
  readonly books = new Map<string, OracleAnswer<OrderBook>>();
  readonly histories = new Map<string, OracleAnswer<PriceHistory>>();
  readonly curves = new Map<string, OracleAnswer<CurveDoc>>();
  fx: OracleAnswer<FxRates> = { kind: 'value', value: { base: 'USD', asOf: '2026-10-13', stale: false, rates: { USD: 1, AUD: 1.5, EUR: 0.9, GBP: 0.8, JPY: 150 } } };
  /** The currency every synthetic book is priced in; 21 is AUD. */
  defaultCurrency = 21;
  /**
   * Strict: a name that was not set answers `absent`, the way the market answers a name that is
   * not an item. Lenient (the default) answers every name with a synthetic book, which is handy
   * for a journey that cares about totals and useless for one that must catch a misspelled name.
   */
  strict = false;
  latencyMs = 5;
  readonly requests: Array<{ kind: 'book' | 'history' | 'curve' | 'fx'; name: string | null }> = [];

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
  setAbsent(name: string): void { this.books.set(name, { kind: 'absent' }); }
  setStatus(name: string, status: number): void { this.books.set(name, { kind: 'status', status }); }
  setTransportFailure(name: string): void { this.books.set(name, { kind: 'transport' }); }
}

export class OracleMarketDataSource implements MarketDataSource {
  constructor(private readonly world: OracleMarketWorld) {}

  async book(name: string): Promise<Answer<OrderBook>> {
    this.world.requests.push({ kind: 'book', name });
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

  async curve(venue: 'csfloat' | 'steam', name: string): Promise<Answer<CurveDoc>> {
    this.world.requests.push({ kind: 'curve', name: `${venue}:${name}` });
    return this.answer(this.world.curves.get(`${venue}:${name}`) ?? { kind: 'absent' });
  }

  async fx(): Promise<Answer<FxRates>> {
    this.world.requests.push({ kind: 'fx', name: null });
    return this.answer(this.world.fx);
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
