/**
 * What each marketplace takes from a sale, in one place.
 *
 * Every figure that turns what a seller receives into what a buyer pays, or back, comes from
 * here. A marketplace is one entry in `MARKETPLACE_FEES`: which figure its fees are a percentage
 * of, each fee as basis points with its minimum and its rounding, and which figure its list call
 * takes. Changing a rate is changing one number; adding a marketplace is adding one entry and a
 * row of pinned vectors to `tests/unit/marketplace-fees.test.ts`.
 *
 * The formulas are the incumbent's, which it took from each venue's own sell page:
 * `csgomarketv3/src/core/domain/tax_calculation.py` — `to_buyer_price_cents` and
 * `to_seller_price_cents` for Steam; `csfloat_fee_cents`, `csfloat_buyer_to_seller` and
 * `csfloat_seller_to_buyer` for CSFloat. The unit test holds this file to that module's lookup
 * tables cent for cent.
 *
 * **Integer arithmetic only.** A rate held as a fraction makes rounding a question about the last
 * bit of a double: `100 * 0.07` is `7.000000000000001`, which a fee rounded up would charge as 8¢.
 * Today's rates happen to survive it; basis points over integer cents mean the next one need not.
 *
 * **These are previews, never records.** What a venue actually charged is what it reports —
 * Steam's `fee` on an observed listing, a CSFloat sale's proceeds — and the trading record keeps
 * that. Nothing here may be written to `trading.sqlite` as if it had been observed (rule 1).
 */

export type MarketplaceId = 'steam' | 'csfloat';

/** One fee a marketplace charges on a sale. */
export type MarketplaceFee = {
  name: string;
  /** Hundredths of a percent: 500 is 5%. */
  basisPoints: number;
  /** The least this fee comes to, in cents, on any positive price. */
  minimumCents: number;
  /** How a fraction of a cent is settled. */
  rounding: 'floor' | 'ceil';
};

export type MarketplaceFeeSchedule = {
  label: string;
  /**
   * The figure every fee is a percentage of. Steam charges on what the seller receives and adds
   * the fees on top of it; CSFloat charges on the listing price and takes the fee out of it.
   */
  chargedOn: 'receive' | 'buyer';
  fees: readonly MarketplaceFee[];
  /** The figure the marketplace's list call takes as its price. For Steam that is rule 4. */
  listPrice: 'receive' | 'buyer';
  /** Where the formula comes from, so the next change checks the same source. */
  source: string;
};

export const MARKETPLACE_FEES: Readonly<Record<MarketplaceId, MarketplaceFeeSchedule>> = {
  steam: {
    label: 'Steam Community Market',
    chargedOn: 'receive',
    fees: [
      { name: 'Steam transaction fee', basisPoints: 500, minimumCents: 1, rounding: 'floor' },
      { name: 'Counter-Strike 2 fee', basisPoints: 1_000, minimumCents: 1, rounding: 'floor' }
    ],
    listPrice: 'receive',
    source: 'csgomarketv3 src/core/domain/tax_calculation.py to_buyer_price_cents / to_seller_price_cents'
  },
  csfloat: {
    label: 'CSFloat',
    chargedOn: 'buyer',
    fees: [
      { name: 'CSFloat sale fee', basisPoints: 200, minimumCents: 1, rounding: 'ceil' }
    ],
    listPrice: 'buyer',
    source: 'csgomarketv3 src/core/domain/tax_calculation.py csfloat_fee_cents (the CSFloat sell page)'
  }
};

export type FeeLine = { name: string; cents: number };

/** One listing seen from both ends. `buyerCents - receiveCents` is the sum of `fees`. */
export type PriceQuote = {
  /** What the seller is paid. */
  receiveCents: number;
  /** What a buyer pays, which is what the listing shows. */
  buyerCents: number;
  fees: readonly FeeLine[];
};

/** Above this many cents a fee's `cents × basis points` could leave the exact integer range. */
const LARGEST_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 10_000);

function feeOn(fee: MarketplaceFee, baseCents: number): number {
  if (baseCents <= 0) return 0;
  const scaled = baseCents * fee.basisPoints;
  const remainder = scaled % 10_000;
  const whole = (scaled - remainder) / 10_000;
  return Math.max(fee.minimumCents, fee.rounding === 'ceil' && remainder > 0 ? whole + 1 : whole);
}

function feeLines(schedule: MarketplaceFeeSchedule, baseCents: number): FeeLine[] {
  return schedule.fees.map((fee) => ({ name: fee.name, cents: feeOn(fee, baseCents) }));
}

