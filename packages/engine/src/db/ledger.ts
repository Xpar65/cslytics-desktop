import type { EngineDatabase } from './database.js';

/**
 * One posting in the trading ledger.
 *
 * `amount_cents` is nullable and `amount_basis` says which kind of null it is, because DATA-04
 * forbids an unknown price becoming zero. A caller that wants money must read `EVIDENCED`; one
 * that sums `amount_cents` without looking has invented revenue.
 */
export type EconomicEventRow = {
  account_id: string; source_key: string; kind: string; occurred_at: string; quantity: number;
  amount_cents: number | null; fee_cents: number | null; currency: number | null;
  amount_basis: 'EVIDENCED' | 'UNKNOWN';
  order_id: string | null; trade_id: string | null;
  offer_id: string | null; listing_id: string | null; corrects_source_key: string | null;
  observation_id: number; recorded_at: string;
};

export type EconomicEventInput = {
  accountId: string;
  /** Stable, account-scoped identity for the source fact. Re-posting it is a no-op (DATA-02). */
  sourceKey: string;
  kind: EconomicEventRow['kind'];
  occurredAt: string;
  quantity: number;
  observationId: number;
  amountCents?: number | null;
  feeCents?: number | null;
  currency?: number | null;
  orderId?: string | null;
  tradeId?: string | null;
  offerId?: string | null;
  listingId?: string | null;
  correctsSourceKey?: string | null;
};

/**
 * The trading ledger and the wallet money it commits, over the one writer (holdings plan §10.1).
 * A posting is written once per source key; an amount is evidenced or unknown, never invented.
 */
