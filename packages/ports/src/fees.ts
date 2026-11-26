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
 * `csgomarketv3/src/core/domain/tax_calculation.py` — `to_buyer_price_cents`,
 * `to_seller_price_cents` and `steam_fee_minimum_cents` for Steam; `csfloat_fee_cents`,
 * `csfloat_buyer_to_seller` and `csfloat_seller_to_buyer` for CSFloat. The unit test holds this
 * file to that module's lookup tables cent for cent.
 *
 * **Steam's minimum belongs to the seller's wallet and to a time.** Steam raises each fee, and the
 * price itself, to the wallet's `wallet_market_minimum` (`economy_common.js`
 * `ToValidMarketPrice`). That was 1¢ on every wallet until AUD wallets moved to 2¢ at 00:00 AEDT
 * on 2026-11-21 (2026-11-20T13:00Z; corpus `concepts.steam-market-fees`). So a Steam figure is
 * always asked for with `FeeTerms`: the seller's wallet currency, and the instant the fee applies
 * to — now for a price about to be listed, the sale's own time for a sale already made, because a
 * price made under the 1¢ rule stays what it was.
 *
 * **The wallet's own word comes first.** Steam states the minimum with the wallet
 * (`wallet_market_minimum`), and a figure made now for a wallet that has stated one is made with
 * it (`FeeTerms.walletMinimumCents`), whatever the table below says: the table is what this file
 * knew when it was written, and it was a day behind on 2026-11-21. The table serves a wallet that
 * has stated nothing yet, and money dated before the wallet spoke.
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
  /**
   * The least this fee comes to, in cents, on any positive price — unless one of the schedule's
   * `walletMinimums` applies to the seller's wallet at the fee's time, which replaces it.
   */
  minimumCents: number;
  /** How a fraction of a cent is settled. */
  rounding: 'floor' | 'ceil';
};

/**
 * A wallet whose minimum moved, from an instant on (Steam's `wallet_market_minimum`). From `from`,
 * a seller whose wallet is in `walletCurrency` pays at least `minimumCents` on every fee, and a
 * listing pays that seller at least `minimumCents`: Steam raises a lower price to it.
 */
export type WalletMinimum = {
  /** Steam's numeric wallet currency (`ECurrencyCode`, as `currency.ts` numbers them): 21 is AUD. */
  walletCurrency: number;
  /** The instant it took effect, ISO-8601 in UTC. */
  from: string;
  minimumCents: number;
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
  /**
   * The wallets whose minimum moved, and when. Before a change, and on every wallet none names,
   * each fee's own `minimumCents` holds and the price is not raised. A schedule that has any
   * needs `FeeTerms` on every call; one with none (CSFloat) charges the same on every wallet.
   */
  walletMinimums?: readonly WalletMinimum[];
};

/**
 * Whose wallet a fee is charged to, and when: what Steam's minimum depends on.
 *
 * `walletCurrency` is the seller's Steam wallet currency as the account's own wallet read names
 * it (`ECurrencyCode`), or `null` while no read has named it yet; an unread wallet is charged what
 * every wallet is unless a change names it, as Steam's own sell dialog does when the wallet names
 * no minimum (`wallet_market_minimum ?? 1`). `at` is the instant the fee applies to: a `Date`,
 * epoch milliseconds, or an ISO-8601 string, where a string with no zone is UTC.
 *
 * `walletMinimumCents` is the minimum the wallet itself stated on its latest read, in whole cents,
 * for a figure made now. Given, it is the minimum and no table is consulted, so `at` decides
 * nothing. Leave it out (or `null`) for a wallet that has stated none, and for money dated before
 * the read: a sale already made keeps the minimum of its own time.
 */
export type FeeTerms = {
  walletCurrency: number | null;
  at: Date | number | string;
  walletMinimumCents?: number | null | undefined;
};

