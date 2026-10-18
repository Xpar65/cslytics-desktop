import type { AccountId, BuyOrderRequest, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, ObservationRow } from '../db/database.js';
import { type EngineContext, executeMutation } from '../kernel/context.js';
import { ACCOUNT_HISTORY, ACCOUNT_MARKET, attemptReturned, postAttempt, surfaceEvidence, type ProofNeed } from '../kernel/evidence.js';
import { required } from '../kernel/support.js';
import { settleNotApplied } from '../kernel/not-applied.js';
import { requireFreshMoneyEvidence, walletAvailability } from '../policy/wallet-admission.js';
import { LedgerStore } from '../db/ledger.js';
import { WorkStore } from '../db/work.js';
import { OrderStore } from '../db/orders.js';

/** Provenance for a fill posting, deliberately outside `FRESHNESS` — see `syncStatuses`. */
export const BUY_ORDER_STATUS_SURFACE = 'steam-buy-order-status';

export type BuyOrderParams = { request: BuyOrderRequest; reservationCents: number };
export type CancelBuyParams = { buyOrderId: string };

/** Buy-order admission, wallet reservation, cancellation and fill attribution. */
export class BuyOrderService {
  constructor(protected readonly context: EngineContext) {}

  /**
   * Admits one buy order.
   *
   * Serialised per account, and fails closed when either the wallet or the current-orders
   * observation is incomplete — an order placed on a half-known wallet can overcommit real
   * money (rollout-v3 §4.3 invariant 4).
   */
  async create(accountId: AccountId, request: BuyOrderRequest): Promise<ActionRow> {
    return this.context.locks.run(accountId, async () => {
      const { database } = this.context;
      this.requireCompleteAdmission(accountId);

      // Three claims on one balance — ours, somebody else's at the Steam website, and what is
      // left — computed once for every wallet spender in `policy/wallet-admission.ts` (N-BUY-05).
      const available = walletAvailability(database, accountId, request.currency).availableCents;
      if (available < request.priceTotalCents) throw new Error(`Insufficient unreserved wallet balance: ${available}`);

      await this.context.ports.market.getTradeFeeTaxRate(accountId, request.billing);

      // A command of one hop, admitted with its own id; the action is the hop's (D3). One order
      // per name at a time: a second create for a name whose first is still in flight is refused.
      // The order itself is a `SUBMITTED` row of the one order table until a walk shows it (D4).
      const now = this.context.now();
      const work = new WorkStore(database);
      const action = database.transaction(() => {
        const hop = work.lone('BUY_ORDER_CREATE', { accountId, kind: 'BUY_ORDER_CREATE', targetId: request.marketHashName,
          params: { request, reservationCents: request.priceTotalCents, hashName: request.marketHashName }, now });
        const queued = database.enqueueAction({ accountId, stepId: hop.id, actionKind: 'CREATE_BUY_ORDER', targetId: request.marketHashName,
          resourceKey: `buy-order:${request.marketHashName}`, params: { request, reservationCents: request.priceTotalCents } satisfies BuyOrderParams, now });
        work.attachAction(hop.id, queued.id, now);
        new OrderStore(database).openBuy(queued, request, now);
        return queued;
      });
      database.raw().prepare(`
        INSERT INTO reservation(account_id, ref_kind, ref_id, amount_cents, state)
        VALUES (?, 'BUY_ORDER_ACTION', ?, ?, 'SUBMITTED_UNOBSERVED')
      `).run(accountId, action.id, request.priceTotalCents);

      await this.execute(action.id);
      return required(database.action(action.id), `Action disappeared ${action.id}`);
    });
  }

  async execute(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.desiredParams(action) as BuyOrderParams;
    const outcome = await new WorkStore(database).send(action.id, () => executeMutation(this.context, action, () =>
      this.context.ports.market.createBuyOrder(action.account_id, params.request)), () => this.context.now());
    if (outcome.kind === 'DEFINITIVELY_REJECTED') {
      database.raw().prepare(`UPDATE reservation SET state='RELEASED' WHERE account_id=? AND ref_id=?`)
        .run(action.account_id, action.id);
    }
    return outcome;
  }

