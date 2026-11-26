import type { CsfloatBuyOrderConstraints, CsfloatBuyOrderCreate, CsfloatBuyOrderEdit, MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CsfloatStore, type CsfloatBuyOrderRow } from '../db/csfloat.js';
import { MarketplaceStore, type ConnectionRow } from '../db/marketplace.js';
import { INTERRUPTED_BEFORE_OUTCOME, type ActionRow, type AttemptRow, type ObservationRow } from '../db/database.js';
import type { CommandAuthority } from '../db/alphabets.js';
import { WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { attemptWatermark, postAttempt } from '../kernel/evidence.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { onCsfloatPriceIncrement, csfloatPriceIncrement, preservableConstraints, sameBuyOrderConstraints, validateBuyOrderConstraints } from '../kernel/csfloat-buy-orders.js';
import { CSFLOAT_BUY_ORDER_SURFACE, type CsfloatBuyOrderService } from '../surfaces/csfloat-buy-orders.js';
import type { Settling } from './settle.js';
import type { Reading } from './reads.js';

/**
 * A create, a change or a cancel of one of the account's own CSFloat buy orders: one command, one
 * step, one action (consolidation plan D2). A change or a cancel is named by the venue's order id,
 * carries the terms it was admitted with, and is settled only by a complete walk of the book that
 * shows the new terms or no longer shows the order (CSF-39, CSF-40, CSF-41). A walk after the
 * attempt that still shows the old terms proves the request did not take, and nothing is sent again.
 *
 * A create is named by the market name it bids on, since the order has no id until the venue
 * answers, and is settled by a complete walk that shows the order it made; that order is then
 * linked to it (`venue_order.action_id`), so the book names the command that placed it (CSF-64).
 * The venue takes a second order for a name the account already bids on, so a create is sent once:
 * an answer lost on the way back is settled by the walks, never by sending again (CSF-65).
 */
export type CsfloatBuyingServices = {
  book: CsfloatBuyOrderService;
  settle: Settling;
  reads: Reading;
};
export type CsfloatBuyOrderTerms = { maxPriceCents: number; quantity: number; constraints?: CsfloatBuyOrderConstraints | undefined };
/** A new order for any item of one market name. The create route's filters are not captured, so none is taken. */
export type CsfloatBuyOrderCreateTerms = { marketHashName: string; maxPriceCents: number; quantity: number };

/** The hops a CSFloat buy order can be given: step kinds, and the action kinds that send them. */
export const BUY_ORDER_CREATE = 'CSFLOAT_BUY_ORDER_CREATE' as const;
export const BUY_ORDER_EDIT = 'CSFLOAT_BUY_ORDER_EDIT' as const;
export const BUY_ORDER_CANCEL = 'CSFLOAT_BUY_ORDER_CANCEL' as const;
export type BuyOrderOperationKind = typeof BUY_ORDER_CREATE | typeof BUY_ORDER_EDIT | typeof BUY_ORDER_CANCEL;
export const BUY_ORDER_OPERATION_KINDS: readonly BuyOrderOperationKind[] = [BUY_ORDER_CREATE, BUY_ORDER_EDIT, BUY_ORDER_CANCEL];
/** The hops about an order that exists, named by its id. */
const ORDER_CHANGE_KINDS: readonly BuyOrderOperationKind[] = [BUY_ORDER_EDIT, BUY_ORDER_CANCEL];
export const BUY_ORDER_BOOK_WINDOW_MS = 300_000;
export const BUY_ORDER_NOT_APPLIED = 'complete-observation-proved-not-applied';
export const BUY_ORDER_MIN_PRICE_CENTS = 3;
/** The venue reads a create's quantity as an unsigned byte and takes 1 to 249 (captured 2026-11-07). */
export const BUY_ORDER_MAX_QUANTITY = 249;
/** A create the venue answered with its order, which no walk ever showed: bought at once, or cancelled. */
export const BUY_ORDER_LEFT_THE_BOOK = 'CSFloat answered with the new order, which left the book before a CSFloat read showed it: it filled at once or was cancelled';

/** The frozen terms, on the step and on its action alike, so a read of either says what was asked. */
export type BuyOrderStepParams = {
  operationId: string;
  orderId: string;
  maxPriceCents: number | null;
  quantity: number | null;
  constraints: CsfloatBuyOrderConstraints | null;
  propertiesJson: string | null;
  hashName?: string;
  /** The CSFloat connection the terms were admitted under; a walk of another generation proves nothing about them. */
  generation: number;
  policyVersion: number;
};

/**
 * A create's frozen terms. No order id: the venue names one in its answer, which the attempt keeps,
 * and the walk that shows the order links it. `hashName` is what the work panel names the hop by.
 */
export type BuyOrderCreateParams = {
  operationId: string;
  hashName: string;
  maxPriceCents: number;
  quantity: number;
  generation: number;
  policyVersion: number;
};

/** An order a create may have made, as the book's walks recorded it. */
export type CreatedOrder = { order_id: string; venue_order_id: string; first_seen_obs: number; action_id: string | null };
const CREATED_ORDER_COLUMNS = 'v.order_id, v.venue_order_id, v.first_seen_obs, v.action_id';

export class CsfloatBuyingService {
  protected readonly store: CsfloatStore;
  protected readonly work: WorkStore;
  private readonly advancing = new AccountLock();
  private readonly scheduled = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatBuyingServices) {
    this.store = new CsfloatStore(context.database);
    this.work = new WorkStore(context.database);
  }

  /** The own buy-order book, as a need: a walk begun after `startedAfter`. */
  private book(accountId: string, startedAfter: string, priority: 'person' | 'work'): Promise<unknown> {
    return this.services.reads.need(accountId, { ref: { surface: CSFLOAT_BUY_ORDER_SURFACE, scope: { kind: 'account' } }, startedAfter, priority });
  }

  async refresh(accountId: string): Promise<void> {
    await this.book(accountId, this.context.now(), 'person');
    this.services.settle.settleNow(accountId);
  }

  async submitCreate(accountId: string, commandId: string, terms: CsfloatBuyOrderCreateTerms, authority: CommandAuthority = 'HUMAN'): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.book(accountId, this.context.now(), 'person');
    const step = this.queueCreate(accountId, commandId, terms, authority);
    this.schedule(accountId);
    return step;
  }

  async submitEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms, authority: CommandAuthority = 'HUMAN'): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.book(accountId, this.context.now(), 'person');
    const step = this.queueEdit(accountId, commandId, orderId, terms, authority);
    this.schedule(accountId);
    return step;
  }

  async submitCancel(accountId: string, commandId: string, orderId: string, authority: CommandAuthority = 'HUMAN'): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.book(accountId, this.context.now(), 'person');
    const step = this.queueCancel(accountId, commandId, orderId, authority);
    this.schedule(accountId);
    return step;
  }

  /**
   * Admits a new order, before any call: a connection, a complete walk of the book inside its
   * window, a price CSFloat takes, a quantity it takes, and no other create of this name on the
   * account still waiting to be settled, because a second one would be a second order (CSF-64,
   * CSF-67). The same command id with the same terms is the same create.
   */
  queueCreate(accountId: string, commandId: string, terms: CsfloatBuyOrderCreateTerms, authority: CommandAuthority = 'HUMAN'): WorkStepRow {
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        const asked = this.work.params<BuyOrderCreateParams>(existing);
        if (existing.account_id !== accountId || existing.kind !== BUY_ORDER_CREATE || asked.hashName !== terms.marketHashName
          || asked.maxPriceCents !== terms.maxPriceCents || asked.quantity !== terms.quantity) {
          throw new Error('Command id was already used for different terms');
        }
        return existing;
      }
      const connection = this.validateBook(accountId);
      const name = terms.marketHashName;
      if (typeof name !== 'string' || !name || name !== name.trim()) throw new Error('A CSFloat buy order names its item by the exact market name');
      const price = this.priceProblem(terms.maxPriceCents);
      if (price) throw new Error(price);
      if (!Number.isSafeInteger(terms.quantity) || terms.quantity < 1 || terms.quantity > BUY_ORDER_MAX_QUANTITY) {
        throw new Error(`CSFloat takes a buy-order quantity from 1 to ${BUY_ORDER_MAX_QUANTITY}`);
      }
      if (this.work.openForTarget(accountId, BUY_ORDER_CREATE, name).length) {
        throw new Error('A buy order for this item is already being placed on this account; a CSFloat read has to settle it first');
      }
      const params: BuyOrderCreateParams = {
        operationId: commandId, hashName: name, maxPriceCents: terms.maxPriceCents, quantity: terms.quantity,
        generation: connection.generation, policyVersion: this.store.policy().version
      };
      return this.insert({ id: commandId, accountId, kind: BUY_ORDER_CREATE, targetId: name, resource: `csfloat-buy-order-create:${name}`, params, authority });
    });
  }

  queueEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms, authority: CommandAuthority = 'HUMAN'): WorkStepRow {
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        const asked = this.paramsOf(existing);
        if (existing.account_id !== accountId || existing.target_id !== orderId || existing.kind !== BUY_ORDER_EDIT
          || asked.maxPriceCents !== terms.maxPriceCents || asked.quantity !== terms.quantity
          || (terms.constraints !== undefined && (asked.constraints === null || !sameBuyOrderConstraints(asked.constraints, terms.constraints)))) {
          throw new Error('Command id was already used for different terms');
        }
        return existing;
      }
      const row = this.validateOpen(accountId, orderId);
      this.refuseSecondOperation(accountId, orderId);
      // A price CSFloat would not take is refused here: an edit is one of two a minute, and a refusal spends one.
      const price = this.priceProblem(terms.maxPriceCents);
      if (price) throw new Error(price);
      if (!Number.isSafeInteger(terms.quantity) || terms.quantity < 1) throw new Error('CSFloat buy-order quantity must be at least 1');
      const observed = preservableConstraints(propertiesOf(row));
      if (observed === null) throw new Error('This buy order carries constraints this app cannot preserve through an edit; change it on CSFloat instead');
      const constraints = terms.constraints === undefined ? observed : validateBuyOrderConstraints(terms.constraints);
      if (terms.maxPriceCents === row.price_cents && terms.quantity === row.quantity && sameBuyOrderConstraints(constraints, observed)) {
        throw new Error('The buy order already has these terms');
      }
      return this.insert({ id: commandId, accountId, kind: BUY_ORDER_EDIT, targetId: orderId, resource: `csfloat-buy-order:${orderId}`,
        params: this.changeParams(commandId, accountId, orderId, row, constraints, terms), authority });
    });
  }

  queueCancel(accountId: string, commandId: string, orderId: string, authority: CommandAuthority = 'HUMAN'): WorkStepRow {
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        if (existing.account_id !== accountId || existing.target_id !== orderId || existing.kind !== BUY_ORDER_CANCEL) throw new Error('Command id was already used for different terms');
        return existing;
      }
      const row = this.validateOpen(accountId, orderId);
      this.refuseSecondOperation(accountId, orderId);
      return this.insert({ id: commandId, accountId, kind: BUY_ORDER_CANCEL, targetId: orderId, resource: `csfloat-buy-order:${orderId}`,
        params: this.changeParams(commandId, accountId, orderId, row, null), authority });
    });
  }

  /**
   * Why CSFloat would not take this buy-order price, or null when it would: under its $0.03 floor,
   * or off the price increment its FAQ names for that price (`csfloatPriceIncrement`). Checked before
   * a create and before an edit, so neither is spent on a refusal (CSF-67). Isolated so a saboteur
   * can forget the increment.
   */
  protected priceProblem(priceCents: number): string | null {
    if (!Number.isSafeInteger(priceCents) || priceCents < BUY_ORDER_MIN_PRICE_CENTS) return 'CSFloat takes no buy-order price under $0.03 each';
    if (!onCsfloatPriceIncrement(priceCents)) {
      const step = csfloatPriceIncrement(priceCents);
      const below = priceCents - (priceCents % step);
      return `CSFloat takes a buy-order price of ${dollars(priceCents)} only in steps of ${dollars(step)}: ${dollars(below)} or ${dollars(below + step)}`;
    }
    return null;
  }

  /** The connection a change to the book is admitted under, and a complete walk of the book inside its window. */
  protected validateBook(accountId: string): ConnectionRow {
    const db = this.context.database;
    const connection = new MarketplaceStore(db).connection(accountId, 'csfloat');
    if (connection?.status !== 'CONNECTED' || !connection.credential_ref) throw new Error('Connect CSFloat first');
    if (!this.fresh(db.latestCompleteObservation(accountId, CSFLOAT_BUY_ORDER_SURFACE), connection)) throw new Error('Refresh CSFloat buy orders first');
    return connection;
  }

  protected validateOpen(accountId: string, orderId: string): CsfloatBuyOrderRow {
    const db = this.context.database;
    const connection = new MarketplaceStore(db).connection(accountId, 'csfloat');
    if (connection?.status !== 'CONNECTED' || !connection.credential_ref) throw new Error('Connect CSFloat first');
    const row = this.store.buyOrder(accountId, orderId);
    if (!row || !this.fresh(db.observation(accountId, row.last_seen_obs), connection)) throw new Error('Refresh CSFloat buy orders first');
    return row;
  }

  /** A complete, clean walk of this connection's book, begun inside the window. */
  private fresh(observation: ObservationRow | undefined, connection: ConnectionRow): boolean {
    const age = observation ? Date.parse(this.context.now()) - Date.parse(observation.started_at) : NaN;
    return Boolean(observation?.complete) && !observation!.error && observation!.generation === connection.generation && age >= 0 && age <= BUY_ORDER_BOOK_WINDOW_MS;
  }

  private paramsOf(step: WorkStepRow): BuyOrderStepParams {
    return this.work.params<BuyOrderStepParams>(step);
  }

  private refuseSecondOperation(accountId: string, orderId: string): void {
    const open = ORDER_CHANGE_KINDS.flatMap((kind) => this.work.openForTarget(accountId, kind, orderId));
    if (open.length) throw new Error('This buy order already has a change on its way; a CSFloat read has to settle it first');
  }

  private changeParams(id: string, accountId: string, orderId: string, row: CsfloatBuyOrderRow, constraints: CsfloatBuyOrderConstraints | null, terms?: CsfloatBuyOrderTerms): BuyOrderStepParams {
    const connection = new MarketplaceStore(this.context.database).connection(accountId, 'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    return {
      operationId: id, orderId, maxPriceCents: terms?.maxPriceCents ?? null, quantity: terms?.quantity ?? null,
      constraints, propertiesJson: row.properties_json, hashName: row.hash_name,
      generation: connection.generation, policyVersion: this.store.policy().version
    };
  }

  private insert(input: { id: string; accountId: string; kind: BuyOrderOperationKind; targetId: string; resource: string; params: BuyOrderStepParams | BuyOrderCreateParams; authority: CommandAuthority }): WorkStepRow {
    const db = this.context.database, now = this.context.now();
    // The command id the caller chose is the command, the step and the operation: one id, one hop.
    this.work.adoptCommand(input.id, input.kind, now, input.authority);
    const step = this.work.insert({ id: input.id, commandId: input.id, accountId: input.accountId, ordinal: 0, kind: input.kind, targetId: input.targetId, params: input.params, now });
    const action = db.enqueueAction({ accountId: input.accountId, stepId: step.id, actionKind: input.kind,
      targetId: input.resource, resourceKey: input.resource, params: input.params, now });
    this.work.attachAction(step.id, action.id, now);
    return this.work.step(step.id)!;
  }

  schedule(accountId: string): void {
    if (this.stopped || this.scheduled.has(accountId)) return;
    this.scheduled.add(accountId);
    setImmediate(() => {
      this.scheduled.delete(accountId);
      if (this.stopped) return;
      void this.advance(accountId).catch(() => undefined);
    });
  }

  async advance(accountId: string): Promise<void> {
    const work = this.advancing.run(accountId, async () => {
      const db = this.context.database;
      if (!new MarketplaceStore(db).connection(accountId, 'csfloat')?.credential_ref || !this.context.ports.csfloat) return;
      const queued = this.work.open(accountId, BUY_ORDER_OPERATION_KINDS)
        .filter((step) => step.state === 'QUEUED' && step.action_id !== null && db.action(step.action_id)?.state === 'READY');
      if (!queued.length) return;
      // The book inside its window before anything is sent: a walk begun inside it answers without a read.
      await this.book(accountId, new Date(Date.parse(this.context.now()) - BUY_ORDER_BOOK_WINDOW_MS).toISOString(), 'work');
      let sent = false;
      for (const { id } of queued) {
        if (this.stopped) return;
        try {
          if (await this.execute(id)) sent = true;
        } catch (error) {
          if (this.stopped) return;
          if (this.work.step(id)?.state === 'FAILED') continue;
          try { db.addEvent(accountId, 'csfloat-dispatch-error', { operationId: id, message: errorMessage(error) }, this.context.now()); } catch { /* closed under us */ }
        }
      }
      // The book again, begun after the sends returned: the proof the reconciler judges (CSF-39, CSF-40, CSF-64).
      if (sent && !this.stopped) await this.book(accountId, this.context.now(), 'work');
    });
    this.running.set(accountId, work);
    try { await work; } finally { if (this.running.get(accountId) === work) this.running.delete(accountId); }
  }

  async settled(commandId: string): Promise<void> {
    const accounts = [...new Set(this.work.steps(commandId).map((step) => step.account_id))];
    for (;;) {
      if (accounts.some((accountId) => this.scheduled.has(accountId))) { await new Promise<void>((resolve) => setImmediate(resolve)); continue; }
      const running = accounts.map((accountId) => this.running.get(accountId)).filter((work): work is Promise<void> => work !== undefined);
      if (!running.length) return;
      await Promise.all(running.map((work) => work.catch(() => undefined)));
    }
  }

  stop(): void {
    this.stopped = true;
    this.scheduled.clear();
  }

  /** The send: one request for a QUEUED step whose action is READY, admitted again at the moment of sending. */
  async execute(id: string): Promise<MutationOutcome | null> {
    const initial = this.work.step(id);
    if (!initial) throw new Error('Unknown CSFloat operation');
    return this.context.locks.run(initial.account_id, async () => {
      const step = this.work.step(id)!, db = this.context.database, action = step.action_id ? db.action(step.action_id) : undefined;
      if (!action || action.state !== 'READY' || step.state !== 'QUEUED' || !step.target_id) return null;
      const target = step.target_id;
      const generation = this.work.params<{ generation: number }>(step).generation;
      const connection = new MarketplaceStore(db).connection(step.account_id, 'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const validate = () => {
        const current = new MarketplaceStore(db).connection(step.account_id, 'csfloat');
        if (current?.generation !== generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the buy order');
        if (step.kind === BUY_ORDER_CREATE) { this.validateBook(step.account_id); return; }
        const row = this.validateOpen(step.account_id, target);
        if (step.kind === BUY_ORDER_EDIT && row.properties_json !== this.paramsOf(step).propertiesJson) {
          throw new Error('The buy order changed on CSFloat since it was reviewed; refresh and change it again');
        }
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      const credential = connection.credential_ref;
      let outcome: MutationOutcome;
      try {
        outcome = await executeMutation(this.context, action, () => step.kind === BUY_ORDER_CREATE
          ? ports.buyOrders.create(step.account_id, credential, this.createFor(this.work.params<BuyOrderCreateParams>(step)))
          : step.kind === BUY_ORDER_EDIT
            ? ports.buyOrders.update(step.account_id, credential, target, this.editFor(this.paramsOf(step)))
            : ports.buyOrders.remove(step.account_id, credential, target), admit);
      } catch (error) {
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id, 'FAILED', this.context.now(), rejected.message);
          this.work.settle(step.id, 'FAILED', null, this.context.now(), rejected.message);
        });
        throw error;
      }
      // A walk that ran while the answer was on its way may already have settled the hop; the answer never unsettles it.
      if (!isSettled(this.work.step(step.id)!)) {
        this.work.setState(step.id, outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION', this.context.now(),
          outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
      }
      return outcome;
    });
  }

  protected createFor(params: BuyOrderCreateParams): CsfloatBuyOrderCreate {
    return { marketHashName: params.hashName, maxPriceCents: params.maxPriceCents, quantity: params.quantity };
  }

  protected editFor(params: BuyOrderStepParams): CsfloatBuyOrderEdit {
    if (params.maxPriceCents === null || params.quantity === null || params.constraints === null) throw new Error('Edit terms are missing; review the buy order');
    return { maxPriceCents: params.maxPriceCents, quantity: params.quantity, constraints: params.constraints };
  }

  /** The proof: a complete walk of the book, of the same connection, begun after the attempt. */
  reconcile(accountId: string): void {
    const db = this.context.database;
    for (const step of this.work.open(accountId, BUY_ORDER_OPERATION_KINDS)) {
      if (!['QUEUED', 'AWAITING_OBSERVATION'].includes(step.state) || !step.action_id || !step.target_id) continue;
      const action = db.action(step.action_id);
      if (!action || !['RUNNING', 'AWAITING_OBSERVATION'].includes(action.state)) continue;
      if (step.state !== 'AWAITING_OBSERVATION') this.work.setState(step.id, 'AWAITING_OBSERVATION', this.context.now());
      const obs = db.latestObservation(accountId, CSFLOAT_BUY_ORDER_SURFACE);
      if (step.kind === BUY_ORDER_CREATE) {
        this.reconcileCreate(step, action, this.work.params<BuyOrderCreateParams>(step), obs);
        continue;
      }
      const params = this.paramsOf(step);
      if (!obs?.complete || obs.error || obs.generation !== params.generation) continue;
      const row = this.store.buyOrder(accountId, step.target_id);
      const present = row !== undefined && row.last_seen_obs === obs.id;
      if (step.kind === BUY_ORDER_CANCEL) {
        if (!present) {
          if (postAttempt(db, action, obs, false)) this.settle(step, action, obs.id);
          continue;
        }
        if (postAttempt(db, action, obs, true)) this.fail(step, action, BUY_ORDER_NOT_APPLIED, 'A CSFloat read after the cancel still showed the order open, so nothing was cancelled');
        continue;
      }
      if (present && row.price_cents === params.maxPriceCents && row.quantity === params.quantity && this.showsConstraints(row, action)) {
        if (postAttempt(db, action, obs, false)) this.settle(step, action, obs.id);
        continue;
      }
      if (!postAttempt(db, action, obs, true)) continue;
      if (!present) this.fail(step, action, 'order-gone', 'The order left the CSFloat book before the change was seen: it may have filled or been cancelled');
      else this.fail(step, action, BUY_ORDER_NOT_APPLIED, 'A CSFloat read after the change still showed the old terms, so nothing was changed');
    }
  }

  /**
   * A create is settled by the order it made, found by a complete walk of the same connection, or by
   * a walk begun after the attempt returned that shows none. The order is the one the answer named,
   * else (a lost answer) the earliest of its name and terms first shown by a walk after the attempt
   * began and made by no other create of ours; an order older than the attempt is never the one it
   * made. Found, it is linked to the create's action and the create is done. Not found, a create
   * the venue answered with its order is done all the same (the order was made, and left the book
   * before a walk saw it), and any other is proved never placed. It is never sent again (CSF-65).
   */
  private reconcileCreate(step: WorkStepRow, action: ActionRow, params: BuyOrderCreateParams, obs: ObservationRow | undefined): void {
    const db = this.context.database;
    const attempt = db.latestAttempt(action.id);
    if (!attempt) return;
    const order = this.createdOrder(step.account_id, action, params, attempt);
    if (order) {
      const shown = db.observation(step.account_id, order.first_seen_obs);
      if (shown?.complete && !shown.error && shown.generation === params.generation) this.settleLinked(step, action, order, shown.id);
      return;
    }
    if (!obs?.complete || obs.error || obs.generation !== params.generation || !this.absenceProved(action, attempt, obs)) return;
    if (this.answeredOrderId(attempt) !== null) this.settle(step, action, obs.id, BUY_ORDER_LEFT_THE_BOOK);
    else this.fail(step, action, BUY_ORDER_NOT_APPLIED, 'A complete CSFloat read after the create showed no such order, so none was placed; it is not sent again');
  }

  /** The order this create made, as a walk recorded it: already linked, the one its answer named, or one matching its terms. */
  private createdOrder(accountId: string, action: ActionRow, params: BuyOrderCreateParams, attempt: AttemptRow): CreatedOrder | undefined {
    const db = this.context.database;
    const linked = db.raw().prepare(`SELECT ${CREATED_ORDER_COLUMNS} FROM venue_order v WHERE v.account_id=? AND v.action_id=?`).get(accountId, action.id) as CreatedOrder | undefined;
    if (linked) return linked;
    const named = this.answeredOrderId(attempt);
    if (named !== null) {
      const row = db.raw().prepare(`SELECT ${CREATED_ORDER_COLUMNS} FROM venue_order v WHERE v.account_id=? AND v.venue='csfloat' AND v.venue_order_id=?
        AND v.side='BUY' AND v.first_seen_obs IS NOT NULL`).get(accountId, named) as CreatedOrder | undefined;
      return row && row.action_id === null ? row : undefined;
    }
    // An answer still on its way may name the order: no order is taken on its terms until it is in.
    if (attempt.finished_at === null && action.error !== INTERRUPTED_BEFORE_OUTCOME) return undefined;
    return this.unclaimedOrders(accountId, params, attemptWatermark(attempt))[0];
  }

  /**
   * The orders of this name and terms no create of ours has claimed, first shown by a walk recorded
   * after `watermark`, earliest first: the account's CSFloat orders by `order_venue_id`, read only
   * while a create waits on a lost answer. Isolated so a saboteur can look before the attempt.
   */
  protected unclaimedOrders(accountId: string, params: BuyOrderCreateParams, watermark: number): CreatedOrder[] {
    return this.context.database.raw().prepare(`SELECT ${CREATED_ORDER_COLUMNS} FROM venue_order v
      WHERE v.account_id=? AND v.venue='csfloat' AND v.venue_order_id IS NOT NULL AND v.side='BUY' AND v.hash_name=? AND v.price_cents=? AND v.quantity=? AND v.action_id IS NULL AND v.first_seen_obs > ?
      ORDER BY v.first_seen_obs, v.venue_order_id`).all(accountId, params.hashName, params.maxPriceCents, params.quantity, watermark) as CreatedOrder[];
  }

  /** The order id the create's answer named, when the venue answered with one. Isolated so a saboteur can ignore it. */
  protected answeredOrderId(attempt: AttemptRow): string | null {
    if (attempt.outcome !== 'SUBMITTED' || !attempt.response_ref) return null;
    const answer = JSON.parse(attempt.response_ref) as { id?: unknown } | null;
    return typeof answer?.id === 'string' && /^\d+$/.test(answer.id) ? answer.id : null;
  }

  /**
   * Whether this walk can show the order missing: begun after the attempt returned, or, for a call a
   * dead process never saw return (rule 6), after the record opened again and recovered it.
   */
  private absenceProved(action: ActionRow, attempt: AttemptRow, obs: ObservationRow): boolean {
    if (postAttempt(this.context.database, action, obs, true)) return true;
    return attempt.finished_at === null && action.error === INTERRUPTED_BEFORE_OUTCOME
      && postAttempt(this.context.database, action, obs, false) && obs.started_at > action.updated_at;
  }

  /** The order made, linked to the create that made it, and the create done, together. */
  private settleLinked(step: WorkStepRow, action: ActionRow, order: CreatedOrder, observationId: number): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      if (order.action_id === null && !this.linkOrder(step.account_id, order.order_id, action.id)) return;
      db.resolveAction(action, observationId, true, now);
      this.work.settle(step.id, 'DONE', observationId, now);
    });
  }

  /**
   * Names the create that made an order on its row (`CsfloatStore.linkBuyOrder`), so the book reads
   * the command that placed it. Isolated so a saboteur can skip it.
   */
  protected linkOrder(accountId: string, orderId: string, actionId: string): boolean {
    return this.store.linkBuyOrder(accountId, orderId, actionId);
  }

  protected showsConstraints(row: CsfloatBuyOrderRow, action: ActionRow): boolean {
    const sent = (this.context.database.actionParams(action) as BuyOrderStepParams).constraints;
    if (sent === null) return true;
    const shown = preservableConstraints(propertiesOf(row));
    return shown !== null && sameBuyOrderConstraints(shown, sent);
  }

  private settle(step: WorkStepRow, action: ActionRow, observationId: number, reason: string | null = null): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      db.resolveAction(action, observationId, true, now);
      this.work.settle(step.id, 'DONE', observationId, now, reason);
    });
  }

  private fail(step: WorkStepRow, action: ActionRow, actionError: string, reason: string): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      db.setActionState(action.id, 'FAILED', now, actionError);
      this.work.settle(step.id, 'FAILED', null, now, reason);
    });
  }
}

function propertiesOf(row: CsfloatBuyOrderRow): Record<string, unknown> | null {
  return row.properties_json === null ? null : JSON.parse(row.properties_json) as Record<string, unknown>;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
