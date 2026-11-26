/**
 * CSFloat's shared request counter, as this process last heard it.
 *
 * `GET /me`, an account's stall, its buy orders and standing, `GET /listings/{id}`, `POST /listings` and
 * `DELETE /buy-orders/{id}` draw on one counter of 50,000 a day, kept per egress IP across every key
 * that calls from it (one key read 48,400 from one address
 * and 49,999 through another in the same second, 2026-11-13). Every account a process holds
 * spends the same counter, so its state is the process's, not an account's.
 *
 * - `open`: more than the reserve is left, or nothing has been heard yet.
 * - `reserve`: the venue says a tenth or less is left. Only work already under way goes on: a sale
 *   already accepted is sent, notified and followed, and a purchase on its way to us is followed. A
 *   new sale is not accepted, because accepting is a promise to deliver; it waits for the reset.
 * - `spent`: the venue refused with a 429, or said nothing is left. Nothing on the counter is sent
 *   until the reset.
 */
export type CsfloatBudgetPhase = 'open' | 'reserve' | 'spent';

export type CsfloatBudgetState = {
  phase: CsfloatBudgetPhase;
  /** The counter's size and what was left, as the last response on it said; null before any. */
  limit: number | null;
  remaining: number | null;
  /** When the venue said the counter resets (ISO), when it said. */
  resetAt: string | null;
  /** When that response arrived (ISO). */
  observedAt: string | null;
};

export type CsfloatBudgetPort = {
  state(): CsfloatBudgetState;
};
