import type { CredentialVault, CsfloatBudgetState } from '@cslytics/ports';

/**
 * The one place a CSFloat API key meets the network.
 *
 * Four rules live here rather than in each route, because each fails silently at the call site:
 *
 *  1. **One host.** Every request is built from `CSFLOAT_BASE`, and a path that would escape it
 *     throws before a key is attached. Nothing accepts a caller-supplied URL.
 *  2. **No redirects, ever.** `redirect: 'manual'` — following a 30x would forward the
 *     `Authorization` header wherever the response pointed, which is how a credential leaves the
 *     machine. A redirect is reported, never followed and never retried.
 *  3. **The key is write-only.** Failures carry a status and CSFloat's own body; nothing here
 *     returns, logs or interpolates the header.
 *  4. **A transport fact is not a verdict.** A timeout, a WAF page and a 429 differ from "this
 *     key is invalid", and only the last may end a connection (CSF-02).
 */
export const CSFLOAT_BASE = 'https://csfloat.com/api/v1';
const CSFLOAT_HOST = 'csfloat.com';

export type CsfloatRate = {
  /** The route's bucket, when the venue says. */
  limit: number | null;
  /** Remaining requests, when the venue says. Header names match case-insensitively. */
  remaining: number | null;
  /** Reset instant as epoch milliseconds, when the venue says. */
  resetAtMs: number | null;
  /** `Retry-After` normalised to milliseconds, whether it arrived as seconds or as a date. */
  retryAfterMs: number | null;
};

export type CsfloatResponse = {
  kind: 'response';
  status: number;
  ok: boolean;
  /** Parsed JSON, or null when the body was empty or not JSON. `text` says which. */
  body: unknown;
  text: string;
  rate: CsfloatRate;
};

export type CsfloatTransportFailure = { kind: 'failure'; cause: 'timeout' | 'transport' | 'redirected'; detail: string };
export type CsfloatTransportResult = CsfloatResponse | CsfloatTransportFailure;

export type CsfloatRequest = {
  accountId?: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** A path below the base, such as `/me`. Never a full URL. */
  path: string;
  key: string;
  body?: unknown;
  /**
   * A call that finishes work already under way: following and telling CSFloat about a sale already
   * accepted, or a purchase on its way to us. It may spend the shared counter's reserve; nothing else
   * may (`CsfloatBudgetState`). It never passes a spent counter, nor a route's own small-bucket reserve.
   */
  essential?: boolean;
};

/** What one request did to the shared counter, for a host that logs or measures it. Never carries the key. */
export type CsfloatRequestEvent = {
  at: number;
  accountId: string | null;
  method: CsfloatRequest['method'];
  /** The route with ids as `:id` and no query: `GET /api/v1/users/:id/stall`. */
  route: string;
  essential: boolean;
  /** Whether the route draws on the shared counter, as the corpus lists it or as its own headers showed. */
  shared: boolean;
  /** The venue's status; null when no answer came back. */
  status: number | null;
  /** Why nothing was sent: the shared counter's reserve or its exhaustion, or the route's own cooldown. */
  blocked: 'reserve' | 'spent' | 'cooldown' | null;
  rate: CsfloatRate | null;
};

/**
 * The share of a route's bucket left unspent. CSFloat's website draws on the account's buckets too: on 2026-10-25 a
 * run that spent `/me/trades` to zero locked the account out of its own trades page ("too many requests ... 20").
 * Rounded down, so a bucket too small to share (a buy-order edit, two a minute) keeps none.
 */
export const CSFLOAT_HEADROOM = 0.1;

/**
 * The routes on the counter of 50,000 a day that CSFloat keeps per egress IP across keys
 * (captured 2026-09-23, 2026-11-12 and 2026-11-13).
 * A route the list misses joins it the first time its own headers name a counter that large.
 */
export const CSFLOAT_SHARED_ROUTES: readonly string[] = [
  'GET /api/v1/me',
  'GET /api/v1/users/:id/stall',
  'GET /api/v1/me/transactions',
  'GET /api/v1/me/buy-orders',
  'GET /api/v1/me/account-standing',
  'DELETE /api/v1/buy-orders/:id',
  'POST /api/v1/listings',
  'GET /api/v1/listings/:id'
];

/** A counter this large is the shared one: every per-key or per-order bucket on record is 2,000 or less. */
const SHARED_COUNTER_MIN_LIMIT = 10_000;

/** The wait a refusal earns when the venue named none. */
const DEFAULT_WAIT_MS = 60_000;

type SharedCounter = { limit: number | null; remaining: number | null; resetAtMs: number | null; observedAtMs: number; spentUntilMs: number };

