import type { AccountId, AssetId, BuyOrderId, ListingId, MutationOutcome } from '../kernel.js';

/**
 * The Steam Community Market: listings, buy orders, wallet and history.
 *
 * `sellitem` price is integer cents the **seller receives**, not the buyer price (rule 4). Raw
 * venue event codes stay uninterpreted here; the why-oracle in the engine decides what a code
 * means, because that meaning is evidence-graded and has changed.
 */
export type MarketAsset = {
  appId: number;
  assetId: AssetId;
  marketHashName: string;
  marketName?: string;
  iconUrl?: string;
};

export type MarketListing = {
  listingId: ListingId;
  asset: MarketAsset;
  priceReceiveCents: number;
  feeCents: number;
  buyerPriceCents: number;
  currency: number;
  status?: number;
  active: boolean;
  holdUntil?: string;
};

export type MarketBuyOrder = {
  buyOrderId: BuyOrderId;
  appId: number;
  hashName: string;
  currency: number;
  priceCents: number;
  quantity: number;
  quantityRemaining: number;
};

export type MyListingsPage = {
  success: true;
  start: number;
  totalCount: number;
  listings: MarketListing[];
  listingsOnHold: MarketListing[];
  listingsToConfirm: MarketListing[];
  buyOrders: MarketBuyOrder[];
  numActiveListings: number;
};

/** Raw venue event codes are interpreted only by the engine. */
export type MarketHistoryEvent = {
  eventId: string;
  listingId: string;
  purchaseId?: string;
  /** The asset the listing named, when the body carried it: what binds a sale to a request the book never showed. */
  assetId?: string;
  eventType: number;
  occurredAt: string;
  raw: unknown;
};
export type MyHistoryPage = { success: true; start: number; totalCount: number; events: MarketHistoryEvent[] };

/**
 * One event of the 2026 market's own history read, `QueryMyHistory`: the same log as
 * `MarketHistoryEvent`, without the purchase id the old route names an event by, and with the
 * moment the listing went live. Raw venue codes stay uninterpreted, as above.
 */
export type MarketHistoryAction = {
  listingId: string;
  eventType: number;
  /** When the event happened, to the millisecond Steam gave. */
  occurredAt: string;
  /** When the listing went live, when Steam said; absent when it gave none or gave zero. */
  listedAt?: string;
  /** How many units the listing was created with (`original_amount`), when the body said. */
  listingUnits?: number;
  /** What the body's description called the item, when it carried one. */
  hashName?: string;
  raw: unknown;
};

/**
 * A page of `QueryMyHistory`. There is no total: `more` is the venue's only word on whether the
 * log goes on, and a page is addressed by the offset and count it was asked for.
 */
export type MyHistoryActionsPage = { start: number; count: number; more: boolean; events: MarketHistoryAction[] };

export type BuyOrderRequest = {
  currency: number;
  appId: 730;
  marketHashName: string;
  priceTotalCents: number;
  tradeFeeTax: number;
  quantity: number;
  billing: BillingAddress;
  confirmationId?: string;
};

export type BillingAddress = {
  state: string;
  country?: string;
  city?: string;
  postalCode?: string;
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
};

export type BuyOrderStatus = {
  active: boolean;
  purchased: number;
  quantity: number;
  quantityRemaining: number;
};

export type TaxRate = { addTax: boolean; rate: number };
/**
 * `marketMinimumCents` is Steam's `wallet_market_minimum` for this wallet, in whole cents, when the
 * read learned it: the least fee and the least price a listing pays its seller (`fees.ts`). A read
 * that could not learn it leaves it out, and the fee table answers instead; it never fails the read.
 */
export type Wallet = { balanceCents: number; delayedBalanceCents: number; currency: number; observedAt: string; marketMinimumCents?: number };

/** One resting level of an order book: a price and the units at it, point not cumulative. */
export type OrderBookLevel = { priceCents: number; quantity: number };

/**
 * The account's own read of a name's order book: `/market/orderbook` asked with the account's
 * session, integer cents in `currency`, which is the `eCurrency` Steam named for the answer and is
 * never assumed. Where the session pins the book to the wallet, every figure here is one the venue
 * named in the wallet's currency, and so one a price may be pressed from without conversion
 * (AGENTS.md rule 9).
 */
export type AccountOrderBook = {
  currency: number;
  highestBidCents: number | null;
  lowestAskCents: number | null;
  /** Units resting on each side, as Steam counts them. */
  bidUnits: number;
  askUnits: number;
  /** Best bid first. */
  bids: readonly OrderBookLevel[];
  /** Best ask first. */
  asks: readonly OrderBookLevel[];
  etag: string | null;
  observedAt: string;
};

