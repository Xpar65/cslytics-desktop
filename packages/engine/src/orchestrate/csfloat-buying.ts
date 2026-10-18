import type { CsfloatBuyOrderConstraints, CsfloatBuyOrderEdit, MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CsfloatStore, type CsfloatBuyOrderRow } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { ActionRow } from '../db/database.js';
import { WorkStore, type WorkStepRow } from '../db/work.js';
import { postAttempt } from '../kernel/evidence.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { preservableConstraints, sameBuyOrderConstraints, validateBuyOrderConstraints } from '../kernel/csfloat-buy-orders.js';
import { CSFLOAT_BUY_ORDER_SURFACE, type CsfloatBuyOrderService } from '../surfaces/csfloat-buy-orders.js';
import type { Settling } from './settle.js';
import type { Reading } from './reads.js';

/**
 * A change or a cancel of one of the account's own CSFloat buy orders: one command, one step, one
 * action (consolidation plan D2). The step is named by the venue's order id, carries the terms it
 * was admitted with, and is settled only by a complete walk of the book that shows the new terms
 * or no longer shows the order (CSF-39, CSF-40, CSF-41). A walk after the attempt that still shows
 * the old terms proves the request did not take, and nothing is sent again.
 */
export type CsfloatBuyingServices = {
  book: CsfloatBuyOrderService;
  settle: Settling;
  reads: Reading;
};
export type CsfloatBuyOrderTerms = { maxPriceCents: number; quantity: number; constraints?: CsfloatBuyOrderConstraints | undefined };

