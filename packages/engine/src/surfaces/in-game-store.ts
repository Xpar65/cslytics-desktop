import type { AccountId, MutationOutcome, StoreApprovalOutcome, StorePurchaseFinalizeRaw, StorePurchaseInitRaw } from '@cslytics/ports';
import type { ActionRow, ObservationRow } from '../db/database.js';
import {
  InGameStoreStore, STORE_PURCHASE, parseItemIds, storeHopId,
  type StoreHop, type StorePurchaseLineRow, type StorePurchaseParams, type StorePurchaseRow, type StorePurchaseState
} from '../db/in-game-store.js';
import { WorkStore, isSettled, type WorkStepRow } from '../db/work.js';
import { executeMutation, type EngineContext } from '../kernel/context.js';
import { postAttempt, surfaceEvidence, type SurfaceRef } from '../kernel/evidence.js';
import { errorMessage } from '../kernel/support.js';
import { requireFreshMoneyEvidence, walletAvailability } from '../policy/wallet-admission.js';
import { LedgerStore } from '../db/ledger.js';

/**
 * The CS2 in-game store as a vertical slice: the price sheet observation, one purchase's
 * admission and its GC hops, and the reconciliation that lets inventory and wallet evidence —
 * never a response — decide what happened.
 *
 * A purchase is a command with a hop per GC step (consolidation plan D2): the init, the person's
 * approval at the checkout, the finalize, and a cancel when asked for. Its lines sit beside the
 * init hop (`store_line`), its wallet reservation is taken at admission under the command's id,
 * and each hop's action goes through `executeMutation` like every other mutation in the engine,
 * so the crash matrix treats it like one. Where the purchase is, in its own words, is read from
 * the hops (`InGameStoreStore.purchase`). Rationale and evidence:
 * `cslytics-app-docs/steam/in-game-store.md`.
 */

export const STORE_SHEET_SURFACE = 'gc-store-price-sheet' as const;
export const ACCOUNT_STORE_SHEET: SurfaceRef = { surface: STORE_SHEET_SURFACE, scope: { kind: 'account' } };

/** How long one purchase waits for the person at the checkout before it stops waiting and says so. */
export const STORE_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const STORE_LINES_MAX = 50;
export const STORE_LINE_QUANTITY_MAX = 100;
/** Language 0 is English; the store answers with names the host ignores. */
export const STORE_LANGUAGE = 0;

/**
 * Decision C of the in-game store plan: the amount a completed purchase posts is `EVIDENCED`,
 * because the GC verifies `cost_in_local_currency` against its own sheet at init and refuses a
 * mismatch, so a finalised purchase was charged exactly the accepted cost. The Oracle models
 * that refusal; the purchase probe is what confirms it on live Steam before this posts real
 * money as evidenced.
 */
export const STORE_AMOUNT_BASIS = 'EVIDENCED';

/**
 * Steam `ECurrencyCode` → the label the sheet keys its prices by. The labels are the ones a live
 * sheet carried (captured 2026-09-13); the codes are Steam's enum, in which 33 is unused, 34 is ARS
 * and 36 is BYN (`../cs2-knowledge/concepts/steam-wallet-currencies.md`).
 */
export const STORE_CURRENCY_LABEL: Readonly<Record<number, string>> = {
  1: 'USD', 2: 'GBP', 3: 'EUR', 4: 'CHF', 5: 'RUB', 6: 'PLN', 7: 'BRL', 8: 'JPY', 9: 'NOK', 10: 'IDR',
  11: 'MYR', 12: 'PHP', 13: 'SGD', 14: 'THB', 15: 'VND', 16: 'KRW', 17: 'TRY', 18: 'UAH', 19: 'MXN', 20: 'CAD',
  21: 'AUD', 22: 'NZD', 23: 'CNY', 24: 'INR', 25: 'CLP', 26: 'PEN', 27: 'COP', 28: 'ZAR', 29: 'HKD', 30: 'TWD',
  31: 'SAR', 32: 'AED', 35: 'ILS', 37: 'KZT', 38: 'KWD', 39: 'QAR', 40: 'CRC', 41: 'UYU'
};

export type StorePurchaseLineRequest = { entryKey: string; defIndex: number; quantity: number; unitPriceCents: number };
export type StorePurchaseRequest = { commandId: string; accountId: AccountId; lines: StorePurchaseLineRequest[] };

