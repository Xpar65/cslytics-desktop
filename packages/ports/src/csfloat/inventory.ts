import type { AccountId } from '../kernel.js';
import type { CsfloatCredentialRef, CsfloatReadResult } from './account.js';
import type { CsfloatListingItem } from './listings.js';

export type { CsfloatReadResult } from './account.js';

export interface CsfloatInventoryPort {
  /** CSFloat eligibility supplements GC ownership; it never replaces the physical inventory. */
  getInventory(accountId: AccountId, credential: CsfloatCredentialRef): Promise<CsfloatReadResult<CsfloatListingItem[]>>;
}
