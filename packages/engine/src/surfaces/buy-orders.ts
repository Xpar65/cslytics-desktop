import type { AccountId, BuyOrderRequest, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, ObservationRow } from '../db/database.js';
import type { CommandAuthority } from '../db/alphabets.js';
import { type EngineContext, executeMutation } from '../kernel/context.js';
import { ACCOUNT_HISTORY, ACCOUNT_MARKET, attemptReturned, postAttempt, surfaceEvidence, type ProofNeed } from '../kernel/evidence.js';
import { required } from '../kernel/support.js';
import { attemptsMade, settleNotApplied } from '../kernel/not-applied.js';
import { CONFIRM_RETRY_DELAYS_MS } from '../kernel/retry-policy.js';
import { AdmissionRefused, admissionPolicy, requireFreshMoneyEvidence, walletAvailability, type BuyOrderAdmissionPolicy } from '../policy/wallet-admission.js';
import { errorMessage } from '../kernel/support.js';
import { LedgerStore } from '../db/ledger.js';
import { WorkStore } from '../db/work.js';
import { BUY_ORDER_STATUS_SURFACE, OrderStore } from '../db/orders.js';
import { ConfirmationStore } from '../db/confirmations.js';

/** Provenance for a fill posting, deliberately outside `FRESHNESS` — see `syncStatuses`. */
export { BUY_ORDER_STATUS_SURFACE } from '../db/orders.js';

export type BuyOrderParams = { request: BuyOrderRequest; reservationCents: number };
export type CancelBuyParams = { buyOrderId: string };

/** Whose a buy order or its cancel is, and the id the caller gave its command, if it gave one (standing buy orders plan D6). */
export type BuyOrderCommandOptions = { commandId?: string | undefined; authority?: CommandAuthority | undefined };

/** A create's action, with what the venue answered its first request; `null` when the command was already admitted and this is its replay. */
export type BuyOrderCreated = ActionRow & { outcome: MutationOutcome | null };

/**
 * How many times a create waiting for its phone confirmation is sent again: once for each press the
 * confirmation schedule allows (`CONFIRM_RETRY_DELAYS_MS`, twelve presses). After the last, it
 * waits for the walks that settle any create.
 */
export const BUY_ORDER_CONFIRMATION_ROUNDS = CONFIRM_RETRY_DELAYS_MS.length + 1;

/**
 * How long a create waits for its tap with nothing sending it again. A host with a confirmation
 * port presses on its own schedule, which is over by then; without one the person taps and asks
 * the engine to continue (`buyOrder.continue`). Past it, the create goes back to the walks that
 * settle any create, so an order nobody continued is not reserving money for ever (D9).
 */
export const BUY_ORDER_CONFIRMATION_WAIT_MS = 2 * 60 * 60_000;

/** Buy-order admission, wallet reservation, cancellation and fill attribution. */
export class BuyOrderService {
  protected readonly confirmations: ConfirmationStore;

  constructor(protected readonly context: EngineContext) {
    this.confirmations = new ConfirmationStore(context.database);
  }

  /** The limits the composing host gave this account, or one times the wallet and no count (BUY-11). */
  protected policy(accountId: AccountId): BuyOrderAdmissionPolicy {
    return admissionPolicy(this.context.buyOrderAdmission, accountId);
  }