/** The action kind each hop sends, and the hop's place in the chain. */
const HOP_ACTION: Record<StoreHop, string> = {
  STORE_INIT: 'STORE_PURCHASE_INIT', STORE_APPROVE: 'STORE_PURCHASE_APPROVE', STORE_FINALIZE: 'STORE_PURCHASE_FINALIZE', STORE_CANCEL: 'STORE_PURCHASE_CANCEL'
};
const HOP_ORDINAL: Record<StoreHop, number> = { STORE_INIT: 0, STORE_APPROVE: 1, STORE_FINALIZE: 2, STORE_CANCEL: 3 };

const INIT_UNANSWERED = 'Steam did not answer the purchase request. The reserved funds stay reserved until later inventory and wallet observations explain it';
const FINALIZE_UNANSWERED = 'Steam did not answer the finalize. Waiting for inventory and wallet evidence; the reserved funds stay reserved';

export class InGameStoreService {
  protected readonly store: InGameStoreStore;
  protected readonly work: WorkStore;
  private readonly advancing = new Set<string>();

  constructor(protected readonly context: EngineContext) {
    this.store = new InGameStoreStore(context.database);
    this.work = this.store.work;
  }

  // ---------------------------------------------------------------- the price sheet

  async syncPriceSheet(accountId: AccountId): Promise<number> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const known = this.store.sheet(accountId);
    try {
      const read = await this.context.ports.inGameStore.getPriceSheet(accountId, known?.parse_state === 'PARSED' ? known.version : undefined);
      const label = STORE_CURRENCY_LABEL[read.currency];
      const observationId = database.transaction(() => {
        const observationId = database.insertObservation({
          accountId, surface: STORE_SHEET_SURFACE, startedAt, finishedAt: this.context.now(), complete: true,
          totalExpected: read.kind === 'sheet' ? read.sheet.entries.length : known?.entry_count ?? 0
        });
        if (read.kind === 'not-modified') {
          database.raw().prepare('UPDATE store_price_sheet SET observation_id=?, observed_at=? WHERE account_id=?').run(observationId, read.observedAt, accountId);
          return observationId;
        }
        if (!label) {
          // A wallet currency the sheet cannot be read in is a sheet this account cannot buy from.
          this.store.markUnparseable(accountId, observationId, read.observedAt);
          return observationId;
        }
        this.store.publishSheet(accountId, {
          observationId,
          version: read.sheet.version,
          currency: read.currency,
          currencyLabel: label,
          observedAt: read.observedAt,
          entries: read.sheet.entries
            .filter((entry) => typeof entry.prices[label] === 'number')
            .map((entry) => ({
              key: entry.key,
              categoryTags: entry.categoryTags,
              priceCents: entry.prices[label]!,
              salePriceCents: entry.salePrices?.[label] ?? null
            }))
        });
        return observationId;
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: STORE_SHEET_SURFACE, complete: true, observationId });
      return observationId;
    } catch (error) {
      const observationId = database.insertObservation({
        accountId, surface: STORE_SHEET_SURFACE, startedAt, finishedAt: this.context.now(), complete: false, error: errorMessage(error)
      });
      // An unparseable sheet is recorded as such and the previous entries stay visible; a
      // transport failure changes nothing about what was last parsed (STORE-01, STORE-14).
      if ((error as { name?: unknown } | null)?.name === 'StoreSheetError') this.store.markUnparseable(accountId, observationId, this.context.now());
      this.context.signals.emit({ kind: 'observed', accountId, surface: STORE_SHEET_SURFACE, complete: false, observationId });
      throw error;
    }
  }

  // ---------------------------------------------------------------- admission

  /**
   * Admits one purchase and takes its wallet reservation. Idempotent by command id: the same
   * click, retried, finds its row; the same id with different terms is refused (STORE-03). The
   * command's id is the purchase's.
   */
  queue(request: StorePurchaseRequest): StorePurchaseRow {
    const { database } = this.context;
    const now = this.context.now();
    return database.transaction(() => {
      const found = this.store.purchase(request.commandId);
      if (found) {
        const lines = this.store.lines(found.id);
        const same = found.account_id === request.accountId && lines.length === request.lines.length
          && request.lines.every((line, index) => {
            const frozen = lines[index]!;
            return frozen.entry_key === line.entryKey && frozen.def_index === line.defIndex && frozen.quantity === line.quantity && frozen.unit_price_cents === line.unitPriceCents;
          });
        if (!same) throw new Error('Command id was already used for different terms');
        return found;
      }
      if (database.command(request.commandId)) throw new Error('Command id was already used for different terms');
      if (!database.account(request.accountId)) throw new Error(`Unknown account ${request.accountId}`);
      const { sheet, total } = this.validateLines(request);
      requireFreshMoneyEvidence(this.context, request.accountId, 'Store purchase admission');
      const available = this.availableCents(request.accountId, sheet.currency);
      if (available < total) throw new Error(`Insufficient unreserved wallet balance: ${available}`);
      const gc = this.context.ports.gc.connectionStatus(request.accountId);
      if (gc.state !== 'CONNECTED') throw new Error(gc.detail ?? 'The CS2 Game Coordinator is not connected for this account');

      const id = request.commandId;
      const params: StorePurchaseParams = { purchaseId: id, currency: sheet.currency, requestedTotalCents: total, sheetVersion: sheet.version,
        hashName: request.lines.map((line) => line.quantity > 1 ? `${line.entryKey} × ${line.quantity}` : line.entryKey).join(', ') };
      this.work.adoptCommand(id, STORE_PURCHASE, now);
      const init = this.work.insert({ id: storeHopId(id, 'STORE_INIT'), commandId: id, accountId: request.accountId, ordinal: HOP_ORDINAL.STORE_INIT, kind: 'STORE_INIT', params, now });
      request.lines.forEach((line, index) => this.work.insertStoreLine({
        step_id: init.id, account_id: request.accountId, line_index: index, entry_key: line.entryKey, def_index: line.defIndex,
        quantity: line.quantity, unit_price_cents: line.unitPriceCents,
        baseline_quantity: this.store.mainQuantityOfDef(request.accountId, line.defIndex), observed_quantity: 0
      }));
      database.raw().prepare(`INSERT INTO reservation(account_id, ref_kind, ref_id, amount_cents, state) VALUES (?, 'STORE_PURCHASE', ?, ?, 'ACTIVE')`)
        .run(request.accountId, id, total);
      database.addEvent(request.accountId, 'store-purchase-admitted', { purchaseId: id, commandId: request.commandId, totalCents: total, currency: sheet.currency }, now);
      return this.store.purchase(id)!;
    });
  }

  /** What this wallet can still commit, in its own currency: balance less our reservations and others' orders. */
  protected availableCents(accountId: AccountId, currency: number): number {
    return walletAvailability(this.context.database, accountId, currency).availableCents;
  }

  /**
   * The terms a purchase freezes must be the terms the last parsed sheet shows, and that sheet
   * must be a fresh complete observation for *this* account. A remembered price, another
   * account's price, or an unparseable sheet admits nothing (STORE-01, STORE-02).
   */
  protected validateLines(request: StorePurchaseRequest): { sheet: { currency: number; version: number }; total: number } {
    if (!request.lines.length || request.lines.length > STORE_LINES_MAX) throw new Error(`Select between 1 and ${STORE_LINES_MAX} store entries`);
    const sheet = this.store.sheet(request.accountId);
    if (!sheet || sheet.parse_state !== 'PARSED') throw new Error('Refresh the store price sheet first');
    const evidence = surfaceEvidence(this.context.database, request.accountId, ACCOUNT_STORE_SHEET, this.context.ports.clock.now());
    if (evidence.grade !== 'SATISFIED') {
      throw new Error(`Store purchase admission requires a fresh complete price sheet (${evidence.grade === 'UNKNOWN' ? evidence.freshness : evidence.reason})`);
    }
    let total = 0;
    const seen = new Set<string>();
    for (const line of request.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > STORE_LINE_QUANTITY_MAX) throw new Error(`Quantity for ${line.entryKey} must be 1 to ${STORE_LINE_QUANTITY_MAX}`);
      if (!Number.isInteger(line.defIndex) || line.defIndex < 0) throw new Error(`No def index is known for store entry ${line.entryKey}`);
      if (seen.has(line.entryKey)) throw new Error(`Store entry ${line.entryKey} appears twice`);
      seen.add(line.entryKey);
      const entry = this.store.entry(request.accountId, line.entryKey);
      if (!entry) throw new Error(`Store entry ${line.entryKey} is not on this account's price sheet`);
      const current = entry.sale_price_cents ?? entry.price_cents;
      if (line.unitPriceCents !== current) throw new Error(`Store price for ${line.entryKey} is ${current}, not ${line.unitPriceCents}; refresh the sheet`);
      total += current * line.quantity;
    }
    return { sheet: { currency: sheet.currency, version: sheet.version }, total };
  }

  // ---------------------------------------------------------------- the hops

  /**
   * Drives one purchase as far as it can go right now: init under the account lock, the
   * approval wait *outside* it (a person at a checkout must not block every other operation on
   * the account for ten minutes), then finalize under the lock again. Anything thrown lands on
   * the hop it stopped at rather than on the caller: the hops are the record.
   */
  async advance(id: string): Promise<void> {
    if (this.advancing.has(id)) return;
    this.advancing.add(id);
    try {
      let proceed = await this.context.locks.run(this.accountOf(id), () => this.initStep(id));
      // Every step that asks to continue must have moved the purchase on. A step that returns
      // true and leaves the state alone would spin this loop on microtasks alone, starving
      // timers and the rest of the process; that is a bug, and it stops here as one.
      let previous: StorePurchaseState | null = null;
      while (proceed) {
        const current = this.store.purchase(id);
        if (!current) return;
        if (current.state === previous) throw new Error(`Store purchase step made no progress from ${current.state}`);
        previous = current.state;
        if (current.state === 'AWAITING_APPROVAL') proceed = await this.approvalStep(current);
        else if (current.state === 'FINALISING') proceed = await this.context.locks.run(current.account_id, () => this.finalizeStep(id));
        else if (current.state === 'CANCELLING' && !current.cancel_action_id) proceed = await this.context.locks.run(current.account_id, () => this.cancelStep(id));
        else proceed = false;
      }
    } catch (error) {
      this.unresolved(id, errorMessage(error));
    } finally {
      this.advancing.delete(id);
    }
  }

  /** The purchase cannot go on by itself: the hop it stopped at fails with the reason, for the person to cancel or continue. */
  private unresolved(id: string, reason: string): void {
    const open = [...this.hops(id)].reverse().find((hop) => !isSettled(hop));
    if (open) this.work.failHop(open, reason, this.context.now());
  }

  /** The user's cancel: the recorded transaction, or nothing at all when nothing was sent. */
  async cancel(id: string): Promise<void> {
    await this.context.locks.run(this.accountOf(id), async () => {
      const purchase = this.store.purchase(id);
      if (!purchase) throw new Error('Unknown store purchase');
      if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(purchase.state)) throw new Error(`Purchase is already ${purchase.state.toLowerCase()}`);
      if (!purchase.txn_id) {
        if (purchase.state === 'ADMITTED') { this.reject(purchase, 'Cancelled before anything was sent to Steam'); return; }
        throw new Error('Steam has not named a transaction to cancel; wait for the next inventory and wallet observation');
      }
      this.hop(purchase, 'STORE_CANCEL');
      await this.cancelStep(id);
    });
  }

  private accountOf(id: string): string {
    const purchase = this.store.purchase(id);
    if (!purchase) throw new Error('Unknown store purchase');
    return purchase.account_id;
  }

  protected async initStep(id: string): Promise<boolean> {
    const purchase = this.store.purchase(id)!;
    if (purchase.state !== 'ADMITTED' && purchase.state !== 'INITIALISING') return purchase.state === 'AWAITING_APPROVAL' || purchase.state === 'FINALISING';
    const init = this.hop(purchase, 'STORE_INIT');
    const action = this.hopAction(purchase, init);
    if (action.state !== 'READY') {
      // A dead RUNNING init recovered as AWAITING_OBSERVATION: never re-sent (STORE-04, STORE-10).
      this.work.setState(init.id, 'AWAITING_OBSERVATION', this.context.now(), INIT_UNANSWERED);
      return false;
    }
    const lines = this.store.lines(id);
    const admission = { rejected: null as Error | null };
    const validate = (): void => {
      try {
        this.validateBeforeInit(purchase, lines);
      } catch (error) {
        admission.rejected = error instanceof Error ? error : new Error(String(error));
        throw admission.rejected;
      }
    };
    this.work.setState(init.id, 'SENT', this.context.now());
    let outcome: MutationOutcome;
    try {
      outcome = await executeMutation(this.context, action, () => this.context.ports.inGameStore.initPurchase(purchase.account_id, {
        currency: purchase.currency,
        language: STORE_LANGUAGE,
        lines: lines.map((line) => ({ itemDefId: line.def_index, quantity: line.quantity, costInLocalCurrencyCents: line.unit_price_cents * line.quantity }))
      }), validate);
    } catch (error) {
      if (admission.rejected && error === admission.rejected) {
        this.context.database.setActionState(action.id, 'FAILED', this.context.now(), admission.rejected.message);
        this.reject(purchase, admission.rejected.message);
      } else {
        this.work.failHop(init, errorMessage(error), this.context.now());
      }
      return false;
    }
    if (outcome.kind === 'SUBMITTED') {
      const raw = outcome.raw as StorePurchaseInitRaw;
      // The transaction Steam named is the init hop's object; the hop stays open until the
      // purchase is proved, because a response is an attempt and not a delivery.
      const now = this.context.now();
      this.context.database.transaction(() => {
        this.work.update(init.id, { state: 'AWAITING_OBSERVATION', target_id: String(raw.txnId), reason: null }, now);
        this.openHop(purchase, 'STORE_APPROVE', String(raw.txnId), 'AWAITING_OBSERVATION');
      });
      return true;
    }
    if (outcome.kind === 'DEFINITIVELY_REJECTED') {
      this.reject(purchase, `Steam refused the purchase (${outcome.reason})`);
      return false;
    }
    this.work.setState(init.id, 'AWAITING_OBSERVATION', this.context.now(), INIT_UNANSWERED);
    return false;
  }

  /** Re-checks, immediately before the send, everything admission checked (STORE-12, OP-02). */
  protected validateBeforeInit(purchase: StorePurchaseRow, lines: StorePurchaseLineRow[]): void {
    const gc = this.context.ports.gc.connectionStatus(purchase.account_id);
    if (gc.state !== 'CONNECTED') throw new Error(gc.detail ?? 'The CS2 Game Coordinator is not connected for this account');
    const sheet = this.store.sheet(purchase.account_id);
    if (!sheet || sheet.parse_state !== 'PARSED') throw new Error('Refresh the store price sheet first');
    for (const line of lines) {
      const entry = this.store.entry(purchase.account_id, line.entry_key);
      const current = entry ? entry.sale_price_cents ?? entry.price_cents : undefined;
      if (current !== line.unit_price_cents) throw new Error(`Store price for ${line.entry_key} changed; submit the purchase again`);
    }
    // This purchase's own reservation is already inside the reserved total; it must not count against itself.
    const available = this.availableCents(purchase.account_id, purchase.currency) + purchase.requested_total_cents;
    if (available < purchase.requested_total_cents) throw new Error(`Insufficient unreserved wallet balance: ${available}`);
  }

  /**
   * The person at the checkout. The approval hop has no action of its own: its outcome is what
   * the checkout port reports, and the hop records it. Approved is the hop done and the finalize
   * opened; declined or closed is the hop failed and a cancel opened; a timeout leaves the hop
   * queued with the reason, for the person to continue or cancel.
   */
  protected async approvalStep(purchase: StorePurchaseRow): Promise<boolean> {
    const approve = this.hop(purchase, 'STORE_APPROVE');
    let outcome: StoreApprovalOutcome;
    try {
      outcome = await this.context.ports.inGameStore.awaitApproval(purchase.account_id, purchase.txn_id!, STORE_APPROVAL_TIMEOUT_MS);
    } catch (error) {
      this.work.failHop(approve, errorMessage(error), this.context.now());
      return false;
    }
    const now = this.context.now();
    this.context.database.addEvent(purchase.account_id, 'store-checkout', { purchaseId: purchase.id, txnId: purchase.txn_id, outcome: outcome.kind }, now);
    switch (outcome.kind) {
      case 'approved':
        this.approved(purchase);
        return true;
      case 'timeout':
        this.work.update(approve.id, { state: 'QUEUED', reason: 'No approval within 10 minutes. Open the Store to continue the checkout, or cancel the purchase' }, now);
        return false;
      default:
        this.context.database.transaction(() => {
          this.work.failHop(approve, outcome.kind === 'declined' ? 'The checkout was declined' : 'The checkout was closed before approval', now);
          this.hop(purchase, 'STORE_CANCEL');
        });
        return true;
    }
  }

  /** The person approved: the approval hop is done, and the finalize is the next hop. */
  protected approved(purchase: StorePurchaseRow): void {
    const now = this.context.now();
    this.context.database.transaction(() => {
      const approve = this.hop(purchase, 'STORE_APPROVE');
      if (!isSettled(approve)) this.work.settle(approve.id, 'DONE', null, now);
      this.hop(purchase, 'STORE_FINALIZE');
    });
  }

  protected async finalizeStep(id: string): Promise<boolean> {
    const purchase = this.store.purchase(id)!;
    if (purchase.state !== 'FINALISING') return false;
    const finalize = this.hop(purchase, 'STORE_FINALIZE');
    const action = this.hopAction(purchase, finalize);
    if (action.state !== 'READY') {
      this.work.setState(finalize.id, 'AWAITING_OBSERVATION', this.context.now(), FINALIZE_UNANSWERED);
      return false;
    }
    this.work.setState(finalize.id, 'SENT', this.context.now());
    const outcome = await executeMutation(this.context, action, () => this.context.ports.inGameStore.finalizePurchase(purchase.account_id, purchase.txn_id!));
    const now = this.context.now();
    if (outcome.kind === 'SUBMITTED') {
      const raw = outcome.raw as StorePurchaseFinalizeRaw;
      this.work.update(finalize.id, { state: 'AWAITING_OBSERVATION', reason: null, params_json: JSON.stringify({ itemIds: (raw.itemIds ?? []).map(String) }) }, now);
      this.reconcile(purchase.account_id);
    } else if (outcome.kind === 'DEFINITIVELY_REJECTED') {
      this.work.failHop(finalize, `Steam refused to finalise (${outcome.reason}). The approved transaction may still be charged: cancel it, or refresh once the inventory and wallet have been observed`, now);
    } else {
      this.work.setState(finalize.id, 'AWAITING_OBSERVATION', now, FINALIZE_UNANSWERED);
    }
    return false;
  }

  protected async cancelStep(id: string): Promise<boolean> {
    const purchase = this.store.purchase(id)!;
    if (!purchase.txn_id) return false;
    const cancel = this.hop(purchase, 'STORE_CANCEL');
    const action = this.hopAction(purchase, cancel);
    if (action.state !== 'READY') return false;
    this.work.setState(cancel.id, 'SENT', this.context.now());
    const outcome = await executeMutation(this.context, action, () => this.context.ports.inGameStore.cancelPurchase(purchase.account_id, purchase.txn_id!));
    const now = this.context.now();
    if (outcome.kind === 'SUBMITTED') {
      this.work.setState(cancel.id, 'AWAITING_OBSERVATION', now, 'Cancel accepted; the reserved funds return once the wallet and inventory have been observed');
    } else if (outcome.kind === 'DEFINITIVELY_REJECTED') {
      // The GC refuses to cancel a finalised transaction: that refusal is the strongest hint
      // that money and items moved, and the inventory is what proves it. The cancel hop stops
      // there; the finalize or the init goes on waiting for that evidence.
      this.work.settle(cancel.id, 'STOPPED', null, now, `Steam refused the cancel (${outcome.reason}); waiting for inventory evidence of what was delivered`);
      const waiting = this.hop(purchase, 'STORE_FINALIZE', false) ?? this.hop(purchase, 'STORE_INIT');
      if (!isSettled(waiting)) this.work.setState(waiting.id, 'AWAITING_OBSERVATION', now, `Steam refused the cancel (${outcome.reason}); waiting for inventory evidence of what was delivered`);
    } else {
      this.work.setState(cancel.id, 'AWAITING_OBSERVATION', now, 'Steam did not answer the cancel; waiting for wallet and inventory evidence');
    }
    return false;
  }

  /** The purchase's hops, in order. */
  protected hops(id: string): WorkStepRow[] {
    return this.work.steps(id).filter((hop) => hop.command_id === id);
  }

  /** A hop of the purchase, opened in its place when the purchase first reaches it. */
  protected hop(purchase: StorePurchaseRow, kind: StoreHop): WorkStepRow;
  protected hop(purchase: StorePurchaseRow, kind: StoreHop, open: false): WorkStepRow | undefined;
  protected hop(purchase: StorePurchaseRow, kind: StoreHop, open = true): WorkStepRow | undefined {
    const existing = this.store.hop(purchase.id, kind);
    if (existing || !open) return existing;
    return this.openHop(purchase, kind, purchase.txn_id, 'QUEUED');
  }

  private openHop(purchase: StorePurchaseRow, kind: StoreHop, txnId: string | null, state: 'QUEUED' | 'AWAITING_OBSERVATION'): WorkStepRow {
    const init = this.store.hop(purchase.id, 'STORE_INIT');
    const params = init ? this.work.params<StorePurchaseParams>(init) : null;
    const hop = this.work.insert({ id: storeHopId(purchase.id, kind), commandId: purchase.id, accountId: purchase.account_id, ordinal: HOP_ORDINAL[kind], kind,
      targetId: txnId, params: params ? { purchaseId: purchase.id, txnId, hashName: params.hashName } : { purchaseId: purchase.id, txnId }, now: this.context.now() });
    if (state !== 'QUEUED') this.work.setState(hop.id, state, this.context.now());
    return this.work.step(hop.id)!;
  }

  /** The action that carries a hop, made the first time the hop is sent. */
  protected hopAction(purchase: StorePurchaseRow, hop: WorkStepRow): ActionRow {
    const db = this.context.database;
    const existing = hop.action_id ? db.action(hop.action_id) : undefined;
    if (existing) return existing;
    return db.transaction(() => {
      const now = this.context.now();
      const kind = HOP_ACTION[hop.kind as StoreHop];
      const action = db.enqueueAction({ accountId: purchase.account_id, stepId: hop.id, actionKind: kind,
        targetId: purchase.id, resourceKey: `store-purchase:${purchase.id}:${kind}`, params: { purchaseId: purchase.id, txnId: purchase.txn_id }, now });
      this.work.attachAction(hop.id, action.id, now);
      return action;
    });
  }

  /** Refused, before or by Steam: the init hop fails with the reason and the money comes back. */
  protected reject(purchase: StorePurchaseRow, reason: string): void {
    this.context.database.transaction(() => {
      const init = this.hop(purchase, 'STORE_INIT');
      this.work.failHop(init, reason, this.context.now());
      this.store.setReservation(purchase.account_id, purchase.id, 'RELEASED');
      this.context.database.addEvent(purchase.account_id, 'store-purchase-rejected', { purchaseId: purchase.id, reason }, this.context.now());
    });
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * Called after every complete inventory, event and wallet observation, and after a finalize.
   * It sends nothing. A purchase completes when the items it named are seen in main inventory
   * by an observation later than the finalize attempt, or — for a finalize that named no ids —
   * when a complete inventory walk after the attempt shows the def-index quantity it asked
   * for. A cancel settles only after the wallet and the inventory have both been re-read after
   * the cancel attempt. An init Steam never answered settles as not applied only after both
   * surfaces were re-read and nothing arrived (STORE-06 to STORE-10).
   */
  reconcile(accountId: AccountId): void {
    const db = this.context.database;
    const inventory = db.latestObservation(accountId, 'gc-inventory');
    const wallet = db.latestObservation(accountId, 'steam-wallet');
    const completeInventory = inventory?.complete === 1 && !inventory.error ? inventory : undefined;
    const completeWallet = wallet?.complete === 1 && !wallet.error ? wallet : undefined;
    for (const purchase of this.store.openPurchases(accountId)) {
      if (purchase.state === 'ADMITTED' || purchase.state === 'AWAITING_APPROVAL' || purchase.state === 'FINALISING') continue;
      const lines = this.store.lines(purchase.id);
      const finalize = purchase.finalize_action_id ? db.action(purchase.finalize_action_id) : undefined;
      const init = purchase.init_action_id ? db.action(purchase.init_action_id) : undefined;
      const cancel = purchase.cancel_action_id ? db.action(purchase.cancel_action_id) : undefined;
      const attempt = finalize ?? init;

      if (finalize && this.completeByItemIds(purchase, lines, finalize)) continue;
      if (attempt && completeInventory && postAttempt(db, attempt, completeInventory, false) && this.completeByQuantity(purchase, lines, completeInventory)) continue;

      if (purchase.state === 'CANCELLING' && cancel && completeInventory && completeWallet
        && postAttempt(db, cancel, completeInventory, true) && postAttempt(db, cancel, completeWallet, true)) {
        db.transaction(() => {
          const now = this.context.now();
          if (cancel.state === 'AWAITING_OBSERVATION') db.resolveAction(cancel, completeInventory.id, true, now);
          if (init?.state === 'AWAITING_OBSERVATION') db.resolveAction(init, completeInventory.id, false, now);
          this.store.setReservation(accountId, purchase.id, 'RELEASED');
          const cancelHop = this.store.hop(purchase.id, 'STORE_CANCEL')!;
          this.work.settle(cancelHop.id, 'DONE', completeInventory.id, now);
          for (const kind of ['STORE_INIT', 'STORE_APPROVE', 'STORE_FINALIZE'] as const) {
            const hop = this.store.hop(purchase.id, kind);
            if (hop && !isSettled(hop)) this.work.settle(hop.id, 'STOPPED', completeInventory.id, now, 'Transaction cancelled');
          }
          db.addEvent(accountId, 'store-purchase-cancelled', { purchaseId: purchase.id, txnId: purchase.txn_id }, now);
        });
        continue;
      }

      if (purchase.state === 'AWAITING_OBSERVATION' && !purchase.txn_id && init && completeInventory && completeWallet
        && postAttempt(db, init, completeInventory, true) && postAttempt(db, init, completeWallet, true)
        && lines.every((line) => this.store.mainQuantityOfDef(accountId, line.def_index) - line.baseline_quantity < line.quantity)) {
        db.transaction(() => {
          const now = this.context.now();
          if (init.state === 'AWAITING_OBSERVATION') db.resolveAction(init, completeInventory.id, false, now);
          this.store.setReservation(accountId, purchase.id, 'RELEASED');
          const initHop = this.store.hop(purchase.id, 'STORE_INIT')!;
          this.work.failHop(initHop, 'Steam never answered the purchase request, and the inventory and wallet observed afterwards show nothing bought', now, completeInventory.id);
        });
      }
    }
  }

  protected completeByItemIds(purchase: StorePurchaseRow, lines: StorePurchaseLineRow[], finalize: ActionRow): boolean {
    const db = this.context.database;
    const itemIds = parseItemIds(purchase);
    if (!itemIds.length) return false;
    const seenByDef = new Map<number, { ids: string[]; latestObs: number }>();
    for (const assetId of itemIds) {
      const seen = this.store.assetSeen(purchase.account_id, assetId);
      if (!seen || seen.location !== 'MAIN') continue;
      const observation = db.observation(purchase.account_id, seen.lastSeenObs);
      if (!observation || !postAttempt(db, finalize, observation, false)) continue;
      const bucket = seenByDef.get(seen.defIndex) ?? { ids: [], latestObs: 0 };
      bucket.ids.push(assetId);
      bucket.latestObs = Math.max(bucket.latestObs, observation.id);
      seenByDef.set(seen.defIndex, bucket);
    }
    let latest = 0;
    for (const line of lines) {
      const bucket = seenByDef.get(line.def_index);
      const observed = Math.min(bucket?.ids.length ?? 0, line.quantity);
      if (observed !== line.observed_quantity) this.store.setObservedQuantity(purchase.id, line.line_index, observed);
      if (observed < line.quantity) return false;
      latest = Math.max(latest, bucket!.latestObs);
    }
    this.complete(purchase, lines, latest);
    return true;
  }

  protected completeByQuantity(purchase: StorePurchaseRow, lines: StorePurchaseLineRow[], observation: ObservationRow): boolean {
    if (purchase.state === 'CANCELLING' && !purchase.txn_id) return false;
    for (const line of lines) {
      const gained = this.store.mainQuantityOfDef(purchase.account_id, line.def_index) - line.baseline_quantity;
      const observed = Math.max(0, Math.min(gained, line.quantity));
      if (observed !== line.observed_quantity) this.store.setObservedQuantity(purchase.id, line.line_index, observed);
      if (gained < line.quantity) return false;
    }
    this.complete(purchase, lines, observation.id);
    return true;
  }

  /** The posting's identity: the transaction and the line, never the observation that happened to see it (STORE-08). */
  protected ledgerKey(txn: string, lineIndex: number, _observationId: number): string {
    return `store:${txn}:${lineIndex}`;
  }

  /**
   * One ledger posting and one lot per line, keyed by transaction so a replay is a no-op
   * (STORE-08); then every hop the purchase made is done on the observation that proved it, and
   * a cancel that was on its way is over.
   */
  protected complete(purchase: StorePurchaseRow, lines: StorePurchaseLineRow[], observationId: number): void {
    const db = this.context.database;
    db.transaction(() => {
      const now = this.context.now();
      const txn = purchase.txn_id ?? purchase.id;
      for (const line of lines) {
        const amount = line.unit_price_cents * line.quantity;
        const sourceKey = this.ledgerKey(txn, line.line_index, observationId);
        // The posting names the purchase and no holding (D12): the items it brought are in the
        // record as holdings, and the line's observed quantity is the proof that they arrived.
        new LedgerStore(db).postEconomicEvent({
          accountId: purchase.account_id, sourceKey, kind: 'STORE_PURCHASE', occurredAt: now,
          quantity: line.quantity, observationId, amountCents: amount, feeCents: null, currency: purchase.currency, orderId: txn
        }, now);
        this.store.setObservedQuantity(purchase.id, line.line_index, line.quantity);
      }
      for (const actionId of [purchase.finalize_action_id, purchase.init_action_id]) {
        const action = actionId ? db.action(actionId) : undefined;
        if (action && action.state === 'AWAITING_OBSERVATION') db.resolveAction(action, observationId, true, now);
      }
      this.store.setReservation(purchase.account_id, purchase.id, 'CONSUMED');
      // The finalize is the hop the delivery proves; without one (a purchase completed by
      // quantity before any finalize was sent) it is opened here, done, so the reading is one.
      const finalize = this.store.hop(purchase.id, 'STORE_FINALIZE') ?? this.openHop(purchase, 'STORE_FINALIZE', purchase.txn_id, 'QUEUED');
      for (const kind of ['STORE_INIT', 'STORE_APPROVE'] as const) {
        const hop = this.store.hop(purchase.id, kind);
        if (hop && !isSettled(hop)) this.work.settle(hop.id, 'DONE', observationId, now);
      }
      this.work.settle(finalize.id, 'DONE', observationId, now);
      const cancel = this.store.hop(purchase.id, 'STORE_CANCEL');
      if (cancel && !isSettled(cancel)) this.work.settle(cancel.id, 'STOPPED', observationId, now, 'The items arrived: the purchase went through');
      db.addEvent(purchase.account_id, 'store-purchase-completed', { purchaseId: purchase.id, txnId: purchase.txn_id, observationId }, now);
    });
  }
}