export class LedgerStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * Posts one ledger event, exactly once per source key.
   *
   * `INSERT ... DO NOTHING` is the deduplication rule (DATA-02) rather than a caller-side
   * "have I seen this?" check, because a replayed page and a restarted process both race the
   * same read. Returns whether this call is the one that wrote it, so a caller can adjust a
   * reservation or a quantity in the same transaction without doing it twice.
   */
  postEconomicEvent(input: EconomicEventInput, now: string): boolean {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new Error('Ledger quantity must be a positive integer');
    const evidenced = input.amountCents !== undefined && input.amountCents !== null;
    if (evidenced && !Number.isInteger(input.amountCents)) throw new Error('Ledger amount must be integer minor units');
    const result = this.db.raw().prepare(`
      INSERT INTO economic_event(account_id, source_key, kind, occurred_at, quantity, amount_cents, fee_cents,
        currency, amount_basis, order_id, trade_id, offer_id, listing_id,
        corrects_source_key, observation_id, recorded_at)
      VALUES (@account, @key, @kind, @occurred, @quantity, @amount, @fee, @currency, @basis,
        @orderId, @tradeId, @offerId, @listingId, @corrects, @obs, @now)
      ON CONFLICT(account_id, source_key) DO NOTHING
    `).run({
      account: input.accountId, key: input.sourceKey, kind: input.kind, occurred: input.occurredAt,
      quantity: input.quantity, amount: evidenced ? input.amountCents! : null,
      fee: input.feeCents ?? null, currency: input.currency ?? null,
      basis: evidenced ? 'EVIDENCED' : 'UNKNOWN',
      orderId: input.orderId ?? null, tradeId: input.tradeId ?? null, offerId: input.offerId ?? null,
      listingId: input.listingId ?? null, corrects: input.correctsSourceKey ?? null,
      obs: input.observationId, now
    });
    if (Number(result.changes) > 0) this.db.touch(input.accountId, 'economic_event');
    return Number(result.changes) > 0;
  }

  /**
   * Records one newly observed buy-order fill, exactly once, and moves its reservation.
   *
   * Two surfaces see a fill: the status poll and the market walk. They must agree, so the
   * decision lives here rather than in either of them — the source key is the cumulative
   * purchased count, so whichever gets there first posts, and the other is a no-op (BUY-04,
   * DATA-02). A reservation is reduced by what the fill consumed rather than released, because
   * the rest of the order is still committed money (N-BUY-03).
   *
   * The amount is deliberately absent. `getbuyorderstatus` and the orders book both report
   * quantities only; what was actually paid arrives later, from history, through
   * `evidenceEconomicAmount`. Until then it is `UNKNOWN`, never the limit (BUY-06).
   */
  recordBuyOrderFill(input: {
    accountId: string; buyOrderId: string; purchasedTotal: number; delta: number;
    unitPriceCents: number; observationId: number; now: string;
  }): boolean {
    const posted = this.postEconomicEvent({
      accountId: input.accountId,
      sourceKey: `buy-order:${input.buyOrderId}:purchased:${input.purchasedTotal}`,
      kind: 'BUY_ORDER_FILL',
      occurredAt: input.now,
      quantity: input.delta,
      amountCents: null,
      orderId: input.buyOrderId,
      observationId: input.observationId
    }, input.now);
    if (!posted) return false;
    this.db.raw().prepare(`
      UPDATE reservation SET amount_cents=MAX(0, amount_cents - ?)
      WHERE account_id=? AND ref_kind='BUY_ORDER' AND ref_id=? AND state IN ('ACTIVE','SUBMITTED_UNOBSERVED')
    `).run(input.delta * input.unitPriceCents, input.accountId, input.buyOrderId);
    return true;
  }

  /**
   * Fills in an amount that was previously unknown.
   *
   * This is not a rewrite of a receipt, which DATA-03 forbids: it resolves an `UNKNOWN` into the
   * figure Steam eventually named. The `WHERE` clause is the guarantee — a row that already has
   * an evidenced amount is never touched, so a later, different number becomes a visible
   * conflict rather than a silent overwrite.
   */
  evidenceEconomicAmount(input: {
    accountId: string; sourceKey: string; amountCents: number; feeCents?: number | null;
    currency?: number | null; observationId: number;
  }): boolean {
    if (!Number.isInteger(input.amountCents)) throw new Error('Ledger amount must be integer minor units');
    const result = this.db.raw().prepare(`
      UPDATE economic_event SET amount_cents=?, fee_cents=COALESCE(?, fee_cents), currency=COALESCE(?, currency),
        amount_basis='EVIDENCED', observation_id=?
      WHERE account_id=? AND source_key=? AND amount_basis='UNKNOWN'
    `).run(input.amountCents, input.feeCents ?? null, input.currency ?? null, input.observationId,
      input.accountId, input.sourceKey);
    if (Number(result.changes) > 0) this.db.touch(input.accountId, 'economic_event');
    return Number(result.changes) > 0;
  }

  /**
   * Wallet money committed by orders this app did not open.
   *
   * An externally created buy order spends the same balance ours do, and it has no reservation
   * row because no intent of ours produced it. Admission has to count it or it will overcommit
   * (BUY-02, N-BUY-05); it must not *also* reserve it, or the same money is subtracted twice.
   */
  externalOrderCommitmentCents(accountId: string): number {
    return (this.db.raw().prepare(`
      SELECT COALESCE(SUM(o.price_cents * (o.quantity - o.filled)), 0) AS amount FROM venue_order o
      WHERE o.account_id=? AND o.venue='steam' AND o.side='BUY' AND o.first_seen_obs IS NOT NULL AND o.state NOT LIKE 'ENDED_%' AND NOT EXISTS (
        SELECT 1 FROM reservation r WHERE r.account_id=o.account_id AND r.ref_kind='BUY_ORDER'
          AND r.ref_id=o.venue_order_id AND r.state IN ('ACTIVE','SUBMITTED_UNOBSERVED'))
    `).get(accountId) as { amount: number }).amount;
  }

  /** Reservations this engine is holding against the wallet, in minor units. */
  reservedWalletCents(accountId: string): number {
    return (this.db.raw().prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM reservation
      WHERE account_id=? AND state IN ('ACTIVE','SUBMITTED_UNOBSERVED')
    `).get(accountId) as { amount: number }).amount;
  }

  economicEvents(accountId: string): EconomicEventRow[] {
    return this.db.raw().prepare(`SELECT * FROM economic_event WHERE account_id=? ORDER BY occurred_at, source_key`)
      .all(accountId) as EconomicEventRow[];
  }

  economicEvent(accountId: string, sourceKey: string): EconomicEventRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM economic_event WHERE account_id=? AND source_key=?`)
      .get(accountId, sourceKey) as EconomicEventRow | undefined;
  }
}
