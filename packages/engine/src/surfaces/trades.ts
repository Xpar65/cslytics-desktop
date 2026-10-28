import { steamId64FromAccountId, type AccountId, type ExecutedTrade, type TradeLine, type TradeOffer } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import type { ActionRow } from '../db/database.js';
import { TransferStore } from '../db/transfers.js';
import { AssetEvidenceStore } from '../db/asset-evidence.js';
import { HoldingsStore } from '../db/holdings.js';
import type { TradeInventoryItem, SendOfferRequest, TradeHistoryPage } from '@cslytics/ports';
import { errorMessage } from '../kernel/support.js';
import { COMMITTING_STATUSES, offerStatus, reversesDelivery, settlesDelivery, tradeStatus } from '../policy/trade-status.js';
import { TradeStore, type TradeHistoryCoverage } from '../db/trades.js';
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

/** Bounds one offers walk. A pathological account cannot make a single walk unbounded. */
export const MAX_OFFER_PAGES = 100;
export const HISTORY_PAGE_SIZE = 50;

/**
 * The pages one history walk may read: the top of the log, then as many older pages as are left.
 *
 * `GetTradeHistory` refuses a burst. At the desktop's own pace a walk of consecutive pages drew
 * HTTP 429 after twenty to thirty pages every time (corpus `steam-webapi.ieconservice.get-trade-history`),
 * and a walk that began again at the newest page after each refusal never reached the end: by
 * 2026-10-28 one record held 477 such walks for one account and 91 for another, and neither account held a trade
 * older than the pages a walk read before Steam refused it (history backfill plan §1). A walk now
 * reads what is new and extends its coverage by a few older pages, each page past the first on the
 * endpoint's own token (`admitPage`), and the cadence asks again every `HISTORY_BACKFILL_EVERY_MS`
 * while older pages remain (`policy/cadence.ts`). The pages a refusal interrupted stay read: an
 * older page is contiguous with the boundary it was read after, so the boundary moves to the last
 * page that answered, and the next walk reads on from there rather than from the top.
 */
export const TRADE_HISTORY_PAGES_PER_WALK = 5;

export type TradeSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  /** Rows this walk read, before deduplication. */
  observed: number;
  /** Rows this walk was the first to record. */
  recorded: number;
  checkpointAdvanced: boolean;
  /** The coverage this walk committed, when it committed one. */
  coverage?: TradeHistoryCoverage;
  /** The walk handed the lane back before its pages were spent, because somebody was waiting for it. */
  yielded?: boolean;
  error?: string;
};

/** How a history walk asks its host whether to stop short: a page it does not read is read next time. */
export type HistoryWalkOptions = { yield?: () => boolean };

