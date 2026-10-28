import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountOrderBook, ClockPort } from '@cslytics/ports';
import {
  HttpMarketDataSource, MarketDataScheduler, MarketDataStore, MarketSchemaNewerError, OracleMarketDataSource, OracleMarketWorld,
  type FetchLike, type FillEntry, type FxRates, type MarketDataSource, type OrderBook, type PriceHistory, type SchedulerEvent,
  type SchedulerStatus, type StoredBook, type StoredCurve, type StoredHistory
} from '@cslytics/market-data';
import type { FillState } from '../../shared/market.js';

/**
 * Main's composition of the market-data package (portfolio and pricing plan §3): the cache file,
 * the source, the scheduler and the FX refresh, in one object the IPC handlers talk to.
 *
 * The cache is `market.sqlite` beside `settings.json`; main is its only writer and the engine
 * runtime never opens it. A file stamped above this build is moved aside and a fresh one opened,
 * because it is a cache: the daily history in it is lost, nothing else, and the trading record is
 * untouched. A profile holding `market-seed.json` gets the Oracle source instead of Steam, which is
 * how an offline journey prices a seeded inventory without a network.
 */

export const MARKET_FILE = 'market.sqlite';
export const MARKET_SEED_FILE = 'market-seed.json';

export type MarketSeed = {
  strict?: boolean;
  currency?: number;
  books?: Record<string, OrderBook>;
  /** Names whose book moves on every read, through these books in turn. */
  cycles?: Record<string, OrderBook[]>;
  /** A sales series by name, in place of the synthetic thirty days. */
  histories?: Record<string, PriceHistory>;
  absent?: string[];
  /** An account's own read of a book, by account id then name, in whatever currency it says (plan D17); `null` is a session that answers none. */
  accountBooks?: Record<string, Record<string, OrderBook | null>>;
  fx?: FxRates | null;
};

