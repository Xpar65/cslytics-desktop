import type { AccountId, CsfloatTrade } from '@cslytics/ports';
import { CsfloatStore } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';

/** Historical states are observed separately; a busy verified window must not hide a queued sale. */
export const CSFLOAT_TRADE_STATES = ['queued','pending','verified','failed','cancelled'] as const;
export class CsfloatTradeService {
  constructor(protected readonly context: EngineContext) {}
  async sync(accountId: AccountId): Promise<number> {
    const { database: db, ports } = this.context, connectionStore = new MarketplaceStore(db), store = new CsfloatStore(db);
    const before = connectionStore.connection(accountId,'csfloat'), startedAt = this.context.now();
    const rows = new Map<string,CsfloatTrade>();
    let error: string | undefined, pagesWalked = 0;
    if (!before?.credential_ref || before.status === 'DISCONNECTED' || !ports.csfloat) error = 'Connect CSFloat to observe sales';
    else {
      try {
        for (const state of CSFLOAT_TRADE_STATES) {
          const result = await ports.csfloat.trades.getTrades(accountId,before.credential_ref,state);
          pagesWalked++;
          if (result.kind !== 'ok') { error = `CSFloat ${state} trades unavailable`; break; }
          if (result.value.count !== result.value.trades.length) { error = `CSFloat ${state} trades truncated`; break; }
          for (const trade of result.value.trades) {
            if (trade.state !== state || rows.has(trade.tradeId) || (trade.sellerSteamId !== before.remote_steam_id && trade.buyerSteamId !== before.remote_steam_id)) { error = 'CSFloat trade coverage changed'; break; }
            rows.set(trade.tradeId,trade);
          }
          if (error) break;
        }
      } catch { error = 'CSFloat trades unavailable'; }
    }
    if (connectionStore.connection(accountId,'csfloat')?.generation !== before?.generation) error = 'CSFloat connection changed';
    const id = db.transaction(() => {
      const obs = db.insertObservation({ accountId, surface: 'csfloat-trades', generation: before?.generation ?? 0, startedAt,
        finishedAt: this.context.now(), complete: !error, pagesWalked, ...(error ? { error } : { totalExpected: rows.size }) });
      // Never delete a trade on absence. Individual terminal sightings establish release.
      if (!error) for (const trade of rows.values()) store.publishTrade(accountId,trade,obs);
      return obs;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-trades', complete: !error, observationId: id });
    return id;
  }
  /**
   * One trade by id, for the delivery that moves it on. The delivery reads the venue's answer
   * verbatim (the buyer's trade token, the deadline, the listing's item), which the row does not
   * keep, so this is the one read the broker does not make; it takes the venue's transport budget
   * here instead (read broker plan D12).
   */
  async syncTrade(accountId: AccountId, tradeId: string): Promise<CsfloatTrade | null> {
    const { database: db, ports } = this.context, connections = new MarketplaceStore(db), before = connections.connection(accountId,'csfloat');
    if (!before?.credential_ref || before.status === 'DISCONNECTED' || !ports.csfloat) return null;
    await this.context.governors.admitRead(accountId, 'csfloat', `csfloat-trade:${tradeId}`);
    const startedAt = this.context.now();
    const result = await ports.csfloat.trades.getTrade(accountId,before.credential_ref,tradeId);
    if (connections.connection(accountId,'csfloat')?.generation !== before.generation) return null;
    const trade = result.kind === 'ok' && result.value.tradeId === tradeId && (result.value.sellerSteamId === before.remote_steam_id || result.value.buyerSteamId === before.remote_steam_id) ? result.value : null;
    const obs = db.insertObservation({ accountId, surface: 'csfloat-trade', scopeKind: 'item', scopeId: tradeId, generation: before.generation,
      startedAt, finishedAt: this.context.now(), complete: Boolean(trade), pagesWalked: 1, ...(trade ? {} : { error: 'CSFloat trade unavailable' }) });
    if (trade) db.transaction(() => new CsfloatStore(db).publishTrade(accountId,trade,obs));
    return trade;
  }
}