type HistoryCursor = { afterTimeSeconds: number; afterTradeId: string };

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
 *   page of the top leaves it where it was, so the next sync re-reads rather than skipping
 *   (TRD-05, N-TRD-03); a failed page of the backfill keeps the boundary the pages before it
 *   reached, because each was read after the one above (OBS-HIST-03).
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

  syncHistory(accountId: AccountId, pageSize = HISTORY_PAGE_SIZE, options: HistoryWalkOptions = {}): Promise<TradeSyncResult> {
    return this.walkHistory(accountId, pageSize, options);
  }

  /** The committed coverage of the account's executed trades, or undefined before a walk committed one. */
  coverage(accountId: string): TradeHistoryCoverage | undefined {
    return new TradeStore(this.context.database).historyCoverage(accountId);
  }

  /** Whether older pages of the history remain to be read, which hurries the surface's cadence (`policy/cadence.ts`). */
  backfillPending(accountId: string): boolean {
    const coverage = this.coverage(accountId);
    return coverage !== undefined && !coverage.reachedEnd && !coverage.stopped;
  }

  /** The pages one walk may read. Isolated so a saboteur can read without end. */
  protected pagesPerWalk(): number {
    return TRADE_HISTORY_PAGES_PER_WALK;
  }

  /**
   * Takes the endpoint's token for one more page of a walk already admitted. The broker charges a
   * walk one token; a walk of several pages is several requests to the venue, and is paced as such.
   * Isolated so a saboteur can page for free.
   */
  protected async admitPage(accountId: string): Promise<void> {
    await this.context.governors.admitRead(accountId, 'steam-web', TRADE_HISTORY_SURFACE);
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
   * Whether a page followed the cursor it was read after: every row new to this walk, none newer
   * than the cursor, and rows at all when Steam says there are more. A page that fails this is a
   * cursor that did not advance, which is what `navigating_back` produced for six weeks, and what
   * a walk must never read as progress (OBS-HIST-04). Isolated so a saboteur can believe the page.
   */
  protected follows(page: TradeHistoryPage, after: HistoryCursor, seen: ReadonlySet<string>): boolean {
    if (page.trades.some((trade) => seen.has(trade.tradeId))) return false;
    if (!page.trades.length && page.more) return false;
    const first = page.trades[0];
    return !(first && after.afterTradeId !== '' && Date.parse(first.initiatedAt) > after.afterTimeSeconds * 1000 + 999);
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

  /**
   * One walk of the account's executed trades: the newest pages down to what the record already
   * holds, then, while the walk's pages last, older pages below its boundary.
   *
   * The log is keyset-paged, newest first: an older page is read after the last row of the one
   * above it, so a boundary is a stable place to resume from, which an offset into the market
   * history is not. The top is read until a page's oldest trade is older than the committed
   * coverage (`historyBoundaryMs`: its newest trade less the overlap, and further back to the
   * oldest trade Steam may still change), which joins what was read to the coverage. A first walk
   * has nothing to join and reads at most its pages from the top; what it read is the coverage,
   * and the rest of the log is the backfill's, a few pages a walk until the end. A later top that
   * outran the walk's pages restarts the coverage at what was read, contiguous from the newest
   * trade, and what lay below is backfilled again (`history-coverage-rebased`), as the market
   * history does. A page whose rows the walk already holds, or that claims more rows while
   * carrying none, is a cursor that did not advance: it fails the top, and it stops the backfill
   * with a reason, since a cursor that lies is not a thing to reason past.
   *
   * A failed page of the top commits no coverage (rule 5), though every trade read is a fact worth
   * keeping (N-TRD-03). A failed page of the backfill keeps the boundary the pages before it
   * reached: they were read after the boundary in turn, so the segment is still contiguous, and a
   * refusal costs one page rather than the walk. The walk is incomplete either way, so the broker
   * holds the scope and answers no need from it.
   */
  protected async walkHistory(accountId: AccountId, pageSize: number, options: HistoryWalkOptions): Promise<TradeSyncResult> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const previous = this.coverage(accountId);
    const boundaryMs = this.historyBoundaryMs(accountId);
    const heldRow = database.raw().prepare(`SELECT 1 FROM executed_trade WHERE account_id=? AND trade_id=?`);
    const seen = new Set<string>();
    const trades: ExecutedTrade[] = [];
    let pagesWalked = 0;
    let total: number | null = null;
    let error: string | undefined;
    let coverage: TradeHistoryCoverage | undefined;
    let coveredThrough: string | null = previous ? database.checkpoint(accountId, TRADE_HISTORY_SURFACE)?.covered_through ?? null : null;
    let rebased = false;
    let yielded = false;

    const read = async (after: HistoryCursor): Promise<TradeHistoryPage> => {
      if (pagesWalked > 0) await this.admitPage(accountId);
      const page = await this.context.ports.trade.getTradeHistoryPage(accountId, { ...after, maxTrades: pageSize });
      pagesWalked += 1;
      if (page.totalTrades !== null) total = page.totalTrades;
      if (!this.follows(page, after, seen)) throw new Error('history-cursor-did-not-advance');
      for (const trade of page.trades) seen.add(trade.tradeId);
      return page;
    };
    const oldestOf = (page: TradeHistoryPage): ExecutedTrade | undefined => page.trades[page.trades.length - 1];

    // 1. The top of the log, down to the covered segment.
    let newest: ExecutedTrade | undefined;
    let oldest: ExecutedTrade | undefined;
    let reachedEnd = false;
    let crossedBoundary = false;
    let outran = false;
    try {
      let cursor: HistoryCursor = { afterTimeSeconds: 0, afterTradeId: '' };
      for (;;) {
        const page = await read(cursor);
        trades.push(...page.trades);
        newest ??= page.trades[0];
        oldest = oldestOf(page) ?? oldest;
        if (!page.more) { reachedEnd = true; break; }
        if (oldest && Date.parse(oldest.initiatedAt) < boundaryMs) { crossedBoundary = true; break; }
        if (pagesWalked >= this.pagesPerWalk()) { outran = true; break; }
        // A first walk has nothing to join, so it may stop for a person as the backfill does.
        if (!previous && options.yield?.()) { outran = true; yielded = true; break; }
        cursor = cursorOf(oldest!);
      }
    } catch (caught) {
      error = errorMessage(caught);
    }
    const joined = this.historyCoverageIsContiguous({ failed: error !== undefined, reachedEnd, crossedBoundary });
    if (previous && joined) {
      const fresh = trades.filter((trade) => heldRow.get(accountId, trade.tradeId) === undefined).length;
      const deeper = oldest !== undefined && Date.parse(oldest.initiatedAt) < previous.boundaryTimeSeconds * 1000;
      coverage = {
        ...previous,
        ...(newest ? cursorOf(newest) : {}),
        ...(deeper ? { boundaryTimeSeconds: seconds(oldest!.initiatedAt), boundaryTradeId: oldest!.tradeId } : {}),
        coveredCount: previous.coveredCount + fresh,
        total: total ?? previous.total,
        reachedEnd: previous.reachedEnd || reachedEnd
      };
      if (newest) coveredThrough = newest.initiatedAt;
    } else if (joined || (error === undefined && outran)) {
      // The first segment, or a top that outran the walk's pages: the coverage is what was read.
      rebased = previous !== undefined;
      coverage = newest && oldest
        ? { ...cursorOf(newest), boundaryTimeSeconds: seconds(oldest.initiatedAt), boundaryTradeId: oldest.tradeId, coveredCount: trades.length, total, reachedEnd }
        : { afterTimeSeconds: 0, afterTradeId: '', boundaryTimeSeconds: 0, boundaryTradeId: '', coveredCount: 0, total, reachedEnd };
      coveredThrough = newest?.initiatedAt ?? null;
    }

    // 2. Older pages below the boundary, while the walk's pages last and nobody waits for the lane.
    try {
      while (error === undefined && coverage && !coverage.reachedEnd && !coverage.stopped && coverage.boundaryTradeId !== '' && pagesWalked < this.pagesPerWalk()) {
        if (options.yield?.()) { yielded = true; break; }
        let page: TradeHistoryPage;
        try {
          page = await read({ afterTimeSeconds: coverage.boundaryTimeSeconds, afterTradeId: coverage.boundaryTradeId });
        } catch (caught) {
          if (errorMessage(caught) === 'history-cursor-did-not-advance') { coverage = { ...coverage, stopped: 'history-cursor-did-not-advance' }; break; }
          throw caught;
        }
        trades.push(...page.trades);
        const last = oldestOf(page);
        coverage = {
          ...coverage,
          coveredCount: coverage.coveredCount + page.trades.length,
          total: total ?? coverage.total,
          reachedEnd: !page.more,
          ...(last ? { boundaryTimeSeconds: seconds(last.initiatedAt), boundaryTradeId: last.tradeId } : {})
        };
      }
    } catch (caught) {
      error = errorMessage(caught);
    }

    const complete = error === undefined;
    let recorded = 0;
    const observationId = database.transaction(() => {
      const obs = database.insertObservation({
        accountId,
        surface: TRADE_HISTORY_SURFACE,
        startedAt,
        finishedAt: this.context.now(),
        complete,
        pagesWalked,
        totalExpected: total ?? trades.length,
        ...(error === undefined ? {} : { error })
      });
      // Trade rows are point facts: one that was read is true whether or not a later page failed.
      for (const trade of trades) if (this.persistTrade(accountId, trade, obs)) recorded += 1;
      // The coverage moves only with the rows that join it, in the transaction that writes them,
      // so a restart cannot keep the one without the other and a failed top cannot make the next
      // walk skip the trades it never saw.
      if (coverage) {
        database.advanceCheckpoint({ accountId, surface: TRADE_HISTORY_SURFACE, cursor: coverage, coveredThrough, observationId: obs, now: this.context.now() });
        if (rebased) database.addEvent(accountId, 'history-coverage-rebased', { surface: TRADE_HISTORY_SURFACE, coveredCount: coverage.coveredCount, total: coverage.total }, this.context.now());
        if (coverage.stopped && coverage.stopped !== previous?.stopped) database.addEvent(accountId, 'history-backfill-stopped', { surface: TRADE_HISTORY_SURFACE, reason: coverage.stopped, coveredCount: coverage.coveredCount }, this.context.now());
      }
      return obs;
    });

    this.context.signals.emit({ kind: 'observed', accountId, surface: TRADE_HISTORY_SURFACE, complete, observationId });
    return { observationId, complete, pagesWalked, observed: trades.length, recorded, checkpointAdvanced: coverage !== undefined,
      ...(coverage ? { coverage } : {}), ...(yielded ? { yielded } : {}), ...(error ? { error } : {}) };
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
      reverses_trade_id: trade.rollbackOf ?? null,
      observation_id: observationId
    });
    // The first read of a reversal is the fact a person is told of (delivery retries plan D11): once per
    // trade, however many walks read the 12 again. The return trade posts the items' way back itself.
    if (changed && status === 'REVERSED') {
      database.addEventOnce(accountId, 'trade-reversed', { tradeId: trade.tradeId, offerId, counterpartySteamId64: trade.counterpartySteamId64,
        assetIds: trade.given.map((line) => line.assetId) }, this.context.now());
    }

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

/** The keyset a page after this trade is read with: Steam's own `time_init` and `tradeid`. */
function cursorOf(trade: ExecutedTrade): HistoryCursor {
  return { afterTimeSeconds: seconds(trade.initiatedAt), afterTradeId: trade.tradeId };
}

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
