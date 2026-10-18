import type { ClockPort } from '@cslytics/ports';
import type { MarketDataSource } from './source.js';
import type { MarketDataStore } from './store.js';

/**
 * Who gets read next, how fast, and when to stop (portfolio and pricing plan D13, §6).
 *
 * Three priorities on one budget: what is on screen, then the fill of every held name, then the
 * trickle that keeps the oldest book fresh. The budget is one token bucket for the whole machine,
 * because the order book is limited per IP and shared with the person's browser; nothing here is
 * keyed by account, because the data has none.
 *
 * It backs off on latency, not only on status: the open-loop run of 2026-10-13 saw no 429 at
 * 5 rps but a p90 of 10.7 s in its last window, and the 2026 market actions endpoint showed
 * overload the same way. Any 429 stops every queue for half an hour, because the order book's 429
 * body has never been captured and the histogram's penalty ran past 25 minutes. A failed or
 * unparseable read keeps the previous book; the store never evicts.
 *
 * The governor's baseline is the median of the run's first ten reads, but never under
 * `baselineFloorMs`: the same run measured a p50 of 641 ms, and a baseline taken from ten fast
 * answers at start-up once made every ordinary read look like overload, so the fill sat at one read
 * a minute and a cached book an hour old was never refreshed.
 *
 * Time comes from a `ClockPort`, so the unit test drives it on a virtual clock.
 */

export type SchedulerOptions = {
  fillRps: number;
  maxInFlight: number;
  trickleRps: number;
  /** How long every queue stops after a 429 or a run of server errors. */
  stopMs: number;
  /** How long an `absent` answer is believed before the name is asked again. */
  absentRetryMs: number;
  /** The first wait after an `unknown` answer; doubles per attempt up to a day. */
  unknownRetryMs: number;
  /** How long a hidden window keeps the trickle before it pauses. */
  hiddenPauseMs: number;
  /** Books older than this are due for the trickle. */
  trickleAfterMs: number;
  /** A name on screen is not re-read within this of its last book. */
  demandMinIntervalMs: number;
  governor: {
    windowMs: number;
    /** The baseline is never taken below this, however fast the first reads were. */
    baselineFloorMs: number;
    /** Median latency at this multiple of the baseline halves the offered rate. */
    halveAt: number;
    /** At this multiple the fill pauses for `pauseMs`. */
    pauseAt: number;
    pauseMs: number;
    /** A window under this multiple of the baseline counts as clean. */
    restoreBelow: number;
    /** Clean for this long restores the full rate. */
    restoreAfterMs: number;
  };
};

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  fillRps: 4,
  maxInFlight: 8,
  trickleRps: 0.25,
  stopMs: 30 * 60_000,
  absentRetryMs: 7 * 24 * 60 * 60_000,
  unknownRetryMs: 60 * 60_000,
  hiddenPauseMs: 10 * 60_000,
  trickleAfterMs: 15 * 60_000,
  demandMinIntervalMs: 5_000,
  governor: { windowMs: 10_000, baselineFloorMs: 600, halveAt: 2, pauseAt: 4, pauseMs: 60_000, restoreBelow: 1.5, restoreAfterMs: 60_000 }
};

export type SchedulerEvent =
  | { kind: 'book'; name: string }
  | { kind: 'absent'; name: string }
  | { kind: 'unknown'; name: string; detail: string }
  | { kind: 'stopped'; until: string; reason: string }
  | { kind: 'rate'; rps: number; reason: string }
  | { kind: 'fill-complete'; names: number }
  | { kind: 'fill-progress'; done: number; total: number };

export type SchedulerStatus = {
  running: boolean;
  visible: boolean;
  /** Nothing is being dispatched: the window is hidden past its grace, or the governor paused. */
  paused: boolean;
  /** Set while the governor holds the queues for latency; `null` for a hidden-window pause. */
  slowedUntil: string | null;
  stoppedUntil: string | null;
  /** The configured fill rate, so a reader can tell an offered rate below it was lowered. */
  fillRps: number;
  offeredRps: number;
  inFlight: number;
  /** Reads in the air that the fill dispatched, as opposed to the demand or trickle lanes. */
  fillInFlight: number;
  demandQueued: number;
  fillQueued: number;
  fillTotal: number;
  fillDone: number;
  lastLatencyMs: number | null;
  medianLatencyMs: number | null;
  baselineMs: number | null;
  reads: number;
  lastEvent: string | null;
};

