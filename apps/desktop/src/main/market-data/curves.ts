import type { ClockPort } from '@cslytics/ports';
import type { StoredCurve } from '@cslytics/market-data';
import type { CurveFillState, CurveFillStatus } from '../../shared/market.js';

export type { CurveFillState, CurveFillStatus };

/**
 * The curve fill: CSlytics's Steam float curve for every skin the person holds (portfolio and
 * pricing plan D7, D18), so the portfolio's float value can price each one at its own float.
 *
 * Curves are behind the sign-in and the member route allows 2,000 curve requests an hour to one
 * person, shared with the website and the Items page (pricing behind sign-in plan §5.1). So the fill
 * asks only for what it lacks: a name whose copy is under a day old is not asked, a held copy is
 * revalidated with its ETag, and a held copy prices the skin while it is revalidated. It asks at a
 * steady rate with a few in the air, stops itself at an hourly budget under the route's, and honours
 * a 429's `Retry-After`. Without `curves.steam` in the grant it asks nothing, and no skin has a
 * float value.
 *
 * `settled()` is what the float value waits for (plan D18), never the market value: every held name
 * has a copy or has been asked this run. A name the budget or a 429 has put off counts as asked for
 * the hour, and stays at the mid price in the float value until then, because a figure held back for
 * an hour reads as broken.
 *
 * Time comes from a `ClockPort`, so the unit test drives it on a virtual clock.
 */

export type CurveFetchOutcome =
  | 'stored' | 'unchanged' | 'absent'
  /** No request was made: the issuer gave no token. */
  | 'no-token'
  | 'unauthenticated' | 'forbidden' | 'rate-limited'
  /** A transport fault, a 5xx, a 503 before the first generation, or a body that did not parse. */
  | 'unavailable';

export type CurveFetch = { outcome: CurveFetchOutcome; curve: StoredCurve | null; retryAfterSeconds: number | null };

export type CurveFillOptions = {
  rps: number;
  concurrency: number;
  /** Requests a rolling hour may hold, under the route's 2,000 so the website and the Items page keep theirs. */
  hourlyBudget: number;
  /** How old a copy may be before it is asked again: the curves are generated daily. */
  freshMs: number;
  /** After a failure, before the same name is asked again. */
  retryMs: number;
};

export const DEFAULT_CURVE_FILL_OPTIONS: CurveFillOptions = {
  rps: 4,
  concurrency: 4,
  hourlyBudget: 1_500,
  freshMs: 24 * 60 * 60_000,
  retryMs: 15 * 60_000
};

const HOUR_MS = 60 * 60_000;

export class CurveFill {
  private readonly options: CurveFillOptions;
  /** Held names, heaviest first. */
  private held: string[] = [];
  /** When each held name's copy was fetched, or `null` when there is none. */
  private readonly fetchedAt = new Map<string, number | null>();
  /** When each name was last asked, whatever it answered. */
  private readonly attemptedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly requests: number[] = [];
  private nextSlotMs = 0;
  private pausedUntilMs = 0;
  private deferredBy: CurveFillStatus['deferredBy'] = null;
  private running = false;
  private wake: (() => void) | null = null;
  private readonly settling = new Set<Promise<void>>();
  private lastSettled = true;

