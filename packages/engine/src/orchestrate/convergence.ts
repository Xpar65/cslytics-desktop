import type { AccountId } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { AccountLock, errorMessage } from '../kernel/support.js';
import { type SurfaceRef, surfaceName } from '../kernel/evidence.js';
import { ListingPlanner, LISTING_TARGET, LISTED_AT } from '../policy/listing-planner.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { StorageService, CasketParams } from '../surfaces/storage.js';
import type { MarketService } from '../surfaces/market.js';
import type { Settling } from './settle.js';
import type { Observe } from './refresh.js';

export type ConvergenceServices = { planner: ListingPlanner; inventory: InventoryService; storage: StorageService; market: MarketService; settle: Settling; observe: Observe };
export type ConvergenceResult = { observations: number; mutations: number };

/** The unattended heartbeat: how often an account with goals reconsiders them. */
const HEARTBEAT_MS = 30_000;

export class ConvergenceService {
  private readonly locks = new AccountLock();
  private readonly scheduled = new Set<string>();
  private stopped = false;
  private readonly heartbeats = new Set<string>();

  constructor(protected readonly context: EngineContext, protected readonly services: ConvergenceServices) {}

  /**
   * Starts the per-account heartbeat.
   *
   * Driven by `ports.clock.sleep` rather than `setInterval`, so a `VirtualClock` can advance to
   * the next beat and a scenario can assert what it did. With a real timer nothing in this
   * repository could say when this service ran, which is why nothing did.
   */
  start(accountId: AccountId): void {
    if (this.stopped || this.heartbeats.has(accountId)) return;
    this.heartbeats.add(accountId);
    void (async () => {
      try {
        while (!this.stopped && this.heartbeats.has(accountId)) {
          this.schedule(accountId);
          await this.context.ports.clock.sleep(HEARTBEAT_MS);
        }
      } finally {
        this.heartbeats.delete(accountId);
      }
    })();
  }

