import type { MarketHistoryEvent } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { ACCOUNT_INVENTORY, ACCOUNT_MARKET, freshness, locationEvidence, postAttempt, surfaceEvidence, type Evidence } from '../kernel/evidence.js';
import type { ItemRow } from '../db/database.js';
import type { OrderConfidence, OrderState, OrderVenue } from '../db/alphabets.js';
import { OrderStore, type VenueOrderRow } from '../db/orders.js';
import { errorMessage } from '../kernel/support.js';
import { LedgerStore } from '../db/ledger.js';
import type { ProofDemand } from '../policy/proof.js';

export type { OrderState } from '../db/alphabets.js';
export type { VenueOrderRow } from '../db/orders.js';

export type VenueProfile = {
  venue: OrderVenue; supportsPriceEdit: boolean; ordersExpire: boolean;
  pendingKind: 'phone-confirm' | 'trade-offer' | 'escrow' | 'none';
  identityModel: 'asset-reissue' | 'stable-asset';
  whyOracle: 'per-order-history' | 'aggregate-only' | 'none'; settlementDelayDays: number;
};
/**
 * `identityModel` is measured, not assumed: a Steam list → cancel round-trip keeps the asset id
 * (nine of nine on the trading record, 2026-09-08 → 09-22; `M-04` 2026-09-15;
 * `steam/market-listings.md`), and the item never leaves the inventory while it is listed
 * (`db/commitment.ts`). A *trade* reissues it, and that is the trades surface's concern, not this one's.
 * The bucket-to-state map of `mylistings` is `STEAM_BUCKET_STATE` in `db/orders.ts`, the walk's own.
 */