/**
 * The `terms` argument a call on `M` takes: optional on CSFloat, which charges every wallet the
 * same, and required on Steam or on a venue not known until run time, so a Steam figure is never
 * priced on a guessed wallet or time. (`[M] extends` keeps a union of venues from making it optional.)
 */
export type TermsFor<M extends MarketplaceId> = [M] extends ['csfloat'] ? [terms?: FeeTerms] : [terms: FeeTerms];

export const MARKETPLACE_FEES: Readonly<Record<MarketplaceId, MarketplaceFeeSchedule>> = {
  steam: {
    label: 'Steam Community Market',
    chargedOn: 'receive',
    fees: [
      { name: 'Steam transaction fee', basisPoints: 500, minimumCents: 1, rounding: 'floor' },
      { name: 'Counter-Strike 2 fee', basisPoints: 1_000, minimumCents: 1, rounding: 'floor' }
    ],
    listPrice: 'receive',
    source: 'csgomarketv3 src/core/domain/tax_calculation.py to_buyer_price_cents / to_seller_price_cents / steam_fee_minimum_cents',
    // AUD: 00:00 AEDT on 2026-11-21. Steam's own sell dialog read 2¢ on an AUD wallet that day and
    // other wallets still 1¢ (captured 2026-11-21), and AUD listings since carry the 2¢ fees.
    walletMinimums: [{ walletCurrency: 21, from: '2026-11-20T13:00:00.000Z', minimumCents: 2 }]
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

/** An ISO-8601 date and time with no zone: read as UTC, never as the machine's local time. */
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** The instant `at` names, in epoch milliseconds. */
function instantOf(at: FeeTerms['at']): number {
  let ms: number;
  if (at instanceof Date) ms = at.getTime();
  else if (typeof at === 'number') ms = at;
  else if (typeof at === 'string') {
    const zoneless = ZONELESS.exec(at.trim());
    ms = Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : at.trim());
  } else ms = Number.NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`a fee's time must be an instant, not ${String(at)}`);
  return ms;
}

/**
 * The wallet minimum these terms fall under, or `null` when no change names the wallet at that
 * time and each fee's own minimum holds. A schedule with wallet minimums refuses to guess. The
 * time is read only when a change names the wallet: any other wallet pays the same at every
 * instant, so a figure in it never fails on a time it does not depend on.
 */
function walletMinimumOf(schedule: MarketplaceFeeSchedule, terms: FeeTerms | undefined): number | null {
  const changes = schedule.walletMinimums ?? [];
  if (changes.length === 0) return null;
  if (terms === undefined) {
    throw new TypeError(`${schedule.label} charges by the seller's wallet and the time: pass FeeTerms`);
  }
  // The wallet's own statement outranks the table. Anything but a whole number of cents from 1 up
  // is not a statement, and the table answers.
  const stated = terms.walletMinimumCents;
  if (typeof stated === 'number' && Number.isSafeInteger(stated) && stated >= 1) return stated;
  const named = changes.filter((change) => change.walletCurrency === terms.walletCurrency);
  if (named.length === 0) return null;
  const at = instantOf(terms.at);
  let latest: { from: number; cents: number } | null = null;
  for (const change of named) {
    const from = Date.parse(change.from);
    if (at >= from && (latest === null || from > latest.from)) latest = { from, cents: change.minimumCents };
  }
  return latest?.cents ?? null;
}

/** The fee schedule as it applies to one wallet at one time: every minimum settled. */
type Terms = {
  schedule: MarketplaceFeeSchedule;
  /** Each fee's minimum, in `schedule.fees` order. */
  minimums: readonly number[];
  /** The least price a listing pays its seller; 0 where the price is not raised. */
  priceFloorCents: number;
};

function termsOf(marketplace: MarketplaceId, terms: FeeTerms | undefined): Terms {
  const schedule = MARKETPLACE_FEES[marketplace];
  const wallet = walletMinimumOf(schedule, terms);
  return {
    schedule,
    minimums: schedule.fees.map((fee) => wallet ?? fee.minimumCents),
    priceFloorCents: wallet ?? 0
  };
}