  constructor(
    private readonly deps: {
      /** One curve, through the host's gate: token, 401 once, 403 to main, 304 kept, 404 recorded. */
      fetch: (name: string) => Promise<CurveFetch>;
      /** The copies held, by name, in one read. */
      records: (names: readonly string[]) => ReadonlyMap<string, StoredCurve>;
      /** Whether the grant holds `curves.steam` now. */
      granted: () => boolean;
      clock: ClockPort;
      /** A curve landed or the fill settled: the window re-reads the valuation. */
      onChange?: () => void;
      log?: (message: string, detail?: unknown) => void;
    },
    options: Partial<CurveFillOptions> = {}
  ) {
    this.options = { ...DEFAULT_CURVE_FILL_OPTIONS, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.wake?.();
  }

  /**
   * The skins held now, heaviest first, replacing the last set. A name already held keeps what is
   * known about it, so a valuation read after every landed book extends the fill rather than
   * restarting it.
   */
  hold(names: readonly string[]): void {
    const unique = [...new Set(names)];
    const fresh = unique.filter((name) => !this.fetchedAt.has(name));
    if (fresh.length > 0) {
      const records = this.deps.records(fresh);
      for (const name of fresh) {
        const record = records.get(name);
        const at = record === undefined ? null : Date.parse(record.fetchedAt);
        this.fetchedAt.set(name, at === null || Number.isNaN(at) ? null : at);
      }
    }
    const keep = new Set(unique);
    for (const name of [...this.fetchedAt.keys()]) if (!keep.has(name)) { this.fetchedAt.delete(name); this.attemptedAt.delete(name); }
    this.held = unique;
    this.wake?.();
  }

  /** The grant moved: a stop for want of a sign-in is lifted and the fill looks again at once. */
  grantChanged(): void {
    if (this.deferredBy === 'sign-in') { this.pausedUntilMs = 0; this.deferredBy = null; }
    this.wake?.();
  }

  /** Every held name has a copy or has been asked this run, or the fill cannot ask now: the float value may show. */
  settled(): boolean {
    const now = this.deps.clock.now().getTime();
    if (!this.deps.granted() || this.pausedUntilMs > now) return true;
    return !this.held.some((name) => this.blocking(name));
  }

  /** True while a curve request is in the air. */
  busy(): boolean {
    return this.inFlight.size > 0;
  }

  status(): CurveFillStatus {
    const now = this.deps.clock.now().getTime();
    const total = this.held.length;
    const due = this.held.filter((name) => this.due(name, now)).length;
    const deferred = this.pausedUntilMs > now;
    const state: CurveFillState = !this.deps.granted() ? 'no-feature'
      : deferred ? 'deferred'
        : total === 0 ? 'idle'
          : due > 0 || this.inFlight.size > 0 ? 'filling' : 'complete';
    return {
      state, done: total - due, total,
      resumesAt: deferred ? new Date(this.pausedUntilMs).toISOString() : null,
      deferredBy: deferred ? this.deferredBy : null
    };
  }

  /**
   * Dispatch what may go now, at most one a slot, and say how long until there may be more to do.
   * The loop sleeps that long or until woken; a test calls it directly on a virtual clock.
   */
  tick(): number {
    const now = this.deps.clock.now().getTime();
    this.noteSettled();
    if (!this.deps.granted()) return 60_000;
    if (this.pausedUntilMs > now) return this.pausedUntilMs - now;
    if (this.inFlight.size >= this.options.concurrency) return 60_000;
    if (now < this.nextSlotMs) return this.nextSlotMs - now;
    while (this.requests.length > 0 && this.requests[0]! <= now - HOUR_MS) this.requests.shift();
    const name = this.held.find((entry) => !this.inFlight.has(entry) && this.due(entry, now));
    if (name === undefined) {
      // Nothing due: wake when the next retry or the next copy comes due, or in a minute.
      const next = Math.min(...this.held.map((entry) => this.dueAt(entry)).filter((at) => at > now), now + 60_000);
      return Math.max(1_000, next - now);
    }
    if (this.requests.length >= this.options.hourlyBudget) {
      this.pause(this.requests[0]! + HOUR_MS, 'budget');
      this.deps.log?.(`curves: ${this.options.hourlyBudget} asked in the last hour; the rest wait until ${new Date(this.pausedUntilMs).toISOString()}`);
      return this.pausedUntilMs - now;
    }
    this.dispatch(name, now);
    this.nextSlotMs = now + Math.ceil(1_000 / this.options.rps);
    return this.nextSlotMs - now;
  }

  /** Every request in the air has answered: for a test. */
  async drain(): Promise<void> {
    while (this.settling.size > 0) await Promise.all([...this.settling]);
  }

  private dispatch(name: string, now: number): void {
    this.inFlight.add(name);
    this.requests.push(now);
    const settled = this.deps.fetch(name)
      .catch((error: unknown): CurveFetch => {
        this.deps.log?.(`curve ${name}: the request threw`, error);
        return { outcome: 'unavailable', curve: null, retryAfterSeconds: null };
      })
      .then((answer) => this.record(name, answer))
      .finally(() => {
        this.inFlight.delete(name);
        this.settling.delete(settled);
        this.noteSettled();
        this.wake?.();
      });
    this.settling.add(settled);
  }

  private record(name: string, answer: CurveFetch): void {
    const now = this.deps.clock.now().getTime();
    this.attemptedAt.set(name, now);
    if (!this.fetchedAt.has(name)) return;
    switch (answer.outcome) {
      case 'stored':
      case 'absent':
        this.fetchedAt.set(name, now);
        this.deps.onChange?.();
        return;
      case 'unchanged':
        this.fetchedAt.set(name, now);
        return;
      case 'rate-limited':
        this.pause(now + (answer.retryAfterSeconds !== null ? answer.retryAfterSeconds * 1_000 : this.options.retryMs), 'server');
        return;
      case 'no-token':
      case 'unauthenticated':
      case 'forbidden':
        // The sign-in is the problem, not the name: nothing more is asked until the grant moves.
        this.pause(now + this.options.retryMs, 'sign-in');
        return;
      case 'unavailable':
        return;
    }
  }

  private pause(untilMs: number, by: NonNullable<CurveFillStatus['deferredBy']>): void {
    if (untilMs <= this.pausedUntilMs) return;
    this.pausedUntilMs = untilMs;
    this.deferredBy = by;
    this.deps.onChange?.();
  }

  /** No copy, and never asked this run: the total waits for it. */
  private blocking(name: string): boolean {
    return this.fetchedAt.get(name) == null && !this.attemptedAt.has(name);
  }

  private due(name: string, now: number): boolean {
    return this.dueAt(name) <= now;
  }

  /** When a name is next to be asked: once its copy is a day old, and not within the retry wait of its last ask. */
  private dueAt(name: string): number {
    const fetched = this.fetchedAt.get(name) ?? null;
    const stale = fetched === null ? 0 : fetched + this.options.freshMs;
    const attempted = this.attemptedAt.get(name);
    const retry = attempted === undefined || (fetched !== null && fetched >= attempted) ? 0 : attempted + this.options.retryMs;
    return Math.max(stale, retry);
  }

  /** Tell main once when the fill becomes settled, so the float value waiting on it is shown. */
  private noteSettled(): void {
    const now = this.settled();
    if (now && !this.lastSettled) this.deps.onChange?.();
    this.lastSettled = now;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let wait: number;
      try {
        wait = this.tick();
      } catch (error) {
        this.deps.log?.('curve fill failed', error);
        wait = this.options.retryMs;
      }
      await Promise.race([this.deps.clock.sleep(Math.max(1, wait)), new Promise<void>((resolve) => { this.wake = resolve; })]);
      this.wake = null;
    }
  }
}
