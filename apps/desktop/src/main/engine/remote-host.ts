import { changeNotificationSchema, type ChangeNotification } from '@cslytics/runtime/api';
import { hostPagesSchema, type EngineHostState, type HostPage } from '../../shared/api.js';

/**
 * The engine on another machine, driven over an engine host's four routes (remote engine host
 * plan D1, D7, D8): `POST /command` for an answer, the `/events` stream for the engine's change
 * notices, `GET /health` for the host's build and accounts. The same commands, the same answers and
 * the same refusals as the Engine Runtime beside the window, so nothing above this file knows which
 * it is talking to.
 *
 * No Electron here: the transport takes its `fetch`, so a test drives it against the host's pure
 * request handler and a hand-made stream, with no socket.
 */

export type RemoteHostState = {
  state: EngineHostState;
  /** When the state last changed; a retry that fails again keeps it. */
  since: string;
  build: string | null;
  accounts: readonly string[];
  detail: string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RemoteHostOptions = {
  url: string;
  token: string;
  onNotice: (notice: ChangeNotification) => void;
  onState?: (state: RemoteHostState) => void;
  fetch?: FetchLike;
  now?: () => Date;
  /** The waits between reconnects: the first, doubled each failure, capped at the longest. */
  backoffMs?: { first: number; longest: number };
  log?: (line: string) => void;
};

/**
 * Commands a desktop never sends to a host, each with the sentence it answers instead (plan D5).
 * The sessions are the host's: a sign-out would stop the host's own reads of that account, a
 * focus hint would re-tier every account the host keeps active, and the process
 * commands have no process here. The desktop keeps no second list of what a host *cannot* do:
 * anything else is forwarded, and a refusal the host's own ports make comes back as the host's
 * sentence.
 */
export const REMOTE_HOST_OWNS: Readonly<Record<string, string>> = {
  'session.connect': 'The engine host signs its accounts in itself. This desktop reads what it holds and cannot connect an account for it.',
  'session.signOut': "The engine host owns this account's session. Signing out from here would stop the host's own reads, so it is not sent.",
  'auth.beginQr': 'Accounts are signed in on the engine host, not from this desktop.',
  'auth.pollQr': 'Accounts are signed in on the engine host, not from this desktop.',
  'auth.credentials': 'Accounts are signed in on the engine host, not from this desktop.',
  'auth.guard': 'Accounts are signed in on the engine host, not from this desktop.',
  'auth.cancel': 'Accounts are signed in on the engine host, not from this desktop.',
  'auth.refresh': 'Accounts are signed in on the engine host, not from this desktop.',
  'accounts.remove': 'This account belongs to the engine host. Remove it there; this desktop only reads it.',
  'accounts.reset': 'This account belongs to the engine host. Reset it there; this desktop only reads it.',
  'refresh.scope': 'The engine host sets its own refresh cadence.',
  'refresh.resume': 'The engine host sets its own refresh cadence.',
  'csfloat.protection': 'Double-listing protection is set on the engine host, not from this desktop.'
};

/**
 * What the window re-reads after the stream comes back (plan D7): every surface a page watches,
 * in two notices per account because the window's bridge takes at most sixteen in one.
 */
export const CATCH_UP_SURFACES: ReadonlyArray<readonly string[]> = [
  ['gc-inventory', 'gc-storage-units', 'gc-casket', 'gc-event', 'steam-market', 'steam-wallet', 'steam-buy-order-status', 'steam-persona', 'steam-market-history'],
  ['steam-trade-offers', 'steam-trade-history', 'csfloat-account-status', 'csfloat-stall', 'csfloat-listing', 'csfloat-buy-orders', 'csfloat-trades', 'csfloat-inventory', 'marketplace']
];

const DEFAULT_BACKOFF = { first: 1_000, longest: 60_000 };

export class RemoteHostTransport {
  readonly kind = 'remote' as const;
  readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly onNotice: (notice: ChangeNotification) => void;
  private readonly onState: ((state: RemoteHostState) => void) | undefined;
  private readonly backoff: { first: number; longest: number };
  private readonly log: (line: string) => void;
  private current: RemoteHostState;
  private stream: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wait = 0;
  private generation = 0;
  private everConnected = false;
  private closed = false;

  constructor(options: RemoteHostOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.onNotice = options.onNotice;
    this.onState = options.onState;
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.log = options.log ?? (() => undefined);
    this.current = { state: 'connecting', since: this.now().toISOString(), build: null, accounts: [], detail: null };
  }

  /** Opens the event stream. Idempotent; a closed transport stays closed. */
  start(): void {
    if (this.closed || this.stream) return;
    void this.open();
  }

  state(): RemoteHostState {
    return this.current;
  }

  /**
   * One runtime command, answered the way the Engine Runtime answers it: the value, or the host's
   * own sentence as the error. A command the host owns (D5) is refused here before any request;
   * a refused token, a command the host's build does not know (D8) and an unreachable host each
   * say so in words a page can show.
   */
  async invoke(command: unknown): Promise<unknown> {
    const type = (command as { type?: unknown } | null)?.type;
    if (typeof type === 'string' && REMOTE_HOST_OWNS[type]) throw new Error(REMOTE_HOST_OWNS[type]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(command)
      });
    } catch (error) {
      throw new Error(`Cannot reach the engine host: ${message(error)}`);
    }
    const text = await response.text();
    if (response.status === 401) throw new Error('The engine host refused the token. Check it under Settings › Engine host.');
    let parsed: { ok?: unknown; value?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`The engine host answered ${response.status} with something that is not JSON.`);
    }
    if (response.status === 400) {
      throw new Error(`The engine host does not know this command; its build may be older than this desktop. It said: ${String(parsed.error ?? text)}`);
    }
    if (!response.ok) throw new Error(`The engine host answered ${response.status}: ${String(parsed.error ?? text)}`);
    if (parsed.ok === true) return parsed.value ?? null;
    throw new Error(String(parsed.error ?? 'The engine host refused the command.'));
  }

  /**
   * A request to one of the host's own routes (plan D9, D12), with the token; the answer comes back
   * as its status and text, for the caller to read as it sees fit.
   */
  async hostRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: string }> {
    if (!path.startsWith('/')) throw new Error('A host route starts with /');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      throw new Error(`Cannot reach the engine host: ${message(error)}`);
    }
    return { status: response.status, body: await response.text() };
  }

  /** The pages the host serves, or none when it serves no list. */
  async pages(): Promise<HostPage[]> {
    const answer = await this.hostRequest('GET', '/ui/pages');
    if (answer.status === 404) return [];
    if (answer.status === 401) throw new Error('The engine host refused the token. Check it under Settings › Engine host.');
    if (answer.status !== 200) throw new Error(`The engine host answered ${answer.status} to /ui/pages.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new Error('The engine host answered /ui/pages with something that is not JSON.');
    }
    const read = hostPagesSchema.safeParse(parsed);
    if (!read.success) throw new Error('The engine host answered /ui/pages with something that is not a list of pages.');
    return read.data.pages;
  }

  /** Ends the stream and every retry. Never asks the host to shut down: the host is somebody else's process. */
  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.abort();
    this.stream = null;
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.stream = controller;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/events`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
        signal: controller.signal
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.stream = null;
      this.setState('unreachable', message(error));
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation) return;
    if (response.status === 401) {
      this.stream = null;
      this.setState('refused', 'The engine host refused the token.');
      this.scheduleReconnect();
      return;
    }
    if (!response.ok || !response.body) {
      this.stream = null;
      this.setState('unreachable', `the engine host answered ${response.status} to /events`);
      this.scheduleReconnect();
      return;
    }
    const reconnect = this.everConnected;
    this.everConnected = true;
    this.wait = 0;
    await this.connected(reconnect);
    if (generation !== this.generation) return;
    let reason = 'the event stream closed';
    try {
      await this.pump(response.body, generation);
    } catch (error) {
      reason = message(error);
    }
    if (generation !== this.generation) return;
    this.stream = null;
    this.setState('unreachable', reason);
    this.scheduleReconnect();
  }

  /**
   * The stream is open: the host's build and accounts from `/health`, and after a reconnect one
   * notice per account naming every surface, so the window re-reads what moved while it was deaf.
   */
  private async connected(reconnect: boolean): Promise<void> {
    let build: string | null = null;
    let accounts: readonly string[] = [];
    try {
      const health = await this.fetchImpl(`${this.url}/health`);
      const parsed = JSON.parse(await health.text()) as { accounts?: unknown; build?: unknown };
      if (Array.isArray(parsed.accounts)) accounts = parsed.accounts.filter((id): id is string => typeof id === 'string');
      if (typeof parsed.build === 'string' && parsed.build.length > 0) build = parsed.build;
    } catch (error) {
      this.log(`engine host: /health did not answer: ${message(error)}`);
    }
    this.setState('connected', null, { build, accounts });
    if (!reconnect) return;
    const at = this.now().toISOString();
    for (const accountId of accounts) {
      for (const surfaces of CATCH_UP_SURFACES) this.onNotice({ kind: 'changed', accountId, surfaces: [...surfaces], at });
    }
  }

  /** Reads `event:`/`data:` frames off the stream until it ends; comments (`: ping`) are the host keeping it open. */
  private async pump(body: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (generation !== this.generation) return;
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        this.frame(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf('\n\n');
      }
    }
  }

  private frame(frame: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (event !== 'changed' || data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    const notice = changeNotificationSchema.safeParse(parsed);
    if (notice.success) this.onNotice(notice.data);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    this.wait = this.wait === 0 ? this.backoff.first : Math.min(this.wait * 2, this.backoff.longest);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, this.wait);
    this.timer.unref?.();
  }

  /** Moves the state; the listener hears only a change, so a retry that fails the same way again is silent. */
  private setState(state: EngineHostState, detail: string | null, facts?: { build: string | null; accounts: readonly string[] }): void {
    const changed = state !== this.current.state;
    const next: RemoteHostState = {
      state,
      since: changed ? this.now().toISOString() : this.current.since,
      build: facts ? facts.build : this.current.build,
      accounts: facts ? facts.accounts : this.current.accounts,
      detail
    };
    const same = !changed && next.detail === this.current.detail && next.build === this.current.build
      && next.accounts.length === this.current.accounts.length && next.accounts.every((id, index) => id === this.current.accounts[index]);
    this.current = next;
    if (same) return;
    if (changed) this.log(`engine host: ${state}${detail ? ` (${detail})` : ''}`);
    this.onState?.(this.current);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
