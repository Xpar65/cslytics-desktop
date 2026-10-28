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
   * `delaysMs`, when present, is how long after the n-th proof the owner may send again: the gap
   * between a command's rounds (bulk storage plan D3). Absent, the owner may send at once.
   */
  | { resend: 'owner'; owner: string; limit: number; delaysMs?: readonly number[] };

/** After the proof: five seconds, then thirty, then a minute; then it fails. Three retries, four sends. */
export const CANCEL_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 60_000];

/**
 * The gaps between a casket move's rounds (bulk storage plan D3): two seconds after the round that
 * proved it did not land, then ten, then thirty; four sends in all. A round's proof read settles
 * every move of the round at once, so every move it proved absent goes again together.
 */
export const CASKET_ROUND_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

/**
 * After a walk shows a confirmation still waiting (strategy authority and confirmations plan
 * D10): two minutes, then four, then every eight; twelve presses in all, about an hour and a half.
 * The pace is Steam's: each press lists what awaits confirmation, which Steam limits per account and
 * which a delivery's offer needs more than a relist does.
 */
export const CONFIRM_RETRY_DELAYS_MS: readonly number[] = [120_000, 240_000, ...Array.from({ length: 9 }, () => 480_000)];

/** Why a kind is `never`, or carries the limit it does, when the row alone does not say. */
export const RETRY_POLICY: Readonly<Record<string, RetryPolicy>> = {
  REMOVE_SELL_LISTING: { resend: 'retry-service', delaysMs: CANCEL_RETRY_DELAYS_MS },
  CANCEL_BUY_ORDER: { resend: 'retry-service', delaysMs: CANCEL_RETRY_DELAYS_MS },
  // A never-landed create retries once (order-lifecycle A1, D3): its owner re-sends the `READY`
  // action, convergence on its next tick for a goal and `CommandService.advanceSteps` at the
  // proof for a hop; the second proof parks the goal, or fails the hop.
  CREATE_SELL_LISTING: { resend: 'owner', owner: 'convergence for a goal, the command service for a hop', limit: 2 },
  // One deliberate second try; a name Steam declines twice is a name, not a lost reply (STO-07).
  RENAME_CASKET: { resend: 'owner', owner: 'storage', limit: 2 },
  // A buy order is wallet money: proved never placed, it fails with the reason and the person
  // decides whether to place it again. It used to go back to `READY`, which nothing re-sent and
  // the buy-order book did not show.
  CREATE_BUY_ORDER: { resend: 'never' },
  // A casket move proved not applied goes back to `READY` (`StorageService.reconcile`, through
  // `settleNotApplied`): the proof is a complete unit read and a complete inventory walk, both begun
  // after the attempt, that still show the item where it was. Its owner sends it again in the next
  // round, after the round's gap: convergence for the retrieve a listing goal carries, under the
  // goal's own mutation cap, and `CommandService` for a store or retrieve a command's hop carries
  // (N-QUEUE-09, BULK-04). Four sends, then it fails with the reason (bulk storage plan D3, BULK-05).
  // Until 2026-10-16 the reconciler bypassed `settleNotApplied`, so the cap never ended anything.
  STORE_IN_CASKET: { resend: 'owner', owner: 'convergence for a goal, the command service for a hop', limit: 4, delaysMs: CASKET_ROUND_DELAYS_MS },
  RETRIEVE_FROM_CASKET: { resend: 'owner', owner: 'convergence for a goal, the command service for a hop', limit: 4, delaysMs: CASKET_ROUND_DELAYS_MS },
  // CSF-46: a CSFloat edit the listing read proves not applied fails and is never re-sent. Its
  // own orchestrator would be the sender; flipping this row is the day that is wanted.
  CSFLOAT_CANCEL: { resend: 'never' },
  CSFLOAT_REPRICE: { resend: 'never' },
  // A confirmation is a tap, and a second tap on what is already confirmed changes nothing, so it
  // earns the full schedule. Its owner presses every due one of an account in one call (D12).
  CONFIRM: { resend: 'owner', owner: 'the confirmation service', limit: CONFIRM_RETRY_DELAYS_MS.length + 1, delaysMs: CONFIRM_RETRY_DELAYS_MS },
  // The two hops of a CSFloat delivery a press proves, never the loop (delivery retries plan D3,
  // D4, D5): the trade read every press makes shows an accept still `queued`, and the offers walk
  // the send demands shows no offer for the sale. Neither carries a delay: presses pace them. An
  // accept is harmless to repeat (CSFloat refuses a trade that is not queued), so it earns the
  // cancel's four sends. A send is a create, and its proof is a complete set walk begun after the
  // attempt, so it earns one more than a listing create; a walk showing more than one offer for
  // the sale never resends at all.
  CSFLOAT_ACCEPT: { resend: 'owner', owner: 'the CSFloat delivery, on its next press', limit: 4 },
  CSFLOAT_SEND: { resend: 'owner', owner: 'the CSFloat delivery, on the press that proved it', limit: 3 }
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
 * A resend waits the delay the attempt earned, counted from the proof: the service's always, an
 * owner's when its row names delays (a casket move's round gap), and otherwise an owner's is due at
 * once, because that driver has its own cadence and this table is only its cap.
 */
export function retryPlan(policy: RetryPolicy, attempts: number, provedAt: string): RetryPlan {
  const limit = attemptLimit(policy);
  if (attempts >= limit) return { kind: 'exhausted', attempt: attempts, limit };
  const delayMs = policy.resend === 'never' ? 0 : policy.delaysMs?.[attempts - 1] ?? 0;
  return { kind: 'again', retryAt: new Date(Date.parse(provedAt) + delayMs).toISOString(), attempt: attempts + 1, limit };
}
