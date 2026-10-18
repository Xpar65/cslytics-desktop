import { steamId64FromAccountId, type AccountId, type ExecutedTrade, type TradeLine, type TradeOffer } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import type { ActionRow } from '../db/database.js';
import { TransferStore } from '../db/transfers.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { HoldingsStore } from '../db/holdings.js';
import type { TradeInventoryItem, SendOfferRequest } from '@cslytics/ports';
import { errorMessage } from '../kernel/support.js';
import { COMMITTING_STATUSES, offerStatus, reversesDelivery, settlesDelivery, tradeStatus } from '../policy/trade-status.js';
import { TradeStore } from '../db/trades.js';
import { LedgerStore } from '../db/ledger.js';

export const TRADE_OFFERS_SURFACE = 'steam-trade-offers';
export const TRADE_HISTORY_SURFACE = 'steam-trade-history';

/**
 * How far back a history walk re-reads across its own committed boundary.
 *
 * A trade that lands while a walk is in flight can be written on Steam's side with a timestamp
 * just inside the coverage the previous walk claimed. Re-reading a window means the next walk
 * still sees it; deduplication by `tradeid` is what makes the overlap free (TRD-05).
 */
export const HISTORY_OVERLAP_MS = 10 * 60_000;

/** How far back a history walk still re-reads a trade Steam has not settled: escrow is at most 15 days, protection 7. */
export const UNSETTLED_REREAD_MS = 31 * 86_400_000;

/** Bounds one sync. A pathological account cannot make a single walk unbounded. */
export const MAX_HISTORY_PAGES = 200;
export const MAX_OFFER_PAGES = 100;
export const HISTORY_PAGE_SIZE = 50;

export type TradeSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  /** Rows this walk read, before deduplication. */
  observed: number;
  /** Rows this walk was the first to record. */
  recorded: number;
  checkpointAdvanced: boolean;
  error?: string;
};

type HistoryCheckpoint = { afterTimeSeconds: number; afterTradeId: string };

/**
 * Trade observation: the offer book and the executed-trade log.
 *
 * Mutations use the common attempt journal. The owned-account orchestrator admits and
 * correlates them; this surface also owns the judgements the observed records force:
 *
 * - **An offer is not a delivery.** An `ACCEPTED` or escrowed offer moves nothing in the ledger;
 *   only an executed trade whose status is `COMPLETE` posts an item movement (TRD-04, N-TRD-01).
 * - **A checkpoint is a promise about coverage.** It advances only inside the transaction that
 *   committed the rows it covers, and only when the walk actually reached its boundary. A failed
 *   page leaves it where it was, so the next sync re-reads rather than skipping (TRD-05,
 *   N-TRD-03).
 *
 * Money is never invented here. Steam does not price a trade, so every trade posting carries an
 * `UNKNOWN` amount basis rather than a zero (DATA-04).
 */
export class TradeService {
  constructor(protected readonly context: EngineContext) {}

