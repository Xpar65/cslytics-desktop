import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountOrderBook, ClockPort } from '@cslytics/ports';
import {
  HttpMarketDataSource, MarketDataScheduler, MarketDataStore, MarketSchemaNewerError, OracleMarketDataSource, OracleMarketWorld,
  type CurveDoc, type FetchLike, type FillEntry, type FxRates, type MarketDataSource, type OrderBook, type PriceHistory, type PriceSnapshot, type SchedulerEvent,
  type SchedulerStatus, type StoredBook, type StoredCurve, type StoredHistory, type StoredPrice, type StoredPriceSnapshot
} from '@cslytics/market-data';
import type { FillState } from '../../shared/market.js';
import { CurveFill, type CurveFetch } from './curves.js';

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
  /** A published float curve by `venue:name`, in place of the member route's; a name not seeded is absent. */
  curves?: Record<string, CurveDoc>;
  absent?: string[];
  /** An account's own read of a book, by account id then name, in whatever currency it says (plan D17); `null` is a session that answers none. */
  accountBooks?: Record<string, Record<string, OrderBook | null>>;
  fx?: FxRates | null;
  /** CSlytics's member snapshot (portfolio prices plan §7.6); unset, the route answers 404. */
  prices?: PriceSnapshot;
  /** The gate's answer in place of a document: 401, 403 or 429. */
  pricesStatus?: number;
};

