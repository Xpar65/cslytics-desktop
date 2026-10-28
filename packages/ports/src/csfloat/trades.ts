import type { AccountId, MutationOutcome } from '../kernel.js';
import type { CsfloatCredentialRef } from './account.js';
import type { CsfloatReadResult } from './inventory.js';
import type { CsfloatListing } from './listings.js';

export type CsfloatTrade = {
  tradeId: string; listingId: string; sellerSteamId: string; buyerSteamId: string;
  state: string; createdAt: string; acceptedAt: string | null;
  listing: CsfloatListing;
  offerId: string | null; offerState: number | null; deadlineAt: string | null;
  verificationMode: string | null; verifySaleAt: string | null;
  /** Runtime-only. Never projected into an IPC result, action payload or diagnostic. */
  tradeToken: string | null;
};

export interface CsfloatTradePort {
  /** One state at a time: a count larger than the returned rows is incomplete coverage. */
  getTrades(accountId: AccountId, credential: CsfloatCredentialRef, state: string): Promise<CsfloatReadResult<{ trades: CsfloatTrade[]; count: number }>>;
  getTrade(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string): Promise<CsfloatReadResult<CsfloatTrade>>;
  accept(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string): Promise<MutationOutcome>;
  /**
   * Several queued sales in one call (`POST /trades/bulk/accept`), answered per id: a refusal or a lost answer of the
   * whole call is every id's, and an id a successful answer does not name is AMBIGUOUS, for a trade read to settle.
   */
  acceptMany(accountId: AccountId, credential: CsfloatCredentialRef, tradeIds: readonly string[]): Promise<Readonly<Record<string, MutationOutcome>>>;
  notifyOffer(accountId: AccountId, credential: CsfloatCredentialRef, offerId: string, assetIds: readonly string[]): Promise<MutationOutcome>;
  cannotDeliver(accountId: AccountId, credential: CsfloatCredentialRef, tradeId: string): Promise<MutationOutcome>;
}