  /** The Community trade inventory: a broker scope (`steam-trade-inventory`), walked when the broker says, under its budget. */
  async syncEligibility(accountId: string): Promise<number> {
    {
      const evidence = new AssetEvidenceStore(this.context.database);
      const startedAt = this.context.now();
      const items: TradeInventoryItem[] = [];
      let cursor: string | undefined, total: number | undefined, error: string | undefined, pages = 0;
      const cursors = new Set<string>();
      try {
        do {
          const page = await this.context.ports.trade.getTradeInventoryPage(accountId, cursor);
          pages += 1;
          if (total !== undefined && total !== page.total) throw new Error('Trade inventory changed during the walk');
          total = page.total; items.push(...page.items);
          if (page.nextCursor === null) break;
          if (pages >= 100 || cursors.has(page.nextCursor)) throw new Error('Trade inventory cursor did not advance');
          cursors.add(page.nextCursor); cursor = page.nextCursor;
        } while (true);
        if (items.length !== total || new Set(items.map(item => item.assetId)).size !== items.length) throw new Error('Trade inventory walk is incomplete');
        if (!items.length && this.context.database.countMainItems(accountId) > 0) throw new Error('Suspicious empty trade inventory');
      } catch { error = 'Trade eligibility could not be completely refreshed'; }
      const obs = this.context.database.transaction(() => {
        const id = this.context.database.insertObservation({ accountId, surface: 'steam-trade-inventory', startedAt,
          finishedAt: this.context.now(), complete: !error, pagesWalked: pages, ...(error ? { error } : {}) });
        if (!error) evidence.observeCommunity(accountId, items, id);
        return id;
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-trade-inventory', complete: !error, observationId: obs });
      return obs;
    }
  }

  /**
   * The account's own trade link, and below it the hold a send to one owned account would meet.
   * Neither is a surface the evidence table grades, so neither is a broker scope: a transfer reads
   * them for itself, under the venue's budget (read broker plan D12).
   */
  async syncTradeLink(accountId: string): Promise<void> {
    const startedAt = this.context.now();
    await this.context.governors.admitRead(accountId, 'steam-web', 'steam-trade-link');
    const link = await this.context.ports.trade.getMyTradeUrl(accountId);
    if (this.context.database.listAccounts().find(a => a.id === accountId)?.steam_id64 !== link.steamId64) throw new Error('Trade link belongs to another account');
    this.context.database.transaction(() => {
      const id = this.context.database.insertObservation({ accountId, surface: 'steam-trade-link', startedAt, finishedAt: this.context.now(), complete: true });
      this.context.database.raw().prepare('UPDATE account SET trade_token=?, trade_token_obs=? WHERE id=?').run(link.token, id, accountId);
    });
  }

  async syncHold(accountId: string, destination: string): Promise<void> {
    const store = new TransferStore(this.context.database);
    const link = store.link(destination);
    const partner = this.context.database.listAccounts().find(a => a.id === destination);
    if (!link || !partner) throw new Error('Destination trade link is unknown');
    const startedAt = this.context.now();
    await this.context.governors.admitRead(accountId, 'steam-web', `steam-trade-hold:${destination}`);
    // A failed replacement cannot leave an old zero-hold claim authorising a send.
    this.context.database.raw().prepare('DELETE FROM transfer_hold WHERE account_id=? AND destination_account_id=?').run(accountId,destination);
    const hold = await this.context.ports.trade.getHoldDurations(accountId, partner.steam_id64, link.token);
    this.context.database.transaction(() => {
      const obs = this.context.database.insertObservation({ accountId, surface: `steam-trade-hold:${destination}`, startedAt, finishedAt: this.context.now(), complete: true });
      this.context.database.raw().prepare('INSERT OR REPLACE INTO transfer_hold VALUES (?,?,?,?,?)').run(accountId,destination,hold.mySeconds,hold.theirSeconds,obs);
    });
  }

  async sendOffer(action: ActionRow, validate: () => void) {
    const params = this.context.database.actionParams(action) as { destinationAccountId: string; message: string; give: SendOfferRequest['give'] };
    const partner = this.context.database.listAccounts().find(a => a.id === params.destinationAccountId);
    const link = new TransferStore(this.context.database).link(params.destinationAccountId);
    if (!partner || !link) throw new Error('Destination trade link is unknown');
    return executeMutation(this.context, action, () => this.context.ports.trade.sendOffer(action.account_id,
      { give: params.give, message: params.message, partnerSteamId64: partner.steam_id64, token: link.token }), validate);
  }

  async acceptOffer(action: ActionRow, validate: () => void) {
    const params = this.context.database.actionParams(action) as { offerId: string; partnerSteamId64: string };
    return executeMutation(this.context, action, () => this.context.ports.trade.acceptOffer(action.account_id, params.offerId, params.partnerSteamId64), validate);
  }

  async cancelOffer(action: ActionRow, validate: () => void) {
    const params = this.context.database.actionParams(action) as { offerId: string };
    return executeMutation(this.context, action, () => this.context.ports.trade.cancelOffer(action.account_id, params.offerId), validate);
  }

  syncOffers(accountId: AccountId): Promise<TradeSyncResult> {
    return this.walkOffers(accountId);
  }

  syncHistory(accountId: AccountId, pageSize = HISTORY_PAGE_SIZE): Promise<TradeSyncResult> {
    return this.walkHistory(accountId, pageSize);
  }

  // --- offers --------------------------------------------------------------

  protected async walkOffers(accountId: AccountId): Promise<TradeSyncResult> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const offers: TradeOffer[] = [];
    let pagesWalked = 0;
    let cursor: number | undefined;
    let error: string | undefined;
    try {
      for (;;) {
        const page = await this.context.ports.trade.getTradeOffersPage(accountId, cursor);
        pagesWalked += 1;
        offers.push(...page.sent, ...page.received);
        if (page.nextCursor === null) break;
        if (pagesWalked >= MAX_OFFER_PAGES) throw new Error('offer-walk-page-limit');
        if (cursor !== undefined && page.nextCursor <= cursor) throw new Error('offer-cursor-did-not-advance');
        cursor = page.nextCursor;
      }
      const ids = new Set(offers.map((offer) => offer.offerId));
      if (ids.size !== offers.length) throw new Error('offer-walk-duplicate-ids');
      if (!offers.length && new TradeStore(database).committedTradeAssets(accountId, COMMITTING_STATUSES).length) throw new Error('offer-walk-suspicious-empty');
    } catch (caught) {
      error = errorMessage(caught);
    }

    const complete = error === undefined;
    let recorded = 0;
    const observationId = database.transaction(() => {
      const obs = database.insertObservation({
        accountId,
        surface: TRADE_OFFERS_SURFACE,
        startedAt,
        finishedAt: this.context.now(),
        complete,
        pagesWalked,
        totalExpected: offers.length,
        ...(error === undefined ? {} : { error })
      });
      // Offer rows are point facts: one that was read is true whether or not later pages
      // failed. Only the *set* claim — "these are all the offers" — needs a complete walk, and
      // that claim lives on the observation row, not on the rows themselves.
      for (const offer of offers) if (this.persistOffer(accountId, offer, obs)) recorded += 1;
      if (complete) {
        database.advanceCheckpoint({
          accountId,
          surface: TRADE_OFFERS_SURFACE,
          cursor: { walkedPages: pagesWalked },
          coveredThrough: this.context.now(),
          observationId: obs,
          now: this.context.now()
        });
      }
      return obs;
    });

    this.context.signals.emit({ kind: 'observed', accountId, surface: TRADE_OFFERS_SURFACE, complete, observationId });
    return { observationId, complete, pagesWalked, observed: offers.length, recorded, checkpointAdvanced: complete, ...(error ? { error } : {}) };
  }

  /**
   * Whether this walk's coverage joins up with what was already committed.
   *
   * Contiguity, not "the request returned". Reaching Steam's end covers everything; crossing the
   * previous committed boundary covers the gap between then and now. Anything else leaves a
   * hole, and a checkpoint moved over a hole is how the next sync skips history nobody ever saw
   * (TRD-05, N-TRD-03). It is a method rather than an expression so a wrong version of this one
   * judgement can be composed in and caught.
   */
  protected historyCoverageIsContiguous(walk: { failed: boolean; reachedEnd: boolean; crossedBoundary: boolean }): boolean {
    return !walk.failed && (walk.reachedEnd || walk.crossedBoundary);
  }

  /**
   * How far back a history walk reads: the previous committed boundary, pulled back by the overlap
   * window — and further, to the oldest trade Steam may still change.
   *
   * A trade-protected trade is listed at once, `status` 3, with `time_settlement` at the end of its
   * reversal period and no new asset ids until then; a reversal turns it to 12 inside that period
   * (csgomarketv3 trade-offer-state-endpoints.md, findings 2026-10-02). A walk that stopped at its
   * checkpoint would never read either change for a trade older than the checkpoint, so every trade
   * that no complete walk has seen past its settlement is read again, as is an accepted offer whose
   * trade the history has not shown yet. Bounded to a month: escrow is at most fifteen days and
   * protection seven.
   */
  protected historyBoundaryMs(accountId: AccountId): number {
    const { database } = this.context;
    const previous = database.checkpoint(accountId, TRADE_HISTORY_SURFACE);
    if (!previous?.covered_through) return Number.NEGATIVE_INFINITY;
    const checkpoint = Date.parse(previous.covered_through) - HISTORY_OVERLAP_MS;
    const lastWalk = database.raw().prepare(`SELECT MAX(started_at) AS at FROM observation WHERE account_id=? AND surface=? AND complete=1 AND error IS NULL`)
      .get(accountId, TRADE_HISTORY_SURFACE) as { at: string | null };
    const floor = new Date(Date.parse(this.context.now()) - UNSETTLED_REREAD_MS).toISOString();
    const oldest = database.raw().prepare(`SELECT MIN(at) AS at FROM (
        SELECT initiated_at AS at FROM executed_trade WHERE account_id=? AND initiated_at>=?
          AND (status IN ('PENDING','ESCROW','UNKNOWN') OR (settled_at IS NOT NULL AND settled_at>=?))
        UNION ALL
        SELECT o.updated_at FROM trade_offer o WHERE o.account_id=? AND o.status='ACCEPTED' AND o.trade_id IS NOT NULL AND o.updated_at>=?
          AND NOT EXISTS (SELECT 1 FROM executed_trade t WHERE t.account_id=o.account_id AND t.trade_id=o.trade_id))`)
      .get(accountId, floor, lastWalk.at ?? '', accountId, floor) as { at: string | null };
    return oldest.at ? Math.min(checkpoint, Date.parse(oldest.at) - HISTORY_OVERLAP_MS) : checkpoint;
  }

  protected persistOffer(accountId: string, offer: TradeOffer, observationId: number): boolean {
    const { database } = this.context;
    const status = offerStatus(offer.state);
    const { changed } = new TradeStore(database).upsertTradeOffer({
      account_id: accountId,
      offer_id: offer.offerId,
      trade_id: offer.tradeId ?? null,
      // Steam's API speaks the other party's account32; the record keeps a SteamID64 (D14).
      counterparty_steam_id64: steamId64FromAccountId(offer.counterpartyId) ?? offer.counterpartyId,
      direction: offer.direction === 'sent' ? 'SENT' : 'RECEIVED',
      state_code: offer.state,
      status,
      confirmation_method: offer.confirmationMethod ?? null,
      escrow_until: offer.escrowUntil ?? null,
      expires_at: offer.expiresAt ?? null,
      settlement_date: offer.settlementDate ?? null,
      created_at: offer.createdAt,
      updated_at: offer.updatedAt,
      observation_id: observationId
    });
    database.raw().prepare('UPDATE trade_offer SET message=? WHERE account_id=? AND offer_id=?').run(offer.message ?? null,accountId,offer.offerId);
    database.raw().prepare("DELETE FROM trade_line WHERE account_id=? AND offer_id=? AND line_key LIKE 'offer:%'").run(accountId,offer.offerId);
    for (const [side, lines] of [['GIVE', offer.give], ['RECEIVE', offer.receive]] as const) {
      for (const line of lines) this.persistLine(accountId, { side, line, offerId: offer.offerId, tradeId: null, observationId });
    }
    return changed;
  }

  // --- executed history ----------------------------------------------------

  protected async walkHistory(accountId: AccountId, pageSize: number): Promise<TradeSyncResult> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const boundaryMs = this.historyBoundaryMs(accountId);

    const trades: ExecutedTrade[] = [];
    let pagesWalked = 0;
    let cursor: HistoryCheckpoint = { afterTimeSeconds: 0, afterTradeId: '' };
    let reachedEnd = false;
    let crossedBoundary = false;
    let error: string | undefined;

    try {
      for (;;) {
        const page = await this.context.ports.trade.getTradeHistoryPage(accountId, { ...cursor, maxTrades: pageSize });
        pagesWalked += 1;
        trades.push(...page.trades);
        if (!page.more || page.trades.length === 0) { reachedEnd = true; break; }
        const oldest = page.trades[page.trades.length - 1]!;
        if (Date.parse(oldest.initiatedAt) < boundaryMs) { crossedBoundary = true; break; }
        if (pagesWalked >= MAX_HISTORY_PAGES) throw new Error('history-walk-page-limit');
        cursor = { afterTimeSeconds: Math.floor(Date.parse(oldest.initiatedAt) / 1000), afterTradeId: oldest.tradeId };
      }
      if (new Set(trades.map((trade) => trade.tradeId)).size !== trades.length) throw new Error('history-walk-duplicate-trade-ids');
    } catch (caught) {
      error = errorMessage(caught);
    }

    const complete = this.historyCoverageIsContiguous({ failed: error !== undefined, reachedEnd, crossedBoundary });
    const newest = newestOf(trades);
    let recorded = 0;
    let checkpointAdvanced = false;

    const observationId = database.transaction(() => {
      const obs = database.insertObservation({
        accountId,
        surface: TRADE_HISTORY_SURFACE,
        startedAt,
        finishedAt: this.context.now(),
        complete,
        pagesWalked,
        totalExpected: trades.length,
        ...(error === undefined ? {} : { error })
      });
      for (const trade of trades) if (this.persistTrade(accountId, trade, obs)) recorded += 1;
      if (complete && newest) {
        database.advanceCheckpoint({
          accountId,
          surface: TRADE_HISTORY_SURFACE,
          cursor: { afterTimeSeconds: Math.floor(Date.parse(newest.initiatedAt) / 1000), afterTradeId: newest.tradeId },
          coveredThrough: newest.initiatedAt,
          observationId: obs,
          now: this.context.now()
        });
        checkpointAdvanced = true;
      }
      return obs;
    });

    this.context.signals.emit({ kind: 'observed', accountId, surface: TRADE_HISTORY_SURFACE, complete, observationId });
    return { observationId, complete, pagesWalked, observed: trades.length, recorded, checkpointAdvanced, ...(error ? { error } : {}) };
  }

