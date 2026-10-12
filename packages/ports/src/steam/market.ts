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
export type OrderBookLevel = { priceCents: number; cumulativeQuantity: number };
export type OrderBook = {
  kind: 'order-book';
  currency: number;
  highestBuyCents: number;
  lowestSellCents: number;
  buy: OrderBookLevel[];
  sell: OrderBookLevel[];
  etag?: string;
};
export type NotModified = { kind: 'not-modified'; etag?: string };

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
  getOrderBook(accountId: AccountId, hashName: string, etag?: string): Promise<OrderBook | NotModified>;
}
