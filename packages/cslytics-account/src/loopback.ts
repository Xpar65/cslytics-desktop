import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

/**
 * The one redirect the browser makes back to the desktop at the end of a sign-in.
 *
 * RFC 8252 §7.3 lets a native app receive it on its loopback address with any port. The listener
 * binds 127.0.0.1 only, for one attempt, and the decision about each request lives in
 * `CallbackGate` so it can be proved without a socket.
 */

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  /** The person declined on the consent page. */
  | { kind: 'declined' }
  /** The browser came back with something that ends the attempt: a wrong state, an error, no code. */
  | { kind: 'failed'; reason: 'state' | 'duplicate' | 'error' | 'code' }
  | { kind: 'timedOut' }
  | { kind: 'cancelled' };

export type CallbackRequest = { method: string; url: string; host: string | undefined };
export type CallbackReply = { status: number; body: string; outcome: CallbackOutcome | null };

const RECEIVED_PAGE = page('CSlytics has your sign-in. You can close this tab and return to the app.');
const ENDED_PAGE = page('This sign-in did not complete. Return to CSlytics to try again.');

export class CallbackGate {
  constructor(private readonly expectedState: string, private readonly port: number) {}

  handle(request: CallbackRequest): CallbackReply {
    // A page that rebinds its own name to 127.0.0.1 can reach this port, but not under this Host.
    if (request.host !== `127.0.0.1:${this.port}`) return ignored(400);
    if (request.method !== 'GET') return ignored(405);
    if (!request.url.startsWith('/') || request.url.startsWith('//')) return ignored(400);
    const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
    if (url.pathname !== '/callback') return ignored(404);
    const params = url.searchParams;
    for (const key of new Set(params.keys())) {
      if (params.getAll(key).length > 1) return ended({ kind: 'failed', reason: 'duplicate' });
    }
    const state = params.get('state');
    if (state === null || !this.stateMatches(state)) return ended({ kind: 'failed', reason: 'state' });
    const error = params.get('error');
    if (error !== null) return ended(error === 'access_denied' ? { kind: 'declined' } : { kind: 'failed', reason: 'error' });
    const code = params.get('code');
    if (code === null || code === '') return ended({ kind: 'failed', reason: 'code' });
    return { status: 200, body: RECEIVED_PAGE, outcome: { kind: 'code', code } };
  }

  /** Whether the browser returned this attempt's state. Compared in constant time. */
  protected stateMatches(received: string): boolean {
    const a = Buffer.from(received);
    const b = Buffer.from(this.expectedState);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export interface CallbackListener {
  /** `http://127.0.0.1:<port>/callback`, exactly what the authorize request names. */
  readonly redirectUri: string;
  /** Settles once: with the browser's answer, a timeout, or `cancelled` when closed first. */
  readonly outcome: Promise<CallbackOutcome>;
  close(): void;
}

export type OpenListener = (state: string, timeoutMs: number) => Promise<CallbackListener>;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  Connection: 'close'
};

/** Opens a listener on an ephemeral port of 127.0.0.1 for one sign-in attempt. */
export const openLoopbackListener: OpenListener = (state, timeoutMs) => new Promise((resolve, reject) => {
  let settle: (outcome: CallbackOutcome) => void = () => undefined;
  const outcome = new Promise<CallbackOutcome>((done) => { settle = done; });
  let settled = false;
  let gate: CallbackGate | null = null;
  const server = createServer((request, response) => {
    if (settled || gate === null) {
      response.writeHead(410, HEADERS).end(ENDED_PAGE);
      return;
    }
    const reply = gate.handle({ method: request.method ?? '', url: request.url ?? '', host: request.headers.host });
    response.writeHead(reply.status, HEADERS).end(reply.body);
    if (reply.outcome) {
      finish(reply.outcome);
      response.on('close', shutdown);
    }
  });
  const timer = setTimeout(() => { finish({ kind: 'timedOut' }); shutdown(); }, timeoutMs);
  timer.unref();

  function finish(result: CallbackOutcome): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(result);
  }
  function shutdown(): void {
    server.close();
    server.closeAllConnections();
  }

  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    gate = new CallbackGate(state, port);
    resolve({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      outcome,
      close: () => { finish({ kind: 'cancelled' }); shutdown(); }
    });
  });
});

function ignored(status: number): CallbackReply {
  return { status, body: '', outcome: null };
}

function ended(outcome: CallbackOutcome): CallbackReply {
  return { status: 400, body: ENDED_PAGE, outcome };
}

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CSlytics</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:3rem;line-height:1.5"><p>${message}</p></body></html>`;
}