  /**
   * Writes one executed trade, its lines and — only if it settled — its ledger effect.
   *
   * Returns whether this call was the first to see the trade at this status, which is what a
   * replay assertion reads: the second walk of the same page records nothing new.
   */
  protected persistTrade(accountId: string, trade: ExecutedTrade, observationId: number): boolean {
    const { database } = this.context;
    const status = tradeStatus(trade.status);
    const offerId = this.offerIdFor(accountId, trade.tradeId);
    const { changed } = new TradeStore(database).upsertExecutedTrade({
      account_id: accountId,
      trade_id: trade.tradeId,
      offer_id: offerId,
      counterparty_steam_id64: trade.counterpartySteamId64,
      status_code: trade.status,
      status,
      initiated_at: trade.initiatedAt,
      updated_at: trade.updatedAt ?? null,
      settled_at: trade.settledAt ?? null,
      reverses_trade_id: null,
      observation_id: observationId
    });

    const sides = [['GIVE', trade.given], ['RECEIVE', trade.received]] as const;
    for (const [side, lines] of sides) {
      for (const line of lines) this.persistLine(accountId, { side, line, offerId, tradeId: trade.tradeId, observationId });
    }

    if (settlesDelivery(status)) {
      for (const [side, lines] of sides) {
        for (const line of lines) this.postTradeEffect(accountId, trade, side, line, observationId);
      }
    } else if (reversesDelivery(status)) {
      // The original postings stay exactly as they were; a rollback is a *new linked* event
      // (DATA-03, TRD-07). Deleting them would erase the only record that the items ever moved.
      for (const [side, lines] of sides) {
        for (const line of lines) this.postRollback(accountId, trade, side, line, observationId);
      }
    }
    return changed;
  }

