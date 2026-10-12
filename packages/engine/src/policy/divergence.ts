import type { AccountId } from '@cslytics/ports';
import type { ActionRow, DesiredStateRow, ItemRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { ACCOUNT_MARKET, locationEvidence, surfaceEvidence } from '../kernel/evidence.js';

const OPEN_STATUSES = "('ACTIVE','ON_HOLD','PENDING_CONFIRMATION')";

export const LISTING_REVERSED = 'Listing ended outside this goal; review before relisting';
export const LOCATION_REVERSED = 'Item moved outside this goal; review before retrying';

/**
 * Where one of our own actions would have put the item.
 *
 * Without this, the effect of our own store is indistinguishable from a stranger moving the item.
 * A listing is not here because it moves nothing: the Game Coordinator keeps a listed item in main
 * inventory (`db/steam-listing.ts`), and a listing that ended is the `sell-listing` branch's.
 */
const EFFECT: Record<string, ItemRow['location']> = {
  STORE_IN_CASKET: 'CASKET',
  RETRIEVE_FROM_CASKET: 'MAIN'
};

/**
 * The single intent-versus-world divergence loop.
 *
 * `order-lifecycle.md` §2.1: casket residency needs no order row, but a human emptying a
 * storage unit is the same disagreement as a human cancelling a listing — intent says one
 * thing, a complete observation says another, and no attempt of ours explains the difference.
 * One loop, keyed by evidence, not one lifecycle per domain: a storage-specific reconciler
 * would have to re-derive freshness, ownership and suspension, and would drift from this one.
 *
 * Suspension is the only outcome. Deciding what to do about a divergence is the human's
 * (`order-lifecycle.md` D2), which is why nothing here re-plans, retries or cancels.
 */
export function reconcileDivergence(context: EngineContext, accountId: AccountId): void {
  const { database } = context;
  const now = context.ports.clock.now();
  const goals = database.raw().prepare(`SELECT * FROM desired_state
    WHERE account_id=? AND superseded_by IS NULL AND suspended_reason IS NULL`).all(accountId) as DesiredStateRow[];
  const market = surfaceEvidence(database, accountId, ACCOUNT_MARKET, now, true);

  for (const goal of goals) {
    if (goal.target_kind === 'sell-listing' && goal.intent === 'LISTED_AT') {
      // An order of ours was observed open and is now absent from a complete walk. The
      // create's own reconciler cannot see this once its action is DONE.
      if (market.grade !== 'SATISFIED') continue;
      const ended = database.raw().prepare(`SELECT 1 FROM action a JOIN market_listing m ON m.account_id=a.account_id
          AND m.local_id=a.target_id
        JOIN observation first ON first.id=m.first_seen_obs
        WHERE a.account_id=? AND a.desired_id=? AND a.kind='CREATE_SELL_LISTING' AND m.status='ABSENT' AND first.finished_at>=a.created_at
        AND NOT EXISTS (SELECT 1 FROM market_listing open WHERE open.account_id=m.account_id
          AND (open.local_id=m.local_id OR open.asset_id=m.asset_id) AND open.status IN ${OPEN_STATUSES})`)
        .get(accountId, goal.id);
      if (ended) database.suspendGoal(accountId, goal.id, LISTING_REVERSED, context.now());
      continue;
    }

    if (goal.target_kind !== 'item-location' || (goal.intent !== 'MAIN' && goal.intent !== 'CASKET')) continue;
    // Only a goal that was *proven* satisfied can have been reversed. A store that never
    // landed leaves the item where it started, which is a pending goal, not a divergence.
    const satisfied = database.raw().prepare(`SELECT * FROM action WHERE account_id=? AND desired_id=?
      AND state='DONE' AND resolution='OBSERVED_APPLIED' ORDER BY updated_at DESC LIMIT 1`).get(accountId, goal.id) as ActionRow | undefined;
    if (!satisfied) continue;
    const where = locationEvidence(database, accountId, goal.target_id, goal.intent, now);
    if (where.grade === 'UNKNOWN') continue;
    const wanted = (JSON.parse(goal.params_json) as { casketId?: string }).casketId;
    const reversed = where.grade === 'UNSATISFIED'
      || (goal.intent === 'CASKET' && Boolean(wanted) && where.value.casket_id !== wanted);
    if (!reversed) continue;
    const item = database.itemByLocalId(accountId, goal.target_id);
    // An attempt of ours that is at least as recent as the proof cannot be somebody else's move.
    const ours = database.actions(accountId).some((action) => action.target_id === goal.target_id
      && action.state !== 'FAILED' && EFFECT[action.kind] === item?.location && action.updated_at >= satisfied.updated_at);
    if (!ours) database.suspendGoal(accountId, goal.id, LOCATION_REVERSED, context.now());
  }
}
