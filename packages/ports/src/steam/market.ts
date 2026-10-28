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
export type Wallet = { balanceCents: number; delayedBalanceCents: number; currency: number; observedAt: string };

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

export interface SteamMarketPort {
  getMyHistoryPage(accountId: AccountId, start: number, count: number): Promise<MyHistoryPage>;
  getMyListingsPage(accountId: AccountId, start: number, count: number): Promise<MyListingsPage>;
  createSellListing(accountId: AccountId, assetId: AssetId, priceReceiveCents: number): Promise<MutationOutcome>;
  removeListing(accountId: AccountId, listingId: ListingId): Promise<MutationOutcome>;
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