  /** A cancel is a command of one hop (`BUY_ORDER_CANCEL`) named by the order, whose action is the hop's (D3). */
  queueCancel(accountId: AccountId, buyOrderId: string): ActionRow {
    const { database } = this.context;
    const now = this.context.now();
    const work = new WorkStore(database);
    const order = new OrderStore(database).steamBuyOrder(accountId, buyOrderId);
    return database.transaction(() => {
      const hop = work.lone('BUY_ORDER_CANCEL', { accountId, kind: 'BUY_ORDER_CANCEL', targetId: buyOrderId,
        params: { buyOrderId, ...(order ? { hashName: order.hash_name } : {}) }, now });
      const action = database.enqueueAction({ accountId, stepId: hop.id, actionKind: 'CANCEL_BUY_ORDER', targetId: buyOrderId,
        resourceKey: `buy-order-cancel:${buyOrderId}`, params: { buyOrderId } satisfies CancelBuyParams, now });
      work.attachAction(hop.id, action.id, now);
      return action;
    });
  }

  async executeCancel(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.desiredParams(action) as CancelBuyParams;
    return new WorkStore(database).send(action.id, () => executeMutation(this.context, action, () =>
      this.context.ports.market.cancelBuyOrder(action.account_id, params.buyOrderId)), () => this.context.now());
  }

  /**
   * Polls `getbuyorderstatus` and records any new fill.
   *
   * Two things this deliberately does not do. It does not treat the order's limit as what was
   * paid — `getbuyorderstatus` reports quantities and nothing else, so the ledger posting is
   * `UNKNOWN` until `myhistory` supplies a real `paid_amount` (BUY-06, N-BUY-04). And it does not
   * guess lineage: the lot keeps every candidate and stays `UNATTRIBUTED`.
   *
   * The status poll gets its own observation row. Its surface is deliberately absent from
   * `FRESHNESS` and `CADENCE`: it is provenance for a posting, not a schedulable walk, and a
   * per-order poll has no business setting an account-wide freshness verdict.
   */
  async syncStatuses(accountId: AccountId): Promise<void> {
    const { database } = this.context;
    const store = new OrderStore(database);
    for (const row of store.steamBuyOrders(accountId)) {
      const buyOrderId = row.venue_order_id!;
      // One HTTP request per order, under the venue's budget: a scope the broker has no need for,
      // since the poll is provenance for a posting and not evidence (read broker plan D12).
      await this.context.governors.admitRead(accountId, 'steam-web', BUY_ORDER_STATUS_SURFACE);
      const startedAt = this.context.now();
      const status = await this.context.ports.market.getBuyOrderStatus(accountId, buyOrderId);
      const delta = status.purchased - row.filled;
      database.transaction(() => {
        const observationId = database.insertObservation({
          accountId, surface: BUY_ORDER_STATUS_SURFACE, startedAt, finishedAt: this.context.now(),
          complete: true, totalExpected: 1, scopeKind: 'listing', scopeId: buyOrderId
        });
        store.recordSteamBuyOrderStatus(accountId, row, status, observationId, this.context.now());
        if (delta > 0) {
          // Lineage is not invented: the posting names the order and no holding (consolidation plan D12).
          new LedgerStore(database).recordBuyOrderFill({
            accountId, buyOrderId, purchasedTotal: status.purchased, delta,
            unitPriceCents: row.price_cents ?? 0, observationId, now: this.context.now()
          });
        }
        if (!status.active) this.settleReservation(accountId, buyOrderId);
      });
    }
  }

  /**
   * What a waiting buy-order action needs walked before `reconcile` can settle it (settling and
   * read path plan D5). A create the book did not show is settled by a *history* walk begun after
   * the attempt — the walk the old static table never asked for (N-BUY-11).
   */
  needs(action: ActionRow): ProofNeed {
    const { database } = this.context;
    const market = { ref: ACCOUNT_MARKET, startedAfter: attemptReturned(database, action) };
    if (action.kind === 'CANCEL_BUY_ORDER') return { kind: 'walks', walks: [market] };
    if (action.kind !== 'CREATE_BUY_ORDER') return { kind: 'none' };
    const attempt = database.latestAttempt(action.id);
    const book = database.latestObservation(action.account_id, 'steam-market');
    // Still waiting after a complete walk of the book that began after it: the order was not
    // there to match, and only the history can say whether it filled or never was.
    if (!attempt || book?.complete !== 1 || book.started_at < market.startedAfter) return { kind: 'walks', walks: [market] };
    return { kind: 'walks', walks: [market, { ref: ACCOUNT_HISTORY, startedAfter: attempt.started_at }] };
  }

