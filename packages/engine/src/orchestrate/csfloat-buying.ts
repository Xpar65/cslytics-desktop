import type { CsfloatBuyOrderConstraints, CsfloatBuyOrderEdit, MutationOutcome } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { executeMutation } from '../kernel/context.js';
import { CsfloatStore, type CsfloatBuyOrderRow, type CsfloatOperation } from '../db/csfloat.js';
import { MarketplaceStore } from '../db/marketplace.js';
import type { ActionRow } from '../db/database.js';
import { postAttempt } from '../kernel/evidence.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { preservableConstraints, sameBuyOrderConstraints, validateBuyOrderConstraints } from '../kernel/csfloat-buy-orders.js';
import { CSFLOAT_BUY_ORDER_SURFACE, type CsfloatBuyOrderService } from '../surfaces/csfloat-buy-orders.js';
import type { Settling } from './settle.js';
import type { Observe } from './refresh.js';

export type CsfloatBuyingServices = {
  book: CsfloatBuyOrderService;
  /** Settles on the caller's stack when a decision follows the driver's own read. */
  settle: Settling;
  /** The governed read (`RefreshService.observe`): the budget, the breaker, then the settle. */
  observe: Observe;
};
/**
 * What an edit asks for. `constraints`, when given, is the order's whole new filter set — the edit
 * route replaces every constraint it is sent — and when absent the order's own, as last observed,
 * are carried through unchanged.
 */
export type CsfloatBuyOrderTerms = { maxPriceCents: number; quantity: number; constraints?: CsfloatBuyOrderConstraints | undefined };

export const BUY_ORDER_EDIT = 'BUY_ORDER_EDIT';
export const BUY_ORDER_CANCEL = 'BUY_ORDER_CANCEL';
/** The `csfloat_operation.kind`s this service owns; every other kind is the selling or delivery service's. */
export const BUY_ORDER_OPERATION_KINDS: readonly string[] = [BUY_ORDER_EDIT, BUY_ORDER_CANCEL];
/** How old the book an edit or cancel is judged against may be. */
export const BUY_ORDER_BOOK_WINDOW_MS = 300_000;
/** The action's error when a walk after the attempt shows the request did not take: the Steam cancel's word for it. */
export const BUY_ORDER_NOT_APPLIED = 'complete-observation-proved-not-applied';
/**
 * The least CSFloat takes for one item, USD cents: `minimum allowed price is $0.03 USD` (code 6),
 * captured on a listing reprice and the same floor for a buy order by the account holder's
 * account (2026-09-24). Refused here so a change the venue would refuse does not spend one of the
 * two edits a minute.
 */
export const BUY_ORDER_MIN_PRICE_CENTS = 3;

/** The action's frozen terms: what is sent, and the row the edit was reviewed against. */
type BuyOrderActionParams = {
  operationId: string;
  orderId: string;
  maxPriceCents: number | null;
  quantity: number | null;
  constraints: CsfloatBuyOrderConstraints | null;
  /** `properties_json` as observed at admission, so a send can tell the order changed meanwhile. */
  propertiesJson: string | null;
  /**
   * The order's market name at admission, so `work.open` can name the work after a settled cancel
   * has taken the order out of the book. Absent on an operation admitted before it was recorded.
   */
  hashName?: string;
};

/**
 * Edit or cancel one of the account's own CSFloat buy orders.
 *
 * The shape is `CsfloatSellingService`'s, deliberately: admission is one short transaction over
 * recorded evidence, the reply is the durable operation and not the send, `advance` sends what is
 * queued once each behind the reply and after a restart, and only a complete walk of the book
 * settles anything (rule 1, CSF-24, CSF-25). Three things are this service's own:
 *
 *  - **An edit carries the order through.** `PATCH /buy-orders/{id}` replaces every constraint it
 *    is sent and clears every one it is not, so a price change alone would strip a float range.
 *    Admission freezes the order's observed constraints beside the new terms, by allowlist, and an
 *    order whose constraints this app cannot express is refused before any call rather than sent
 *    without them (CSF-ORDER-02, CSF-ORDER-03). An edit may instead name a whole new filter set,
 *    as the site's own edit dialog does; it is checked and frozen the same way, and it is proved
 *    only by a walk showing those filters as well as the new price and quantity (CSF-41).
 *  - **The send is judged against the order as reviewed.** If the book read before the send shows
 *    the order's constraints changed since admission, the edit is refused: sending the frozen
 *    constraints would overwrite what someone set on the website meanwhile.
 *  - **Absence proves a cancel; presence with the new terms proves an edit.** A cancel accepted by
 *    the venue keeps its order in the book until a later complete walk no longer shows it, and a
 *    walk begun after the attempt that still shows it ends the cancel `FAILED`, never re-sent —
 *    the Steam buy-order rule (N-BUY-08, N-BUY-09), in a second venue.
 */
