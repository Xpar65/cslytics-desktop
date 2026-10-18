import type { CurveDoc, CurveSegments, CurveSeries, CurveVertex, FxRates, OrderBook, Parsed, PriceHistory } from './types.js';

/**
 * What a body means, decided in one place.
 *
 * Three answers and no fourth: `ok` with the value, `absent` when the platform said there is no
 * such thing, and `unknown` for everything else. A transport status, a body that is not JSON, a
 * shape with a missing field or a non-finite number all land in `unknown`, because treating any
 * of them as a zero or an absence is how a price silently becomes wrong. The caller keeps what
 * it knew (plan D13).
 *
 * Evidence for each shape is on the corpus page named beside it; the fixtures under
 * `fixtures/steam/contracts/` and `fixtures/cslytics/` hold captured examples.
 */

function unknown(detail: string): Parsed<never> {
  return { kind: 'unknown', detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An integer, whether Steam sent it as a number or as a string of digits. An empty or blank
 * string is not zero (`Number('')` is), and nothing here is allowed to read it as one.
 */
function finiteInteger(value: unknown): number | null {
  if (typeof value === 'string') {
    if (!/^\s*-?\d+\s*$/.test(value)) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteInteger(value);
  return number === null || number < 0 ? null : number;
}

/**
 * `/market/orderbook?q=Load` (`steamcommunity.market.orderbook`). The levels sit under
 * `data.data` beside `data.success` (captured 2026-08-19 and 2026-10-11); the 2026-06-12 capture
 * had them one level up, and a parser that read only one shape produced NaN levels without an
 * error. Both shapes are read. `{"data":{"success":false}}` is the answer for a name that is not
 * a market item (captured 2026-10-13), which is an absence, never a throttle and never a zero.
 */
export function parseOrderBook(status: number, body: unknown, etag: string | null = null): Parsed<OrderBook> {
  if (status !== 200) return unknown(`HTTP ${status}`);
  if (!isRecord(body) || !isRecord(body.data)) return unknown('no data envelope');
  const outer = body.data;
  const data = isRecord(outer.data) ? outer.data : outer;
  const success = outer.success ?? data.success;
  if (success === false) return { kind: 'absent' };
  if (success !== true) return unknown('no success flag');
  const currency = finiteInteger(data.eCurrency);
  if (currency === null || currency < 1) return unknown('eCurrency missing or not a currency id');
  const bids = levels(data.rgCompactBuyOrders);
  const asks = levels(data.rgCompactSellOrders);
  if (bids === null || asks === null) return unknown('levels did not parse');
  const highestBidCents = bids.length > 0 ? bids[0]!.priceCents : null;
  const lowestAskCents = asks.length > 0 ? asks[0]!.priceCents : null;
  const topBid = finiteInteger(data.amtMaxBuyOrder);
  const topAsk = finiteInteger(data.amtMinSellOrder);
  if (highestBidCents !== null && topBid !== null && topBid !== highestBidCents) return unknown('amtMaxBuyOrder disagrees with the levels');
  if (lowestAskCents !== null && topAsk !== null && topAsk !== lowestAskCents) return unknown('amtMinSellOrder disagrees with the levels');
  const bidUnits = data.cBuyOrders === undefined ? bids.reduce((sum, level) => sum + level.quantity, 0) : nonNegativeInteger(data.cBuyOrders);
  const askUnits = data.cSellOrders === undefined ? asks.reduce((sum, level) => sum + level.quantity, 0) : nonNegativeInteger(data.cSellOrders);
  if (bidUnits === null || askUnits === null) return unknown('a side count is not a count');
  return {
    kind: 'ok',
    value: {
      currency,
      highestBidCents,
      lowestAskCents,
      bidUnits,
      askUnits,
      bids,
      asks,
      etag
    }
  };
}

/**
 * Steam sends a side flat, `price, qty, price, qty, …`, best price first, point quantities. A
 * level priced at nothing or holding nothing is no level Steam sends: a zero top bid would halve
 * the mid and make a stack worth nothing to sell, so the side is refused rather than read.
 */
function levels(raw: unknown): OrderBook['bids'] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length % 2 !== 0) return null;
  const out: Array<{ priceCents: number; quantity: number }> = [];
  for (let index = 0; index < raw.length; index += 2) {
    const priceCents = finiteInteger(raw[index]);
    const quantity = finiteInteger(raw[index + 1]);
    if (priceCents === null || quantity === null || priceCents <= 0 || quantity <= 0) return null;
    out.push({ priceCents, quantity });
  }
  return out;
}

/**
 * `/market/actions?q=QueryPriceHistory` (`steamcommunity.market.query-price-history`):
 * `{"data":{"ecurrency":21,"prices":[{"time","price_median","purchases"}]}}`, `price_median` a
 * float in currency units. It is rounded to hundredths here and never kept as a float.
 */
export function parsePriceHistory(status: number, body: unknown): Parsed<PriceHistory> {
  if (status !== 200) return unknown(`HTTP ${status}`);
  if (!isRecord(body) || !isRecord(body.data)) return unknown('no data envelope');
  const data = body.data;
  const currency = finiteInteger(data.ecurrency);
  if (currency === null) return unknown('ecurrency missing');
  if (!Array.isArray(data.prices)) return unknown('prices missing');
  const points: Array<{ time: number; medianCents: number; purchases: number }> = [];
  for (const raw of data.prices) {
    if (!isRecord(raw)) return unknown('a price row is not an object');
    const time = finiteInteger(raw.time);
    const purchases = finiteInteger(raw.purchases);
    const median = typeof raw.price_median === 'number' && Number.isFinite(raw.price_median) ? raw.price_median : null;
    if (time === null || purchases === null || median === null) return unknown('a price row did not parse');
    points.push({ time, medianCents: Math.round(median * 100), purchases });
  }
  return { kind: 'ok', value: { currency, points } };
}

/**
 * A published curve, the free `<venue>/curves/<hash>.json` (`curveUrl`). A 404 is the normal
 * answer for a name without a curve. Vertices are raw float against whole currency units and are
 * kept as the document gives them: the chart interpolates, nothing here does.
 */
export function parseCurve(status: number, body: unknown): Parsed<CurveDoc> {
  if (status === 404) return { kind: 'absent' };
  if (status !== 200) return unknown(`HTTP ${status}`);
  if (!isRecord(body)) return unknown('not an object');
  const venue = body.venue;
  if (venue !== 'csfloat' && venue !== 'steam') return unknown('venue missing');
  if (typeof body.market_hash_name !== 'string') return unknown('market_hash_name missing');
  if (typeof body.currency !== 'string') return unknown('currency missing');
  const fairPrice = series(body.fair_price);
  const lowestAsk = series(body.lowest_ask);
  const highestBid = segments(body.highest_bid);
  if (fairPrice === false || lowestAsk === false || highestBid === false) return unknown('a series did not parse');
  const listings = isRecord(body.listings) ? body.listings : null;
  const entries: Array<{ id: string; float: number | null; price: number }> = [];
  if (listings !== null) {
    if (!Array.isArray(listings.entries)) return unknown('listings.entries missing');
    for (const raw of listings.entries) {
      if (!isRecord(raw) || typeof raw.price !== 'number' || !Number.isFinite(raw.price)) return unknown('a listing did not parse');
      entries.push({ id: String(raw.id ?? ''), float: typeof raw.float === 'number' && Number.isFinite(raw.float) ? raw.float : null, price: raw.price });
    }
  }
  const range = isRecord(body.float_range) && typeof body.float_range.min === 'number' && typeof body.float_range.max === 'number'
    ? { min: body.float_range.min, max: body.float_range.max }
    : null;
  return {
    kind: 'ok',
    value: {
      venue,
      marketHashName: body.market_hash_name,
      currency: body.currency,
      floatRange: range,
      computedAt: typeof body.computed_at === 'string' ? body.computed_at : null,
      fairPrice,
      lowestAsk,
      highestBid,
      listings: entries,
      listingsAsOf: listings !== null && typeof listings.as_of === 'string' ? listings.as_of : null
    }
  };
}

function vertex(raw: unknown): CurveVertex | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [x, y] = raw;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** `null` for an absent series, `false` for one that is present and broken. */
function series(raw: unknown): CurveSeries | null | false {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !Array.isArray(raw.vertices)) return false;
  const vertices: CurveVertex[] = [];
  for (const item of raw.vertices) {
    const parsed = vertex(item);
    if (parsed === null) return false;
    vertices.push(parsed);
  }
  return { vertices, asOf: typeof raw.as_of === 'string' ? raw.as_of : null };
}