/** The two hops a CSFloat buy order can be given: step kinds, and the action kinds that send them. */
export const BUY_ORDER_EDIT = 'CSFLOAT_BUY_ORDER_EDIT' as const;
export const BUY_ORDER_CANCEL = 'CSFLOAT_BUY_ORDER_CANCEL' as const;
export const BUY_ORDER_OPERATION_KINDS: readonly (typeof BUY_ORDER_EDIT | typeof BUY_ORDER_CANCEL)[] = [BUY_ORDER_EDIT, BUY_ORDER_CANCEL];
export const BUY_ORDER_BOOK_WINDOW_MS = 300_000;
export const BUY_ORDER_NOT_APPLIED = 'complete-observation-proved-not-applied';
export const BUY_ORDER_MIN_PRICE_CENTS = 3;

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

  async submitEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.book(accountId, this.context.now(), 'person');
    const step = this.queueEdit(accountId, commandId, orderId, terms);
    this.schedule(accountId);
    return step;
  }

  async submitCancel(accountId: string, commandId: string, orderId: string): Promise<WorkStepRow> {
    if (!this.work.step(commandId)) await this.book(accountId, this.context.now(), 'person');
    const step = this.queueCancel(accountId, commandId, orderId);
    this.schedule(accountId);
    return step;
  }

  queueEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms): WorkStepRow {
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
      if (!Number.isSafeInteger(terms.maxPriceCents) || terms.maxPriceCents < BUY_ORDER_MIN_PRICE_CENTS) throw new Error('CSFloat takes no buy-order price under $0.03 each');
      if (!Number.isSafeInteger(terms.quantity) || terms.quantity < 1) throw new Error('CSFloat buy-order quantity must be at least 1');
      const observed = preservableConstraints(propertiesOf(row));
      if (observed === null) throw new Error('This buy order carries constraints this app cannot preserve through an edit; change it on CSFloat instead');
      const constraints = terms.constraints === undefined ? observed : validateBuyOrderConstraints(terms.constraints);
      if (terms.maxPriceCents === row.price_cents && terms.quantity === row.quantity && sameBuyOrderConstraints(constraints, observed)) {
        throw new Error('The buy order already has these terms');
      }
      return this.insert({ id: commandId, accountId, orderId, kind: BUY_ORDER_EDIT, row, terms, constraints });
    });
  }

  queueCancel(accountId: string, commandId: string, orderId: string): WorkStepRow {
    return this.context.database.transaction(() => {
      const existing = this.work.step(commandId);
      if (existing) {
        if (existing.account_id !== accountId || existing.target_id !== orderId || existing.kind !== BUY_ORDER_CANCEL) throw new Error('Command id was already used for different terms');
        return existing;
      }
      const row = this.validateOpen(accountId, orderId);
      this.refuseSecondOperation(accountId, orderId);
      return this.insert({ id: commandId, accountId, orderId, kind: BUY_ORDER_CANCEL, row, constraints: null });
    });
  }

  protected validateOpen(accountId: string, orderId: string): CsfloatBuyOrderRow {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(accountId, 'csfloat');
    if (connection?.status !== 'CONNECTED' || !connection.credential_ref) throw new Error('Connect CSFloat first');
    const row = this.store.buyOrder(accountId, orderId);
    const observation = row ? db.observation(accountId, row.last_seen_obs) : undefined;
    const age = observation ? Date.parse(now) - Date.parse(observation.started_at) : NaN;
    if (!row || !observation?.complete || observation.error || observation.generation !== connection.generation || !(age >= 0 && age <= BUY_ORDER_BOOK_WINDOW_MS)) {
      throw new Error('Refresh CSFloat buy orders first');
    }
    return row;
  }

  private paramsOf(step: WorkStepRow): BuyOrderStepParams {
    return this.work.params<BuyOrderStepParams>(step);
  }

  private refuseSecondOperation(accountId: string, orderId: string): void {
    const open = BUY_ORDER_OPERATION_KINDS.flatMap((kind) => this.work.openForTarget(accountId, kind, orderId));
    if (open.length) throw new Error('This buy order already has a change on its way; a CSFloat read has to settle it first');
  }

  private insert(input: { id: string; accountId: string; orderId: string; kind: typeof BUY_ORDER_EDIT | typeof BUY_ORDER_CANCEL; row: CsfloatBuyOrderRow; terms?: CsfloatBuyOrderTerms; constraints: CsfloatBuyOrderConstraints | null }): WorkStepRow {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(input.accountId, 'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    const params: BuyOrderStepParams = {
      operationId: input.id, orderId: input.orderId, maxPriceCents: input.terms?.maxPriceCents ?? null, quantity: input.terms?.quantity ?? null,
      constraints: input.constraints, propertiesJson: input.row.properties_json, hashName: input.row.hash_name,
      generation: connection.generation, policyVersion: this.store.policy().version
    };
    // The command id the window chose is the command, the step and the operation: one id, one hop.
    this.work.adoptCommand(input.id, input.kind, now);
    const step = this.work.insert({ id: input.id, commandId: input.id, accountId: input.accountId, ordinal: 0, kind: input.kind, targetId: input.orderId, params, now });
    const action = db.enqueueAction({ accountId: input.accountId, stepId: step.id, actionKind: input.kind,
      targetId: `csfloat-buy-order:${input.orderId}`, resourceKey: `csfloat-buy-order:${input.orderId}`, params, now });
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
      // The book again, begun after the sends returned: the proof the reconciler judges (CSF-39, CSF-40).
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
      const orderId = step.target_id;
      const params = this.paramsOf(step);
      const connection = new MarketplaceStore(db).connection(step.account_id, 'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const validate = () => {
        const current = new MarketplaceStore(db).connection(step.account_id, 'csfloat');
        if (current?.generation !== params.generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the buy order');
        const row = this.validateOpen(step.account_id, orderId);
        if (step.kind === BUY_ORDER_EDIT && row.properties_json !== params.propertiesJson) {
          throw new Error('The buy order changed on CSFloat since it was reviewed; refresh and change it again');
        }
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      let outcome: MutationOutcome;
      try {
        outcome = await executeMutation(this.context, action, () => step.kind === BUY_ORDER_EDIT
          ? ports.buyOrders.update(step.account_id, connection.credential_ref!, orderId, this.editFor(params))
          : ports.buyOrders.remove(step.account_id, connection.credential_ref!, orderId), admit);
      } catch (error) {
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id, 'FAILED', this.context.now(), rejected.message);
          this.work.settle(step.id, 'FAILED', null, this.context.now(), rejected.message);
        });
        throw error;
      }
      this.work.setState(step.id, outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION', this.context.now(),
        outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
      return outcome;
    });
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
      const params = this.paramsOf(step);
      const obs = db.latestObservation(accountId, CSFLOAT_BUY_ORDER_SURFACE);
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

  protected showsConstraints(row: CsfloatBuyOrderRow, action: ActionRow): boolean {
    const sent = (this.context.database.actionParams(action) as BuyOrderStepParams).constraints;
    if (sent === null) return true;
    const shown = preservableConstraints(propertiesOf(row));
    return shown !== null && sameBuyOrderConstraints(shown, sent);
  }

  private settle(step: WorkStepRow, action: ActionRow, observationId: number): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      db.resolveAction(action, observationId, true, now);
      this.work.settle(step.id, 'DONE', observationId, now);
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