  /** Finish deferred postings from stored history, even after its overlap window has passed. */
  postObservedDelivery(accountId: string, tradeId: string): void {
    const row=new TradeStore(this.context.database).executedTrade(accountId,tradeId);
    if(!row || !settlesDelivery(tradeStatus(row.status_code))) return;
    const trade:ExecutedTrade={tradeId,counterpartySteamId64:row.counterparty_steam_id64,status:row.status_code,
      initiatedAt:row.initiated_at,...(row.updated_at?{updatedAt:row.updated_at}:{}),...(row.settled_at?{settledAt:row.settled_at}:{}),given:[],received:[],raw:{}};
    for(const line of new TradeStore(this.context.database).tradeLines(accountId,{tradeId})) {
      this.postTradeEffect(accountId,trade,line.side,{appId:line.app_id,contextId:line.context_id,assetId:line.asset_id,
        classId:line.class_id,instanceId:line.instance_id,quantity:line.quantity,...(line.new_asset_id?{newAssetId:line.new_asset_id}:{})},line.observation_id);
    }
  }

  protected postTradeEffect(accountId: string, trade: ExecutedTrade, side: 'GIVE' | 'RECEIVE', line: TradeLine, observationId: number): void {
    const pending = new TransferStore(this.context.database).batches().some(batch => !['DONE','ENDED','FAILED'].includes(batch.state)
      && (batch.account_id === accountId || batch.destination_account_id === accountId)
      && (JSON.parse(batch.assets_json) as Array<{assetId:string}>).some(asset => asset.assetId === line.assetId));
    if (pending) return; // Our transfers settle only after both complete GC inventories agree.
    new LedgerStore(this.context.database).postEconomicEvent({
      accountId,
      sourceKey: sourceKey(trade.tradeId, side, line),
      kind: side === 'RECEIVE' ? 'TRADE_RECEIPT' : 'TRADE_DISPOSAL',
      occurredAt: trade.settledAt ?? trade.updatedAt ?? trade.initiatedAt,
      quantity: line.quantity,
      // Steam names no price for a trade, and a trade is not a sale. Unknown stays unknown.
      amountCents: null,
      tradeId: trade.tradeId,
      observationId
    }, this.context.now());
  }

