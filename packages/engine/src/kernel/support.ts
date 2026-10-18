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
 * different accounts must never block each other — see CLAUDE.md rule 8. Nobody waits on a read
 * while holding it: a command's dispatch takes it for admission and for each pass's sends, and
 * lets it go across the reads between them (read broker plan D8).
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