/** A held name and, when known, the cents it is worth, which orders the trickle. */
export type FillEntry = { name: string; weightCents?: number };

export class MarketDataScheduler {
  private readonly options: SchedulerOptions;
  private readonly demandQueue: string[] = [];
  private readonly demandSet = new Set<string>();
  private fill = new Map<string, number>();
  private fillPending: string[] = [];
  private fillDone = 0;
  private fillTotal = 0;
  private fillInFlight = 0;
  /** Every name dispatched this run, on any lane: a stale cached book is the fill's until it is asked. */
  private readonly asked = new Set<string>();
  private readonly inFlight = new Set<string>();
  private running = false;
  private stopRequested: (() => void) | null = null;
  private visible = true;
  private hiddenSinceMs: number | null = null;
  private stoppedUntilMs: number | null = null;
  private offeredRps: number;
  private nextSlotMs = 0;
  private consecutiveServerErrors = 0;
  private readonly latencies: Array<{ atMs: number; ms: number }> = [];
  private baselineMs: number | null = null;
  private baselineSamples: number[] = [];
  private cleanSinceMs: number | null = null;
  private pausedUntilMs: number | null = null;
  private lastLatencyMs: number | null = null;
  private lastEvent: string | null = null;
  private reads = 0;
  private lastObserved = new Map<string, number>();
  /** Names the store said not to ask again before a time, by that time. */
  private readonly due = new Map<string, number>();

