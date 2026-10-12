import type { AccountId, MutationOutcome } from '../kernel.js';
import type { CsfloatReadResult } from './inventory.js';
import type { CsfloatCredentialRef } from './account.js';

/**
 * One listing in an account's own stall.
 *
 * Shaped from the live capture of 2026-09-11 (fixtures/csfloat/INDEX.md). Three decisions in
 * here are load-bearing:
 *
 * `priceCents` is the **buyer** price in integer USD cents, which is what CSFloat's `price` is
 * and what `sellitem` on Steam is not (CSF-08). Nothing derives proceeds from it here.
 *
 * `type` and `state` stay raw strings. CSFloat publishes `buy_now`, `auction`, `listed`, `sold`,
 * `delisted`, `refunded` today; a value this app has never seen still has to reach the engine,
 * because the alternative is a listing that silently stops existing.
 *
 * The item attributes are the identity tuple, not decoration: `(defIndex, paintIndex, floatValue,
 * paintSeed, quality)` is how a CSFloat listing is matched to an owned Steam item, and a rounded
 * or missing one means identity is unknown (XLIST-08).
 */
export type CsfloatListingItem = {
  assetId: string;
  defIndex: number;
  marketHashName: string;
  paintIndex?: number;
  paintSeed?: number;
  /** CSFloat's `float_value`, exact as sent. Never rounded for comparison. */
  floatValue?: number;
  quality?: number;
  isStatTrak?: boolean;
  isSouvenir?: boolean;
  /** CSFloat's `tradable`, an integer flag rather than a boolean. */
  tradable?: number;
};

export type CsfloatListing = {
  /** CSFloat's listing id, which becomes `contract_id` on a trade once it sells. */
  listingId: string;
  createdAt: string;
  type: string;
  state: string;
  priceCents: number;
  item: CsfloatListingItem;
  raw: unknown;
};

/**
 * One page of a stall walk.
 *
 * `totalCount` is the venue's own claim about the whole book and is the only completeness signal
 * the route offers; `nextCursor` is null when the venue supplied none. A walk that collected
 * fewer rows than `totalCount` is incomplete however many pages it read (CSF-05).
 */
export type CsfloatStallPage = {
  listings: CsfloatListing[];
  totalCount: number | null;
  nextCursor: string | null;
  raw: unknown;
};

export type CsfloatStallResult =
  | { kind: 'ok'; page: CsfloatStallPage }
  | { kind: 'rejected'; reason: 'invalid-key' | 'forbidden' | 'not-found'; status: number; raw: unknown }
  | { kind: 'throttled'; retryAfterMs: number | null; raw: unknown }
  | { kind: 'unavailable'; cause: 'timeout' | 'transport' | 'malformed' | 'redirected'; raw: unknown };

export interface CsfloatListingPort {
  getListing(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string): Promise<CsfloatReadResult<CsfloatListing>>;
  create(accountId: AccountId, credential: CsfloatCredentialRef, assetId: string, priceCents: number): Promise<MutationOutcome>;
  reprice(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string, priceCents: number): Promise<MutationOutcome>;
  cancel(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string): Promise<MutationOutcome>;
  /**
   * One page of the account's own stall.
   *
   * Takes the remote SteamID64 because the route is addressed by it, and the credential ref
   * because which credential is current is durable state the engine owns (CSF-04).
   */
  getStallPage(
    accountId: AccountId,
    credential: CsfloatCredentialRef,
    remoteSteamId: string,
    cursor?: string
  ): Promise<CsfloatStallResult>;
}
