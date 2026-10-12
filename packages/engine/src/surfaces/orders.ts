import { randomUUID } from 'node:crypto';
import type { MarketHistoryEvent } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, ACCOUNT_MARKET, freshness, locationEvidence, postAttempt, surfaceEvidence, type Evidence } from '../kernel/evidence.js';
import type { ItemRow } from '../db/database.js';
import { errorMessage } from '../kernel/support.js';
import { LedgerStore } from '../db/ledger.js';

export type OrderState = 'SUBMITTED' | 'OPEN' | 'OPEN_UNTRANSACTABLE' | 'PENDING_EXTERNAL' | 'UNEXPLAINED' | 'QUARANTINED'
  | 'ENDED_FILLED' | 'ENDED_CANCELLED_BY_US' | 'ENDED_CANCELLED_EXTERNALLY' | 'ENDED_LAPSED' | 'ENDED_NOT_APPLIED';
export type VenueProfile = {
  venue: string; supportsPriceEdit: boolean; ordersExpire: boolean;
  pendingKind: 'phone-confirm' | 'trade-offer' | 'escrow' | 'none';
  identityModel: 'asset-reissue' | 'stable-asset';
  whyOracle: 'per-order-history' | 'aggregate-only' | 'none'; settlementDelayDays: number;
  stateMap: Record<string, OrderState>;
};
/**
 * `identityModel` is measured, not assumed: a Steam list → cancel round-trip keeps the asset id
 * (nine of nine on the trading record, 2026-09-08 → 09-22; `M-04` 2026-09-15;
 * `steam/market-listings.md`), and the item never leaves the inventory while it is listed
 * (`db/steam-listing.ts`). A *trade* reissues it, and that is the trades surface's concern, not this one's.
 */
export const STEAM_PROFILE: VenueProfile = {
  venue: 'steam', supportsPriceEdit: false, ordersExpire: false, pendingKind: 'phone-confirm',
  identityModel: 'stable-asset', whyOracle: 'per-order-history', settlementDelayDays: 0,
  stateMap: { ACTIVE: 'OPEN', ON_HOLD: 'OPEN_UNTRANSACTABLE', PENDING_CONFIRMATION: 'PENDING_EXTERNAL' }
};
export type VenueOrderRow = {
  account_id: string; order_id: string; venue: string; side: 'SELL' | 'BUY'; local_id: string | null;
  venue_order_id: string | null; action_id: string | null; managed: number; opened_from_intent: string | null;
  state: OrderState; first_open_obs: number | null; last_seen_obs: number | null; opened_at: string;
  confidence: 'proven' | 'probable' | 'unknown'; venue_detail_json: string;
};
export type OrderClassification = {
  orderId: string; state: OrderState; evidence: number; confidence: VenueOrderRow['confidence']; reason: string;
  /** Present only when per-order history actually named a sale. Amounts stay optional. */
  sale?: { listingId: string; purchaseId: string; occurredAt: string };
};

/**
 * What Steam said an event was worth, if anything.
 *
 * `myhistory` carries the money on `purchases[listing_purchase]` and the fee on
 * `listings[listing]` (schema example `fixtures/steam/contracts/myhistory.json`, evidence grade
 * `2W`; the live captures recorded counts and codes only). A field that is absent or not an
 * integer yields `null`, and `null` reaches the ledger as `UNKNOWN` rather than as zero
 * (DATA-04, BUY-06).
 */
export type HistoryMoney = { amountCents: number | null; feeCents: number | null; currency: number | null };

export function historyMoney(raw: unknown, field: 'received_amount' | 'paid_amount'): HistoryMoney {
  const body = (raw ?? {}) as { purchase?: Record<string, unknown> | null; listing?: Record<string, unknown> | null };
  const amount = body.purchase?.[field];
  const fee = body.listing?.fee;
  // Steam's wallet currency appears as a bare code (21) on the wallet and as 2000 + code (2021)
  // on a market listing. One number reaches the ledger, so the offset is removed here.
  const rawCurrency = body.listing?.currencyid ?? body.purchase?.['currencyid'];
  const currency = Number.isSafeInteger(rawCurrency) ? Number(rawCurrency) : null;
  return {
    amountCents: Number.isSafeInteger(amount) ? Number(amount) : null,
    feeCents: Number.isSafeInteger(fee) ? Number(fee) : null,
    currency: currency === null ? null : currency >= 2000 ? currency - 2000 : currency
  };
}

