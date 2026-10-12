import type { AccountId } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import type { EngineSignal } from '../kernel/signals.js';
import { errorMessage } from '../kernel/support.js';
import type { BuyOrderService } from '../surfaces/buy-orders.js';
import type { InGameStoreService } from '../surfaces/in-game-store.js';
import type { MarketService } from '../surfaces/market.js';
import type { StorageService } from '../surfaces/storage.js';

/** The reconcilers one settle runs. Every one is idempotent and reads evidence only. */
export type SettleServices = {
  storage: StorageService;
  market: MarketService;
  buyOrders: BuyOrderService;
  inGameStore: InGameStoreService;
  /** CSFloat selling and buying, late-bound: both orchestrators are built after the settler's inputs. */
  csfloat: { reconcileSelling(accountId: AccountId): void; reconcileBuying(accountId: AccountId): void };
};

/**
 * What an orchestrator may ask of the settler. Handed over as a bag of late-bound functions,
 * because the orchestrators that need it are built before it is.
 */
export type Settling = {
  /** Settles the account now, on the caller's stack, and wakes the drivers for what it saw. */
  settleNow(accountId: AccountId): void;
  /**
   * Resolves once nothing observed for this account is waiting to be settled — at once while the
   * account is held, because its holder settles it.
   */
  settled(accountId: AccountId): Promise<void>;
  /** Defers settling while `work` runs, then settles once if anything arrived meanwhile. */
  hold<T>(accountId: AccountId, work: () => Promise<T>): Promise<T>;
};

/**
 * Wakes the drivers after a settle, with the surfaces whose walks it settled. The rules live in
 * the composition root, which is the one place that knows every driver.
 */
export type WakeDrivers = (accountId: AccountId, surfaces: ReadonlySet<string>) => void;

/**
 * The one place a waiting action is settled (settling and read path plan §3).
 *
 * Settling used to belong to whoever made the walk, so each of six places that walked the market
 * ran its own subset of the reconcilers, and a buy-order cancel said "Cancelling" for hours after
 * the refresh loop's walks had stopped showing the order (N-BUY-10). Here it hangs off the
 * observation instead: a complete walk of anything marks its account dirty, and the settle that
 * follows runs every reconciler, so no reader can forget one and no new action kind needs wiring.
 *
 * **One settle per turn.** Every pushed Game Coordinator item is an observation, and settling on
 * the emitter's stack turned a twenty-item burst into twenty full sweeps — the storm the signal
 * subscription in `engine.ts` was narrowed to avoid. A mark queues a microtask, so a burst emitted
 * in one turn settles once (INV-06); an observation that lands while a settle runs earns exactly
 * one more, so the last item of a burst is never missed.
 *
 * **A settle decides and nothing else.** It never reads, never sends and never plans; the drivers
 * it wakes do that on their own turn. Anything that needs the verdict awaits `settled`, or — when
 * it is deciding on a read it just made itself — calls `settleNow` first.
 */