  /**
   * Admits one buy order.
   *
   * Serialised per account, and fails closed when either the wallet or the current-orders
   * observation is incomplete — an order placed on a half-known wallet can overcommit real
   * money (rollout-v3 §4.3 invariant 4).
   *
   * A command id the caller already admitted answers with that command's action and sends
   * nothing: one decision, one order, however often it is made (N-BUY-21).
   */
  async create(accountId: AccountId, request: BuyOrderRequest, admission: BuyOrderCommandOptions = {}): Promise<BuyOrderCreated> {
    return this.context.locks.run(accountId, async () => {
      const { database } = this.context;
      const replay = admission.commandId ? this.admitted(accountId, admission.commandId) : undefined;
      if (replay) return { ...replay, outcome: null };
      try {
        this.requireCompleteAdmission(accountId);
      } catch (error) {
        throw error instanceof AdmissionRefused ? error : new AdmissionRefused('STALE_MONEY_EVIDENCE', errorMessage(error));
      }
      this.admit(accountId, request);

      await this.context.ports.market.getTradeFeeTaxRate(accountId, request.billing);

      // A command of one hop, admitted with its own id; the action is the hop's (D3). One order
      // per name at a time: a second create for a name whose first is still in flight is refused.
      // The order itself is a `SUBMITTED` row of the one order table until a walk shows it (D4).
      const now = this.context.now();
      const work = new WorkStore(database);
      // Steam holds one order per name, so a create for a name whose last one no walk has explained
      // is refused before a command exists (N-BUY-07).
      if (database.inFlight(accountId, `buy-order:${request.marketHashName}`)) {
        throw new AdmissionRefused('NAME_IN_FLIGHT', `Resource buy-order:${request.marketHashName} already has an in-flight action`);
      }
      const action = database.transaction(() => {
        const hop = work.lone('BUY_ORDER_CREATE', { accountId, kind: 'BUY_ORDER_CREATE', targetId: request.marketHashName,
          params: { request, reservationCents: request.priceTotalCents, hashName: request.marketHashName }, now }, admission.authority ?? 'HUMAN', admission.commandId);
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

      const outcome = await this.execute(action.id);
      return { ...required(database.action(action.id), `Action disappeared ${action.id}`), outcome };
    });
  }

  /**
   * Whether the wallet can carry one more standing order, or why not, as an `AdmissionRefused` code
   * (BUY-11). Three claims on one balance — ours, somebody else's at the Steam website, and what is
   * left — computed once for every wallet spender in `policy/wallet-admission.ts` (N-BUY-05), under
   * the limits the host's policy sets, in this order:
   *
   *  1. one unit may not cost more than the wallet holds less what is set aside, because a fill
   *     spends it from the balance itself, whatever the multiple (N-BUY-17, N-BUY-22);
   *  2. every standing order together may not pass the cap (N-BUY-17);
   *  3. no more orders may stand than the policy allows, anyone's counted (N-BUY-23).
   */
  protected admit(accountId: AccountId, request: BuyOrderRequest): void {
    const policy = this.policy(accountId);
    const admitted = walletAvailability(this.context.database, accountId, request.currency, policy);
    const unit = Math.floor(request.priceTotalCents / request.quantity);
    const spendable = admitted.balanceCents - policy.reserveCents;
    if (unit > spendable) {
      throw new AdmissionRefused('UNIT_ABOVE_WALLET', `A unit of ${unit} costs more than the wallet holds: ${spendable}${policy.reserveCents ? ` after ${policy.reserveCents} set aside` : ''}`);
    }
    if (admitted.availableCents < request.priceTotalCents) throw new AdmissionRefused('COMMITMENT_CAP', `Insufficient unreserved wallet balance: ${admitted.availableCents}`);
    const standing = this.standingOrderCount(accountId);
    if (standing >= policy.maxOpenOrders) throw new AdmissionRefused('OPEN_ORDER_CAP', `${standing} buy orders already stand, the most this account allows`);
  }

  /** How many orders stand against the open-order cap: anyone's, and our creates in flight. Isolated so a saboteur can count only ours. */
  protected standingOrderCount(accountId: AccountId): number {
    return new OrderStore(this.context.database).countStandingSteamBuyOrders(accountId);
  }

  /** The create a command id already admitted for this account, if any. */
  protected admitted(accountId: AccountId, commandId: string): ActionRow | undefined {
    const step = new WorkStore(this.context.database).loneStep(commandId);
    if (!step) return undefined;
    if (step.account_id !== accountId || step.kind !== 'BUY_ORDER_CREATE') throw new Error(`Command ${commandId} is not a buy order of this account`);
    return step.action_id ? this.context.database.action(step.action_id) : undefined;
  }

  async execute(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    const params = database.desiredParams(action) as BuyOrderParams;
    const outcome = await new WorkStore(database).send(action.id, () => executeMutation(this.context, action, () =>
      this.context.ports.market.createBuyOrder(action.account_id, params.request)), () => this.context.now());
    this.answered(action.id, outcome);
    return outcome;
  }

  /**
   * Sends a create waiting for its phone confirmation again, carrying the confirmation's id (D1):
   * the same action, a second attempt, so everything that keys on the action — the one open create
   * per name, the reservation, the proof — follows the order whichever request placed it.
   *
   * Only a create Steam asked to have confirmed may go again; anything else is refused before it is
   * sent. The answer is evidence like any other: `success: 1` waits for the walk that binds the
   * order, the same confirmation again means the tap did not apply.
   */
  async repost(actionId: string): Promise<MutationOutcome> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    if (action.kind !== 'CREATE_BUY_ORDER' || action.state !== 'READY' || action.resolution !== 'AWAITING_CONFIRMATION') {
      throw new Error('Only a buy order waiting for its phone confirmation can be continued');
    }
    const confirmationId = this.confirmations.requestedConfirmation(action.id);
    if (confirmationId === null) throw new Error('Steam named no confirmation for this buy order');
    const params = database.desiredParams(action) as BuyOrderParams;
    const outcome = await new WorkStore(database).send(action.id, () => executeMutation(this.context, action, () =>
      this.context.ports.market.createBuyOrder(action.account_id, { ...params.request, confirmationId })), () => this.context.now());
    this.answered(action.id, outcome);
    return outcome;
  }

  /**
   * What a create's answer does to its action. A refusal releases its money. An answer asking for
   * a tap puts the action back to `READY` with `AWAITING_CONFIRMATION`, while rounds are left: the
   * order does not exist yet, so nothing is released and no walk can prove anything about it.
   */
  protected answered(actionId: string, outcome: MutationOutcome): void {
    const { database } = this.context;
    const now = this.context.now();
    if (outcome.kind === 'DEFINITIVELY_REJECTED') {
      database.raw().prepare(`UPDATE reservation SET state='RELEASED' WHERE account_id=(SELECT account_id FROM action WHERE id=?) AND ref_id=?`)
        .run(actionId, actionId);
      return;
    }
    if (outcome.kind !== 'SUBMITTED' || this.confirmations.requestedConfirmation(actionId) === null) return;
    if (attemptsMade(database, actionId) > BUY_ORDER_CONFIRMATION_ROUNDS) return;
    const work = new WorkStore(database);
    database.transaction(() => {
      this.confirmations.awaitConfirmation(actionId, now);
      work.mirror(actionId, now);
      const hop = work.byAction(actionId);
      if (hop) work.update(hop.id, { reason: 'Waiting for the phone confirmation' }, now);
    });
  }

  /** A cancel is a command of one hop (`BUY_ORDER_CANCEL`) named by the order, whose action is the hop's (D3). */
  queueCancel(accountId: AccountId, buyOrderId: string, admission: BuyOrderCommandOptions = {}): ActionRow {
    const { database } = this.context;
    const now = this.context.now();
    const work = new WorkStore(database);
    if (admission.commandId) {
      const step = work.loneStep(admission.commandId);
      if (step) {
        if (step.account_id !== accountId || step.kind !== 'BUY_ORDER_CANCEL') throw new Error(`Command ${admission.commandId} is not a buy-order cancel of this account`);
        return required(step.action_id ? database.action(step.action_id) : undefined, `Cancel ${admission.commandId} has no action`);
      }
    }
    const order = new OrderStore(database).steamBuyOrder(accountId, buyOrderId);
    return database.transaction(() => {
      const hop = work.lone('BUY_ORDER_CANCEL', { accountId, kind: 'BUY_ORDER_CANCEL', targetId: buyOrderId,
        params: { buyOrderId, ...(order ? { hashName: order.hash_name } : {}) }, now }, admission.authority ?? 'HUMAN', admission.commandId);
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
   * Polls `getbuyorderstatus` for every order still open, and records any new fill.
   *
   * Two things this deliberately does not do. It does not treat the order's limit as what was
   * paid — `getbuyorderstatus` reports quantities and nothing else, so the ledger posting is
   * `UNKNOWN` until `myhistory` supplies a real `paid_amount` (BUY-06, N-BUY-04). And it does not
   * guess lineage: the lot keeps every candidate and stays `UNATTRIBUTED`.
   *
   * Only orders not yet ended are asked about (N-BUY-20): an ended order has nothing left to fill,
   * and asking about every order ever shown grew the poll with the account's whole history.
   *
   * The status poll gets its own observation row. Its surface is deliberately absent from
   * `FRESHNESS` and `CADENCE`: it is provenance for a posting, not a schedulable walk, and a
   * per-order poll has no business setting an account-wide freshness verdict.
   */
  async syncStatuses(accountId: AccountId): Promise<void> {
    const { database } = this.context;
    const store = new OrderStore(database);
    for (const row of store.openSteamBuyOrders(accountId)) {
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
        // The fill first: it moves the reservation, and an ending below settles what is left of it.
        if (delta > 0) {
          // Lineage is not invented: the posting names the order and no holding (consolidation plan D12).
          new LedgerStore(database).recordBuyOrderFill({
            accountId, buyOrderId, purchasedTotal: status.purchased, delta,
            unitPriceCents: row.price_cents ?? 0, observationId, now: this.context.now(), hashName: row.hash_name
          });
        }
        store.recordSteamBuyOrderStatus(accountId, row, status, observationId, this.context.now());
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
    this.reconcileAwaitingConfirmation(accountId, observationId);
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
          this.bindReservation(accountId, action.id, own.venue_order_id);
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
        // Gone from the book and not yet explained by Steam's counter: it may have filled before the
        // cancel reached it, so neither "cancelled" nor "still open" is known yet (N-BUY-18).
        if (row?.state === 'UNEXPLAINED') continue;
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
   * Creates waiting for their phone confirmation (D2, D9). One a walk has already bound was placed
   * by the tap alone, so it is done; one nobody sent again within `BUY_ORDER_CONFIRMATION_WAIT_MS`
   * goes back to the walks that settle any create, which end it as never placed if no walk and no
   * purchase shows it.
   */
  protected reconcileAwaitingConfirmation(accountId: AccountId, observationId: number): void {
    const { database } = this.context;
    const now = this.context.now();
    for (const action of this.confirmations.awaitingConfirmation(accountId)) {
      const own = new OrderStore(database).byAction(accountId, action.id);
      if (own?.venue_order_id) {
        database.resolveAction(action, observationId, true, now);
        this.bindReservation(accountId, action.id, own.venue_order_id);
        new WorkStore(database).mirror(action.id, now);
        continue;
      }
      const asked = database.latestAttempt(action.id)?.finished_at ?? action.updated_at;
      if (Date.parse(now) - Date.parse(asked) < BUY_ORDER_CONFIRMATION_WAIT_MS) continue;
      this.confirmations.stopAwaitingConfirmation(action.id, now);
      new WorkStore(database).mirror(action.id, now);
    }
  }

  /** The reservation an admitted create held follows the order a walk bound it to. */
  private bindReservation(accountId: AccountId, actionId: string, buyOrderId: string): void {
    this.context.database.raw().prepare(`
      UPDATE reservation SET ref_kind='BUY_ORDER', ref_id=?, state='ACTIVE'
      WHERE account_id=? AND ref_kind='BUY_ORDER_ACTION' AND ref_id=?
    `).run(buyOrderId, accountId, actionId);
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
    new LedgerStore(this.context.database).settleBuyOrderReservation(accountId, buyOrderId);
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