function segments(raw: unknown): CurveSegments | null | false {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !Array.isArray(raw.segments)) return false;
  const out: CurveVertex[][] = [];
  for (const segment of raw.segments) {
    if (!Array.isArray(segment)) return false;
    const vertices: CurveVertex[] = [];
    for (const item of segment) {
      const parsed = vertex(item);
      if (parsed === null) return false;
      vertices.push(parsed);
    }
    out.push(vertices);
  }
  return { segments: out, asOf: typeof raw.as_of === 'string' ? raw.as_of : null };
}

/**
 * The free `fx-rates.json` (`FX_RATES_URL`): `{base: "USD", as_of, stale, rates}` with a
 * positive rate per code. A rate that is zero or negative would turn a conversion into nonsense,
 * so the whole file is refused rather than one entry dropped.
 */
export function parseFxRates(status: number, body: unknown): Parsed<FxRates> {
  if (status !== 200) return unknown(`HTTP ${status}`);
  if (!isRecord(body)) return unknown('not an object');
  if (body.base !== 'USD') return unknown('base is not USD');
  if (typeof body.as_of !== 'string') return unknown('as_of missing');
  if (!isRecord(body.rates)) return unknown('rates missing');
  const rates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(body.rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return unknown(`rate for ${code} is not a positive number`);
    rates[code.toUpperCase()] = rate;
  }
  if (rates.USD !== 1) return unknown('USD is not 1');
  return { kind: 'ok', value: { base: 'USD', asOf: body.as_of, stale: body.stale === true, rates } };
}