export const STEAM_PROFILE: VenueProfile = {
  venue: 'steam', supportsPriceEdit: false, ordersExpire: false, pendingKind: 'phone-confirm',
  identityModel: 'stable-asset', whyOracle: 'per-order-history', settlementDelayDays: 0
};
export type OrderClassification = {
  orderId: string; state: OrderState; evidence: number; confidence: OrderConfidence; reason: string;
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

/**
 * What Steam called the item an event was about, when the body carried the asset's description
 * (`assets` beside `listings` and `purchases`, carried by the adapter as `asset`); `null` when it
 * did not, which a read answers from the order the event names.
 */
export function historyHashName(raw: unknown): string | null {
  const body = (raw ?? {}) as { asset?: { market_hash_name?: unknown } | null };
  return typeof body.asset?.market_hash_name === 'string' && body.asset.market_hash_name ? body.asset.market_hash_name : null;
}

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

/**
 * The venue describes facts; the walk writes them (`OrderStore.observeSteamListings`). This
 * service assigns meaning to an order that is no longer shown, then separately applies policy.
 */
export class OrderService {
  constructor(protected readonly context: EngineContext, readonly profile: VenueProfile = STEAM_PROFILE) {}

  async syncHistory(accountId: string, pageSize = 500): Promise<number> {
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
          // What a read asks of an event, and no body (D15): the money it named is the ledger's
          // row, keyed by the event, and the name is what the venue called the item, when it said.
          database.raw().prepare(`INSERT INTO market_history
            (account_id,event_id,listing_id,purchase_id,event_type,occurred_at,observation_id,hash_name) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id,event_id) DO UPDATE SET observation_id=excluded.observation_id, hash_name=COALESCE(excluded.hash_name, market_history.hash_name)`)
            .run(accountId, event.eventId, event.listingId, event.purchaseId ?? null, event.eventType, event.occurredAt, obs, historyHashName(event.raw));
          this.postHistoryLedger(accountId, event, obs);
        }
        database.touch(accountId, 'market_history');
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

  /** Pure read: no policy, database writes, ports, or ambient clock. */
  classifyOrders(accountId: string, observationId: number): OrderClassification[] {
    const { database } = this.context;
    const now = this.context.ports.clock.now();
    const market = surfaceEvidence(database, accountId, ACCOUNT_MARKET, now, true);
    if (market.grade !== 'SATISFIED' || market.observationId !== observationId) return [];
    const history = surfaceEvidence(database, accountId, { surface: 'steam-market-history', scope: { kind: 'account' } }, now, true);
    const orders = new OrderStore(database).standingOrders(accountId, this.profile.venue);
    const result: OrderClassification[] = [];
    for (const order of orders) {
      if (order.state === 'QUARANTINED') continue;
      if (!order.first_seen_obs) {
        const rejected = order.action_id ? database.action(order.action_id) : undefined;
        if (rejected?.state === 'FAILED' && postAttempt(database, rejected, market.value, true)) result.push({ orderId: order.order_id, state: 'ENDED_NOT_APPLIED', evidence: observationId, confidence: 'proven', reason: 'Rejected request is absent from a later complete observation' });
        continue;
      }
      // A buy order's ending is the book's to say and the walk writes it (`OrderStore.observeSteamBuyOrders`); only a request it never showed is graded here.
      if (order.side === 'BUY' || order.gone_obs === null) continue;
      const first = database.observation(accountId, order.first_seen_obs);
      if (!first || market.value.started_at <= first.finished_at) continue;
      const action = order.action_id ? database.action(order.action_id) : undefined;
      if (action && !postAttempt(database, action, market.value, true)) continue;
      let state: OrderState = 'UNEXPLAINED';
      let saleFact: OrderClassification['sale'];
      let confidence: OrderConfidence = 'unknown';
      let evidence = observationId;
      let reason = 'No fresh per-order evidence explains the disappearance';
      const facts = history.grade === 'SATISFIED' && this.profile.whyOracle === 'per-order-history'
        ? database.raw().prepare(`SELECT event_type, purchase_id, occurred_at FROM market_history WHERE account_id=? AND listing_id=? AND observation_id=?
          AND occurred_at>=? ORDER BY occurred_at DESC`).all(accountId, order.venue_order_id, history.observationId, order.opened_at) as Array<{ event_type: number; purchase_id: string | null; occurred_at: string }> : [];
      // A sale is a type-3 event Steam gave a purchase id (§9.5): the id is what the ledger row is keyed by.
      const sale = facts.find((event) => event.event_type === 3 && event.purchase_id !== null);
      const cancel = facts.find((event) => event.event_type === 2);
      const returned = order.local_id ? this.heldAfterEnding(accountId, order, now) : undefined;
      // A cancel of ours that reached Steam, by hand (a goal's action) or as a chain's hop (a step's): both carry the listing id in the action's own params.
      const cancelAction = database.raw().prepare(`SELECT 1 FROM action a JOIN attempt t ON t.action_id=a.id
        WHERE a.account_id=? AND a.kind='REMOVE_SELL_LISTING' AND json_extract(a.params_json,'$.listingId')=? LIMIT 1`).get(accountId, order.venue_order_id);
      if (sale && (cancel || returned?.grade === 'SATISFIED')) { state = 'QUARANTINED'; reason = 'History and item evidence contradict each other'; }
      else if (sale && history.grade === 'SATISFIED') {
        state = 'ENDED_FILLED'; confidence = 'proven'; evidence = history.observationId; reason = 'Per-order history records a sale';
        saleFact = { listingId: order.venue_order_id!, purchaseId: sale.purchase_id!, occurredAt: sale.occurred_at };
      }
      else if (cancel && history.grade === 'SATISFIED') { state = cancelAction ? 'ENDED_CANCELLED_BY_US' : 'ENDED_CANCELLED_EXTERNALLY'; confidence = 'proven'; evidence = history.observationId; reason = 'Per-order history records cancellation'; }
      else if (returned?.grade === 'SATISFIED') {
        state = cancelAction ? 'ENDED_CANCELLED_BY_US' : order.state === 'PENDING_EXTERNAL' ? 'ENDED_LAPSED' : 'ENDED_CANCELLED_EXTERNALLY';
        confidence = 'probable'; evidence = returned.observationId; reason = 'Item still held under its asset id after the listing ended; cancellation is provisional';
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
   * The walks the orders a walk stopped showing are waiting on (settling and read path plan D5).
   * Nothing of ours waits on a listing cancelled on the website, so no action asked for the
   * inventory walk that ends it (`heldAfterEnding`) and it waited out the surface's own cadence:
   * L-04's outside cancel read pending three minutes after the book let it go (2026-10-15), and
   * would have for twenty in the background. Each asks from the walk that first missed it.
   */
  standingNeeds(accountId: string): ProofDemand[] {
    return new OrderStore(this.context.database).goneUngraded(accountId, this.profile.venue)
      .map((order) => ({ ref: ACCOUNT_INVENTORY, startedAfter: order.gone_started_at, since: order.gone_finished_at }));
  }

  /**
   * Whether the item an ended listing named is still held: `SATISFIED` held, `UNSATISFIED` gone,
   * `UNKNOWN` not yet said. `undefined` when the listing is not known to have ended.
   *
   * The Game Coordinator keeps a listed item in main inventory and drops it when it sells
   * (`db/commitment.ts`), and a cancel keeps the asset id while a sale retires it (rule 3), so the
   * same id held afterwards is the proof for a holding of either kind (consolidation plan D6): a
   * case walked back under its id is the case that was listed, not an identical one, which is what
   * made the fingerprint-era rule say "never for fungibles". The two answers need different walks. *Held* counts only from an
   * inventory walk begun after the market walk that first showed the listing gone: one from while
   * it was listed holds the item either way, and reading that as "returned" turns a sale into a
   * cancel. *Gone* counts from any walk after the listing was last seen open, because a live
   * listing's item is never missing from the GC.
   */
  private heldAfterEnding(accountId: string, order: VenueOrderRow, now: Date): Evidence<ItemRow> | undefined {
    const { database } = this.context;
    const endedBy = order.gone_obs === null ? undefined : database.observation(accountId, order.gone_obs);
    if (!endedBy || !order.local_id) return undefined;
    const held = locationEvidence(database, accountId, order.local_id, 'MAIN', now);
    if (held.grade === 'UNKNOWN') return held;
    const proof = database.observation(accountId, held.observationId);
    const since = held.grade === 'SATISFIED' ? endedBy : database.observation(accountId, order.last_seen_obs);
    return proof && since && proof.id > since.id && proof.started_at >= since.started_at
      ? held
      : { grade: 'UNKNOWN', want: ACCOUNT_INVENTORY, freshness: 'INCOMPLETE' };
  }

  /**
   * A person closes an order nothing could explain (consolidation plan D7): cancelled or sold, on
   * their word. The record keeps what it observed and adds a `CORRECTION` naming the order, the
   * choice and the unexplained posting it answers; the order ends with confidence `asserted`.
   * Never a timeout (order lifecycle D6), and never a rewrite of a posting (DATA-03).
   */
  close(accountId: string, orderId: string, as: 'cancelled' | 'sold'): VenueOrderRow {
    const { database } = this.context;
    const now = this.context.now();
    const closed = database.transaction(() => {
      const store = new OrderStore(database);
      const before = store.order(accountId, orderId);
      if (!before) throw new Error(`Unknown order ${orderId}`);
      const evidence = before.end_evidence ?? before.gone_obs ?? before.last_seen_obs;
      if (evidence === null) throw new Error('An order no observation has shown cannot be closed by hand');
      const order = store.close(accountId, orderId, as, now);
      // The posting that said nobody could explain it, when one was made: the correction answers that row.
      const corrects = (database.raw().prepare(`SELECT source_key FROM economic_event WHERE account_id=? AND order_id=? AND kind='UNEXPLAINED_MOVEMENT'
        ORDER BY recorded_at DESC, source_key DESC LIMIT 1`).get(accountId, orderId) as { source_key: string } | undefined)?.source_key ?? null;
      new LedgerStore(database).postEconomicEvent({
        accountId, sourceKey: `order:${orderId}:closed:${as}`, kind: 'CORRECTION', occurredAt: now, quantity: 1, observationId: evidence,
        orderId, ...(order.venue_order_id ? { listingId: order.venue_order_id } : {}),
        ...(corrects ? { correctsSourceKey: corrects } : {})
      }, now);
      return order;
    });
    this.context.signals.emit({ kind: 'order-changed', accountId, side: closed.side, state: closed.state });
    return closed;
  }

  decideOrders(accountId: string, classifications: OrderClassification[]): void {
    const { database } = this.context;
    const store = new OrderStore(database);
    for (const fact of classifications) {
      const order = store.order(accountId, fact.orderId);
      if (!order) continue;
      store.end(accountId, fact, this.context.now());
      // An order of ours is one an attempt of ours created; the goal behind that attempt, when
      // it had one, is parked until a person looks, unless the ending is the cancel it asked for.
      const goalId = order.action_id ? database.action(order.action_id)?.desired_id ?? null : null;
      if (goalId && fact.state !== 'ENDED_CANCELLED_BY_US') database.suspendGoal(accountId, goalId, fact.reason, this.context.now());
      // Why an order ended is also *what happened to the money and the item*. A sale is posted
      // once, with whatever Steam actually named; an ending nobody can explain is posted as
      // exactly that, so the two never blur into one another (DATA-04).
      if (order.state !== fact.state && fact.state === 'UNEXPLAINED') {
        new LedgerStore(database).postEconomicEvent({
          accountId, sourceKey: `order:${fact.orderId}:unexplained:${fact.evidence}`, kind: 'UNEXPLAINED_MOVEMENT',
          occurredAt: this.context.now(), quantity: 1, observationId: fact.evidence,
          orderId: fact.orderId, ...(order.venue_order_id ? { listingId: order.venue_order_id } : {})
        }, this.context.now());
      }
      // An order that just ended is the app's only hint that money moved. The signal schedules a
      // wallet read; it never adjusts a balance, because the only number this app may show is one
      // Steam itself named (steam/wallet.md).
      if (order.state !== fact.state) {
        this.context.signals.emit({ kind: 'order-changed', accountId, side: order.side, state: fact.state });
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