  schedule(accountId: AccountId): void {
    if (this.stopped || this.scheduled.has(accountId)) return;
    this.scheduled.add(accountId);
    // A microtask rather than a timer: the point is to coalesce several `schedule` calls made in
    // one synchronous burst into one tick, not to wait for wall time.
    queueMicrotask(() => {
      this.scheduled.delete(accountId);
      if (this.stopped) return;
      void this.converge(accountId).catch((error: unknown) => {
        if (!this.stopped) this.context.database.addEvent(accountId, 'convergence-error', { message: errorMessage(error) }, this.context.now());
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.scheduled.clear();
    this.heartbeats.clear();
  }

  /**
   * One tick, with settling held off until it ends. The tick settles at the top of every pass
   * itself; a walk it started settling again on its own would re-enter the goal sweep once per
   * read, which is the storm the settler exists to avoid.
   */
  converge(accountId: AccountId): Promise<ConvergenceResult> {
    return this.locks.run(accountId, () => this.services.settle.hold(accountId, () => this.tick(accountId)));
  }

  protected deduplicate(refs: SurfaceRef[]): SurfaceRef[] {
    return [...new Map(refs.map((ref) => [`${surfaceName(ref)}:${ref.scope.kind}:${ref.scope.id ?? ''}`, ref])).values()];
  }

  protected capacity(accountId: string): number {
    const { database } = this.context;
    const pending = database.actions(accountId).filter((action) => action.kind === 'RETRIEVE_FROM_CASKET'
      && ['RUNNING', 'AWAITING_OBSERVATION'].includes(action.state) && database.itemByLocalId(accountId, action.target_id)?.location !== 'MAIN').length;
    return Math.max(0, 1000 - database.countMainItems(accountId) - pending);
  }

  private reconcile(accountId: string): void {
    this.services.settle.settleNow(accountId);
  }

  /**
   * One read for the tick, through the read budget (plan D4). The heartbeat is the most frequent
   * automatic reader in the app, and these reads went straight to the surfaces, so nothing
   * throttled them. Anything that is not a unit, the book or its history is read as main
   * inventory, as it always was.
   */
  private async observe(accountId: string, ref: SurfaceRef): Promise<void> {
    const target: SurfaceRef = ref.surface === 'gc-casket' && ref.scope.id ? ref
      : ref.surface === 'steam-market' || ref.surface === 'steam-market-history' ? { surface: ref.surface, scope: { kind: 'account' } }
        : { surface: 'gc-inventory', scope: { kind: 'account' } };
    await this.services.observe(accountId, target);
  }

  private async tick(accountId: string): Promise<ConvergenceResult> {
    const { database } = this.context;
    const { planner, market, storage } = this.services;
    const result = { observations: 0, mutations: 0 };
    if (this.stopped) return result;
    const depth = new Map<string, number>();
    const observed = new Set<string>();
    let room = this.capacity(accountId);
    // Each pass learns a surface or sends a bounded current step. No future action is queued.
    for (let pass = 0; pass < 8 && !this.stopped; pass += 1) {
      this.reconcile(accountId);
      const plans = database.transaction(() => planner.preview(accountId));
      const refs: SurfaceRef[] = plans.filter((step) => step.kind === 'OBSERVE').map((step) => ({ surface: step.surface, scope: step.scope }));
      const unexplained = database.raw().prepare(`SELECT 1 FROM venue_order WHERE account_id=? AND state='UNEXPLAINED' LIMIT 1`).get(accountId);
      if (unexplained) refs.unshift({ surface: 'steam-market-history', scope: { kind: 'account' } });
      for (const action of database.actions(accountId, 'AWAITING_OBSERVATION')) {
        if (action.kind === 'RETRIEVE_FROM_CASKET' || action.kind === 'STORE_IN_CASKET') {
          const params = database.actionParams(action) as CasketParams;
          refs.push({ surface: 'gc-inventory', scope: { kind: 'account' } }, { surface: 'gc-casket', scope: { kind: 'casket', id: params.casketId } });
        } else if (action.kind === 'CREATE_SELL_LISTING' || action.kind === 'REMOVE_SELL_LISTING') {
          refs.push({ surface: 'steam-market', scope: { kind: 'account' } });
        }
      }
      const reads = this.deduplicate(refs).filter((ref) => !observed.has(surfaceName(ref)));
      if (reads.length) {
        for (const ref of reads) {
          observed.add(surfaceName(ref));
          await this.observe(accountId, ref);
          result.observations += 1;
        }
        continue;
      }
      if (result.mutations === 0) room = this.capacity(accountId);
      const admitted: ActionRow[] = database.transaction(() => {
        const actions: ActionRow[] = [];
        for (const goal of database.currentGoals(accountId, LISTING_TARGET, LISTED_AT)) {
          if (goal.suspended_reason || (depth.get(goal.id) ?? 0) >= 2) continue;
          const step = planner.next(accountId, goal.target_id);
          if (step.kind === 'BLOCKED') {
            database.suspendGoal(accountId, goal.id, step.reason, this.context.now(), step.blockedUntil ?? null);
            continue;
          }
          const ready = database.inFlightAction(accountId, `item:${goal.target_id}`);
          if (step.kind !== 'MUTATE' && !(ready?.state === 'READY' && ready.desired_id === goal.id)) continue;
          const retrieve = ready ? ready.kind === 'RETRIEVE_FROM_CASKET' : step.kind === 'MUTATE' && step.action === 'RETRIEVE_FROM_CASKET';
          if (retrieve && room <= 0) continue;
          const action = ready ?? planner.commit(accountId, goal.target_id);
          if (!action) continue;
          if (retrieve) room -= 1;
          actions.push(action);
        }
        return actions;
      });
      if (!admitted.length) break;
      for (const action of admitted) {
        if (this.stopped) break;
        try {
          if (action.kind === 'CREATE_SELL_LISTING') await market.executeSellListing(action.id);
          else await storage.execute(action.id);
          depth.set(action.desired_id, (depth.get(action.desired_id) ?? 0) + 1);
          result.mutations += 1;
        } catch (error) {
          database.suspendGoal(accountId, action.desired_id, errorMessage(error), this.context.now());
        }
      }
      // Observations before this batch cannot explain this batch's effects.
      observed.clear();
    }
    if (!this.stopped) this.reconcile(accountId);
    return result;
  }
}