export const SYSTEM_CLOCK: ClockPort = { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const FX_REFRESH_MS = 12 * 60 * 60_000;
const HISTORY_FRESH_MS = 24 * 60 * 60_000;
const CURVE_FRESH_MS = 24 * 60 * 60_000;
/** How long the open page's read may wait for the scheduler before it answers with the book held. */
export const WATCH_WAIT_MS = 10_000;

export class MarketDataHost {
  readonly store: MarketDataStore;
  readonly source: MarketDataSource;
  readonly scheduler: MarketDataScheduler;
  /** Set when the profile carried a seed: a journey's deterministic market. */
  readonly oracle: OracleMarketWorld | null;
  private readonly clock: ClockPort;
  private fillComplete = false;
  private running: Promise<void> | null = null;
  private fxTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** A journey's seeded books of an account's own; empty on a live profile. */
  private readonly seededBooks: Readonly<Record<string, Readonly<Record<string, OrderBook | null>>>>;

  constructor(
    userData: string,
    private readonly options: {
      fetch: FetchLike;
      userAgent: string;
      onEvent?: (event: SchedulerEvent) => void;
      clock?: ClockPort;
      log?: (message: string, detail?: unknown) => void;
    }
  ) {
    this.store = MarketDataHost.openStore(join(userData, MARKET_FILE), options.log ?? (() => undefined));
    const seed = MarketDataHost.readSeed(join(userData, MARKET_SEED_FILE));
    if (seed === null) {
      this.oracle = null;
      this.source = new HttpMarketDataSource(options.fetch, { userAgent: options.userAgent });
    } else {
      const world = new OracleMarketWorld();
      world.strict = seed.strict === true;
      if (seed.currency !== undefined) world.defaultCurrency = seed.currency;
      for (const [name, book] of Object.entries(seed.books ?? {})) world.setBook(name, book);
      for (const [name, books] of Object.entries(seed.cycles ?? {})) world.setCycle(name, books);
      for (const [name, history] of Object.entries(seed.histories ?? {})) world.histories.set(name, { kind: 'value', value: history });
      for (const name of seed.absent ?? []) world.setAbsent(name);
      if (seed.fx !== undefined) world.fx = seed.fx === null ? { kind: 'absent' } : { kind: 'value', value: seed.fx };
      this.oracle = world;
      this.source = new OracleMarketDataSource(world);
    }
    this.seededBooks = seed?.accountBooks ?? {};
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.scheduler = new MarketDataScheduler({
      source: this.source,
      store: this.store,
      clock: this.clock,
      onEvent: (event) => {
        if (event.kind === 'fill-complete') this.fillComplete = true;
        // A lowered rate or a stop is why prices are slow, and the log is where that is answered.
        if (event.kind === 'rate') options.log?.(`market order-book rate ${event.rps} rps: ${event.reason}`);
        if (event.kind === 'stopped') options.log?.(`market order-book reads stopped until ${event.until}: ${event.reason}`);
        options.onEvent?.(event);
      }
    });
  }

  private static openStore(path: string, log: (message: string, detail?: unknown) => void): MarketDataStore {
    try {
      return MarketDataStore.open(path);
    } catch (error) {
      if (error instanceof MarketSchemaNewerError) {
        const aside = `${path}.newer-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          renameSync(path, aside);
          log(`market.sqlite was written by a newer build (schema ${error.found}); moved to ${aside} and a fresh cache opened`);
          return MarketDataStore.open(path);
        } catch (second) {
          log('market.sqlite could not be moved aside; prices are kept in memory for this run', second);
        }
      } else {
        log('market.sqlite could not be opened; prices are kept in memory for this run', error);
      }
      return MarketDataStore.memory();
    }
  }

  private static readSeed(path: string): MarketSeed | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as MarketSeed : null;
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = this.scheduler.run().catch((error) => this.options.log?.('market scheduler stopped', error));
    void this.refreshFx();
    this.fxTimer = setInterval(() => void this.refreshFx(), FX_REFRESH_MS);
  }

  async stop(): Promise<void> {
    if (this.fxTimer) clearInterval(this.fxTimer);
    this.fxTimer = null;
    this.scheduler.stop();
    await this.running;
    this.running = null;
    this.store.close();
  }

  setVisible(visible: boolean): void {
    this.scheduler.setVisible(visible);
  }

  /** The names the person holds, replacing the last set; the fill starts over for any that lack a book. */
  hold(entries: readonly FillEntry[]): void {
    this.fillComplete = false;
    this.scheduler.setHeld(entries);
  }

  /**
   * What the fill is doing now, for the portfolio's status line. A trickle read in the air is not
   * the fill: only the fill's own queue and in-flight reads make it `filling`.
   */
  fill(): FillState {
    const status = this.scheduler.status();
    if (status.stoppedUntil !== null) return 'stopped';
    if (status.slowedUntil !== null) return 'slowed';
    if (status.paused) return 'paused';
    if (status.fillQueued > 0 || status.fillInFlight > 0) return 'filling';
    if (this.fillComplete || status.fillTotal === 0) return status.reads === 0 && status.fillTotal === 0 ? 'idle' : 'complete';
    return 'filling';
  }

  /**
   * True once every held name has been asked this fill, whatever each answered: the gate on
   * showing a total at all. A stop or a pause does not unmake it; a new held set does.
   */
  valued(): boolean {
    const status = this.scheduler.status();
    return this.fillComplete && status.fillQueued === 0 && status.fillInFlight === 0;
  }

  /** True once every held name has been asked and nothing is in the air: the only state a day's snapshot may be written in. */
  filled(): boolean {
    return this.valued() && this.scheduler.status().inFlight === 0;
  }

  status(): SchedulerStatus {
    return this.scheduler.status();
  }

  async refreshFx(): Promise<void> {
    const answer = await this.source.fx();
    if (answer.parsed.kind === 'ok') this.store.putFx(answer.parsed.value, new Date().toISOString());
    else this.options.log?.(`fx-rates.json was not read: ${answer.parsed.kind === 'unknown' ? answer.parsed.detail : 'absent'}`);
  }

  /** The newest book held for a name, at once, after asking for a fresh one on the demand lane: what the page opens with. */
  ask(name: string): StoredBook | null {
    this.scheduler.demand([name]);
    return this.store.book(name) ?? null;
  }

  /**
   * The open Items page's live read. It asks for the name on the demand lane and answers once that
   * read has landed, so the page shows the book Steam has just served, not the one before it. A
   * name observed within the scheduler's five seconds is not read again, and the call answers at
   * once with that book. The wait is bounded because a paused or stopped scheduler holds the read:
   * the page then gets the held book, shows its age, and asks again.
   */
  async watch(name: string): Promise<StoredBook | null> {
    this.scheduler.demand([name]);
    await Promise.race([this.scheduler.settled(name), this.clock.sleep(WATCH_WAIT_MS)]);
    return this.store.book(name) ?? null;
  }

  /**
   * A journey's seeded book of an account's own, in place of the runtime's session read: only a
   * profile holding `market-seed.json` has any, and a name not seeded is a session answering none.
   */
  seededAccountBook(accountId: string, name: string): AccountOrderBook | null {
    const book = this.seededBooks[accountId]?.[name] ?? null;
    return book === null ? null : { ...book, observedAt: this.clock.now().toISOString() };
  }

  /** The series for a name, fetched on first open and again once it is a day old. One fetch at a time per name. */
  ensureHistory(name: string): Promise<StoredHistory | null> {
    const current = this.store.history(name);
    if (current && Date.now() - Date.parse(current.fetchedAt) < HISTORY_FRESH_MS) return Promise.resolve(current);
    return this.once(`history:${name}`, async () => {
      const answer = await this.source.history(name);
      if (answer.parsed.kind === 'ok') this.store.putHistory(name, answer.parsed.value, new Date().toISOString());
      return this.store.history(name) ?? null;
    });
  }

  /** The curve for a name on a venue, with a 404 recorded so an uncovered name is not asked on every open. */
  ensureCurve(venue: 'csfloat' | 'steam', name: string): Promise<StoredCurve | null> {
    const current = this.store.curve(venue, name);
    if (current && Date.now() - Date.parse(current.fetchedAt) < CURVE_FRESH_MS) return Promise.resolve(current);
    return this.once(`curve:${venue}:${name}`, async () => {
      const answer = await this.source.curve(venue, name);
      const now = new Date().toISOString();
      if (answer.parsed.kind === 'ok') this.store.putCurve(venue, name, answer.parsed.value, now, answer.etag);
      else if (answer.parsed.kind === 'absent') this.store.putCurve(venue, name, null, now, null);
      return this.store.curve(venue, name) ?? null;
    });
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const started = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, started);
    return started;
  }
}