function feeOn(fee: MarketplaceFee, minimumCents: number, baseCents: number): number {
  if (baseCents <= 0) return 0;
  const scaled = baseCents * fee.basisPoints;
  const remainder = scaled % 10_000;
  const whole = (scaled - remainder) / 10_000;
  return Math.max(minimumCents, fee.rounding === 'ceil' && remainder > 0 ? whole + 1 : whole);
}

function feeLines(terms: Terms, baseCents: number): FeeLine[] {
  return terms.schedule.fees.map((fee, index) => ({ name: fee.name, cents: feeOn(fee, terms.minimums[index]!, baseCents) }));
}

function totalFees(terms: Terms, baseCents: number): number {
  return terms.schedule.fees.reduce((sum, fee, index) => sum + feeOn(fee, terms.minimums[index]!, baseCents), 0);
}

function totalBasisPoints(schedule: MarketplaceFeeSchedule): number {
  return schedule.fees.reduce((sum, fee) => sum + fee.basisPoints, 0);
}

/** A positive receive raised to the least price a listing can pay its seller. */
function listedReceive(terms: Terms, receiveCents: number): number {
  return receiveCents > 0 ? Math.max(terms.priceFloorCents, receiveCents) : receiveCents;
}

/** What a buyer pays on a venue that charges on what the seller receives. */
function asks(terms: Terms, receiveCents: number): number {
  return receiveCents === 0 ? 0 : listedReceive(terms, receiveCents) + totalFees(terms, receiveCents);
}

function whole(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > LARGEST_CENTS) {
    throw new RangeError(`a price must be a whole number of cents from 0 to ${LARGEST_CENTS}, not ${cents}`);
  }
  return cents;
}

/**
 * The smallest fee, and the smallest price a listing pays its seller, on a Steam wallet in this
 * currency at this instant: Steam's `wallet_market_minimum` (`steam_fee_minimum_cents` in the
 * incumbent). What the wallet stated when it stated one (`walletMinimumCents`); otherwise the
 * table's 2¢ on AUD wallets from 2026-11-20T13:00Z, 1¢ before it and on every other wallet.
 */
export function steamFeeMinimumCents(walletCurrency: number | null, at: FeeTerms['at'], walletMinimumCents?: number | null): number {
  const terms = termsOf('steam', { walletCurrency, at, walletMinimumCents });
  return Math.min(...terms.minimums);
}

/**
 * The least a buy order may offer for one unit on a Steam wallet: three times its minimum, which
 * is the receive floor plus both fees at theirs, and the test Steam's own order dialog applies
 * (`3 * wallet_market_minimum`, its page script of 2026-11-23). A$0.06 on an AUD wallet at 2¢.
 */
export function steamBuyOrderMinimumCents(walletCurrency: number | null, at: FeeTerms['at'], walletMinimumCents?: number | null): number {
  return 3 * steamFeeMinimumCents(walletCurrency, at, walletMinimumCents);
}

/**
 * What a buyer pays for a listing that pays the seller `receiveCents`: the least buyer price
 * that pays at least that much.
 *
 * Every amount a seller can ask for is reachable on both venues this file knows, so "at least"
 * is "exactly" in practice; the pinned vectors prove it for every price under $3. On Steam a
 * receive under the wallet's minimum is the minimum's listing: 1¢ on a 2¢ wallet asks what 2¢ does.
 *
 * Steam needs `terms` (whose wallet, and when); CSFloat charges the same on every wallet.
 */
export function buyerPaysFor<M extends MarketplaceId>(marketplace: M, receiveCents: number, ...terms: TermsFor<M>): number {
  return buyerOf(termsOf(marketplace, terms[0]), whole(receiveCents));
}