/**
 * How long Steam holds a listing's price after it goes live and after every price change it
 * accepts, before it takes another: five minutes, per listing (corpus
 * `steamcommunity.market.update-sell-listing-price`). A change asked for inside it is refused with
 * the seconds left, and the refusal does not extend it.
 */
export const LISTING_PRICE_COOLDOWN_MS = 300_000;

/**
 * The longest a call to the market's action route (`updateListingPrice`,
 * `discardListingPriceChange`) waits for its answer before it gives up and answers `AMBIGUOUS` with
 * the cause `timeout`. An implementation of the port gives up no later than this. A request given
 * up on may still be processed by the venue afterwards, so a caller that must know one can no
 * longer land waits this long after it began, and a margin more.
 */
export const MARKET_ACTION_TIMEOUT_MS = 30_000;

/**
 * What `raw` holds on an `updateListingPrice` or `discardListingPriceChange` outcome whenever the
 * venue answered: the HTTP status and the body, parsed when it was JSON and as text otherwise.
 * `redirected` marks an answer that was a redirect, which is not followed. An outcome with no
 * answer at all (a timeout, a failed connection) holds the error's message instead, and a refusal
 * made before any request holds `null`.
 */
export type MarketActionAnswer = { status: number; body: unknown; redirected?: true };

/**
 * What the venue said about a price change, read out of an outcome's `raw`. Every field is `null`
 * when the answer did not carry it. These are the venue's words as it answered; which of them a
 * caller may act on is said by the outcome that carries them, on `updateListingPrice`.
 */
export type ListingPriceChangeAnswer = {
  /**
   * The code the venue's own page would show: `eUpdateResult` when `eResult` is 1, otherwise
   * `eResult`; for a discard, the bare code it answers. 1 is accepted, 84 is the cooldown.
   */
  venueCode: number | null;
  /**
   * `nPrice`, integer cents the seller receives: the price the venue states the listing is at as
   * it answers. On a change that applied at once it is the new price; while a lower one waits for
   * its confirmation it is the price still current, not the one asked for. `null` when the answer
   * named none, or named something that is not a whole number.
   */
  priceReceiveCents: number | null;
  /** Who must confirm a change that waits: the Steam mobile app, or a link sent by e-mail. `null` when no confirmation was asked. */
  confirmation: 'phone' | 'email' | null;
  /** `csecCooldown`: the seconds left before the listing takes another change, on the cooldown refusal. */
  cooldownSeconds: number | null;
};

const NO_PRICE_CHANGE_ANSWER: ListingPriceChangeAnswer = { venueCode: null, priceReceiveCents: null, confirmation: null, cooldownSeconds: null };

/**
 * Reads what the venue said out of the `raw` of an `updateListingPrice` or
 * `discardListingPriceChange` outcome, whichever implementation of the port produced it. Total: a
 * `raw` that is not an answer reads as nothing said.
 */
export function listingPriceChangeAnswer(raw: unknown): ListingPriceChangeAnswer {
  const body = raw !== null && typeof raw === 'object' ? (raw as { body?: unknown }).body : undefined;
  const data = body !== null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (typeof data === 'number') return { ...NO_PRICE_CHANGE_ANSWER, venueCode: integerOrNull(data) };
  if (data === null || typeof data !== 'object') return NO_PRICE_CHANGE_ANSWER;
  const row = data as Record<string, unknown>;
  const result = integerOrNull(row['eResult']);
  const update = integerOrNull(row['eUpdateResult']);
  return {
    venueCode: result === 1 && update !== null ? update : result,
    priceReceiveCents: integerOrNull(row['nPrice']),
    // Method 2 is the mobile app; the venue's page treats every other method as e-mail.
    confirmation: row['bRequiresConfirmation'] ? (row['eConfirmationMethod'] === 2 ? 'phone' : 'email') : null,
    cooldownSeconds: integerOrNull(row['csecCooldown'])
  };
}

/**
 * The seller price, in integer cents, the venue stated the listing is at as it answered an
 * `updateListingPrice`: the price asked for on `price-updated`, which is given to no answer that
 * names another, and the price still current on `price-change-awaiting-confirmation`. `null` for
 * every other outcome, an ambiguous one that named a price included: only a `SUBMITTED` answer is
 * the venue stating a price.
 */
