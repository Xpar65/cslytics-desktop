import type { AccountId, CsfloatTrade } from '@cslytics/ports';
import { CsfloatStore } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';

/** Historical states are observed separately; a busy verified window must not hide a queued sale. */
export const CSFLOAT_TRADE_STATES = ['queued','pending','verified','failed','cancelled'] as const;
/** The states a sale this app must act on is in. The other three are the venue's history. */
export const OPEN_CSFLOAT_TRADE_STATES: readonly string[] = ['queued','pending'];
/** The venue's history: read when a sale this record holds open has left the open states, and at least this often (CSF-69). */
export const HISTORY_CSFLOAT_TRADE_STATES: readonly string[] = ['verified','failed','cancelled'];
export const CSFLOAT_TRADE_HISTORY_EVERY_MS = 60 * 60_000;
/** One state the venue returned fewer rows for than it counted, with the counts. */
export type TruncatedTradeState = { state: string; count: number; rows: number };
export class CsfloatTradeService {
  constructor(protected readonly context: EngineContext) {}
  async sync(accountId: AccountId): Promise<number> {
    const { database: db, ports } = this.context, connectionStore = new MarketplaceStore(db), store = new CsfloatStore(db);
    const before = connectionStore.connection(accountId,'csfloat'), startedAt = this.context.now();
    const rows = new Map<string,CsfloatTrade>();
    const truncated: TruncatedTradeState[] = [];
    let error: string | undefined, pagesWalked = 0;
    if (!before?.credential_ref || before.status === 'DISCONNECTED' || !ports.csfloat) error = 'Connect CSFloat to observe sales';
    else {
      const read = async (state: string): Promise<boolean> => {
        const result = await ports.csfloat!.trades.getTrades(accountId,before.credential_ref!,state);
        pagesWalked++;
        if (result.kind !== 'ok') { error = `CSFloat ${state} trades unavailable`; return false; }
        if (result.value.count !== result.value.trades.length) {
          const cut: TruncatedTradeState = { state, count: result.value.count, rows: result.value.trades.length };
          error = this.truncationError(cut);
          if (error) return false;
          truncated.push(cut);
        }
        for (const trade of result.value.trades) {
          if (trade.state !== state || rows.has(trade.tradeId) || (trade.sellerSteamId !== before.remote_steam_id && trade.buyerSteamId !== before.remote_steam_id)) { error = 'CSFloat trade coverage changed'; return false; }
          rows.set(trade.tradeId,trade);
        }
        return true;
      };
      try {
        let ok = true;
        for (const state of OPEN_CSFLOAT_TRADE_STATES) if (ok) ok = await read(state);
        // The history only when it can say something new: a sale held open here has left the open states (it ended, so
        // its end is among the newest history rows), or the last read of the history is an hour old. A sale in its
        // reversal period is still `pending` and comes with the open read; the 5,000 rows of `verified` do not (CSF-69).
        if (ok && this.historyDue(accountId, rows)) for (const state of HISTORY_CSFLOAT_TRADE_STATES) if (ok) ok = await read(state);
      } catch { error = 'CSFloat trades unavailable'; }
    }
    if (connectionStore.connection(accountId,'csfloat')?.generation !== before?.generation) error = 'CSFloat connection changed';
    const id = db.transaction(() => {
      const obs = db.insertObservation({ accountId, surface: 'csfloat-trades', generation: before?.generation ?? 0, startedAt,
        finishedAt: this.context.now(), complete: !error, pagesWalked, ...(error ? { error } : { totalExpected: rows.size }) });
      // Never delete a trade on absence. Individual terminal sightings establish release.
      if (!error) for (const trade of rows.values()) store.publishTrade(accountId,trade,obs);
      if (!error && truncated.length) db.addEvent(accountId,'csfloat-trades-truncated',{ observationId: obs, states: truncated },this.context.now());
      return obs;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'csfloat-trades', complete: !error, observationId: id });
    return id;
  }

  /**
   * Whether this walk reads the history states too: a sale the record holds `queued` or `pending` is missing from the
   * open states just read, or no complete walk has read the history for `CSFLOAT_TRADE_HISTORY_EVERY_MS`. Nothing ends a
   * trade on its absence, so a walk that skips the history concludes nothing; it only learns a sale's end a walk later
   * than it could have, and a sale that left the open states is exactly the one whose end is read at once. Isolated so a
   * saboteur can read the history every walk, or never.
   */
  protected historyDue(accountId: AccountId, open: ReadonlyMap<string, CsfloatTrade>): boolean {
    const db = this.context.database;
    const held = db.raw().prepare(`SELECT trade_id FROM csfloat_trade WHERE account_id=? AND state_word IN ('queued','pending')`).all(accountId) as Array<{ trade_id: string }>;
    if (held.some((row) => !open.has(row.trade_id))) return true;
    const last = db.raw().prepare(`SELECT started_at FROM observation WHERE account_id=? AND surface='csfloat-trades' AND complete=1 AND pages_walked>=?
      ORDER BY id DESC LIMIT 1`).get(accountId, CSFLOAT_TRADE_STATES.length) as { started_at: string } | undefined;
    if (!last) return true;
    const age = Date.parse(this.context.now()) - Date.parse(last.started_at);
    return !(age >= 0 && age < CSFLOAT_TRADE_HISTORY_EVERY_MS);
  }

  /**
   * What a state the venue returned fewer rows for than it counted does to the walk.
   *
   * `/me/trades` drops the **oldest** rows past its limit of 5,000 and reports the full count,
   * with no cursor to read the rest (corpus `csfloat.trades.list`, captured 2026-08-26: every state
   * answered one total far above the 5,000 rows it carried). An open state is small and is what this app must
   * act on, so a truncated one is a walk that proves nothing about the sales book. A terminal state
   * is the venue's history: what fell off the end is older than every row kept, nothing here ends
   * a trade on its absence, and a sale this app waits on reaches its terminal state within hours,
   * so that sighting is among the newest rows. Such a walk stays complete and records which states
   * were cut, because the alternative left an account with more past sales than one page carries
   * unable to see a new one at all. An empty cut list is still a refusal: it proves nothing about
   * which rows are newest.
   */
  protected truncationError(cut: TruncatedTradeState): string | undefined {
    if (OPEN_CSFLOAT_TRADE_STATES.includes(cut.state) || cut.rows === 0) return `CSFloat ${cut.state} trades truncated`;
    return undefined;
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
