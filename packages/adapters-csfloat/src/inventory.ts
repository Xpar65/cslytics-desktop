import type { AccountId, CredentialVault, CsfloatCredentialRef, CsfloatInventoryPort, CsfloatListingItem } from '@cslytics/ports';
import { CsfloatTransport, requireKey } from './transport.js';
import { readResult } from './outcome.js';
import { readListingItem } from './listings.js';

export class CsfloatInventoryAdapter implements CsfloatInventoryPort {
  constructor(private readonly vault: CredentialVault, private readonly transport = new CsfloatTransport()) {}
  async getInventory(accountId: AccountId, credential: CsfloatCredentialRef) {
    return readResult(await this.transport.send({ accountId, method: 'GET', path: '/me/inventory', key: await requireKey(this.vault, credential) }), readInventory);
  }
}

export function readInventory(body: unknown): CsfloatListingItem[] | null {
  if (!Array.isArray(body)) return null;
  const rows: CsfloatListingItem[] = [], assets = new Set<string>();
  for (const value of body) {
    const row = readListingItem(value);
    if (!row || assets.has(row.assetId)) return null;
    assets.add(row.assetId); rows.push(row);
  }
  return rows;
}
