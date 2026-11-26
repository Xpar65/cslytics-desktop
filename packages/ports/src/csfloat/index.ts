import type { CsfloatAccountPort } from './account.js';
import type { CsfloatListingPort } from './listings.js';
import type { CsfloatBuyOrderPort } from './buy-orders.js';
import type { CsfloatInventoryPort } from './inventory.js';
import type { CsfloatTradePort } from './trades.js';
import type { CsfloatBudgetPort } from './budget.js';
import type { CredentialVault } from '../vault.js';

export type * from './account.js';
export type * from './listings.js';
export type * from './buy-orders.js';
export type * from './inventory.js';
export type * from './trades.js';
export type * from './budget.js';

/**
 * Everything one CSFloat connection needs, composed once per process.
 *
 * The vault is here rather than reached for globally because connecting *is* a credential
 * operation: validate the key, then store it, then switch the database reference. Only the
 * engine may sequence those three, and it can only do that if it is handed the vault.
 */
export type CsfloatPorts = {
  account: CsfloatAccountPort;
  listings: CsfloatListingPort;
  buyOrders: CsfloatBuyOrderPort;
  inventory: CsfloatInventoryPort;
  trades: CsfloatTradePort;
  vault: CredentialVault;
  /**
   * The shared request counter (`budget.ts`). Optional: a process that composes none is always
   * `open`, as every process was before 2026-11-13.
   */
  budget?: CsfloatBudgetPort;
};
