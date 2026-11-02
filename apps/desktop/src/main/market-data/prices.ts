import type { ClockPort } from '@cslytics/ports';
import type { BearerAnswer, CslyticsStatus } from '@cslytics/cslytics-account';
import { FEATURE_STEAM_PRICES, hasFeature } from '../../shared/command-access.js';
import type { MarketDataSource, MarketDataStore, PricesAnswer } from '@cslytics/market-data';

/**
 * The hourly ask for CSlytics's price snapshot (portfolio prices plan §7.3, D10, D14).
 *
 * Main asks the account before any request: no feature in the grant, no request and no network.
 * A 200 is stored whole and a 304 touches the copy held; a 401 refreshes the access token once and
 * retries once; a 403 naming the feature stops the asks until the grant changes, because it was an
 * answer; a 429, a 5xx, a transport fault or a body that does not parse keeps the last snapshot
 * and backs off, honouring `Retry-After` when the server named one. The window never holds a
 * token: it learns of a new snapshot the way it learns of a new book, as a `market` change.
 *
 * Time comes from a `ClockPort`, so the unit test drives it on a virtual clock.
 */

export type PricesAccount = {
  status(): CslyticsStatus;
  bearer(options?: { fresh?: boolean }): Promise<BearerAnswer>;
};

export type PricesOutcome =
  | 'stored' | 'unchanged'
  /** No request was made: the grant lacks the feature, or the issuer gave no token. */
  | 'no-feature' | 'no-token'
  | 'unauthenticated' | 'forbidden' | 'rate-limited'
  /** The API answered 404 for the document, which it never should; reported, never read as a snapshot of nothing. */
  | 'absent'
  | 'malformed' | 'unavailable';

export type PricesStatus = {
  lastAttemptAt: string | null;
  lastOutcome: PricesOutcome | null;
  nextAt: string | null;
  /** A 403 named the feature; nothing is asked until the grant changes. */
  forbidden: boolean;
};

export type PricesRefresherOptions = {
  /** Between successful asks: the snapshot is hourly, so most asks inside an hour are a 304. */
  intervalMs: number;
  /** After anything but an answer, when the server named no wait of its own. */
  retryMs: number;
};

export const DEFAULT_PRICES_OPTIONS: PricesRefresherOptions = { intervalMs: 60 * 60_000, retryMs: 60 * 60_000 };

export class PricesRefresher {
  private readonly options: PricesRefresherOptions;
  private running = false;
  private nextAtMs = 0;
  private forbidden = false;
  private inflight: Promise<PricesOutcome> | null = null;
  private wake: (() => void) | null = null;
  private lastAttemptAt: string | null = null;
  private lastOutcome: PricesOutcome | null = null;
  /** The grant as last seen, so only a changed one wakes the loop. */
  private grantSeen: string | null = null;

