import type { ActionRow, EngineDatabase } from '../db/database.js';
import type { EngineContext } from './context.js';
import { NEVER_RETRY, RETRY_POLICY, retryPlan, type RetryPlan, type RetryPolicy } from './retry-policy.js';

/** How many times an action has been sent. */
export function attemptsMade(database: EngineDatabase, actionId: string): number {
  return (database.raw().prepare(`SELECT COUNT(*) AS n FROM attempt WHERE action_id=?`).get(actionId) as { n: number }).n;
}

/**
 * How many of an action's attempts could have landed: every one but those the venue definitely
 * refused, which sent nothing. The count a cap on resends is held against for a kind whose
 * refusal of the moment puts the same request back to wait (a price change inside Steam's cooldown).
 */
export function sendsThatCouldLand(database: EngineDatabase, actionId: string): number {
  return attemptsMade(database, actionId) - database.definiteRefusals(actionId);
}

/**
 * Settles an action a complete observation proved not applied, the one way.
 *
 * The record is `resolveAction(…, false)`: resolution `OBSERVED_NOT_APPLIED`, and `READY` again
 * while its goal is current, which is what "may be sent again" has always meant in this schema.
 * What happens next is the kind's row in `kernel/retry-policy.ts`: `again`, and the row's resender
 * takes it from `READY` when `retryAt` comes; or `exhausted`, and it fails here with words a
 * person can act on — the proof, and how many times it was tried — rather than a code. A
 * goal-driven kind's goal is suspended with the same words, because its owner reads the goal,
 * not the action, to decide whether to send.
 *
 * `what` is the proof in the reconciler's words ("Steam still shows the listing"), so the reason
 * names what was seen rather than what was hoped. `exhaustedReason` replaces the built sentence
 * for a kind whose words are already a contract. `policy` is a seam for a saboteur, never a
 * production choice: the table is the policy. `attempts` is the count the cap is held against,
 * for a kind where not every attempt was a send that could have landed (`sendsThatCouldLand`).
 */
export function settleNotApplied(
  context: EngineContext,
  action: ActionRow,
  observationId: number,
  what: string,
  options: { exhaustedReason?: string; policy?: RetryPolicy; attempts?: number } = {}
): RetryPlan {
  const { database } = context;
  const now = context.now();
  const policy = options.policy ?? RETRY_POLICY[action.kind] ?? NEVER_RETRY;
  database.resolveAction(action, observationId, false, now);
  const attempts = options.attempts ?? attemptsMade(database, action.id);
  const plan = retryPlan(policy, attempts, now);
  if (plan.kind === 'exhausted' && database.action(action.id)?.state === 'READY') {
    const reason = options.exhaustedReason ?? (attempts > 1 ? `${what} after ${attempts} attempts` : what);
    database.setActionState(action.id, 'FAILED', now, reason);
    if (policy.resend === 'owner' && action.desired_id) database.suspendGoal(action.account_id, action.desired_id, reason, now);
  }
  database.addEvent(action.account_id, 'mutation-not-applied', {
    actionId: action.id, actionKind: action.kind, what, plan: plan.kind, attempt: plan.attempt, limit: plan.limit,
    retryAt: plan.kind === 'again' ? plan.retryAt : null
  }, now);
  return plan;
}