export class CsfloatTransport {
  private readonly cooldowns = new Map<string, number>();
  private readonly sharedRoutes = new Set<string>(CSFLOAT_SHARED_ROUTES);
  private shared: SharedCounter | null = null;
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    private readonly onRequest?: (event: CsfloatRequestEvent) => void
  ) {}

  /**
   * The shared counter as the last response on it said. A reset that has passed opens it: the venue
   * starts a new window, and the next response says how much of it is left.
   */
  budget(nowMs = Date.now()): CsfloatBudgetState {
    const counter = this.shared;
    if (!counter) return { phase: 'open', limit: null, remaining: null, resetAt: null, observedAt: null };
    const rolled = counter.resetAtMs !== null && nowMs >= counter.resetAtMs;
    const reserve = counter.limit === null ? 0 : Math.floor(counter.limit * CSFLOAT_HEADROOM);
    const phase = counter.spentUntilMs > nowMs ? 'spent'
      : rolled || counter.remaining === null ? 'open'
        : counter.remaining <= reserve ? 'reserve' : 'open';
    return {
      phase,
      limit: counter.limit,
      remaining: rolled ? null : counter.remaining,
      resetAt: counter.resetAtMs === null ? null : new Date(counter.resetAtMs).toISOString(),
      observedAt: new Date(counter.observedAtMs).toISOString()
    };
  }

  async send(request: CsfloatRequest): Promise<CsfloatTransportResult> {
    const url = resolve(request.path);
    // One lane per route family and method: every listing, trade or buy order addressed by id
    // shares its family's cooldown, because the venue budgets the route rather than the id (a
    // buy-order edit is two a minute, `fixtures/csfloat/INDEX.md`).
    const route = new URL(url).pathname.replace(/\/(listings|trades|buy-orders)\/\d+/, '/$1/:id');
    const lane = `${request.accountId ?? 'transport-contract'}:${request.method}:${route}`;
    const family = `${request.method} ${route.replace(/\/users\/\d+\//, '/users/:id/')}`;
    const essential = request.essential === true;
    const event = (status: number | null, blocked: CsfloatRequestEvent['blocked'], rate: CsfloatRate | null): void =>
      this.onRequest?.({ at: Date.now(), accountId: request.accountId ?? null, method: request.method, route: family, essential,
        shared: this.sharedRoutes.has(family), status, blocked, rate });
    const refuse = (blocked: NonNullable<CsfloatRequestEvent['blocked']>, until: number): CsfloatTransportResult => {
      const rate = { limit: null, remaining: 0, resetAtMs: until, retryAfterMs: Math.max(0, until - Date.now()) };
      event(429, blocked, rate);
      return { kind: 'response', status: 429, ok: false, body: null, text: '', rate };
    };
    // The shared counter first: in its reserve only work already under way is sent, and once it is
    // spent nothing on it is, whichever account or route asks.
    if (this.sharedRoutes.has(family)) {
      const phase = this.budget().phase;
      const until = Math.max(this.shared?.spentUntilMs ?? 0, this.shared?.resetAtMs ?? 0, Date.now() + DEFAULT_WAIT_MS);
      if (phase === 'spent') return refuse('spent', until);
      if (phase === 'reserve' && !essential) return refuse('reserve', until);
    }
    const notBefore = this.cooldowns.get(lane) ?? 0;
    if (notBefore > Date.now()) return refuse('cooldown', notBefore);
    const headers = new Headers({ Accept: 'application/json', Authorization: request.key });
    if (request.body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const timedOut = lower.includes('timeout') || lower.includes('abort');
      event(null, null, null);
      return { kind: 'failure', cause: timedOut ? 'timeout' : 'transport', detail: message };
    }
    // `redirect: 'manual'` surfaces a 30x as an opaque redirect in some runtimes and as a real
    // status in others. Both mean the same thing here: the key does not travel onward.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { kind: 'failure', cause: 'redirected', detail: `HTTP ${response.status}` };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { kind: 'failure', cause: 'transport', detail: error instanceof Error ? error.message : String(error) };
    }
    const rate = readRate(response.headers, Date.now());
    if (rate.limit !== null && rate.limit >= SHARED_COUNTER_MIN_LIMIT) this.sharedRoutes.add(family);
    if (this.sharedRoutes.has(family)) {
      // The shared counter is judged as a whole (`budget`), never route by route: a 429 or nothing
      // left spends it until the reset, and its reserve stops all but essential work.
      this.observeShared(response.status, rate);
    } else {
      const reserve = rate.limit === null ? 0 : Math.floor(rate.limit * CSFLOAT_HEADROOM);
      if (response.status === 429 || (rate.remaining !== null && rate.remaining <= reserve)) {
        this.cooldowns.set(lane, Math.max(Date.now() + (rate.retryAfterMs ?? DEFAULT_WAIT_MS), rate.resetAtMs ?? 0));
      }
    }
    event(response.status, null, rate);
    return { kind: 'response', status: response.status, ok: response.ok, body: parseJson(text), text, rate };
  }

  private observeShared(status: number, rate: CsfloatRate): void {
    const nowMs = Date.now();
    const previous = this.shared;
    const exhausted = status === 429 || rate.remaining === 0;
    const spentUntilMs = exhausted ? Math.max(nowMs + (rate.retryAfterMs ?? DEFAULT_WAIT_MS), rate.resetAtMs ?? 0) : 0;
    // A refusal without headers says nothing about the count: it keeps what the last answer said.
    this.shared = {
      limit: rate.limit ?? previous?.limit ?? null,
      remaining: rate.remaining ?? (status === 429 ? 0 : previous?.remaining ?? null),
      resetAtMs: rate.resetAtMs ?? previous?.resetAtMs ?? null,
      observedAtMs: nowMs,
      spentUntilMs: Math.max(spentUntilMs, previous && previous.spentUntilMs > nowMs ? previous.spentUntilMs : 0)
    };
  }
}