  /** Resolves buy-order actions against one complete market observation. */
  reconcile(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    for (const action of database.awaitingActionsOfKinds(accountId, ['CREATE_BUY_ORDER', 'CANCEL_BUY_ORDER'])) {
      // A superseded attempt is still *sent*. Refusing to look at it is how a real order, and the
      // wallet money behind it, becomes invisible the moment the user changes their mind
      // (OP-06, N-BUY-07). Nothing below re-sends; it only reads evidence and settles rows.
      const superseded = !database.currentDesired(action);
      const obs = database.latestObservation(accountId, 'steam-market');
      if (!obs?.complete || obs.id !== observationId || obs.finished_at < action.updated_at) continue;

      if (action.kind === 'CREATE_BUY_ORDER') {
        const params = database.desiredParams(action) as BuyOrderParams;
        const unitPrice = Math.floor(params.request.priceTotalCents / params.request.quantity);
        // The walk binds a request to the one order on the book with its terms and no owner yet
        // (`OrderStore.observeSteamBuyOrders`). Still unbound after a complete walk, the request
        // either matched nothing or matched more than it could tell apart.
        const own = new OrderStore(database).byAction(accountId, action.id);
        const matches = own?.venue_order_id ? [] : database.raw().prepare(`
          SELECT venue_order_id AS buy_order_id FROM venue_order
          WHERE account_id=? AND venue='steam' AND side='BUY' AND first_seen_obs IS NOT NULL AND state NOT LIKE 'ENDED_%'
            AND action_id IS NULL AND hash_name=? AND price_cents=? AND quantity=?
        `).all(accountId, params.request.marketHashName, unitPrice, params.request.quantity) as Array<{ buy_order_id: string }>;

        if (own?.venue_order_id) {
          database.setActionState(action.id, superseded ? 'FAILED' : 'DONE', this.context.now(),
            superseded ? 'superseded-after-the-order-was-created' : undefined);
          database.raw().prepare(`
            UPDATE reservation SET ref_kind='BUY_ORDER', ref_id=?, state='ACTIVE'
            WHERE account_id=? AND ref_kind='BUY_ORDER_ACTION' AND ref_id=?
          `).run(own.venue_order_id, accountId, action.id);
        } else if (matches.length === 0) {
          // Absence from the active-order book is exactly as compatible with "created, then
          // filled before anyone looked" as it is with "never created" (BUY-05, N-BUY-02). Only
          // a complete history walk that also shows no purchase in the window rules the first
          // one out; until it does, this stays awaiting observation rather than becoming
          // retryable work.
          const unexplained = this.purchaseCouldExplainAbsence(accountId, action);
          if (unexplained === 'unknown') continue;
          if (unexplained === 'possible') {
            database.addEventOnce(accountId, 'buy-order-create-unresolved', {
              actionId: action.id, reason: 'a purchase in the attempt window may be this order'
            }, this.context.now());
            continue;
          }
          // Never on the book, and no purchase in the window that could have been it: the order
          // was not placed. It fails with the reason — a buy order is wallet money, so whether to
          // place it again is the person's (`kernel/retry-policy.ts`). It used to go back to `READY`,
          // which nothing sent again and the buy-order book did not show.
          settleNotApplied(this.context, action, obs.id, 'Steam never showed the buy order');
          database.raw().prepare(`UPDATE reservation SET state='RELEASED' WHERE account_id=? AND ref_kind='BUY_ORDER_ACTION' AND ref_id=?`)
            .run(accountId, action.id);
        } else {
          // Several open orders are indistinguishable on (hash, price, quantity), so this
          // attempt cannot be tied to one of them. Surface it and hold the reservation
          // rather than guessing which order is ours.
          database.addEventOnce(accountId, 'buy-order-attribution-ambiguous', {
            actionId: action.id,
            hashName: params.request.marketHashName,
            unitPriceCents: unitPrice,
            quantity: params.request.quantity,
            candidates: matches.map((match) => match.buy_order_id)
          }, this.context.now());
        }
      } else {
        const params = database.desiredParams(action) as CancelBuyParams;
        const row = new OrderStore(database).steamBuyOrder(accountId, params.buyOrderId);
        if (row && !row.state.startsWith('ENDED_')) {
          // Still open on a complete walk that began after the attempt finished. That is the later
          // authoritative observation rule 1 asks for, and it says the cancel did not take: a
          // timeout that never reached Steam, or no session to send it with. Left awaiting, it
          // would wait for ever on an order nothing is removing. A cancel can be repeated without
          // harm, so it is sent again on the cancel schedule and fails with the reason after the
          // last (N-BUY-09, `kernel/retry-policy.ts`); `RetryService` sends it.
          if (this.cancelProvedNotApplied(action, obs)) {
            settleNotApplied(this.context, action, obs.id, 'Steam still shows the buy order');
          }
          continue;
        }
        if (row && row.filled >= row.quantity) {
          database.setActionState(action.id, 'FAILED', this.context.now(), 'order-filled-before-cancel-observed');
          this.settleReservation(accountId, params.buyOrderId);
        } else {
          database.setActionState(action.id, 'DONE', this.context.now());
          // A cancellation returns the *remainder*. Anything a fill already consumed stayed
          // spent, and releasing the original amount would hand that money back twice
          // (N-BUY-03, BUY-08).
          this.settleReservation(accountId, params.buyOrderId);
        }
      }
    }
  }