  protected postRollback(accountId: string, trade: ExecutedTrade, side: 'GIVE' | 'RECEIVE', line: TradeLine, observationId: number): void {
    const original = sourceKey(trade.tradeId, side, line);
    if (!new LedgerStore(this.context.database).economicEvent(accountId, original)) return;
    new LedgerStore(this.context.database).postEconomicEvent({
      accountId,
      sourceKey: `${original}:rollback:${trade.status}`,
      kind: 'CORRECTION',
      occurredAt: trade.updatedAt ?? trade.settledAt ?? trade.initiatedAt,
      quantity: line.quantity,
      amountCents: null,
      correctsSourceKey: original,
      tradeId: trade.tradeId,
      observationId
    }, this.context.now());
  }

  protected persistLine(accountId: string, input: {
    side: 'GIVE' | 'RECEIVE'; line: TradeLine; offerId: string | null; tradeId: string | null; observationId: number;
  }): void {
    const { line } = input;
    const candidates = this.candidatesFor(accountId, line);
    new TradeStore(this.context.database).upsertTradeLine({
      account_id: accountId,
      line_key: lineKey(input.tradeId, input.offerId, input.side, line),
      trade_id: input.tradeId,
      offer_id: input.offerId,
      side: input.side,
      app_id: line.appId,
      context_id: line.contextId,
      asset_id: line.assetId,
      new_asset_id: line.newAssetId ?? null,
      class_id: line.classId,
      instance_id: line.instanceId,
      quantity: line.quantity,
      market_hash_name: line.marketHashName ?? null,
      attributes_json: JSON.stringify({
        ...(line.type === undefined ? {} : { type: line.type }),
        ...(line.tradable === undefined ? {} : { tradable: line.tradable }),
        ...(line.marketable === undefined ? {} : { marketable: line.marketable }),
        ...(line.missing === undefined ? {} : { missing: line.missing })
      }),
      // A candidate is a candidate. One match is recorded as the local identity; zero or several
      // stay unresolved rather than becoming an invented lineage (ITEM-05, N-QTY-04).
      local_id: candidates.length === 1 ? candidates[0]! : null,
      candidates_json: JSON.stringify(candidates),
      observation_id: input.observationId
    });
    if (line.newAssetId) this.linkReceipt(line.assetId, line.newAssetId, input.observationId);
  }

