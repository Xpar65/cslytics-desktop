import type { AccountId, CsfloatListingItem, CsfloatReadResult } from '@cslytics/ports';
import { MarketplaceStore } from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';

export class CsfloatInventoryService {
  constructor(protected readonly context: EngineContext) {}
  sync(accountId: AccountId): Promise<number> {
    return this.context.reads.run(`${accountId}:csfloat-inventory`, () => this.walk(accountId));
  }
  private async walk(accountId: AccountId): Promise<number> {
    const { database: db } = this.context;
    const store = new MarketplaceStore(db), before = store.connection(accountId,'csfloat'), startedAt = this.context.now();
    let result: CsfloatReadResult<CsfloatListingItem[]> = { kind: 'unavailable', cause: 'transport', raw: null };
    if (before?.credential_ref && before.status !== 'DISCONNECTED' && this.context.ports.csfloat) {
      try { result = await this.context.ports.csfloat.inventory.getInventory(accountId,before.credential_ref); } catch { /* incomplete observation below */ }
    }
    const current = before && store.connection(accountId,'csfloat')?.generation === before.generation;
    // An empty eligibility cache supplies no positive eligibility, even if the walk is well formed.
    const complete = Boolean(current && result.kind === 'ok');
    const id = db.transaction(() => {
      const obs = db.insertObservation({ accountId, surface: 'csfloat-inventory', generation: before?.generation ?? 0,
        startedAt, finishedAt: this.context.now(), complete, pagesWalked: complete ? 1 : 0,
        ...(complete ? {} : { error: 'CSFloat inventory unavailable or connection changed' }) });
      if (complete && result.kind === 'ok') {
        db.raw().prepare('DELETE FROM csfloat_inventory WHERE account_id=?').run(accountId);
        const insert = db.raw().prepare('INSERT INTO csfloat_inventory(account_id,asset_id,item_json,observation_id) VALUES (?,?,?,?)');
        for (const item of result.value) insert.run(accountId,item.assetId,JSON.stringify(item),obs);
      }
      return obs;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-inventory', complete, observationId: id });
    return id;
  }
}
