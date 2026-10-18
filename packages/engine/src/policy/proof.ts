import type { ActionRow, EngineDatabase } from '../db/database.js';
import { surfaceName, type ProofNeed, type SurfaceRef } from '../kernel/evidence.js';

/**
 * Proof demand: which walks the work waiting for proof needs, and how soon (settling and read
 * path plan D5, D6).
 *
 * It used to be a static table from an action kind to surfaces, read once when a mutation
 * returned, with the requests it made held in memory. The table was wrong for the one case that
 * mattered — a buy order the book never showed is settled by a *history* walk, which the table
 * never asked for — and a restart forgot every request, so an action recovered as waiting asked
 * for nothing. Here demand is derived from the database on every scheduling decision, from the
 * code that settles each kind.
 */

/** One walk a waiting action needs, and since when it has been waiting. */
export type ProofDemand = { ref: SurfaceRef; startedAfter: string; since: string; actionId?: string };

/** Whoever settles a kind of action answers what it needs walked. */
export type ProofOwner = { needs(action: ActionRow): ProofNeed };

/**
 * Whoever settles something no action of ours waits on answers what that needs walked: an order
 * a walk stopped showing, which an inventory walk begun after it ends (`OrderService.standingNeeds`).
 */
export type StandingProofOwner = { standingNeeds(accountId: string): ProofDemand[] };

/**
 * Every walk the waiting actions and the standing owners of one account need, read from the database each time.
 * `provedByDispatch` names the commands whose dispatch is running: each proves its own round, so their hops
 * are left out before anyone is asked what they need (bulk storage plan D15).
 */
export function proofDemand(database: EngineDatabase, accountId: string, owners: Readonly<Partial<Record<string, ProofOwner>>>,
  standing: readonly StandingProofOwner[] = [], provedByDispatch: readonly string[] = []): ProofDemand[] {
  const demand: ProofDemand[] = [];
  for (const action of database.awaitingActionsOutside(accountId, provedByDispatch)) {
    const need = owners[action.kind]?.needs(action);
    if (!need || need.kind !== 'walks') continue;
    for (const walk of need.walks) demand.push({ ...walk, since: action.updated_at, actionId: action.id });
  }
  for (const owner of standing) demand.push(...owner.standingNeeds(accountId));
  return demand;
}

/** The first proof walk is due at once; then every 30 s, every 60 s after two minutes, every 120 s after five. */
export const PROOF_INTERVALS: ReadonlyArray<{ fromAgeMs: number; everyMs: number }> = [
  { fromAgeMs: 5 * 60_000, everyMs: 120_000 },
  { fromAgeMs: 2 * 60_000, everyMs: 60_000 },
  { fromAgeMs: 0, everyMs: 30_000 }
];

/**
 * How long a need may make its surface due before it falls back to the surface's own cadence.
 * A need still open after this is not waiting for a walk any more: the person, or Steam, has it.
 */
export const PROOF_BOUND_MS = 15 * 60_000;

/**
 * When the needs on one scope make it due, or `undefined` when none does (plan D6).
 *
 * A need nobody has read for since it began is due at once. After that, the walks it earned did
 * not settle it — Steam had not caught up — so it asks again on a cadence that slows with age,
 * and stops asking after `PROOF_BOUND_MS`. A walk that began at the very moment the need did
 * counts as read for it: on a frozen test clock the two share every millisecond, and treating
 * that walk as stale would ask again at once, for ever.
 */
export function proofDueAtMs(ref: SurfaceRef, demand: readonly ProofDemand[], lastStartedAt: string | undefined, nowMs: number): number | undefined {
  const name = surfaceName(ref);
  let due: number | undefined;
  for (const need of demand) {
    // The scope as well as the name: every CSFloat listing reads as `csfloat-listing`, and one
    // listing's need is not a reason to read another.
    if (surfaceName(need.ref) !== name || (need.ref.scope.id ?? null) !== (ref.scope.id ?? null)) continue;
    const ageMs = nowMs - Date.parse(need.since);
    if (!(ageMs <= PROOF_BOUND_MS)) continue;
    if (lastStartedAt === undefined || lastStartedAt < need.startedAfter) return nowMs;
    const everyMs = PROOF_INTERVALS.find((step) => ageMs >= step.fromAgeMs)?.everyMs ?? 30_000;
    const at = Date.parse(lastStartedAt) + everyMs;
    due = due === undefined ? at : Math.min(due, at);
  }
  return due;
}