function totalFees(schedule: MarketplaceFeeSchedule, baseCents: number): number {
  return schedule.fees.reduce((sum, fee) => sum + feeOn(fee, baseCents), 0);
}

function totalBasisPoints(schedule: MarketplaceFeeSchedule): number {
  return schedule.fees.reduce((sum, fee) => sum + fee.basisPoints, 0);
}

function whole(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > LARGEST_CENTS) {
    throw new RangeError(`a price must be a whole number of cents from 0 to ${LARGEST_CENTS}, not ${cents}`);
  }
  return cents;
}

/**
 * What a buyer pays for a listing that pays the seller `receiveCents`: the least buyer price
 * that pays at least that much.
 *
 * Every amount a seller can ask for is reachable on both venues this file knows, so "at least"
 * is "exactly" in practice; the pinned vectors prove it for every price under $3.
 */
export function buyerPaysFor(marketplace: MarketplaceId, receiveCents: number): number {
  const schedule = MARKETPLACE_FEES[marketplace];
  const receive = whole(receiveCents);
  if (receive === 0) return 0;
  if (schedule.chargedOn === 'receive') return receive + totalFees(schedule, receive);
  // Charged on the buyer price, so search upward from an estimate. What a buyer price nets never
  // falls as the price rises, so the first price that nets enough is the answer.
  const nets = (buyer: number): number => Math.max(0, buyer - totalFees(schedule, buyer));
  const bps = totalBasisPoints(schedule);
  let buyer = Math.max(receive, Math.floor((receive * 10_000) / (10_000 - bps)) - 2);
  while (buyer > receive && nets(buyer - 1) >= receive) buyer -= 1;
  while (nets(buyer) < receive) buyer += 1;
  return buyer;
}

/**
 * What the seller receives when a buyer pays at most `buyerCents`: the most any listing priced
 * at or under it pays.
 *
 * Not every buyer price exists on Steam — nothing lists at 44¢, because 39¢ asks 43¢ and 40¢
 * asks 46¢ — so this rounds down to a listing that does. `quoteFromBuyer` says what it rounded to.
 */
export function receiveFor(marketplace: MarketplaceId, buyerCents: number): number {
  const schedule = MARKETPLACE_FEES[marketplace];
  const buyer = whole(buyerCents);
  if (schedule.chargedOn === 'buyer') return Math.max(0, buyer - totalFees(schedule, buyer));
  const asks = (receive: number): number => (receive === 0 ? 0 : receive + totalFees(schedule, receive));
  const bps = totalBasisPoints(schedule);
  let receive = Math.max(0, Math.floor((buyer * 10_000) / (10_000 + bps)) + 2);
  while (receive > 0 && asks(receive) > buyer) receive -= 1;
  while (asks(receive + 1) <= buyer) receive += 1;
  return receive;
}

/** The listing that pays the seller `receiveCents`, with what its buyer pays and every fee in it. */
export function quoteFromReceive(marketplace: MarketplaceId, receiveCents: number): PriceQuote {
  const schedule = MARKETPLACE_FEES[marketplace];
  const buyerCents = buyerPaysFor(marketplace, receiveCents);
  const receive = schedule.chargedOn === 'receive' ? whole(receiveCents) : receiveFor(marketplace, buyerCents);
  return quote(schedule, receive, buyerCents);
}

/**
 * The listing a buyer price describes. On a venue that charges on what the seller receives, the
 * buyer price is rounded down to one that exists, so `buyerCents` can come back below the figure
 * given.
 */
export function quoteFromBuyer(marketplace: MarketplaceId, buyerCents: number): PriceQuote {
  const schedule = MARKETPLACE_FEES[marketplace];
  const receiveCents = receiveFor(marketplace, buyerCents);
  const buyer = schedule.chargedOn === 'buyer' ? whole(buyerCents) : buyerPaysFor(marketplace, receiveCents);
  return quote(schedule, receiveCents, buyer);
}

function quote(schedule: MarketplaceFeeSchedule, receiveCents: number, buyerCents: number): PriceQuote {
  const base = schedule.chargedOn === 'receive' ? receiveCents : buyerCents;
  return { receiveCents, buyerCents, fees: receiveCents === 0 && buyerCents === 0 ? [] : feeLines(schedule, base) };
}

/** The figure a marketplace's list call takes, out of a quote. */
export function listPriceOf(marketplace: MarketplaceId, quote: PriceQuote): number {
  return MARKETPLACE_FEES[marketplace].listPrice === 'receive' ? quote.receiveCents : quote.buyerCents;
}