export class SettleService implements Settling {
  /** Surfaces observed since the account last settled. Present means a settle is owed. */
  private readonly owed = new Map<AccountId, Set<string>>();
  private readonly queued = new Set<AccountId>();
  private readonly running = new Set<AccountId>();
  private readonly holds = new Map<AccountId, number>();
  private readonly waiters = new Map<AccountId, Array<() => void>>();
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(
    protected readonly context: EngineContext,
    protected readonly services: SettleServices,
    private readonly wake: WakeDrivers
  ) {
    this.unsubscribe = context.signals.subscribe((signal) => this.onSignal(signal));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const accountId of [...this.waiters.keys()]) this.release(accountId);
  }

  settleNow(accountId: AccountId): void {
    const surfaces = this.owed.get(accountId) ?? new Set<string>();
    this.owed.delete(accountId);
    this.settleOnce(accountId, surfaces);
    if (!this.owed.has(accountId)) this.release(accountId);
  }

  settled(accountId: AccountId): Promise<void> {
    // A held account is settled by its holder, which settles at the top of every pass. Waiting
    // here would be a read inside the hold waiting for the hold to end.
    if (this.holds.has(accountId)) return Promise.resolve();
    if (!this.owed.has(accountId) && !this.queued.has(accountId) && !this.running.has(accountId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.waiters.get(accountId) ?? [];
      list.push(resolve);
      this.waiters.set(accountId, list);
    });
  }

  async hold<T>(accountId: AccountId, work: () => Promise<T>): Promise<T> {
    this.holds.set(accountId, (this.holds.get(accountId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.holds.get(accountId) ?? 1) - 1;
      if (left > 0) this.holds.set(accountId, left);
      else {
        this.holds.delete(accountId);
        if (this.owed.has(accountId)) this.queue(accountId);
      }
    }
  }

  /** Every reconciler, in an order where each sees what the one before it settled. */
  protected run(accountId: AccountId): void {
    const { database } = this.context;
    this.step(accountId, 'storage', () => this.services.storage.reconcile(accountId));
    // Rule 5: an incomplete walk proves nothing, so the market-based decisions wait for a
    // complete one rather than deciding against whatever the latest row happens to be.
    const market = database.latestObservation(accountId, 'steam-market');
    if (market?.complete) {
      this.step(accountId, 'market', () => this.services.market.reconcile(accountId, market.id));
      this.step(accountId, 'buy-orders', () => this.services.buyOrders.reconcile(accountId, market.id));
    }
    this.step(accountId, 'in-game-store', () => this.services.inGameStore.reconcile(accountId));
    this.step(accountId, 'csfloat-selling', () => this.services.csfloat.reconcileSelling(accountId));
    this.step(accountId, 'csfloat-buying', () => this.services.csfloat.reconcileBuying(accountId));
  }

  /**
   * Whether an observation earns a settle. Every complete walk does, of any surface: a history
   * walk is what settles a buy order the book never showed, with no market walk after it
   * (N-BUY-11). An incomplete walk proves nothing (rule 5), so it earns nothing.
   */
  protected owes(signal: Extract<EngineSignal, { kind: 'observed' }>): boolean {
    return signal.complete;
  }

  private onSignal(signal: EngineSignal): void {
    if (signal.kind !== 'observed' || this.stopped || !this.owes(signal)) return;
    const surfaces = this.owed.get(signal.accountId) ?? new Set<string>();
    surfaces.add(signal.surface);
    this.owed.set(signal.accountId, surfaces);
    // A settle in progress picks this up in its trailing run; a held account settles on release.
    if (this.running.has(signal.accountId) || this.holds.has(signal.accountId)) return;
    this.queue(signal.accountId);
  }

  private queue(accountId: AccountId): void {
    if (this.queued.has(accountId)) return;
    this.queued.add(accountId);
    queueMicrotask(() => {
      this.queued.delete(accountId);
      this.drain(accountId);
    });
  }

  private drain(accountId: AccountId): void {
    if (this.stopped) return this.release(accountId);
    if (this.holds.has(accountId)) return;
    while (this.owed.has(accountId)) {
      const surfaces = this.owed.get(accountId)!;
      this.owed.delete(accountId);
      this.settleOnce(accountId, surfaces);
    }
    this.release(accountId);
  }

  private settleOnce(accountId: AccountId, surfaces: ReadonlySet<string>): void {
    this.running.add(accountId);
    try {
      this.context.database.transaction(() => this.run(accountId));
    } finally {
      this.running.delete(accountId);
    }
    if (!this.stopped) this.wake(accountId, surfaces);
  }

  /** One reconciler's failure must not keep the others from deciding what they can. */
  private step(accountId: AccountId, name: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.context.database.addEvent(accountId, 'settle-error', { reconciler: name, message: errorMessage(error) }, this.context.now());
    }
  }

  private release(accountId: AccountId): void {
    const list = this.waiters.get(accountId);
    if (!list) return;
    this.waiters.delete(accountId);
    for (const resolve of list) resolve();
  }
}
