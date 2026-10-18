import type { AccountId } from '@cslytics/ports';
import type { ActionRow, DesiredStateRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { required } from '../kernel/support.js';
import { OrderStore } from '../db/orders.js';
import { ACCOUNT_MARKET, PRECONDITIONS, evaluatePreconditions, surfaceEvidence, type ActionKind, type Evidence, type ScopeRef, type Surface } from '../kernel/evidence.js';

export const LISTING_TARGET = 'sell-listing';
export const LISTED_AT = 'LISTED_AT';
export const MAX_GOAL_MUTATIONS = 8;
export type ListingGoalParams = { priceReceiveCents: number };
type Target = { localId: string; desiredId: string; desiredVersion: number };
export type ListingStep = Target & (
  | { kind: 'MUTATE'; action: ActionKind; params: { priceReceiveCents: number } | { casketId: string; assetId: string }; because: Evidence<unknown>[] }
  | { kind: 'OBSERVE'; surface: Surface; scope: ScopeRef; because: 'stale' | 'never' | 'incomplete' }
  | { kind: 'BLOCKED'; reason: string; blockedUntil?: string }
  | { kind: 'NONE'; reason: 'no-goal' | 'satisfied' | 'in-flight' }
);

/** No sequence is persisted. Every decision is recomputed from the goal and its evidence. */
export class ListingPlanner {
  constructor(protected readonly context: EngineContext) {}

  setListingGoal(accountId: AccountId, localId: string, priceReceiveCents: number, commandId: string | null = null): DesiredStateRow {
    const { database } = this.context;
    if (!Number.isInteger(priceReceiveCents) || priceReceiveCents <= 0) throw new Error('Seller-receives price must be positive integer cents');
    required(database.itemByLocalId(accountId, localId), `Unknown item ${localId}`);
    const goal = database.upsertDesired({ accountId, targetKind: LISTING_TARGET, targetId: localId, intent: LISTED_AT,
      params: { priceReceiveCents }, commandId, now: this.context.now() });
    database.raw().prepare(`UPDATE desired_state SET expires_at=COALESCE(expires_at,?) WHERE account_id=? AND id=?`)
      .run(new Date(Date.parse(goal.created_at) + 7 * 86400_000).toISOString(), accountId, goal.id);
    return database.desiredState(goal.id)!;
  }

  next(accountId: AccountId, localId: string): ListingStep {
    const { database } = this.context;
    const goal = database.currentDesiredState(accountId, LISTING_TARGET, localId);
    const target: Target = { localId, desiredId: goal?.id ?? '', desiredVersion: goal?.version ?? 0 };
    if (!goal || goal.intent !== LISTED_AT) return { ...target, kind: 'NONE', reason: 'no-goal' };
    if (goal.suspended_reason) return { ...target, kind: 'BLOCKED', reason: goal.suspended_reason, ...(goal.blocked_until ? { blockedUntil: goal.blocked_until } : {}) };
    const params = JSON.parse(goal.params_json) as ListingGoalParams;
    const now = this.context.ports.clock.now();
    const market = surfaceEvidence(database, accountId, ACCOUNT_MARKET, now);
    const listing = new OrderStore(database).openSteamListingFor(accountId, localId);
    if (listing && market.grade === 'SATISFIED') {
      return listing.price_cents === params.priceReceiveCents ? { ...target, kind: 'NONE', reason: 'satisfied' }
        : { ...target, kind: 'BLOCKED', reason: `Existing listing at ${listing.price_cents}c needs review before repricing` };
    }
    if (database.inFlight(accountId, `item:${localId}`)) return { ...target, kind: 'NONE', reason: 'in-flight' };
    if (goal.expires_at && Date.parse(goal.expires_at) <= now.getTime()) return { ...target, kind: 'BLOCKED', reason: 'Listing goal expired; review the price before resuming' };
    const attempts = database.raw().prepare(`SELECT COUNT(*) AS n FROM attempt t JOIN action a ON a.id=t.action_id WHERE a.account_id=? AND a.desired_id=?`).get(accountId, goal.id) as { n: number };
    if (attempts.n >= this.mutationLimit()) return { ...target, kind: 'BLOCKED', reason: 'Goal mutation limit reached' };
    const failed = database.actions(accountId, 'FAILED').find((action) => action.desired_id === goal.id);
    if (failed) return { ...target, kind: 'BLOCKED', reason: failed.error ?? 'An action failed; review before resuming' };
    const item = database.itemByLocalId(accountId, localId);
    const action: ActionKind = item?.location === 'CASKET' ? 'RETRIEVE_FROM_CASKET' : 'CREATE_SELL_LISTING';
    // Feasibility includes the final sell restrictions before we move anything out of storage.
    const because = evaluatePreconditions(database, accountId, localId,
      [...new Set([...PRECONDITIONS[action], 'market-lock' as const, 'no-open-order' as const])], now, item?.casket_id ?? undefined);
    const unknown = because.find((evidence) => evidence.grade === 'UNKNOWN');
    if (unknown?.grade === 'UNKNOWN') return { ...target, kind: 'OBSERVE', ...unknown.want,
      because: unknown.freshness === 'NEVER' ? 'never' : unknown.freshness === 'STALE' ? 'stale' : 'incomplete' };
    const blocked = because.find((evidence) => evidence.grade === 'UNSATISFIED');
    if (blocked?.grade === 'UNSATISFIED') return { ...target, kind: 'BLOCKED', reason: blocked.reason, ...(blocked.blockedUntil ? { blockedUntil: blocked.blockedUntil } : {}) };
    return { ...target, kind: 'MUTATE', action, because,
      params: action === 'RETRIEVE_FROM_CASKET' ? { casketId: item!.casket_id!, assetId: item!.asset_id! } : params };
  }

  protected mutationLimit(): number { return MAX_GOAL_MUTATIONS; }

  commit(accountId: AccountId, localId: string): ActionRow | null {
    return this.context.database.transaction(() => {
      const step = this.next(accountId, localId);
      if (step.kind !== 'MUTATE') return null;
      const action = this.context.database.enqueueAction({ accountId, desiredId: step.desiredId, desiredVersion: step.desiredVersion,
        actionKind: step.action, targetId: localId, resourceKey: `item:${localId}`, params: step.params, now: this.context.now() });
      this.context.database.addEvent(accountId, 'goal-step-planned', { actionId: action.id, because: step.because }, this.context.now());
      return action;
    });
  }

  preview(accountId: AccountId): ListingStep[] {
    return this.context.database.currentGoals(accountId, LISTING_TARGET, LISTED_AT).map((goal) => this.next(accountId, goal.target_id));
  }
}