function buyerOf(terms: Terms, receive: number): number {
  if (receive === 0) return 0;
  if (terms.schedule.chargedOn === 'receive') return asks(terms, receive);
  // Charged on the buyer price, so search upward from an estimate. What a buyer price nets never
  // falls as the price rises, so the first price that nets enough is the answer.
  const nets = (buyer: number): number => Math.max(0, buyer - totalFees(terms, buyer));
  const bps = totalBasisPoints(terms.schedule);
  let buyer = Math.max(receive, Math.floor((receive * 10_000) / (10_000 - bps)) - 2);
  while (buyer > receive && nets(buyer - 1) >= receive) buyer -= 1;
  while (nets(buyer) < receive) buyer += 1;
  return buyer;
}

/**
 * What the seller receives when a buyer pays at most `buyerCents`: the most any listing priced
 * at or under it pays.
 *
 * Not every buyer price exists on Steam — on a 1¢ wallet nothing lists at 44¢, because 39¢ asks
 * 43¢ and 40¢ asks 46¢, and on a 2¢ wallet nothing lists under 6¢ — so this rounds down to a
 * listing that does, or to 0 when there is none. `quoteFromBuyer` says what it rounded to.
 *
 * Steam needs `terms` (whose wallet, and when); CSFloat charges the same on every wallet.
 */
export function receiveFor<M extends MarketplaceId>(marketplace: M, buyerCents: number, ...terms: TermsFor<M>): number {
  return receiveOf(termsOf(marketplace, terms[0]), whole(buyerCents));
}

function receiveOf(terms: Terms, buyer: number): number {
  if (terms.schedule.chargedOn === 'buyer') return Math.max(0, buyer - totalFees(terms, buyer));
  const bps = totalBasisPoints(terms.schedule);
  let receive = Math.max(0, Math.floor((buyer * 10_000) / (10_000 + bps)) + 2);
  while (receive > 0 && asks(terms, receive) > buyer) receive -= 1;
  // Every receive under the wallet's minimum asks what the minimum does, so this climbs past them.
  while (asks(terms, receive + 1) <= buyer) receive += 1;
  return receive;
}

/**
 * The listing that pays the seller `receiveCents`, with what its buyer pays and every fee in it.
 * On Steam a receive under the wallet's minimum comes back as the minimum, which is what the
 * listing would pay (Steam raises the price to it), so `receiveCents` can come back above the
 * figure given.
 */
export function quoteFromReceive<M extends MarketplaceId>(marketplace: M, receiveCents: number, ...terms: TermsFor<M>): PriceQuote {
  const settled = termsOf(marketplace, terms[0]);
  const asked = whole(receiveCents);
  const buyerCents = buyerOf(settled, asked);
  const receive = settled.schedule.chargedOn === 'receive' ? listedReceive(settled, asked) : receiveOf(settled, buyerCents);
  return quote(settled, receive, buyerCents);
}

/**
 * The listing a buyer price describes. On a venue that charges on what the seller receives, the
 * buyer price is rounded down to one that exists, so `buyerCents` can come back below the figure
 * given.
 */
export function quoteFromBuyer<M extends MarketplaceId>(marketplace: M, buyerCents: number, ...terms: TermsFor<M>): PriceQuote {
  const settled = termsOf(marketplace, terms[0]);
  const asked = whole(buyerCents);
  const receiveCents = receiveOf(settled, asked);
  const buyer = settled.schedule.chargedOn === 'buyer' ? asked : buyerOf(settled, receiveCents);
  return quote(settled, receiveCents, buyer);
}

function quote(terms: Terms, receiveCents: number, buyerCents: number): PriceQuote {
  const base = terms.schedule.chargedOn === 'receive' ? receiveCents : buyerCents;
  return { receiveCents, buyerCents, fees: receiveCents === 0 && buyerCents === 0 ? [] : feeLines(terms, base) };
}

/** The figure a marketplace's list call takes, out of a quote. */
export function listPriceOf(marketplace: MarketplaceId, quote: PriceQuote): number {
  return MARKETPLACE_FEES[marketplace].listPrice === 'receive' ? quote.receiveCents : quote.buyerCents;
}
