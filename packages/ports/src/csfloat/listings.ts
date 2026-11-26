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

/**
 * A listing as a `reprice` answer stated it: which listing, its buyer price in integer USD cents,
 * and the venue's word for its state. Those three are what the venue is known to answer a reprice
 * with, and all a caller needs of it: everything else about a listing was fixed when it was made,
 * and what an outcome carries is kept with the attempt that earned it.
 */
export type CsfloatStatedListing = Pick<CsfloatListing, 'listingId' | 'priceCents' | 'state'>;

/**
 * The evidence of a `reprice` the venue answered with the listing: the id and the price that were
 * asked for, and its state. No other answer is given it.
 */
export const CSFLOAT_LISTING_RETURNED = 'listing-returned';

/**
 * What `raw` holds on a `reprice` outcome whenever the venue answered and was not refusing: the
 * HTTP status, the id the body named, and the listing when the body named an id, a price and a
 * state. `listing` is there for an answer that named another listing or another price too, so
 * what the venue did say is on record; which answer a caller may act on is said by the outcome
 * that carries it, on `reprice`.
 */
export type CsfloatRepriceAnswer = { status: number; id?: string; listing?: CsfloatStatedListing };

/**
 * Reads the listing out of the `raw` of a `reprice` outcome, whichever implementation of the port
 * produced it and whether it comes straight from the call or from a stored attempt. Total: a `raw`
 * that does not name an id, a price and a state together reads as `null`. These are the venue's
 * words as it answered; an outcome that is not `SUBMITTED` may carry a listing the venue named and
 * is still not the venue stating the change asked for.
 */
export function csfloatListingAnswer(raw: unknown): CsfloatStatedListing | null {
  const listing = record(record(raw)?.['listing']);
  if (!listing) return null;
  const { listingId, priceCents, state } = listing;
  if (typeof listingId !== 'string' || !listingId || !wholeNumber(priceCents) || typeof state !== 'string' || !state) return null;
  return { listingId, priceCents, state };
}

/**
 * The listing as the venue stated it is now, on a `reprice` it accepted: the listing asked about,
 * at the price asked for, with the state the venue gave it after the change. `null` for every
 * other outcome, an ambiguous one that named a listing included: only a `SUBMITTED` answer with
 * the evidence `CSFLOAT_LISTING_RETURNED` is the venue stating the listing.
 */
export function csfloatListingInEffect(outcome: MutationOutcome): CsfloatStatedListing | null {
  return outcome.kind === 'SUBMITTED' && outcome.evidence === CSFLOAT_LISTING_RETURNED ? csfloatListingAnswer(outcome.raw) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export interface CsfloatListingPort {
  getListing(accountId: AccountId, credential: CsfloatCredentialRef, listingId: string): Promise<CsfloatReadResult<CsfloatListing>>;
  create(accountId: AccountId, credential: CsfloatCredentialRef, assetId: string, priceCents: number): Promise<MutationOutcome>;
  /**
   * Changes a listing's price in place: the same listing, the same id, a new buyer price in
   * integer USD cents.
   *
   * The venue answers a reprice with the listing as it now is: its id, its price and its state
   * (corpus `csfloat.listings.update-delete`). What each outcome may be taken to say is fixed here:
   *
   * - `SUBMITTED`, evidence `CSFLOAT_LISTING_RETURNED`: the venue accepted the change and answered
   *   with the listing, under the `listingId` asked about, at exactly the `priceCents` asked for,
   *   and with its state. It is the venue stating that listing as it now is, and no answer that
   *   names another listing, another price or no state is given this evidence. The `state` is the
   *   venue's word after the change: `listed` ordinarily, and `sold` when the new price met a
   *   buy order resting on the item, which sells it in the same call.
   * - `SUBMITTED` with any other evidence: the venue acknowledged the request and stated nothing.
   *   It proves nothing about the listing.
   * - `DEFINITIVELY_REJECTED`: the venue refused and nothing changed: a price under its floor, a
   *   listing it no longer holds as listed, a key it does not accept. A refusal for its pace
   *   carries `retryAfterMs`.
   * - `AMBIGUOUS`: everything else: no answer, an answer that names no listing, and an answer
   *   that names another id or another price. The venue has then not stated the change asked
   *   for, whatever its status says.
   *
   * `raw` is a `CsfloatRepriceAnswer` whenever the venue answered without refusing.
   * `csfloatListingInEffect` reads the listing a `SUBMITTED` answer states; `csfloatListingAnswer`
   * reads whatever listing an answer named out of the `raw` of any outcome.
   */
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
