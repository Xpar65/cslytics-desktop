/**
 * Which action carries a command member, and what the member is therefore doing.
 *
 * A store, retrieve, transfer or delist member points at its action: `command_member.action_id`
 * is set when the member is queued, and a chain's second hop re-points it (`advanceTransfer`,
 * `advanceDelistChain`). A LIST member for an individual item points at nothing. Its listing is
 * a goal (`ListingPlanner.setListingGoal`), and the planner commits the goal's actions — a
 * retrieve from the unit, then the listing — in convergence ticks that know nothing about
 * commands. A group unit's LIST member is the exception: it points at its own
 * `CREATE_SELL_LISTING` action, queued per reserved unit the way a store is, because a case
 * lists from main inventory or is refused and its asset id survives the round-trip (rule 3).
 *
 * The work read used to join `action` through `action_id` alone. So a listing member read *Sent,
 * waiting for Steam to show it* for ever: the goal's action went `DONE` on the walk that showed
 * the listing active, and nothing the member pointed at ever changed (observed live on the storage
 * test account, 2026-09-15). The member's goal is the newest
 * `LISTED_AT` goal for its item at its price, and its current hop is the newest action on that
 * goal — which is exactly what `ListingPlanner.next` reasons over.
 *
 * Two SQL fragments, shared by `read/queries/work.ts` and `orchestrate/command.ts` so the panel
 * and `command.read` cannot disagree. Both expect the command aliased `c` and the member aliased
 * `m`; the joins add `g` (the member's goal) and `a` (the action carrying it).
 */

/**
 * The `desired_state.basis` of a delist that is a command's own first hop — a reprice, a
 * delist-to-storage — rather than somebody's request. Written by the command service and read by
 * the work read, which is why it lives here: the two must not disagree about whose delist it is.
 */
export const COMMAND_BASIS = 'command';

/** Joins `g` and `a` onto `command c JOIN command_member m`. */
export const MEMBER_CARRIER_JOINS = `
    LEFT JOIN desired_state g ON g.id=(
      SELECT d.id FROM desired_state d
      WHERE m.action_id IS NULL AND c.kind='LIST' AND m.state IN ('QUEUED','SUBMITTED')
        AND d.account_id=m.account_id AND d.target_kind='sell-listing' AND d.target_id=m.member_id
        AND d.intent='LISTED_AT' AND json_extract(d.params_json,'$.priceReceiveCents')=m.price_receive_cents
      ORDER BY d.version DESC LIMIT 1)
    LEFT JOIN action a ON a.id=COALESCE(m.action_id, (
      SELECT x.id FROM action x WHERE x.desired_id=g.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1))`;

/**
 * The member's state, in the words `work.open` and `command.read` share.
 *
 * Observation-honest throughout (rule 1): `COMPLETE` only when the carrying action is `DONE`,
 * which an observation did; `AWAITING_CONFIRMATION` only when a complete market walk showed the
 * listing in `listings_to_confirm`, so the person knows the phone is what it waits on;
 * `BLOCKED` when the goal is parked with a reason, which is the refusal OP-08 says must reach
 * them; `RETRYING` when a complete walk proved the last send did not land and the action is
 * `READY` for its next turn (`kernel/not-applied.ts`), so the person sees a resend coming rather
 * than a wait with no end. A listing member whose goal has a hop still to come reads `QUEUED`,
 * not `COMPLETE`, however many earlier hops are done. A member the person stopped, or that was
 * refused, or whose item sold under a chain, keeps that word whatever its action says.
 */
export const MEMBER_STATE_SQL = `CASE
      WHEN m.state IN ('STOPPED','REJECTED','SOLD') THEN m.state
      WHEN a.state='DONE' AND (m.action_id IS NOT NULL OR a.kind='CREATE_SELL_LISTING') THEN 'COMPLETE'
      WHEN a.kind='CREATE_SELL_LISTING' AND a.state='AWAITING_OBSERVATION' AND EXISTS (
        SELECT 1 FROM market_listing l WHERE l.account_id=m.account_id
          AND l.local_id=a.target_id
          AND l.status='PENDING_CONFIRMATION' AND l.price_receive_cents=m.price_receive_cents) THEN 'AWAITING_CONFIRMATION'
      WHEN g.suspended_reason IS NOT NULL THEN 'BLOCKED'
      WHEN a.state='FAILED' THEN 'FAILED'
      WHEN a.state='READY' AND a.resolution='OBSERVED_NOT_APPLIED' THEN 'RETRYING'
      WHEN g.id IS NOT NULL AND a.state IN ('RUNNING','AWAITING_OBSERVATION') THEN 'SUBMITTED'
      WHEN g.superseded_by IS NOT NULL THEN 'STOPPED'
      WHEN g.id IS NOT NULL THEN 'QUEUED'
      ELSE m.state
    END`;

/** Why a member is blocked or failed, when it is: the goal's suspension, else the action's error. */
export const MEMBER_REASON_SQL = `CASE
      WHEN g.suspended_reason IS NOT NULL THEN g.suspended_reason
      WHEN a.state='FAILED' THEN a.error
    END`;
