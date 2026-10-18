import type { AccountId, CsfloatListingItem, CsfloatReadResult } from '@cslytics/ports';
import { MarketplaceStore } from '../db/marketplace.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import type { EngineContext } from '../kernel/context.js';

export class CsfloatInventoryService {
  constructor(protected readonly context: EngineContext) {}
  async sync(accountId: AccountId): Promise<number> {
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
        new AssetEvidenceStore(db).observeCsfloat(accountId,result.value,obs);
      }
      return obs;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-inventory', complete, observationId: id });
    return id;
  }
}
