import type { ClockPort } from '@cslytics/ports';

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly clock: ClockPort,
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {
    this.tokens = capacity;
    this.lastRefillMs = clock.now().getTime();
  }

  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.max(1, Math.ceil(1000 / this.refillPerSecond)));
    }
  }

  private refill(): void {
    const now = this.clock.now().getTime();
    const elapsedSeconds = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = now;
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAtMs: number | null = null;

  constructor(
    private readonly clock: ClockPort,
    private readonly failureThreshold = 5,
    private readonly resetAfterMs = 30_000
  ) {}

  canAttempt(): boolean {
    if (this.openedAtMs === null) return true;
    if (this.clock.now().getTime() - this.openedAtMs >= this.resetAfterMs) {
      this.failures = 0;
      this.openedAtMs = null;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = 0;
    this.openedAtMs = null;
  }

  failure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAtMs = this.clock.now().getTime();
  }
}

/** How many automatic reads one surface, and the whole process, may make, and how fast they refill. */
export type ReadBudget = {
  /** Per account, per surface: a small burst then a slow drip. */
  perSurface: { capacity: number; refillPerSecond: number };
  /** Across every account in this process. Sized for twenty lanes without a thundering herd. */
  shared: { capacity: number; refillPerSecond: number };
};

export const READ_BUDGET: ReadBudget = {
  perSurface: { capacity: 4, refillPerSecond: 0.2 },
  shared: { capacity: 8, refillPerSecond: 2 }
};

export class AccountEndpointGovernors {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly shared: TokenBucket;

  constructor(private readonly clock: ClockPort, private readonly readBudget: ReadBudget = READ_BUDGET) {
    this.shared = new TokenBucket(clock, readBudget.shared.capacity, readBudget.shared.refillPerSecond);
  }

  for(accountId: string, endpoint: string, capacity = 3, refillPerSecond = 0.5): { bucket: TokenBucket; breaker: CircuitBreaker } {
    const key = `${accountId}:${endpoint}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.clock, capacity, refillPerSecond);
      this.buckets.set(key, bucket);
    }
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.clock);
      this.breakers.set(key, breaker);
    }
    return { bucket, breaker };
  }

  /**
   * The budget for one automatic read.
   *
   * Takes **two** tokens: the account's own, and one from a bucket every account shares. That
   * is not belt-and-braces, it is the honest response to not knowing the answer to a question
   * nobody has measured — whether Steam counts several accounts behind one IP against one
   * budget or against independent ones
   * (`cslytics-app-docs/plans/completed/continuous-freshness-plan.md` §9.2). Until a probe settles it,
   * the pessimistic assumption is the one in force, because requirements LANE-06 forbids
   * multiplying an assumed-safe per-account rate by twenty lanes and finding out the hard way.
   *
   * Reads had no governor at all before automatic refresh existed: `executeMutation` is the only
   * other caller, and it governs mutations. A user clicking Sync could not out-run Steam; a loop
   * over twenty accounts can.
   */
  async admitRead(accountId: string, surface: string): Promise<CircuitBreaker> {
    const { bucket, breaker } = this.for(accountId, `read:${surface}`, this.readBudget.perSurface.capacity, this.readBudget.perSurface.refillPerSecond);
    await this.shared.take();
    await bucket.take();
    return breaker;
  }
}