export function listingPriceInEffect(outcome: MutationOutcome): number | null {
  if (outcome.kind !== 'SUBMITTED') return null;
  if (outcome.evidence !== 'price-updated' && outcome.evidence !== 'price-change-awaiting-confirmation') return null;
  return listingPriceChangeAnswer(outcome.raw).priceReceiveCents;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export interface SteamMarketPort {
  getMyHistoryPage(accountId: AccountId, start: number, count: number): Promise<MyHistoryPage>;
  /**
   * The same log through the 2026 market's own read, for the listing time each event carries.
   * Optional: a port without it reads no listing times, and nothing else depends on it. The venue
   * answers only the pages its own page asks for, `[0, 50]` and then `[start + count, 25]`; any
   * other pair is refused, and a refusal throws `query-my-history-refused`.
   */
  getMyHistoryActionsPage?(accountId: AccountId, start: number, count: number): Promise<MyHistoryActionsPage>;
  getMyListingsPage(accountId: AccountId, start: number, count: number): Promise<MyListingsPage>;
  createSellListing(accountId: AccountId, assetId: AssetId, priceReceiveCents: number): Promise<MutationOutcome>;
  removeListing(accountId: AccountId, listingId: ListingId): Promise<MutationOutcome>;
  /**
   * Changes an active listing's price in place: the same listing, the same id, a new price, where
   * `removeListing` and `createSellListing` would make a second listing. Optional: a port without
   * it has no price edit, and a caller removes and relists instead.
   *
   * `priceReceiveCents` is integer cents the seller receives (rule 4), as `createSellListing`
   * takes it. `currency` is the account's wallet currency as Steam numbers it, the form
   * `Wallet.currency` carries (21 is AUD); the id a listing states for the same currency, that
   * code plus 2000, is taken as the same thing. The implementation owns how it reaches the venue.
   *
   * The answer is the venue's word about the attempt, and what each outcome may be taken to say
   * is fixed here:
   *
   * - `SUBMITTED`, evidence `price-updated`: the venue accepted the change, asked for no
   *   confirmation, and named the listing's price as exactly the `priceReceiveCents` asked for.
   *   It is the venue stating that the listing is now at this price, and no answer that names
   *   another price, or none, is given this evidence. Steam answers so for a price that is not
   *   lower than the current one.
   * - `SUBMITTED`, evidence `price-change-awaiting-confirmation`: a lower price, accepted and not
   *   applied. The listing stays on sale at its old price, which is the price the answer names,
   *   until the change is confirmed, in the mobile app or by e-mail, or dropped with
   *   `discardListingPriceChange`.
   * - `DEFINITIVELY_REJECTED`, reason `cooldown`, with `retryAfterMs`: the listing went live or
   *   took a change less than `LISTING_PRICE_COOLDOWN_MS` ago. Nothing changed, and the wait is
   *   not extended by having asked.
   * - `DEFINITIVELY_REJECTED` with any other reason and a `null` `raw`: the request was never
   *   made (a price that is not positive integer cents, no listing id, no such currency).
   * - `AMBIGUOUS`: everything else. That includes any other code of the venue's, and an accepted
   *   change with no confirmation asked whose answer names no price or a price other than the one
   *   asked for: the venue has then not stated the price asked for, whatever its code says. The
   *   code and the price it did name, when there were any, are in `raw`.
   *
   * `raw` is a `MarketActionAnswer` whenever the venue answered. `listingPriceInEffect` reads the
   * price a `SUBMITTED` answer states the listing is at, as a number; `listingPriceChangeAnswer`
   * reads that price, who confirms a waiting change, the seconds of a cooldown and the venue's
   * code out of the `raw` of any outcome.
   */
  updateListingPrice?(accountId: AccountId, listingId: ListingId, priceReceiveCents: number, currency: number): Promise<MutationOutcome>;
  /**
   * Drops a lower price that still waits for its confirmation; the listing keeps its current
   * price. Optional, with `updateListingPrice`. The cooldown neither holds a discard nor is moved
   * by one. `SUBMITTED`, evidence `price-change-discarded`, when the venue accepted it; anything
   * else it answered is `AMBIGUOUS`, and whether a change still waits is for a later observation
   * to say.
   */
  discardListingPriceChange?(accountId: AccountId, listingId: ListingId): Promise<MutationOutcome>;
  createBuyOrder(accountId: AccountId, request: BuyOrderRequest): Promise<MutationOutcome>;
  cancelBuyOrder(accountId: AccountId, buyOrderId: BuyOrderId): Promise<MutationOutcome>;
  getBuyOrderStatus(accountId: AccountId, buyOrderId: BuyOrderId): Promise<BuyOrderStatus>;
  getTradeFeeTaxRate(accountId: AccountId, billing: BillingAddress): Promise<TaxRate>;
  getWallet(accountId: AccountId): Promise<Wallet>;
  /**
   * The account's own read of a name's order book, or `null` when Steam has no market for the
   * name. A price read, not an observation: nothing of it enters the trading record (portfolio
   * and pricing plan D3, D17).
   */
  getOrderBook(accountId: AccountId, marketHashName: string): Promise<AccountOrderBook | null>;
}
