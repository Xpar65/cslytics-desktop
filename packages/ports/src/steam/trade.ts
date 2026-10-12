import type { AccountId, MutationOutcome } from '../kernel.js';

/**
 * Steam trade observations and mutation attempts between owned accounts.
 *
 * Offers and history have different completeness semantics, which is the mistake worth
 * preventing at the type level: offers page with `next_cursor` and describe the *current* set,
 * while history pages with `start_after_time` / `start_after_tradeid` and reports `more` plus
 * `total_trades`. Treating one as the other is how a history walk silently skips the trades it
 * never asked for.
 *
 * An offer id and an executed trade id are different identifiers on the same object
 * (`tradeofferid` vs `tradeid`, captured 2026-09-09 — cslytics-app-docs/steam/trades.md), so both
 * are carried and neither is derived from the other.
 *
 * Raw `trade_offer_state` and `status` codes stay uninterpreted here for the same reason market
 * event codes do: what a code means is evidence-graded and has changed, so the engine decides.
 */
export type TradeLine = {
  appId: number;
  /** Steam's inventory context, opaque. CS2 is `"2"`, but nothing here assumes it. */
  contextId: string;
  assetId: string;
  classId: string;
  instanceId: string;
  /** Stack size on this line. Steam sends `amount`; one is the ordinary case. */
  quantity: number;
  /**
   * The asset id the item carries *after* the trade, when Steam supplies it. A trade reissues
   * asset ids exactly as a market round-trip does (rule 3), so this is remapping evidence, never
   * an identity.
   */
  newAssetId?: string;
  /** Steam says the line's item is no longer in the sender's inventory. */
  missing?: boolean;
  marketHashName?: string;
  type?: string;
  tradable?: boolean;
  marketable?: boolean;
};

export type TradeOffer = {
  /** `tradeofferid`. */
  offerId: string;
  /** `tradeid`: present only once the offer executed. Never derived from `offerId`. */
  tradeId?: string;
  /** `accountid_other`, opaque. Steam sends a 32-bit account id here, not a SteamID64. */
  counterpartyId: string;
  direction: 'sent' | 'received';
  /** Raw `trade_offer_state`. */
  state: number;
  /** Raw `confirmation_method`: nonzero means Steam wants a confirmation this app never makes. */
  confirmationMethod?: number;
  /** `escrow_end_date` as UTC ISO-8601 when Steam supplies it. */
  escrowUntil?: string;
  expiresAt?: string;
  /**
   * `settlement_date`: when Steam settles an accepted offer, which for a trade-protected trade is the
   * end of its reversal period — seven days out, rounded to the hour (captured 2026-10-01 on an
   * accepted offer with `delay_settlement: true`). Zero while the offer is open, which arrives as absent.
   */
  settlementDate?: string;
  createdAt: string;
  updatedAt: string;
  message?: string;
  /** Lines this account gives away. */
  give: TradeLine[];
  /** Lines this account receives. */
  receive: TradeLine[];
  raw: unknown;
};

/**
 * `next_cursor` is Steam's own paging token for offers. `null` means the walk reached the end;
 * a caller may conclude nothing from a page that did not.
 */
export type TradeOffersPage = {
  success: true;
  sent: TradeOffer[];
  received: TradeOffer[];
  nextCursor: number | null;
};

export type ExecutedTrade = {
  /** `tradeid`. */
  tradeId: string;
  /** `steamid_other`, opaque string: a 17-digit id loses precision as a JavaScript number. */
  counterpartySteamId64: string;
  /** Raw `status`. */
  status: number;
  /** `time_init`. */
  initiatedAt: string;
  /** `time_mod`, when supplied. */
  updatedAt?: string;
  /** `time_settlement`: an escrow hold's release, not the moment of acceptance. */
  settledAt?: string;
  given: TradeLine[];
  received: TradeLine[];
  raw: unknown;
};

/**
 * `more` and `total_trades` are how history reports completeness; there is no `next_cursor`
 * here. `totalTrades` is absent unless `include_total` was requested and answered.
 */
export type TradeHistoryPage = {
  success: true;
  trades: ExecutedTrade[];
  more: boolean;
  totalTrades: number | null;
};

/** Where a history walk resumes. Both halves are needed: trades share a second. */
export type TradeHistoryCursor = {
  afterTimeSeconds: number;
  afterTradeId: string;
  maxTrades: number;
};

export interface SteamTradePort {
  getMyTradeUrl(accountId: AccountId): Promise<TradeUrl>;
  getHoldDurations(accountId: AccountId, partnerSteamId64: string, token: string): Promise<HoldDurations>;
  getTradeInventoryPage(accountId: AccountId, cursor?: string): Promise<TradeInventoryPage>;
  sendOffer(accountId: AccountId, request: SendOfferRequest): Promise<MutationOutcome>;
  acceptOffer(accountId: AccountId, offerId: string, partnerSteamId64: string): Promise<MutationOutcome>;
  cancelOffer(accountId: AccountId, offerId: string): Promise<MutationOutcome>;
  getTradeOffersPage(accountId: AccountId, cursor?: number): Promise<TradeOffersPage>;
  getTradeHistoryPage(accountId: AccountId, cursor: TradeHistoryCursor): Promise<TradeHistoryPage>;
}

/** Tokens stay in the runtime; no renderer command accepts or returns them. */
export type TradeUrl = { partnerAccountId: string; steamId64: string; token: string };
export type HoldDurations = { mySeconds: number; theirSeconds: number };
export type TradeAsset = { appId: 730; contextId: '2'; assetId: string; quantity: number };
export type SendOfferRequest = {
  partnerSteamId64: string;
  token: string;
  message: string;
  give: readonly TradeAsset[];
};
/** Community descriptions supply tradability; absence of a GC cooldown does not. */
/** `marketable` is the description's flag when the read carried one; absent is unknown, never false. */
export type TradeInventoryItem = TradeAsset & { tradable: boolean; name: string; classId: string; instanceId: string; marketable?: boolean };
export type TradeInventoryPage = { items: TradeInventoryItem[]; nextCursor: string | null; total: number };
