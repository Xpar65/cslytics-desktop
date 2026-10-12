/**
 * What happens to an action a complete observation proved **not applied** — the one retry rule 1
 * permits, written once.
 *
 * It used to be five answers decided in five reconcilers. A listing create went back to `READY`
 * for convergence to send again, twice in all, then parked its goal as "Listing retry limit
 * reached"; a unit rename got one more try; a buy-order cancel failed at once and was never sent
 * again; a CSFloat delist the same; and a Steam delist had no answer at all, so a cancel whose
 * request died in transport sat *Sent, waiting for Steam to show it* for ever while every later
 * walk showed the listing still up (2026-10-12, the storage test account). Nothing was wrong
 * with any one answer; what was wrong was that the question had no home, so a kind could miss
 * it without anything noticing.
 *
 * Here every kind the loop proves (`engine.proofOwners`) says what proof of absence means for
 * it, and `tests/unit/retry-coverage.test.ts` fails when one does not. `kernel/not-applied.ts`
 * applies the table when a reconciler proves an attempt absent; `orchestrate/retry.ts` sends what
 * the table says to send again; `read/queries/work.ts` tells the person when, from the same
 * arithmetic.
 *
 * **What a retry is, and is not.** It is a resend after a *later complete observation begun after
 * the attempt returned* still shows the state the attempt was meant to change. It is never a
 * second call on an ambiguous reply (the corpus page for `removelisting` records why: a cancel
 * can race a sale, and only the walk can tell them apart), and the schedule counts from that
 * proof, not from the send, because the proof is the moment anything is known. A cancel can be
 * repeated without harm — a listing or an order cancelled twice is cancelled — so a cancel earns
 * the full schedule. A create is not that: a second listing or a second order is a second thing,
 * so creates keep the tighter limits their owners always had. Those are the only two shapes in
 * this table on purpose.
 */
export type RetryPolicy =
  /** Proof of absence ends it: the action fails with the reason, and the person asks again. */
  | { resend: 'never' }
  /**
   * `RetryService` sends it again `delaysMs[n - 1]` after the n-th proof it did not land, and the
   * action fails after the last delay's attempt is proved absent too: `delaysMs.length` retries.
   */
  | { resend: 'retry-service'; delaysMs: readonly number[] }
  /**
   * Another driver sends it again on its own cadence — convergence for a listing goal, the
   * storage reconciler for a rename — and this table only holds its cap, `limit` attempts in
   * all. On the last proof the goal is suspended with the reason, which is how that driver stops.
   */
  | { resend: 'owner'; owner: string; limit: number };

/** After the proof: five seconds, then thirty, then a minute; then it fails. Three retries, four sends. */
export const CANCEL_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 60_000];

/** Why a kind is `never`, or carries the limit it does, when the row alone does not say. */
export const RETRY_POLICY: Readonly<Record<string, RetryPolicy>> = {
  REMOVE_SELL_LISTING: { resend: 'retry-service', delaysMs: CANCEL_RETRY_DELAYS_MS },
  CANCEL_BUY_ORDER: { resend: 'retry-service', delaysMs: CANCEL_RETRY_DELAYS_MS },
  // A never-landed create retries once (order-lifecycle A1, D3): convergence re-sends the `READY`
  // action on its next tick, and the second proof parks the goal.
  CREATE_SELL_LISTING: { resend: 'owner', owner: 'convergence', limit: 2 },
  // One deliberate second try; a name Steam declines twice is a name, not a lost reply (STO-07).
  RENAME_CASKET: { resend: 'owner', owner: 'storage', limit: 2 },
  // A buy order is wallet money: proved never placed, it fails with the reason and the person
  // decides whether to place it again. It used to go back to `READY`, which nothing re-sent and
  // the buy-order book did not show.
  CREATE_BUY_ORDER: { resend: 'never' },
  // KNOWN GAP: a casket move proved not applied goes back to `READY` (`StorageService.reconcile`),
  // and only convergence re-sends one — the retrieve a listing goal owns, under its own mutation
  // cap. A store, or a retrieve a command queued, has no sender and stays *Sent, waiting* for
  // ever. The fix is a sender in `engine.ts` and the schedule above; left as it was until a
  // scenario proves the resend against the casket evidence rules.
  STORE_IN_CASKET: { resend: 'owner', owner: 'convergence (goal-carried only)', limit: 8 },
  RETRIEVE_FROM_CASKET: { resend: 'owner', owner: 'convergence (goal-carried only)', limit: 8 },
  // CSF-46: a CSFloat edit the listing read proves not applied fails and is never re-sent. Its
  // own orchestrator would be the sender; flipping this row is the day that is wanted.
  CSFLOAT_CANCEL: { resend: 'never' },
  CSFLOAT_REPRICE: { resend: 'never' }
};

/** The policy for a kind this table does not name: proof of absence ends it. */
export const NEVER_RETRY: RetryPolicy = { resend: 'never' };

export type RetryPlan =
  /** Send again, at `retryAt`; `attempt` is the number the next send will be, of `limit`. */
  | { kind: 'again'; retryAt: string; attempt: number; limit: number }
  /** Nothing more is sent; `attempt` is how many were. */
  | { kind: 'exhausted'; attempt: number; limit: number };

/** How many sends a policy allows in all, the first included. */
export function attemptLimit(policy: RetryPolicy): number {
  if (policy.resend === 'never') return 1;
  if (policy.resend === 'retry-service') return policy.delaysMs.length + 1;
  return policy.limit;
}

/**
 * What follows the proof that attempt number `attempts` did not land, made at `provedAt`.
 *
 * An owner's resend is due at once: that driver has its own cadence and this table is only its
 * cap. The service's resend waits the delay the attempt earned, counted from the proof.
 */
export function retryPlan(policy: RetryPolicy, attempts: number, provedAt: string): RetryPlan {
  const limit = attemptLimit(policy);
  if (attempts >= limit) return { kind: 'exhausted', attempt: attempts, limit };
  const delayMs = policy.resend === 'retry-service' ? policy.delaysMs[attempts - 1] ?? 0 : 0;
  return { kind: 'again', retryAt: new Date(Date.parse(provedAt) + delayMs).toISOString(), attempt: attempts + 1, limit };
}