  constructor(
    private readonly deps: {
      source: Pick<MarketDataSource, 'prices'>;
      store: MarketDataStore;
      account: PricesAccount;
      clock: ClockPort;
      /** A new snapshot landed: the window re-reads the valuation. */
      onChange?: () => void;
      log?: (message: string, detail?: unknown) => void;
    },
    options: Partial<PricesRefresherOptions> = {}
  ) {
    this.options = { ...DEFAULT_PRICES_OPTIONS, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextAtMs = this.deps.clock.now().getTime();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.wake?.();
  }

  /**
   * The account's status moved. Only a change in what the grant holds matters here: a 403 is
   * lifted and an ask is due at once, because the answer that stopped the asks was about the old
   * grant. A verification that confirmed the same features changes nothing.
   */
  grantChanged(): void {
    const grant = [...this.deps.account.status().features].sort().join(' ');
    if (grant === this.grantSeen) return;
    this.grantSeen = grant;
    this.forbidden = false;
    this.nextAtMs = this.deps.clock.now().getTime();
    this.wake?.();
  }

  status(): PricesStatus {
    return {
      lastAttemptAt: this.lastAttemptAt,
      lastOutcome: this.lastOutcome,
      nextAt: this.running ? new Date(this.nextAtMs).toISOString() : null,
      forbidden: this.forbidden
    };
  }

  /** One ask, now; a second call while one is in the air joins it. */
  refresh(): Promise<PricesOutcome> {
    this.inflight ??= this.once().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.deps.clock.now().getTime() >= this.nextAtMs) {
        try {
          await this.refresh();
        } catch (error) {
          // The store or the account threw: say so and keep the loop, which is the only thing that will ask again.
          this.deps.log?.('prices refresh failed', error);
          this.nextAtMs = this.deps.clock.now().getTime() + this.options.retryMs;
        }
      }
      const wait = Math.max(1_000, this.nextAtMs - this.deps.clock.now().getTime());
      await Promise.race([this.deps.clock.sleep(wait), new Promise<void>((resolve) => { this.wake = resolve; })]);
      this.wake = null;
    }
  }

  private async once(): Promise<PricesOutcome> {
    const nowMs = this.deps.clock.now().getTime();
    this.lastAttemptAt = new Date(nowMs).toISOString();
    const status = this.deps.account.status();
    this.grantSeen = [...status.features].sort().join(' ');
    if (!hasFeature(status, FEATURE_STEAM_PRICES)) return this.settle('no-feature', nowMs + this.options.intervalMs);
    if (this.forbidden) return this.settle('forbidden', nowMs + this.options.intervalMs);
    const bearer = await this.deps.account.bearer();
    if (bearer.kind !== 'ok') return this.settle('no-token', nowMs + this.options.retryMs);
    let answer = await this.ask(bearer.token);
    if (answer.status === 401) {
      // Once: a token the API refuses may be one the website has since rotated; a fresh one that
      // is refused too is the API's answer, and there is no ladder past it (sign-in plan §6.5).
      const again = await this.deps.account.bearer({ fresh: true });
      if (again.kind === 'ok') answer = await this.ask(again.token);
    }
    return this.record(answer);
  }

  private ask(token: string): Promise<PricesAnswer> {
    const held = this.deps.store.priceSnapshot('steam');
    return this.deps.source.prices({ bearer: token, etag: held?.etag ?? null });
  }

  private record(answer: PricesAnswer): PricesOutcome {
    const nowMs = this.deps.clock.now().getTime();
    const at = new Date(nowMs).toISOString();
    const { intervalMs, retryMs } = this.options;
    if (answer.status === 304) {
      this.deps.store.touchPriceSnapshot('steam', at);
      return this.settle('unchanged', nowMs + intervalMs);
    }
    if (answer.status === 200 && answer.parsed.kind === 'ok') {
      this.deps.store.putPriceSnapshot(answer.parsed.value, at, answer.etag);
      this.deps.onChange?.();
      return this.settle('stored', nowMs + intervalMs);
    }
    if (answer.status === 401) return this.settle('unauthenticated', nowMs + retryMs);
    if (answer.status === 403) {
      this.forbidden = true;
      this.deps.log?.(`prices: the API refused the feature ${FEATURE_STEAM_PRICES}; not asked again until the grant changes`);
      return this.settle('forbidden', nowMs + intervalMs);
    }
    if (answer.status === 429) {
      const wait = answer.retryAfterSeconds !== null ? answer.retryAfterSeconds * 1_000 : retryMs;
      return this.settle('rate-limited', nowMs + wait);
    }
    if (answer.parsed.kind === 'absent') {
      this.deps.log?.('prices: the API answered 404 for the prices document');
      return this.settle('absent', nowMs + retryMs);
    }
    if (answer.status === 200) {
      this.deps.log?.(`prices: the document did not parse: ${answer.parsed.kind === 'unknown' ? answer.parsed.detail : answer.parsed.kind}`);
      return this.settle('malformed', nowMs + retryMs);
    }
    this.deps.log?.(`prices: not read: ${answer.parsed.kind === 'unknown' ? answer.parsed.detail : `HTTP ${answer.status}`}`);
    return this.settle('unavailable', nowMs + retryMs);
  }

  private settle(outcome: PricesOutcome, nextAtMs: number): PricesOutcome {
    this.lastOutcome = outcome;
    this.nextAtMs = nextAtMs;
    return outcome;
  }
}
