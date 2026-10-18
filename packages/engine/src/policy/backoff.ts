import type { BackoffState } from './cadence.js';

/**
 * Exponential backoff with jitter, per account and surface.
 *
 * A user pressing a button retries when they feel like it. A loop retries forever, so the loop
 * needs a decay: a surface that failed five times in a row is not going to succeed on the sixth
 * attempt one interval later, and asking anyway is how an account earns a rate limit.
 *
 * Two things this deliberately does **not** do:
 *
 * - It never decides to re-send a mutation. Backoff applies to *reads*. Repository rule 1 says a
 *   timeout is ambiguous and only a later authoritative observation may conclude anything, so
 *   the only thing that gets rescheduled here is the observation itself.
 * - It is not persisted. The next due time is derivable from the `observation` table, and the
 *   consecutive-failure count is the only thing that is not; a restart resetting it is correct,
 *   because a restart should re-observe. That is why this plan adds no table and no migration.
 */
export const BACKOFF_CEILING_MS = 15 * 60_000;

/**
 * The session is held by another computer running CS2.
 *
 * This gets a flat schedule rather than an escalating one, and a long one. Escalating would be
 * wrong in both directions: retrying faster cannot work while the other client is playing, and
 * backing off to an hour would leave the app dead for an hour after they quit. A minute is often
 * enough to notice, and cheap enough to repeat — see steam/gc-inventory.md on why this is not a
 * network fault.
 */
export const BLOCKED_ELSEWHERE_RETRY_MS = 60_000;

export type Jitter = (spanMs: number) => number;

/** Deterministic in tests, spread in production: full jitter over the computed delay. */
export const defaultJitter: Jitter = (spanMs) => Math.random() * spanMs;

export class BackoffLedger {
  private readonly states = new Map<string, BackoffState>();

  constructor(private readonly jitter: Jitter = defaultJitter) {}

  private key(accountId: string, surface: string): string {
    return `${accountId}:${surface}`;
  }

  state(accountId: string, surface: string): BackoffState | undefined {
    return this.states.get(this.key(accountId, surface));
  }

  /**
   * Records a failed or incomplete read and returns when the next attempt may run.
   *
   * `baseMs` is the surface's own interval, so a surface that is normally read every five
   * minutes backs off from five minutes rather than from an invented constant.
   */
  fail(accountId: string, surface: string, baseMs: number, nowMs: number): BackoffState {
    const previous = this.states.get(this.key(accountId, surface));
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const span = Math.min(baseMs * 2 ** (consecutiveFailures - 1), BACKOFF_CEILING_MS);
    const state = { consecutiveFailures, notBeforeMs: nowMs + span / 2 + this.jitter(span / 2) };
    this.states.set(this.key(accountId, surface), state);
    return state;
  }

  /** A complete observation clears the decay. Nothing partial ever does (rule 5). */
  succeed(accountId: string, surface: string): void {
    this.states.delete(this.key(accountId, surface));
  }

  /** Holds a surface off for a fixed span without counting it as an escalating failure. */
  hold(accountId: string, surface: string, spanMs: number, nowMs: number): void {
    const previous = this.states.get(this.key(accountId, surface));
    this.states.set(this.key(accountId, surface), {
      consecutiveFailures: previous?.consecutiveFailures ?? 0,
      notBeforeMs: nowMs + spanMs
    });
  }

  /** Lifts one scope's hold, failures and all: what a person asking for that scope does. */
  clear(accountId: string, surface: string): void {
    this.states.delete(this.key(accountId, surface));
  }

  forget(accountId: string): void {
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(`${accountId}:`)) this.states.delete(key);
    }
  }
}