  constructor(
    private readonly deps: { source: MarketDataSource; store: MarketDataStore; clock: ClockPort; onEvent?: (event: SchedulerEvent) => void },
    options: Partial<SchedulerOptions> = {}
  ) {
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options, governor: { ...DEFAULT_SCHEDULER_OPTIONS.governor, ...(options.governor ?? {}) } };
    this.offeredRps = this.options.fillRps;
  }

  /**
   * Names on screen right now. Read before anything else, newest request first. A name observed
   * within `demandMinIntervalMs` is not asked again: the book changes on a ~5 s cadence, so a page
   * opened and closed twenty times costs one read per five seconds, not twenty.
   */
  demand(names: readonly string[]): void {
    const nowMs = this.deps.clock.now().getTime();
    for (const name of names) {
      if (this.demandSet.has(name) || this.inFlight.has(name)) continue;
      const observed = this.lastObserved.get(name);
      if (observed !== undefined && nowMs - observed < this.options.demandMinIntervalMs) continue;
      this.demandSet.add(name);
      this.demandQueue.unshift(name);
    }
  }

  /**
   * The names the person holds, replacing the last set. Names without a book, or whose last
   * answer is due again, join the fill; the rest are the trickle's to keep fresh. Weights order
   * the trickle so a case stack refreshes before a single sticker.
   *
   * A name not yet asked this run whose cached book is already past the trickle's age joins the
   * fill too: a book from last session is read at the fill rate on launch, not one per four
   * seconds behind everything the fill has to say. It stays the fill's until it is asked, because
   * the set is replaced a second or two into any fill; once asked it is the trickle's, so a held
   * set replaced on every walk re-reads nothing.
   *
   * A set that arrives mid-fill extends the count rather than restarting it: the window replaces
   * the held set on every valuation, which is after every book, and a progress line that went
   * back to zero four times a second said nothing.
   */
  setHeld(entries: readonly FillEntry[]): void {
    this.fill = new Map(entries.map((entry) => [entry.name, entry.weightCents ?? 0]));
    const names = [...this.fill.keys()];
    this.lastObserved = new Map([...this.deps.store.observedAt(names)].map(([name, at]) => [name, Date.parse(at)]));
    const statuses = this.deps.store.statuses(names);
    const nowMs = this.deps.clock.now().getTime();
    this.due.clear();
    for (const status of statuses.values()) if (status.notBefore !== null) this.due.set(status.name, Date.parse(status.notBefore));
    const pending = names.filter((name) => {
      if (this.inFlight.has(name)) return false;
      const status = statuses.get(name);
      if (status === undefined) return true;
      if (status.kind === 'ok') {
        const observed = this.lastObserved.get(name);
        if (observed === undefined) return true;
        return !this.asked.has(name) && nowMs - observed >= this.options.trickleAfterMs;
      }
      const due = this.due.get(name);
      return due === undefined || due <= nowMs;
    });
    pending.sort((a, b) => (this.fill.get(b) ?? 0) - (this.fill.get(a) ?? 0) || a.localeCompare(b));
    const running = this.fillPending.length > 0 || this.fillInFlight > 0;
    this.fillPending = pending;
    if (running) {
      this.fillTotal = this.fillDone + this.fillInFlight + pending.length;
    } else {
      this.fillTotal = pending.length;
      this.fillDone = 0;
    }
    if (pending.length === 0 && this.fillInFlight === 0) this.emit({ kind: 'fill-complete', names: this.fillTotal });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.hiddenSinceMs = visible ? null : this.deps.clock.now().getTime();
  }

  status(): SchedulerStatus {
    const nowMs = this.deps.clock.now().getTime();
    return {
      running: this.running,
      visible: this.visible,
      paused: this.isPaused(nowMs),
      slowedUntil: this.pausedUntilMs !== null && this.pausedUntilMs > nowMs ? new Date(this.pausedUntilMs).toISOString() : null,
      stoppedUntil: this.stoppedUntilMs !== null && this.stoppedUntilMs > nowMs ? new Date(this.stoppedUntilMs).toISOString() : null,
      fillRps: this.options.fillRps,
      offeredRps: this.offeredRps,
      inFlight: this.inFlight.size,
      fillInFlight: this.fillInFlight,
      demandQueued: this.demandQueue.length,
      fillQueued: this.fillPending.length,
      fillTotal: this.fillTotal,
      fillDone: this.fillDone,
      lastLatencyMs: this.lastLatencyMs,
      medianLatencyMs: this.medianLatency(nowMs),
      baselineMs: this.baselineMs,
      reads: this.reads,
      lastEvent: this.lastEvent
    };
  }

  /** Runs until `stop()`; resolves when the loop has exited and nothing is in flight. */
  async run(): Promise<void> {
    if (this.running) throw new Error('scheduler already running');
    this.running = true;
    let stop = false;
    this.stopRequested = () => { stop = true; };
    try {
      while (!stop) {
        const nowMs = this.deps.clock.now().getTime();
        if (this.stoppedUntilMs !== null && this.stoppedUntilMs > nowMs) { await this.deps.clock.sleep(1_000); continue; }
        if (this.isPaused(nowMs)) { await this.deps.clock.sleep(1_000); continue; }
        if (this.inFlight.size >= this.options.maxInFlight) { await this.deps.clock.sleep(50); continue; }
        const next = this.pick(nowMs);
        if (next === null) { await this.deps.clock.sleep(1_000); continue; }
        const rps = next.lane === 'trickle' ? this.options.trickleRps : this.offeredRps;
        const slotMs = Math.max(this.nextSlotMs, nowMs);
        if (slotMs > nowMs) {
          // Wait for the slot, then pick again: a 429 that landed meanwhile must stop this
          // dispatch too, and a name shown on screen meanwhile outranks the one picked.
          this.requeue(next);
          await this.deps.clock.sleep(slotMs - nowMs);
          continue;
        }
        this.nextSlotMs = slotMs + 1_000 / rps;
        void this.read(next.name, next.lane);
      }
    } finally {
      while (this.inFlight.size > 0) await this.deps.clock.sleep(10);
      this.running = false;
      this.stopRequested = null;
    }
  }

  stop(): void {
    this.stopRequested?.();
  }

  /**
   * Past the hidden grace everything holds, the demand queue included: a hidden renderer's
   * timers are throttled, not stopped, so an item page left open would otherwise keep reading
   * all night. The names stay queued and are served first when the window shows again.
   */
  private isPaused(nowMs: number): boolean {
    if (this.pausedUntilMs !== null && this.pausedUntilMs > nowMs) return true;
    return !this.visible && this.hiddenSinceMs !== null && nowMs - this.hiddenSinceMs >= this.options.hiddenPauseMs;
  }

  private requeue(next: { name: string; lane: 'demand' | 'fill' | 'trickle' }): void {
    if (next.lane === 'demand') {
      if (!this.demandSet.has(next.name)) { this.demandSet.add(next.name); this.demandQueue.unshift(next.name); }
    } else if (next.lane === 'fill') {
      this.fillPending.unshift(next.name);
    }
    // A trickle candidate is recomputed from the held set on the next pick.
  }

  private pick(nowMs: number): { name: string; lane: 'demand' | 'fill' | 'trickle' } | null {
    while (this.demandQueue.length > 0) {
      const name = this.demandQueue.shift()!;
      this.demandSet.delete(name);
      if (!this.inFlight.has(name)) return { name, lane: 'demand' };
    }
    while (this.fillPending.length > 0) {
      const name = this.fillPending.shift()!;
      if (!this.inFlight.has(name)) return { name, lane: 'fill' };
    }
    // The trickle: among held names with a book, the one whose age × weight is largest, once it
    // is older than `trickleAfterMs`. A hidden window past its grace has no trickle at all.
    if (!this.visible && this.hiddenSinceMs !== null && nowMs - this.hiddenSinceMs >= this.options.hiddenPauseMs) return null;
    let best: { name: string; score: number } | null = null;
    for (const [name, weight] of this.fill) {
      if (this.inFlight.has(name)) continue;
      const due = this.due.get(name);
      if (due !== undefined && due > nowMs) continue;
      const observed = this.lastObserved.get(name);
      if (observed === undefined) continue;
      const age = nowMs - observed;
      if (age < this.options.trickleAfterMs) continue;
      const score = age * (1 + Math.log10(1 + Math.max(0, weight) / 100));
      if (best === null || score > best.score) best = { name, score };
    }
    return best === null ? null : { name: best.name, lane: 'trickle' };
  }

  /**
   * One read, from dispatch to the store. Nothing here may throw out: the loop fires reads with
   * `void`, so an exception would be an unhandled rejection with the name lost. A store write
   * that fails is recorded on the name as unknown and reported, and the loop goes on.
   *
   * The fill's count moves here, on every exit, so a name whose write failed still counts as
   * asked: a fill is complete when every name has been asked, whatever each answered.
   */
  private async read(name: string, lane: 'demand' | 'fill' | 'trickle'): Promise<void> {
    this.inFlight.add(name);
    this.asked.add(name);
    if (lane === 'fill') this.fillInFlight += 1;
    try {
      await this.readInner(name);
    } catch (error) {
      const detail = `read failed: ${error instanceof Error ? error.message : String(error)}`;
      this.lastEvent = 'unknown';
      try {
        const nowMs = this.deps.clock.now().getTime();
        this.deps.store.markUnknown(name, new Date(nowMs).toISOString(), detail, new Date(nowMs + this.options.unknownRetryMs).toISOString());
        this.due.set(name, nowMs + this.options.unknownRetryMs);
      } catch {
        // The store itself is failing; the event below is all that can be said.
      }
      this.emit({ kind: 'unknown', name, detail });
    } finally {
      this.inFlight.delete(name);
      if (lane === 'fill') {
        this.fillInFlight -= 1;
        this.fillDone += 1;
        this.emit({ kind: 'fill-progress', done: this.fillDone, total: this.fillTotal });
        if (this.fillPending.length === 0 && this.fillInFlight === 0) this.emit({ kind: 'fill-complete', names: this.fillTotal });
      }
    }
  }

  private async readInner(name: string): Promise<void> {
    {
      const answer = await this.deps.source.book(name);
      const now = this.deps.clock.now();
      const nowMs = now.getTime();
      this.reads += 1;
      this.lastLatencyMs = answer.latencyMs;
      if (answer.status === 429) {
        this.stopAll(nowMs, 'HTTP 429');
      } else if (answer.status === null || answer.status >= 500) {
        // No answer at all is the overload signal past the abort, so it counts with a 5xx towards
        // the stop and its latency (the timeout) reaches the governor like any other.
        this.consecutiveServerErrors += 1;
        if (answer.status === null) this.govern(nowMs, answer.latencyMs);
        if (this.consecutiveServerErrors >= 3) this.stopAll(nowMs, answer.status === null ? `${this.consecutiveServerErrors} reads without an answer in a row` : `${this.consecutiveServerErrors} server errors in a row`);
      } else {
        this.consecutiveServerErrors = 0;
      }
      if (answer.parsed.kind === 'ok') {
        this.deps.store.putBook(name, answer.parsed.value, now.toISOString());
        this.lastObserved.set(name, nowMs);
        this.due.delete(name);
        this.emit({ kind: 'book', name });
        this.govern(nowMs, answer.latencyMs);
      } else if (answer.parsed.kind === 'absent') {
        const notBefore = nowMs + this.options.absentRetryMs;
        this.deps.store.markAbsent(name, now.toISOString(), new Date(notBefore).toISOString());
        this.due.set(name, notBefore);
        this.emit({ kind: 'absent', name });
        this.govern(nowMs, answer.latencyMs);
      } else {
        const attempts = (this.deps.store.status(name)?.attempts ?? 0) + 1;
        const wait = Math.min(this.options.unknownRetryMs * 2 ** Math.min(attempts - 1, 10), 24 * 60 * 60_000);
        this.deps.store.markUnknown(name, now.toISOString(), answer.parsed.detail, new Date(nowMs + wait).toISOString());
        this.due.set(name, nowMs + wait);
        this.emit({ kind: 'unknown', name, detail: answer.parsed.detail });
      }
    }
  }

  private stopAll(nowMs: number, reason: string): void {
    this.stoppedUntilMs = nowMs + this.options.stopMs;
    this.emit({ kind: 'stopped', until: new Date(this.stoppedUntilMs).toISOString(), reason });
  }

  private govern(nowMs: number, latencyMs: number): void {
    const { governor } = this.options;
    this.latencies.push({ atMs: nowMs, ms: latencyMs });
    while (this.latencies.length > 0 && this.latencies[0]!.atMs < nowMs - governor.windowMs) this.latencies.shift();
    if (this.baselineMs === null) {
      this.baselineSamples.push(latencyMs);
      if (this.baselineSamples.length >= 10) this.baselineMs = Math.max(median(this.baselineSamples), governor.baselineFloorMs);
      return;
    }
    const current = this.medianLatency(nowMs);
    if (current === null) return;
    if (current >= this.baselineMs * governor.pauseAt) {
      this.pausedUntilMs = nowMs + governor.pauseMs;
      this.cleanSinceMs = null;
      this.setRate(Math.max(0.5, this.offeredRps / 2), `median latency ${Math.round(current)} ms is ${governor.pauseAt}× the baseline; pausing`);
    } else if (current >= this.baselineMs * governor.halveAt) {
      this.cleanSinceMs = null;
      if (this.offeredRps > 0.5) this.setRate(Math.max(0.5, this.offeredRps / 2), `median latency ${Math.round(current)} ms is ${governor.halveAt}× the baseline`);
    } else if (current < this.baselineMs * governor.restoreBelow) {
      this.cleanSinceMs ??= nowMs;
      if (this.offeredRps < this.options.fillRps && nowMs - this.cleanSinceMs >= governor.restoreAfterMs) {
        this.setRate(this.options.fillRps, 'latency back near its baseline');
      }
    }
  }

  private setRate(rps: number, reason: string): void {
    if (rps === this.offeredRps) return;
    this.offeredRps = rps;
    this.emit({ kind: 'rate', rps, reason });
  }

  private medianLatency(nowMs: number): number | null {
    const recent = this.latencies.filter((sample) => sample.atMs >= nowMs - this.options.governor.windowMs).map((sample) => sample.ms);
    return recent.length === 0 ? null : median(recent);
  }

  private emit(event: SchedulerEvent): void {
    this.lastEvent = event.kind;
    this.deps.onEvent?.(event);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