/** Resolves a path below the base and refuses anything that would leave the host. */
export function resolve(path: string): string {
  if (!path.startsWith('/')) throw new Error(`CSFloat path must start with "/": ${path}`);
  // `//host/…` and `..` both survive string concatenation and then mean something else to `URL`.
  // Neither can actually leave `csfloat.com` here, but both produce a request nobody wrote, so
  // they are refused where they are cheap to see rather than trusted to the host check below.
  if (path.startsWith('//') || path.split('/').includes('..')) {
    throw new Error('CSFloat request escaped the approved host');
  }
  const url = new URL(`${CSFLOAT_BASE}${path}`);
  if (url.hostname !== CSFLOAT_HOST || url.protocol !== 'https:' || !url.pathname.startsWith('/api/v1/')) {
    throw new Error('CSFloat request escaped the approved host');
  }
  return url.toString();
}

/**
 * The vault key naming one account's CSFloat credential.
 *
 * Versioned because replacing a key is two durable steps with a gap between them: write the new
 * entry, then switch the database reference. Reusing one name would make that gap destructive.
 */
export function csfloatKeyRef(accountId: string, version: number): string {
  if (!accountId) throw new Error('Credential ref needs an account');
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Credential version must be a positive integer');
  return `csfloat-api-key:${accountId}:${version}`;
}

/** Reads a stored key, or throws a message that names the reference and never the secret. */
export async function requireKey(vault: CredentialVault, credential: string): Promise<string> {
  const key = await vault.get(credential);
  if (!key) throw new Error(`No stored CSFloat credential for ${credential}`);
  return key;
}

export function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Rate headers, case-insensitively, tolerating the absent, the malformed and the already-past.
 *
 * A missing or unparsable header is `null`, which callers treat as "pace conservatively", never
 * as "no limit". `Retry-After` is defined as either seconds or an HTTP date; both appear in the
 * wild, so both are read.
 */
export function readRate(headers: Headers, nowMs: number): CsfloatRate {
  return {
    limit: nonNegativeInteger(headers.get('x-ratelimit-limit')),
    remaining: nonNegativeInteger(headers.get('x-ratelimit-remaining')),
    resetAtMs: resetInstant(headers.get('x-ratelimit-reset'), nowMs),
    retryAfterMs: retryAfter(headers.get('retry-after'), nowMs)
  };
}

function nonNegativeInteger(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A reset may arrive as epoch seconds, epoch milliseconds, or a delta in seconds. */
function resetInstant(value: string | null, nowMs: number): number | null {
  const seconds = nonNegativeInteger(value);
  if (seconds === null) return null;
  if (seconds > 1e12) return seconds;                 // already milliseconds
  if (seconds > 1e9) return seconds * 1000;           // epoch seconds
  return nowMs + seconds * 1000;                      // a delta
}

function retryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const seconds = nonNegativeInteger(value);
  if (seconds !== null) return seconds * 1000;
  // Only an HTTP date is tried as a date. `Date.parse` accepts things no server meant as one —
  // `-5` parses as a year — and reading a malformed delta as "retry immediately" would turn a
  // header this app could not understand into permission to hammer the venue.
  if (!/[a-zA-Z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