export const SYSTEM_CLOCK: ClockPort = { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const FX_REFRESH_MS = 12 * 60 * 60_000;
const HISTORY_FRESH_MS = 24 * 60 * 60_000;
const CURVE_FRESH_MS = 24 * 60 * 60_000;
/** How long the open page's read may wait for the scheduler before it answers with the book held. */
export const WATCH_WAIT_MS = 10_000;
/**
 * How old a snapshot's generation may be and still cover a name (portfolio prices plan D9): one
 * missed hourly push and a late one. Past it, every name is the fill's again, because a stale
 * snapshot shown as the hour's is the one lie this surface could tell.
 */
export const SNAPSHOT_FRESH_MS = 3 * 60 * 60_000;

export class MarketDataHost {
  readonly store: MarketDataStore;
  readonly source: MarketDataSource;
  readonly scheduler: MarketDataScheduler;
  /**
   * CSlytics's Steam curve for every held skin, for the float value (portfolio and pricing plan D7,
   * D18). Main starts it once the stored sign-in has been read, as it does the price snapshot, so
   * the first ask has a token. The market value never waits for it.
   */
  readonly curves: CurveFill;
  /** Set when the profile carried a seed: a journey's deterministic market. */
  readonly oracle: OracleMarketWorld | null;
  private readonly clock: ClockPort;
  private fillComplete = false;
  /** How many held names the snapshot covered at the last `hold`: a fill of nothing over a covered profile is complete, not idle. */
  private lastCovered = 0;
  private running: Promise<void> | null = null;
  private fxTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** A journey's seeded books of an account's own; empty on a live profile. */
  private readonly seededBooks: Readonly<Record<string, Readonly<Record<string, OrderBook | null>>>>;

  constructor(
    userData: string,
    private readonly options: {
      fetch: FetchLike;
      /** The bearer transport for the member namespace (portfolio prices plan D11); without it the snapshot is asked through `fetch`. */
      memberFetch?: FetchLike;
      userAgent: string;
      /** Whether the grant holds the snapshot's feature now; absent, no snapshot ever covers a name. */
      snapshotGranted?: () => boolean;
      /**
       * An access token for a curve request, freshly minted when `fresh` (pricing behind sign-in plan
       * §7.4); `null` when the account has none to give. Absent, no curve is ever asked for.
       */
      curveBearer?: (fresh: boolean) => Promise<string | null>;
      /** The API refused a curve's feature: the grant main holds is stale, and main asks the website again. */
      onCurveForbidden?: () => void;
      /**
       * Whether the grant holds `curves.steam` now: the curve fill asks for every held skin's Steam
       * curve only while it does. Absent, the fill asks nothing and no skin has a float value.
       */
      curvesGranted?: () => boolean;
      /** A held skin's curve landed, or the curve fill settled: the window re-reads the valuation. */
      onCurvesChanged?: () => void;
      onEvent?: (event: SchedulerEvent) => void;
      clock?: ClockPort;
      log?: (message: string, detail?: unknown) => void;
    }
  ) {
    this.store = MarketDataHost.openStore(join(userData, MARKET_FILE), options.log ?? (() => undefined));
    const seed = MarketDataHost.readSeed(join(userData, MARKET_SEED_FILE));
    if (seed === null) {
      this.oracle = null;
      this.source = new HttpMarketDataSource(options.fetch, { userAgent: options.userAgent, ...(options.memberFetch ? { memberFetch: options.memberFetch } : {}) });
    } else {
      const world = new OracleMarketWorld();
      world.strict = seed.strict === true;
      if (seed.currency !== undefined) world.defaultCurrency = seed.currency;
      for (const [name, book] of Object.entries(seed.books ?? {})) world.setBook(name, book);
      for (const [name, books] of Object.entries(seed.cycles ?? {})) world.setCycle(name, books);
      for (const [name, history] of Object.entries(seed.histories ?? {})) world.histories.set(name, { kind: 'value', value: history });
      for (const [key, doc] of Object.entries(seed.curves ?? {})) world.curves.set(key, { kind: 'value', value: doc });
      for (const name of seed.absent ?? []) world.setAbsent(name);
      if (seed.fx !== undefined) world.fx = seed.fx === null ? { kind: 'absent' } : { kind: 'value', value: seed.fx };
      if (seed.prices !== undefined) world.prices = { kind: 'value', value: seed.prices };
      else if (seed.pricesStatus !== undefined) world.prices = { kind: 'status', status: seed.pricesStatus };
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
    this.curves = new CurveFill({
      fetch: (name) => this.fetchCurve('steam', name),
      records: (names) => this.store.curves('steam', names),
      granted: () => options.curvesGranted?.() ?? false,
      clock: this.clock,
      ...(options.onCurvesChanged ? { onChange: options.onCurvesChanged } : {}),
      ...(options.log ? { log: options.log } : {})
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
    this.curves.stop();
    this.scheduler.stop();
    await this.running;
    this.running = null;
    this.store.close();
  }

  setVisible(visible: boolean): void {
    this.scheduler.setVisible(visible);
  }

  /**
   * The names the person holds, replacing the last set; the fill starts over for any that lack a
   * book. A name in `covered` is priced from CSlytics's snapshot and leaves the fill (portfolio
   * prices plan D9): the scheduler never hears of it, so nothing is read for it and nothing is
   * trickled. The caller names the covered set it priced from, so the fill and the figures agree.
   */
  hold(entries: readonly FillEntry[], covered: ReadonlySet<string> = new Set()): void {
    this.fillComplete = false;
    this.lastCovered = entries.filter((entry) => covered.has(entry.name)).length;
    this.scheduler.setHeld(entries.filter((entry) => !covered.has(entry.name)));
  }

  /**
   * The snapshot that may price a name now, or null: the grant must hold the feature and the
   * generation must be under `SNAPSHOT_FRESH_MS` old. Signed out, the snapshot still in the file
   * prices nothing: the feature gates what CSlytics serves, and a cache of it is still that.
   */
  usableSnapshot(): StoredPriceSnapshot | null {
    if (!(this.options.snapshotGranted?.() ?? false)) return null;
    const held = this.store.priceSnapshot('steam');
    if (held === undefined) return null;
    const age = this.clock.now().getTime() - Date.parse(held.generatedAt);
    if (Number.isNaN(age) || age >= SNAPSHOT_FRESH_MS) return null;
    return held;
  }

  /** The snapshot's rows for the names it covers, empty when no snapshot is usable. */
  coveredRows(names: readonly string[]): Map<string, StoredPrice> {
    return this.usableSnapshot() === null ? new Map() : this.store.prices('steam', names);
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
    if (this.fillComplete || status.fillTotal === 0) return status.reads === 0 && status.fillTotal === 0 && this.lastCovered === 0 ? 'idle' : 'complete';
    return 'filling';
  }

  /**
   * True once every held name has been asked this fill, whatever each answered: the gate on showing
   * a total at all (plan D16). A stop or a pause does not unmake it; a new held set does. The float
   * curves are not part of it: the float value has its own gate, `curves.settled()`, and a total
   * held back for curves read at four a second is a portfolio that takes minutes to paint.
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

  /**
   * The curve for a name on a venue, with a 404 recorded so an uncovered name is not asked on every
   * open. Curves are behind the sign-in (pricing behind sign-in plan §7.4): main's gate has already
   * checked the feature, the request carries a token, a 401 is asked again once with a fresh one,
   * and a 403 stores nothing and tells main its grant is stale. Without a token nothing is asked
   * and the copy held, if any, is answered.
   */
  async ensureCurve(venue: 'csfloat' | 'steam', name: string): Promise<StoredCurve | null> {
    const current = this.store.curve(venue, name);
    if (current && this.clock.now().getTime() - Date.parse(current.fetchedAt) < CURVE_FRESH_MS) return current;
    return (await this.fetchCurve(venue, name)).curve;
  }

  /**
   * One curve request through the gate, whoever asks: the Items page through `ensureCurve`, the
   * curve fill for a held skin. One request per name at a time. A copy with a document is sent with
   * its ETag, and a 304 keeps it and stamps it fresh; a 404 is recorded as an absence; a 401 is
   * asked again once with a fresh token; a 403 stores nothing and tells main its grant is stale; a
   * 429, a 503 before the first generation, or anything that does not parse stores nothing.
   */
  fetchCurve(venue: 'csfloat' | 'steam', name: string): Promise<CurveFetch> {
    return this.once(`curve:${venue}:${name}`, async (): Promise<CurveFetch> => {
      const current = this.store.curve(venue, name) ?? null;
      const bearer = this.options.curveBearer;
      const token = bearer ? await bearer(false) : null;
      if (bearer === undefined || token === null) return { outcome: 'no-token', curve: current, retryAfterSeconds: null };
      const etag = current?.doc ? current.etag : null;
      let answer = await this.source.curve(venue, name, token, etag);
      if (answer.status === 401) {
        const again = await bearer(true);
        if (again !== null) answer = await this.source.curve(venue, name, again, etag);
      }
      if (answer.status === 401 || answer.status === 403) {
        if (answer.status === 403) this.options.onCurveForbidden?.();
        this.options.log?.(`curve ${venue}:${name}: the API answered ${answer.status}; nothing stored`);
        return { outcome: answer.status === 401 ? 'unauthenticated' : 'forbidden', curve: current, retryAfterSeconds: null };
      }
      const now = this.clock.now().toISOString();
      if (answer.status === 304 && current !== null) {
        this.store.touchCurve(venue, name, now);
        return { outcome: 'unchanged', curve: this.store.curve(venue, name) ?? null, retryAfterSeconds: null };
      }
      if (answer.status === 429) return { outcome: 'rate-limited', curve: current, retryAfterSeconds: answer.retryAfterSeconds };
      if (answer.parsed.kind === 'ok') {
        this.store.putCurve(venue, name, answer.parsed.value, now, answer.etag);
        return { outcome: 'stored', curve: this.store.curve(venue, name) ?? null, retryAfterSeconds: null };
      }
      if (answer.parsed.kind === 'absent') {
        this.store.putCurve(venue, name, null, now, null);
        return { outcome: 'absent', curve: this.store.curve(venue, name) ?? null, retryAfterSeconds: null };
      }
      return { outcome: 'unavailable', curve: current, retryAfterSeconds: null };
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
