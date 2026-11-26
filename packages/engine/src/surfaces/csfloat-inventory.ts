import type { AccountId, CsfloatListingItem, CsfloatReadResult } from '@cslytics/ports';
import { MarketplaceStore } from '../db/marketplace.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import type { EngineContext } from '../kernel/context.js';

/**
 * The error a walk CSFloat refused for its pace records: words `isRateLimitReason` holds the scope
 * on, to the moment CSFloat named (CSF-60).
 */
export const CSFLOAT_THROTTLED = 'CSFloat refused the read for its pace (HTTP 429)';

/**
 * One walk's result: the observation it wrote, and, when CSFloat refused it for its pace, how long
 * CSFloat said to wait (`x-ratelimit-reset` or `retry-after`), so the read is held to that moment.
 */
export type CsfloatInventoryWalk = { observationId: number; retryAfterMs?: number };

export class CsfloatInventoryService {
  constructor(protected readonly context: EngineContext) {}
  async sync(accountId: AccountId): Promise<CsfloatInventoryWalk> {
    const { database: db } = this.context;
    const store = new MarketplaceStore(db), before = store.connection(accountId,'csfloat'), startedAt = this.context.now();
    let result: CsfloatReadResult<CsfloatListingItem[]> = { kind: 'unavailable', cause: 'transport', raw: null };
    if (before?.credential_ref && before.status !== 'DISCONNECTED' && this.context.ports.csfloat) {
      try { result = await this.context.ports.csfloat.inventory.getInventory(accountId,before.credential_ref); } catch { /* incomplete observation below */ }
    }
    const current = before && store.connection(accountId,'csfloat')?.generation === before.generation;
    // An empty eligibility cache supplies no positive eligibility, even if the walk is well formed.
    const complete = Boolean(current && result.kind === 'ok');
    // A 429 says so in its own words: read as anything else it earned the ordinary backoff, which a
    // listing's read lifted again at once, about fifty refused calls an hour for a day (2026-11-10, CSF-60).
    const error = complete ? undefined : result.kind === 'throttled' ? CSFLOAT_THROTTLED : 'CSFloat inventory unavailable or connection changed';
    const id = db.transaction(() => {
      const obs = db.insertObservation({ accountId, surface: 'csfloat-inventory', generation: before?.generation ?? 0,
        startedAt, finishedAt: this.context.now(), complete, pagesWalked: complete ? 1 : 0, ...(error === undefined ? {} : { error }) });
      if (complete && result.kind === 'ok') {
        new AssetEvidenceStore(db).observeCsfloat(accountId,result.value,obs);
      }
      return obs;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-inventory', complete, observationId: id });
    return result.kind === 'throttled' && result.retryAfterMs !== null ? { observationId: id, retryAfterMs: result.retryAfterMs } : { observationId: id };
  }
}