  /**
   * The receipt as lineage (holdings plan D5). A walk that inserts the receiving row links it from
   * a line already stored; a line read after that row exists has to link it here, or a trade read
   * second leaves the two holdings unconnected.
   */
  protected linkReceipt(assetId: string, newAssetId: string, observationId: number): void {
    new HoldingsStore(this.context.database).linkTradeLine(assetId, newAssetId, observationId, this.context.now());
  }

  /**
   * Local rows this line might be, by asset id only.
   *
   * A trade reissues asset ids, so the *old* id is the only thing a give line can be matched on
   * and a receive line's `newAssetId` the only thing its result can. Each names a holding, never
   * the object across the trade: that link is `item_lineage`, written from the receipt.
   */
  protected candidatesFor(accountId: string, line: TradeLine): string[] {
    const { database } = this.context;
    const found = new Set<string>();
    for (const assetId of [line.assetId, line.newAssetId].filter((id): id is string => Boolean(id))) {
      const item = database.itemByAssetId(accountId, assetId);
      if (item) found.add(item.local_id);
    }
    return [...found].sort();
  }

  /** The offer that produced this trade, when one was observed. Never the other way round. */
  protected offerIdFor(accountId: string, tradeId: string): string | null {
    const row = this.context.database.raw()
      .prepare(`SELECT offer_id FROM trade_offer WHERE account_id=? AND trade_id=?`)
      .get(accountId, tradeId) as { offer_id: string } | undefined;
    return row?.offer_id ?? null;
  }