  /**
   * Whether a complete walk that still shows the order open proves a cancel did not take.
   *
   * Only a walk that *began* after the attempt finished can. One already under way when the cancel
   * went out may have read the book before Steam took the order off it (`postAttempt`, absence).
   */
  protected cancelProvedNotApplied(action: ActionRow, observation: ObservationRow): boolean {
    return postAttempt(this.context.database, action, observation, true);
  }

  /**
   * Whether a purchase in the attempt's window could be this order having been created and
   * filled before anybody observed it.
   *
   * `unknown` when there is no fresh complete history walk to ask; `possible` when the walk
   * contains a purchase this attempt could have caused; `no` only when a walk that covers the
   * window contains none. Deliberately coarse: `myhistory` names a listing, not the buy order
   * that matched it, so attribution here would be a guess, and the only safe use of a guess is
   * to refuse to conclude (BUY-05, §9.5 open evidence).
   */
  protected purchaseCouldExplainAbsence(accountId: string, action: ActionRow): 'unknown' | 'possible' | 'no' {
    const { database } = this.context;
    const attempt = database.latestAttempt(action.id);
    if (!attempt) return 'unknown';
    const history = surfaceEvidence(database, accountId, ACCOUNT_HISTORY, this.context.ports.clock.now());
    if (history.grade !== 'SATISFIED') return 'unknown';
    if (history.value.started_at < attempt.started_at) return 'unknown';
    const purchase = database.raw().prepare(`SELECT 1 FROM market_history
      WHERE account_id=? AND event_type=4 AND occurred_at>=? LIMIT 1`).get(accountId, attempt.started_at);
    return purchase ? 'possible' : 'no';
  }

  /**
   * Closes out a reservation once the order is no longer active.
   *
   * What a fill consumed has already been subtracted by `recordBuyOrderFill`, so whatever is
   * left is the unspent remainder and that is what returns to the wallet. A row that reached
   * zero is CONSUMED rather than RELEASED, because those are different histories.
   */
  protected settleReservation(accountId: string, buyOrderId: string): void {
    const { database } = this.context;
    const row = database.raw().prepare(`SELECT amount_cents FROM reservation
      WHERE account_id=? AND ref_kind='BUY_ORDER' AND ref_id=? AND state IN ('ACTIVE','SUBMITTED_UNOBSERVED')`)
      .get(accountId, buyOrderId) as { amount_cents: number } | undefined;
    if (!row) return;
    database.raw().prepare(`UPDATE reservation SET state=? WHERE account_id=? AND ref_kind='BUY_ORDER' AND ref_id=?`)
      .run(row.amount_cents > 0 ? 'RELEASED' : 'CONSUMED', accountId, buyOrderId);
  }

  /**
   * Fails closed unless the wallet and the current-orders book are both complete *and* fresh.
   *
   * Completeness alone was the old test, and it admitted real money against a week-old balance:
   * a complete observation stays complete forever. `surfaceEvidence` applies `FRESHNESS` as
   * well, which is the whole point of requirements N-BUY-06 — an order committed against a
   * stale balance can overcommit funds that a sale or another order already spent.
   */
  protected requireCompleteAdmission(accountId: string): void {
    requireFreshMoneyEvidence(this.context, accountId, 'Buy-order admission');
  }
}
