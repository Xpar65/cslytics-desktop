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

  /** Waits on the clock for a token. The mutation path; a read asks `tryTake` and sleeps once, to `nextTokenAtMs`. */
  async take(): Promise<void> {
    while (true) {
      if (this.tryTake()) return;
      await this.clock.sleep(Math.max(1, this.nextTokenAtMs() - this.clock.now().getTime()));
    }
  }

  /** Takes a token if one is there, now, without waiting. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Whether a token is there now. */
  has(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /** When a token will next be there: now when one is, otherwise the refill that brings the count to one. */
  nextTokenAtMs(): number {
    this.refill();
    const nowMs = this.clock.now().getTime();
    if (this.tokens >= 1) return nowMs;
    return nowMs + Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /**
   * Charges a token after the fact, below zero if need be. For a cost learned only once the call
   * has answered, such as a unit read the adapter reports went to the wire: the next reads wait
   * for the refill that pays it back.
   */
  debit(): void {
    this.refill();
    this.tokens = Math.max(-this.capacity, this.tokens - 1);
  }

  private refill(): void {
    const now = this.clock.now().getTime();
    const elapsedSeconds = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = now;
  }
}

/** Consecutive failures that open a breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;
/** How long an open breaker refuses before it lets one attempt through. */
export const BREAKER_RESET_MS = 30_000;

export class CircuitBreaker {
  private failures = 0;
  private openedAtMs: number | null = null;

  constructor(
    private readonly clock: ClockPort,
    private readonly failureThreshold = BREAKER_FAILURE_THRESHOLD,
    private readonly resetAfterMs = BREAKER_RESET_MS
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

  /** Whether the breaker is open now, without the reset `canAttempt` makes once its span has passed. */
  isOpen(): boolean {
    return this.openedAtMs !== null && this.clock.now().getTime() - this.openedAtMs < this.resetAfterMs;
  }

  /** When an open breaker lets the next attempt through; null while it is closed. */
  resetsAtMs(): number | null {
    return this.isOpen() ? this.openedAtMs! + this.resetAfterMs : null;
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

/**
 * The mutations whose pace differs from the default of three at once then one every two seconds,
 * and the budget they share.
 *
 * A casket move goes to this account's own Game Coordinator session, which no one else holds while
 * this app does, so after the default's burst of three it is paced at eight a second, one send
 * every 125 ms (bulk storage plan D1): a thousand moves in about two minutes. The GC admits about
 * nine casket moves a second per account, stores and retrieves alike, across both units, and drops
 * the rest in silence: at ten a second one move in ten was dropped, and at thirteen and above it
 * dropped runs of dozens (casket pace probe, 2026-10-18, corpus `cs2-gc.casket.add`). At eight, 963
 * stores and 611 retrieves landed on their first send. Each kind keeps its own budget and breaker,
 * as every mutation does: a command's pass sends one kind at a time (D6) and the account lock runs
 * one command at a time (D14), so the two never add up to more than one pace.
 */
export const MUTATION_BUDGET: Readonly<Record<string, { key: string; capacity: number; refillPerSecond: number }>> = {
  STORE_IN_CASKET: { key: 'STORE_IN_CASKET', capacity: 3, refillPerSecond: 8 },
  RETRIEVE_FROM_CASKET: { key: 'RETRIEVE_FROM_CASKET', capacity: 3, refillPerSecond: 8 }
};

/**
 * What a read costs: the thing the budget counts (read broker plan D5).
 *
 * `gc-cache` is a read of the session's own object cache, which sends the Game Coordinator nothing
 * and is never metered. `gc-wire` is a message to the GC answered over the session: a unit's
 * contents load, the price sheet. `steam-web` is an HTTP request to the Community site with the
 * account's web session, and `csfloat` one to CSFloat with its key.
 */
export type Transport = 'gc-cache' | 'gc-wire' | 'steam-web' | 'csfloat';
export const TRANSPORTS: readonly Transport[] = ['gc-cache', 'gc-wire', 'steam-web', 'csfloat'];

/**
 * The lane a transport's walks run in. One walk at a time per lane and account: the two Game
 * Coordinator transports share the one session, so loading two units at once would make each
 * unload the other's children; the HTTP venues are one conversation each.
 */
export function laneOf(transport: Transport): 'gc' | 'steam-web' | 'csfloat' {
  return transport === 'gc-cache' || transport === 'gc-wire' ? 'gc' : transport;
}

export type BucketSpec = { capacity: number; refillPerSecond: number };

/**
 * One transport's budget. `perScope` is one bucket per account and scope, which for an HTTP venue
 * is one per endpoint, the thing the venue counts; `perAccount` one per account across every scope
 * of the transport; `shared` one across every account in the process. A transport with none is
 * unmetered: coalesced by scope, never paced.
 */
export type TransportBudget = Readonly<Record<Transport, { perScope?: BucketSpec; perAccount?: BucketSpec; shared?: BucketSpec }>>;

/**
 * The read budgets, by transport.
 *
 * The cache costs nothing. The wire budget for the Game Coordinator is three then five a second
 * (read broker plan §11): a contents load is rare, and a unit of 700 loaded in under a second
 * (casket pace probe, 2026-10-18).
 * The HTTP venues keep the numbers the per-surface read budget had: a burst of four then one
 * every five seconds per endpoint and account, and eight then two a second across the process,
 * because whether Steam counts several accounts behind one IP against one budget or against
 * independent ones is **unmeasured** (continuous freshness plan §9.2) and requirements LANE-06
 * forbids multiplying an assumed-safe rate by twenty lanes to find out.
 */
export const TRANSPORT_BUDGET: TransportBudget = {
  'gc-cache': {},
  'gc-wire': { perAccount: { capacity: 3, refillPerSecond: 5 } },
  'steam-web': { perScope: { capacity: 4, refillPerSecond: 0.2 }, shared: { capacity: 8, refillPerSecond: 2 } },
  csfloat: { perScope: { capacity: 4, refillPerSecond: 0.2 }, shared: { capacity: 8, refillPerSecond: 2 } }
};

export class AccountEndpointGovernors {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly clock: ClockPort, readonly transports: TransportBudget = TRANSPORT_BUDGET) {}

  for(accountId: string, endpoint: string, capacity = 3, refillPerSecond = 0.5): { bucket: TokenBucket; breaker: CircuitBreaker } {
    const key = `${accountId}:${endpoint}`;
    return { bucket: this.bucket(key, { capacity, refillPerSecond }), breaker: this.breaker(key) };
  }

  /** The budget and breaker one kind of mutation is sent under (`MUTATION_BUDGET`, or the default). */
  forMutation(accountId: string, kind: string): { bucket: TokenBucket; breaker: CircuitBreaker } {
    const budget = MUTATION_BUDGET[kind];
    return budget ? this.for(accountId, budget.key, budget.capacity, budget.refillPerSecond) : this.for(accountId, kind);
  }

  /** The breaker of one read scope: it opens on what was read, not on what carried it. */
  breakerFor(accountId: string, scope: string): CircuitBreaker {
    return this.breaker(`${accountId}:read:${scope}`);
  }

  /**
   * Takes the transport's tokens for one read of one scope, now, or takes none and says so. Every
   * bucket the transport names must have one, so a burst never spends the shared bucket on reads
   * the per-scope one then refuses.
   */
  tryAdmitRead(accountId: string, transport: Transport, scope: string): boolean {
    const buckets = this.readBuckets(accountId, transport, scope);
    if (!buckets.every((bucket) => bucket.has())) return false;
    for (const bucket of buckets) bucket.tryTake();
    return true;
  }

  /** When the transport next has a token for this scope: now when it has one. */
  readAdmittedAtMs(accountId: string, transport: Transport, scope: string): number {
    return Math.max(this.clock.now().getTime(), ...this.readBuckets(accountId, transport, scope).map((bucket) => bucket.nextTokenAtMs()));
  }

  /**
   * Takes the transport's tokens, waiting on the clock for them, and answers with the scope's
   * breaker. For the reads the broker does not make: a transfer's trade link and hold, the buy-order
   * status poll, the CSFloat standing read and the delivery's own trade, each a read the surface
   * makes beside the one it answers (read broker plan D12).
   */
  async admitRead(accountId: string, transport: Transport, scope: string): Promise<CircuitBreaker> {
    for (const bucket of this.readBuckets(accountId, transport, scope)) await bucket.take();
    return this.breakerFor(accountId, scope);
  }

  /** Charges a read learned after the call: a unit read the adapter reports went to the wire. */
  debitRead(accountId: string, transport: Transport, scope: string): void {
    for (const bucket of this.readBuckets(accountId, transport, scope)) bucket.debit();
  }

  private readBuckets(accountId: string, transport: Transport, scope: string): TokenBucket[] {
    const budget = this.transports[transport];
    const buckets: TokenBucket[] = [];
    if (budget.shared) buckets.push(this.bucket(`read:${transport}`, budget.shared));
    if (budget.perAccount) buckets.push(this.bucket(`${accountId}:read:${transport}`, budget.perAccount));
    if (budget.perScope) buckets.push(this.bucket(`${accountId}:read:${transport}:${scope}`, budget.perScope));
    return buckets;
  }

  private bucket(key: string, spec: BucketSpec): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.clock, spec.capacity, spec.refillPerSecond);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private breaker(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.clock);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