/** The venue describes facts. This service assigns meaning, then separately applies policy. */
export class OrderService {
  constructor(protected readonly context: EngineContext, readonly profile: VenueProfile = STEAM_PROFILE) {}

  syncHistory(accountId: string, pageSize = 500): Promise<number> {
    return this.context.reads.run(`${accountId}:steam-market-history`, () => this.walkHistory(accountId, pageSize));
  }

  private async walkHistory(accountId: string, pageSize: number): Promise<number> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const events: MarketHistoryEvent[] = [];
    let start = 0;
    let pages = 0;
    let total: number | undefined;
    let error: string | undefined;
    try {
      for (;;) {
        const page = await this.context.ports.market.getMyHistoryPage(accountId, start, pageSize);
        pages += 1;
        if (page.start !== start || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0
          || (total !== undefined && total !== page.totalCount)) throw new Error('history-pagination-mismatch');
        total = page.totalCount;
        events.push(...page.events);
        if (events.length === total) break;
        if (events.length > total || !page.events.length || pages >= 1000) throw new Error('history-incomplete-walk');
        start += page.events.length;
      }
      if (new Set(events.map((event) => event.eventId)).size !== events.length) throw new Error('history-duplicate-events');
      if (!events.length && database.raw().prepare(`SELECT 1 FROM market_history WHERE account_id=? LIMIT 1`).get(accountId)) throw new Error('suspicious-empty-history');
    } catch (caught) { error = errorMessage(caught); }
    const observationId = database.transaction(() => {
      const obs = database.insertObservation({ accountId, surface: 'steam-market-history', startedAt, finishedAt: this.context.now(),
        complete: !error && total !== undefined, pagesWalked: pages, ...(total === undefined ? {} : { totalExpected: total }), ...(error ? { error } : {}) });
      if (!error) {
        for (const event of events) {
          database.raw().prepare(`INSERT INTO market_history
            (account_id,event_id,listing_id,purchase_id,event_type,occurred_at,raw_json,observation_id) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id,event_id) DO UPDATE SET observation_id=excluded.observation_id, raw_json=excluded.raw_json`)
            .run(accountId, event.eventId, event.listingId, event.purchaseId ?? null, event.eventType, event.occurredAt, JSON.stringify(event.raw), obs);
          this.postHistoryLedger(accountId, event, obs);
        }
        // Deduplication, the history rows, the ledger postings and the checkpoint commit in one
        // transaction, so a restart cannot keep half the accounting effect (DATA-06). The
        // checkpoint moves only on a walk that reached `total_count`, which is what stops a
        // failed page from making the next sync skip the events it never saw.
        const newest = events.reduce<string | null>((latest, event) =>
          latest === null || event.occurredAt > latest ? event.occurredAt : latest, null);
        database.advanceCheckpoint({
          accountId, surface: 'steam-market-history', cursor: { totalCount: total ?? 0 },
          coveredThrough: newest, observationId: obs, now: this.context.now()
        });
      }
      return obs;
    });
    this.context.signals.emit({
      kind: 'observed', accountId, surface: 'steam-market-history', complete: !error && total !== undefined, observationId
    });
    return observationId;
  }

  /** Incorporates observed Steam rows, including foreign orders. Never called from a mutation response. */
  observeMarket(accountId: string, observationId: number): void {
    const { database } = this.context;
    const rows = database.raw().prepare(`SELECT * FROM market_listing WHERE account_id=? AND last_seen_obs=? AND status<>'ABSENT'`)
      .all(accountId, observationId) as Array<{ listing_id: string; local_id: string | null; status: string; asset_id: string; price_receive_cents: number; hash_name: string; hold_until: string | null }>;
    for (const row of rows) {
      const existing = database.raw().prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND venue_order_id=?`).get(accountId, row.listing_id) as VenueOrderRow | undefined;
      const candidates = existing ? [existing] : database.raw().prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue='steam' AND side='SELL'
        AND venue_order_id IS NULL AND json_extract(venue_detail_json,'$.assetId')=?`).all(accountId, row.asset_id) as VenueOrderRow[];
      const own = candidates.length === 1 ? candidates[0] : undefined;
      const state = this.profile.stateMap[row.status] ?? 'QUARANTINED';
      if (own) {
        database.raw().prepare(`UPDATE venue_order SET venue_order_id=?, state=?, first_open_obs=COALESCE(first_open_obs,?), last_seen_obs=?,
          transactable_after=?, venue_detail_json=?, confidence='proven' WHERE account_id=? AND order_id=?`)
          .run(row.listing_id, state, observationId, observationId, row.hold_until, JSON.stringify({ assetId: row.asset_id, rawState: row.status }), accountId, own.order_id);
      } else {
        database.raw().prepare(`INSERT INTO venue_order(account_id,order_id,venue,side,local_id,hash_name,venue_order_id,price_receive_cents,
          opened_at,state,first_open_obs,last_seen_obs,transactable_after,venue_detail_json,confidence)
          VALUES (?,?,'steam','SELL',?,?,?,?,?,?,?,?,?,?,'proven')`).run(accountId, randomUUID(), row.local_id, row.hash_name, row.listing_id,
            row.price_receive_cents, this.context.now(), state, observationId, observationId, row.hold_until, JSON.stringify({ assetId: row.asset_id, rawState: row.status }));
      }
    }
    const duplicates = database.raw().prepare(`SELECT local_id FROM market_listing WHERE account_id=? AND status IN ('ACTIVE','ON_HOLD','PENDING_CONFIRMATION')
      AND local_id IS NOT NULL GROUP BY local_id HAVING COUNT(*)>1`).all(accountId) as { local_id: string }[];
    for (const item of duplicates) {
      database.raw().prepare(`UPDATE venue_order SET state='QUARANTINED', confidence='unknown' WHERE account_id=? AND local_id=? AND state NOT LIKE 'ENDED_%'`).run(accountId, item.local_id);
      const goal = database.currentDesiredState(accountId, 'sell-listing', item.local_id);
      if (goal) database.suspendGoal(accountId, goal.id, 'Conflicting open listings require review', this.context.now());
    }
  }

  /** Pure read: no policy, database writes, ports, or ambient clock. */
  classifyOrders(accountId: string, observationId: number): OrderClassification[] {
    const { database } = this.context;
    const now = this.context.ports.clock.now();
    const market = surfaceEvidence(database, accountId, ACCOUNT_MARKET, now, true);
    if (market.grade !== 'SATISFIED' || market.observationId !== observationId) return [];
    const history = surfaceEvidence(database, accountId, { surface: 'steam-market-history', scope: { kind: 'account' } }, now, true);
    const orders = database.raw().prepare(`SELECT * FROM venue_order WHERE account_id=? AND venue=? AND side='SELL' AND state NOT LIKE 'ENDED_%'`).all(accountId, this.profile.venue) as VenueOrderRow[];
    const result: OrderClassification[] = [];
    for (const order of orders) {
      if (order.state === 'QUARANTINED') continue;
      if (!order.first_open_obs) {
        const rejected = order.action_id ? database.action(order.action_id) : undefined;
        if (rejected?.state === 'FAILED' && postAttempt(database, rejected, market.value, true)) result.push({ orderId: order.order_id, state: 'ENDED_NOT_APPLIED', evidence: observationId, confidence: 'proven', reason: 'Rejected request is absent from a later complete observation' });
        continue;
      }
      const open = database.raw().prepare(`SELECT 1 FROM market_listing WHERE account_id=? AND listing_id=? AND status<>'ABSENT'`).get(accountId, order.venue_order_id);
      if (open) continue;
      const first = database.observation(accountId, order.first_open_obs);
      if (!first || market.value.started_at <= first.finished_at) continue;
      const action = order.action_id ? database.action(order.action_id) : undefined;
      if (action && !postAttempt(database, action, market.value, true)) continue;
      let state: OrderState = 'UNEXPLAINED';
      let saleFact: OrderClassification['sale'];
      let confidence: VenueOrderRow['confidence'] = 'unknown';
      let evidence = observationId;
      let reason = 'No fresh per-order evidence explains the disappearance';
      const facts = history.grade === 'SATISFIED' && this.profile.whyOracle === 'per-order-history'
        ? database.raw().prepare(`SELECT event_type, purchase_id, raw_json, occurred_at FROM market_history WHERE account_id=? AND listing_id=? AND observation_id=?
          AND occurred_at>=? ORDER BY occurred_at DESC`).all(accountId, order.venue_order_id, history.observationId, order.opened_at) as Array<{ event_type: number; purchase_id: string | null; raw_json: string; occurred_at: string }> : [];
      const sale = facts.find((event) => event.event_type === 3 && event.purchase_id && (JSON.parse(event.raw_json) as { purchase?: unknown }).purchase);
      const cancel = facts.find((event) => event.event_type === 2);
      const returned = order.local_id ? this.heldAfterEnding(accountId, order, now) : undefined;
      const cancelAction = database.actions(accountId).find((candidate) => candidate.kind === 'REMOVE_SELL_LISTING'
        && (database.actionParams(candidate) as { listingId?: string }).listingId === order.venue_order_id && database.latestAttempt(candidate.id));
      if (sale && (cancel || returned?.grade === 'SATISFIED')) { state = 'QUARANTINED'; reason = 'History and item evidence contradict each other'; }
      else if (sale && history.grade === 'SATISFIED') {
        state = 'ENDED_FILLED'; confidence = 'proven'; evidence = history.observationId; reason = 'Per-order history records a sale';
        saleFact = { listingId: order.venue_order_id!, purchaseId: sale.purchase_id!, occurredAt: sale.occurred_at };
      }
      else if (cancel && history.grade === 'SATISFIED') { state = cancelAction ? 'ENDED_CANCELLED_BY_US' : 'ENDED_CANCELLED_EXTERNALLY'; confidence = 'proven'; evidence = history.observationId; reason = 'Per-order history records cancellation'; }
      else if (returned?.grade === 'SATISFIED') {
        state = cancelAction ? 'ENDED_CANCELLED_BY_US' : order.state === 'PENDING_EXTERNAL' ? 'ENDED_LAPSED' : 'ENDED_CANCELLED_EXTERNALLY';
        confidence = 'probable'; evidence = returned.observationId; reason = 'Unique item still held after the listing ended; cancellation is provisional';
      }
      // Nothing explains it yet, and no inventory walk since the ending has said whether the item
      // stayed. That walk is the one thing that can, so the order waits for it rather than being
      // posted as an ending nobody can explain.
      else if (returned?.grade === 'UNKNOWN') continue;
      result.push({ orderId: order.order_id, state, confidence, evidence, reason, ...(saleFact ? { sale: saleFact } : {}) });
    }
    return result;
  }

  /**
   * Whether the item an ended listing named is still held: `SATISFIED` held, `UNSATISFIED` gone,
   * `UNKNOWN` not yet said. `undefined` when the listing is not known to have ended.
   *
   * The Game Coordinator keeps a listed item in main inventory and drops it when it sells
   * (`db/steam-listing.ts`), and the two answers need different walks. *Held* counts only from an
   * inventory walk begun after the market walk that first showed the listing gone: one from while
   * it was listed holds the item either way, and reading that as "returned" turns a sale into a
   * cancel. *Gone* counts from any walk after the listing was last seen open, because a live
   * listing's item is never missing from the GC.
   */
  private heldAfterEnding(accountId: string, order: VenueOrderRow, now: Date): Evidence<ItemRow> | undefined {
    const { database } = this.context;
    const ended = order.venue_order_id ? database.raw().prepare(`SELECT last_seen_obs FROM market_listing WHERE account_id=? AND listing_id=? AND status='ABSENT'`)
      .get(accountId, order.venue_order_id) as { last_seen_obs: number } | undefined : undefined;
    const endedBy = ended ? database.observation(accountId, ended.last_seen_obs) : undefined;
    if (!endedBy || !order.local_id) return undefined;
    const held = locationEvidence(database, accountId, order.local_id, 'MAIN', now);
    if (held.grade === 'UNKNOWN') return held;
    const proof = database.observation(accountId, held.observationId);
    const since = held.grade === 'SATISFIED' ? endedBy : database.observation(accountId, order.last_seen_obs);
    return proof && since && proof.id > since.id && proof.started_at >= since.started_at
      ? held
      : { grade: 'UNKNOWN', want: ACCOUNT_INVENTORY, freshness: 'INCOMPLETE' };
  }

  decideOrders(accountId: string, classifications: OrderClassification[]): void {
    const { database } = this.context;
    for (const fact of classifications) {
      const order = database.raw().prepare(`SELECT * FROM venue_order WHERE account_id=? AND order_id=?`).get(accountId, fact.orderId) as VenueOrderRow | undefined;
      if (!order) continue;
      database.raw().prepare(`UPDATE venue_order SET state=?, confidence=?, end_reason=?, end_evidence=?, ended_at=? WHERE account_id=? AND order_id=?`)
        .run(fact.state, fact.confidence, fact.reason, fact.evidence, fact.state.startsWith('ENDED_') ? this.context.now() : null, accountId, fact.orderId);
      if (order.managed && order.opened_from_intent && fact.state !== 'ENDED_CANCELLED_BY_US') database.suspendGoal(accountId, order.opened_from_intent, fact.reason, this.context.now());
      // Why an order ended is also *what happened to the money and the item*. A sale is posted
      // once, with whatever Steam actually named; an ending nobody can explain is posted as
      // exactly that, so the two never blur into one another (DATA-04).
      if (order.state !== fact.state && fact.state === 'UNEXPLAINED') {
        new LedgerStore(database).postEconomicEvent({
          accountId, sourceKey: `order:${fact.orderId}:unexplained:${fact.evidence}`, kind: 'UNEXPLAINED_MOVEMENT',
          occurredAt: this.context.now(), quantity: 1, observationId: fact.evidence,
          ...(order.local_id ? { localId: order.local_id } : {}),
          orderId: fact.orderId, ...(order.venue_order_id ? { listingId: order.venue_order_id } : {})
        }, this.context.now());
      }
      // An order that just ended is the app's only hint that money moved. The signal schedules a
      // wallet read; it never adjusts a balance, because the only number this app may show is one
      // Steam itself named (steam/wallet.md).
      if (order.state !== fact.state) {
        this.context.signals.emit({ kind: 'order-changed', accountId, side: 'SELL', state: fact.state });
      }
    }
  }

  /**
   * The ledger effect of one raw market-history event.
   *
   * Type 3 is a sale and type 4 a purchase — the live walks on 2026-09-09 saw only those two,
   * and every event carried a `purchaseid` (§9.5). Types 1 and 2 have never been observed on
   * this endpoint, so nothing here posts money for them: a listing being created moves no money,
   * and cancellation is established by `removelisting` plus the item coming back, not here.
   */
  protected postHistoryLedger(accountId: string, event: MarketHistoryEvent, observationId: number): void {
    if (!event.purchaseId || (event.eventType !== 3 && event.eventType !== 4)) return;
    const sold = event.eventType === 3;
    const money = historyMoney(event.raw, sold ? 'received_amount' : 'paid_amount');
    const sourceKey = `market-history:${event.eventId}`;
    new LedgerStore(this.context.database).postEconomicEvent({
      accountId,
      sourceKey,
      kind: sold ? 'MARKET_SALE' : 'EXTERNAL_PURCHASE',
      occurredAt: event.occurredAt,
      quantity: 1,
      amountCents: money.amountCents,
      feeCents: money.feeCents,
      currency: money.currency,
      listingId: event.listingId,
      observationId
    }, this.context.now());
    // A body that arrives later with the figure the first one lacked resolves an unknown; it
    // does not rewrite a known amount, because `evidenceEconomicAmount` only ever moves a row
    // out of UNKNOWN (DATA-03).
    if (money.amountCents !== null) {
      new LedgerStore(this.context.database).evidenceEconomicAmount({
        accountId, sourceKey, amountCents: money.amountCents,
        feeCents: money.feeCents, currency: money.currency, observationId
      });
    }
  }

  historyExplainsEmpty(accountId: string, listingId: string): boolean {
    const obs = this.context.database.latestObservation(accountId, 'steam-market-history');
    return freshness(obs, 'steam-market-history', this.context.ports.clock.now()) === 'FRESH' && Boolean(this.context.database.raw()
      .prepare(`SELECT 1 FROM market_history WHERE account_id=? AND listing_id=? AND observation_id=? AND event_type IN (2,3)`)
      .get(accountId, listingId, obs!.id));
  }
}
