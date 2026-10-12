/** Small helpers shared by every engine service. Deliberately dependency-free. */

export function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialises work per account.
 *
 * Wallet admission and any other whole-account invariant must not interleave, but two
 * different accounts must never block each other — see CLAUDE.md rule 8.
 */
export class AccountLock {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    this.queues.set(accountId, queued);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.queues.get(accountId) === queued) this.queues.delete(accountId);
    }
  }
}

/**
 * Coalesces concurrent reads of the same thing into one.
 *
 * Two walks of one account's inventory racing is not merely wasteful, it is wrong: each ends by
 * sweeping every item its own observation did not see, so the slower one marks the faster one's
 * items `MISSING`. That is repository rule 5 being broken by a scheduling accident rather than a
 * bad judgement, and it only became reachable once something other than a button could start a
 * walk. Requirements INV-06 asks for exactly this — "coalesce reads for the same account,
 * surface and unit".
 *
 * A caller that arrives while a walk is in flight joins it and receives that walk's answer
 * rather than starting a second. That answer may have *started* before they asked, which is the
 * conservative direction: evidence that predates an attempt cannot prove absence
 * (`kernel/evidence.ts` `postAttempt`), so the worst case is a precondition that stays UNKNOWN
 * for one more pass, never a wrong conclusion.
 *
 * Deliberately not a lock: a key is only ever taken by the read that owns it, so a nested call
 * cannot wait on itself.
 */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const started = work().finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }
}