export class CsfloatBuyingService {
  protected readonly store: CsfloatStore;
  /** One `advance` per account at a time; a second asked for meanwhile waits and re-reads. */
  private readonly advancing = new AccountLock();
  private readonly scheduled = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(protected readonly context: EngineContext, protected readonly services: CsfloatBuyingServices) {
    this.store = new CsfloatStore(context.database);
  }

  /** The book read again, and every operation judged against it. Never sends. */
  async refresh(accountId: string): Promise<void> {
    await this.services.observe(accountId, { surface: 'csfloat-buy-orders', scope: { kind: 'account' } });
    this.services.settle.settleNow(accountId);
  }

  /**
   * An edit, admitted against the book as it stands now. The book is read again first unless this
   * command id was already admitted, then the operation is queued and sent behind the reply.
   */
  async submitEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms): Promise<CsfloatOperation> {
    if (!this.store.operation(commandId)) await this.services.observe(accountId, { surface: 'csfloat-buy-orders', scope: { kind: 'account' } });
    const op = this.queueEdit(accountId, commandId, orderId, terms);
    this.schedule(accountId);
    return op;
  }

  async submitCancel(accountId: string, commandId: string, orderId: string): Promise<CsfloatOperation> {
    if (!this.store.operation(commandId)) await this.services.observe(accountId, { surface: 'csfloat-buy-orders', scope: { kind: 'account' } });
    const op = this.queueCancel(accountId, commandId, orderId);
    this.schedule(accountId);
    return op;
  }

  queueEdit(accountId: string, commandId: string, orderId: string, terms: CsfloatBuyOrderTerms): CsfloatOperation {
    return this.context.database.transaction(() => {
      const existing = this.store.operation(commandId);
      if (existing) {
        const sent = existing.action_id ? this.paramsOf(existing.action_id)?.constraints ?? null : null;
        if (existing.account_id !== accountId || existing.order_id !== orderId || existing.kind !== BUY_ORDER_EDIT
          || existing.price_cents !== terms.maxPriceCents || existing.quantity !== terms.quantity
          || (terms.constraints !== undefined && (sent === null || !sameBuyOrderConstraints(sent, terms.constraints)))) throw new Error('Command id was already used for different terms');
        return existing;
      }
      const row = this.validateOpen(accountId, orderId);
      this.refuseSecondOperation(accountId, orderId);
      if (!Number.isSafeInteger(terms.maxPriceCents) || terms.maxPriceCents < BUY_ORDER_MIN_PRICE_CENTS) throw new Error('CSFloat takes no buy-order price under $0.03 each');
      if (!Number.isSafeInteger(terms.quantity) || terms.quantity < 1) throw new Error('CSFloat buy-order quantity must be at least 1');
      // Checked even when new filters are named: an order carrying a filter this app cannot read
      // has one the new set would silently clear, and that is the venue's site's to change.
      const observed = preservableConstraints(propertiesOf(row));
      if (observed === null) throw new Error('This buy order carries constraints this app cannot preserve through an edit; change it on CSFloat instead');
      const constraints = terms.constraints === undefined ? observed : validateBuyOrderConstraints(terms.constraints);
      if (terms.maxPriceCents === row.price_cents && terms.quantity === row.quantity && sameBuyOrderConstraints(constraints, observed)) {
        throw new Error('The buy order already has these terms');
      }
      return this.insert({ id: commandId, accountId, orderId, kind: BUY_ORDER_EDIT, row, terms, constraints });
    });
  }

  queueCancel(accountId: string, commandId: string, orderId: string): CsfloatOperation {
    return this.context.database.transaction(() => {
      const existing = this.store.operation(commandId);
      if (existing) {
        if (existing.account_id !== accountId || existing.order_id !== orderId || existing.kind !== BUY_ORDER_CANCEL) throw new Error('Command id was already used for different terms');
        return existing;
      }
      const row = this.validateOpen(accountId, orderId);
      this.refuseSecondOperation(accountId, orderId);
      return this.insert({ id: commandId, accountId, orderId, kind: BUY_ORDER_CANCEL, row, constraints: null });
    });
  }

  /**
   * The order, in a complete book of this connection's generation read inside the window.
   *
   * Age refuses rather than trusts: `submitEdit` and `advance` read the book again before they
   * get here, so what reaches this check on age alone is a queue that outlived its evidence.
   */
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

  private paramsOf(actionId: string): BuyOrderActionParams | null {
    const action = this.context.database.action(actionId);
    return action ? this.context.database.actionParams(action) as BuyOrderActionParams : null;
  }

  private refuseSecondOperation(accountId: string, orderId: string): void {
    const open = this.context.database.raw().prepare(`SELECT id FROM csfloat_operation WHERE account_id=? AND order_id=? AND state IN ('QUEUED','AWAITING_OBSERVATION')`).get(accountId, orderId);
    if (open) throw new Error('This buy order already has a change on its way; a CSFloat read has to settle it first');
  }

  private insert(input: { id: string; accountId: string; orderId: string; kind: string; row: CsfloatBuyOrderRow; terms?: CsfloatBuyOrderTerms; constraints: CsfloatBuyOrderConstraints | null }): CsfloatOperation {
    const db = this.context.database, now = this.context.now();
    const connection = new MarketplaceStore(db).connection(input.accountId, 'csfloat');
    if (!connection?.credential_ref) throw new Error('Connect CSFloat first');
    const maxPriceCents = input.terms?.maxPriceCents ?? null, quantity = input.terms?.quantity ?? null;
    // One goal per operation, as a listing operation has, so an edit and a later cancel of the
    // same order never supersede each other: the second is refused at admission while the first
    // is open, and each settles on its own evidence.
    const goal = db.upsertDesired({ accountId: input.accountId, targetKind: 'csfloat-buy-order-operation', targetId: input.id,
      intent: input.kind, params: { venue: 'csfloat', orderId: input.orderId, maxPriceCents, quantity }, basis: 'manual', now });
    const params: BuyOrderActionParams = { operationId: input.id, orderId: input.orderId, maxPriceCents, quantity,
      constraints: input.constraints, propertiesJson: input.row.properties_json, hashName: input.row.hash_name };
    const action = db.enqueueAction({ accountId: input.accountId, desiredId: goal.id, desiredVersion: goal.version,
      actionKind: `CSFLOAT_${input.kind}`, targetId: `csfloat-buy-order:${input.orderId}`,
      resourceKey: `csfloat-buy-order:${input.orderId}`, params, now });
    db.raw().prepare(`INSERT INTO csfloat_operation(id,command_id,account_id,kind,local_id,asset_id,listing_id,price_cents,generation,policy_version,state,action_id,created_at,updated_at,order_id,quantity)
      VALUES (?,?,?,?,NULL,NULL,NULL,?,?,?,'QUEUED',?,?,?,?,?)`).run(input.id, input.id, input.accountId, input.kind, maxPriceCents,
      connection.generation, this.store.policy().version, action.id, now, now, input.orderId, quantity);
    return this.store.operation(input.id)!;
  }

  /** Send what is queued, soon, outside whichever transaction or call stack asked (rule 6). */
  schedule(accountId: string): void {
    if (this.stopped || this.scheduled.has(accountId)) return;
    this.scheduled.add(accountId);
    setImmediate(() => {
      this.scheduled.delete(accountId);
      if (this.stopped) return;
      void this.advance(accountId).catch(() => undefined);
    });
  }

  /**
   * Every buy-order operation of this account that was admitted and never sent, sent once each.
   *
   * Resumes by identity, never by retry: `QUEUED` with a `READY` action has never been attempted,
   * so sending is safe; anything past that is settled by observation alone (CSF-17, CSF-25). The
   * book is read again first when its window has lapsed — a queue that outlived a restart is
   * judged on a fresh read, not refused on age — and once more after the sends, so a cancel can be
   * proved absent and an edit present with its terms.
   */
  async advance(accountId: string): Promise<void> {
    const work = this.advancing.run(accountId, async () => {
      const db = this.context.database;
      if (!new MarketplaceStore(db).connection(accountId, 'csfloat')?.credential_ref || !this.context.ports.csfloat) return;
      const queued = db.raw().prepare(`SELECT o.id AS id FROM csfloat_operation o JOIN action a ON a.id=o.action_id
        WHERE o.account_id=? AND o.state='QUEUED' AND a.state='READY' AND o.kind IN ('${BUY_ORDER_EDIT}','${BUY_ORDER_CANCEL}') ORDER BY o.id`).all(accountId) as Array<{ id: string }>;
      if (!queued.length) return;
      if (!this.store.fresh(accountId, CSFLOAT_BUY_ORDER_SURFACE, this.context.now(), BUY_ORDER_BOOK_WINDOW_MS)) {
        await this.services.observe(accountId, { surface: 'csfloat-buy-orders', scope: { kind: 'account' } });
      }
      let sent = false;
      for (const { id } of queued) {
        if (this.stopped) return;
        try {
          if (await this.execute(id)) sent = true;
        } catch (error) {
          if (this.stopped) return;
          // A refusal at admission is already on the operation; a second copy would be noise.
          if (this.store.operation(id)?.state === 'FAILED') continue;
          try { db.addEvent(accountId, 'csfloat-dispatch-error', { operationId: id, message: errorMessage(error) }, this.context.now()); } catch { /* closed under us */ }
        }
      }
      if (sent && !this.stopped) await this.services.observe(accountId, { surface: 'csfloat-buy-orders', scope: { kind: 'account' } });
    });
    this.running.set(accountId, work);
    try { await work; } finally { if (this.running.get(accountId) === work) this.running.delete(accountId); }
  }

  /** Every send this command asked for, as something a scenario can wait for. */
  async settled(commandId: string): Promise<void> {
    const accounts = (this.context.database.raw().prepare('SELECT DISTINCT account_id FROM csfloat_operation WHERE command_id=?').all(commandId) as Array<{ account_id: string }>)
      .map((row) => row.account_id);
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

  async execute(id: string): Promise<MutationOutcome | null> {
    const initial = this.store.operation(id);
    if (!initial) throw new Error('Unknown CSFloat operation');
    return this.context.locks.run(initial.account_id, async () => {
      const op = this.store.operation(id)!, db = this.context.database, action = op.action_id ? db.action(op.action_id) : undefined;
      if (!action || action.state !== 'READY' || op.state !== 'QUEUED' || !op.order_id) return null;
      const connection = new MarketplaceStore(db).connection(op.account_id, 'csfloat'), ports = this.context.ports.csfloat;
      if (!connection?.credential_ref || !ports) throw new Error('Connect CSFloat first');
      const params = db.actionParams(action) as BuyOrderActionParams;
      const validate = () => {
        const current = new MarketplaceStore(db).connection(op.account_id, 'csfloat');
        if (current?.generation !== op.generation || current.status !== 'CONNECTED') throw new Error('Connection changed; review the buy order');
        const row = this.validateOpen(op.account_id, op.order_id!);
        if (op.kind === BUY_ORDER_EDIT && row.properties_json !== params.propertiesJson) {
          throw new Error('The buy order changed on CSFloat since it was reviewed; refresh and change it again');
        }
      };
      const admission = { rejected: null as Error | null };
      const admit = () => { try { validate(); } catch (error) { admission.rejected = error instanceof Error ? error : new Error(String(error)); throw admission.rejected; } };
      let outcome: MutationOutcome;
      try {
        outcome = await executeMutation(this.context, action, () => op.kind === BUY_ORDER_EDIT
          ? ports.buyOrders.update(op.account_id, connection.credential_ref!, op.order_id!, this.editFor(params))
          : ports.buyOrders.remove(op.account_id, connection.credential_ref!, op.order_id!), admit);
      } catch (error) {
        // Admission refused before any call: the command is over, durably. Nothing re-queues it.
        const rejected = admission.rejected;
        if (rejected && error === rejected) db.transaction(() => {
          db.setActionState(action.id, 'FAILED', this.context.now(), rejected.message);
          this.store.update(op.id, 'FAILED', this.context.now(), rejected.message);
        });
        throw error;
      }
      this.store.update(op.id, outcome.kind === 'DEFINITIVELY_REJECTED' ? 'FAILED' : 'AWAITING_OBSERVATION', this.context.now(),
        outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : null);
      return outcome;
    });
  }

  /** The edit as sent: the new terms beside the constraints frozen at admission. Isolated so a saboteur can drop them. */
  protected editFor(params: BuyOrderActionParams): CsfloatBuyOrderEdit {
    if (params.maxPriceCents === null || params.quantity === null || params.constraints === null) throw new Error('Edit terms are missing; review the buy order');
    return { maxPriceCents: params.maxPriceCents, quantity: params.quantity, constraints: params.constraints };
  }

  /** Called after every complete book walk and on restart. It never sends, even when absence is proven. */
  reconcile(accountId: string): void {
    const db = this.context.database;
    for (const op of this.store.operations(accountId)) {
      if (!BUY_ORDER_OPERATION_KINDS.includes(op.kind)) continue;
      if (!['QUEUED', 'AWAITING_OBSERVATION'].includes(op.state) || !op.action_id || !op.order_id) continue;
      const action = db.action(op.action_id);
      if (!action || !['RUNNING', 'AWAITING_OBSERVATION'].includes(action.state)) continue;
      if (op.state !== 'AWAITING_OBSERVATION') this.store.update(op.id, 'AWAITING_OBSERVATION', this.context.now());
      const obs = db.latestObservation(accountId, CSFLOAT_BUY_ORDER_SURFACE);
      if (!obs?.complete || obs.error || obs.generation !== op.generation) continue;
      // A complete walk deletes every row it did not see, so presence is "seen by this walk".
      const row = this.store.buyOrder(accountId, op.order_id);
      const present = row !== undefined && row.last_seen_obs === obs.id;
      if (op.kind === BUY_ORDER_CANCEL) {
        if (!present) {
          // Absent from a walk begun after the attempt began is enough: an order does not come
          // back, so the book no longer holding it is what the cancel was for, whether the
          // removal or a fill emptied it. That also settles an attempt the process died inside,
          // which has no end to count from.
          if (postAttempt(db, action, obs, false)) this.settle(op, action, obs.id);
          continue;
        }
        // Present is a claim about the book after the attempt, so the walk must have begun after
        // it ended: one begun during the call could have read the book before the removal landed.
        if (postAttempt(db, action, obs, true)) this.fail(op, action, BUY_ORDER_NOT_APPLIED, 'A CSFloat read after the cancel still showed the order open, so nothing was cancelled');
        continue;
      }
      if (present && row.price_cents === op.price_cents && row.quantity === op.quantity && this.showsConstraints(row, action)) {
        // The venue's own row wearing the new terms is proof whenever the walk began, so long as
        // it was not before the attempt. The filters are terms too: a change of filters alone
        // leaves the price and quantity as they were, and the old row would otherwise prove it.
        if (postAttempt(db, action, obs, false)) this.settle(op, action, obs.id);
        continue;
      }
      if (!postAttempt(db, action, obs, true)) continue;
      if (!present) this.fail(op, action, 'order-gone', 'The order left the CSFloat book before the change was seen: it may have filled or been cancelled');
      else this.fail(op, action, BUY_ORDER_NOT_APPLIED, 'A CSFloat read after the change still showed the old terms, so nothing was changed');
    }
  }

  /**
   * Whether the walked row carries the filters the edit sent. Isolated so a saboteur can judge an
   * edit by its price and quantity alone.
   */
  protected showsConstraints(row: CsfloatBuyOrderRow, action: ActionRow): boolean {
    const sent = (this.context.database.actionParams(action) as BuyOrderActionParams).constraints;
    if (sent === null) return true;
    const shown = preservableConstraints(propertiesOf(row));
    return shown !== null && sameBuyOrderConstraints(shown, sent);
  }

  private settle(op: CsfloatOperation, action: ActionRow, observationId: number): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      db.resolveAction(action, observationId, true, now);
      this.store.update(op.id, 'DONE', now);
    });
  }

  private fail(op: CsfloatOperation, action: ActionRow, actionError: string, reason: string): void {
    const db = this.context.database, now = this.context.now();
    db.transaction(() => {
      db.setActionState(action.id, 'FAILED', now, actionError);
      this.store.update(op.id, 'FAILED', now, reason);
    });
  }
}

function propertiesOf(row: CsfloatBuyOrderRow): Record<string, unknown> | null {
  return row.properties_json === null ? null : JSON.parse(row.properties_json) as Record<string, unknown>;
}