  /**
   * Offers that still pledge items, for the store/list preflight (TRD-06).
   *
   * Reads persisted rows only: a precondition that reached for the network would make every
   * batch admission wait on Steam.
   */
  committedAssets(accountId: string): Map<string, { offerId: string; status: string }> {
    const map = new Map<string, { offerId: string; status: string }>();
    for (const row of new TradeStore(this.context.database).committedTradeAssets(accountId, COMMITTING_STATUSES)) {
      map.set(row.asset_id, { offerId: row.offer_id, status: row.status });
    }
    return map;
  }
}

/** `(trade, side, asset)` — stable across replays and independent of page position. */
function sourceKey(tradeId: string, side: 'GIVE' | 'RECEIVE', line: TradeLine): string {
  return `trade:${tradeId}:${side}:${line.assetId}`;
}

function lineKey(tradeId: string | null, offerId: string | null, side: 'GIVE' | 'RECEIVE', line: TradeLine): string {
  return `${tradeId ? `trade:${tradeId}` : `offer:${offerId ?? ''}`}:${side}:${line.assetId}`;
}

function newestOf(trades: readonly ExecutedTrade[]): ExecutedTrade | undefined {
  let newest: ExecutedTrade | undefined;
  for (const trade of trades) {
    if (!newest || Date.parse(trade.initiatedAt) > Date.parse(newest.initiatedAt)) newest = trade;
  }
  return newest;
}
