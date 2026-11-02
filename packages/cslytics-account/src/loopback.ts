import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { Landing } from './website.js';

/**
 * The one redirect the browser makes back to the desktop at the end of a sign-in.
 *
 * RFC 8252 §7.3 lets a native app receive it on its loopback address with any port. The listener
 * binds 127.0.0.1 only, for one attempt, and the decision about each request lives in
 * `CallbackGate` so it can be proved without a socket.
 *
 * The website's answer, a code or a decline, is met with a redirect back to the website's own page
 * for it, so the browser ends on cslytics.com and not on a page served from this computer. The
 * redirect is a fixed URL and carries nothing from the callback. A callback the gate cannot trust
 * keeps the browser here, on a page saying the sign-in did not complete.
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
export type CallbackReply = { status: number; body: string; location: string | null; outcome: CallbackOutcome | null };

/**
 * The website's own card, drawn with its colours, so the one page this computer shows does not look
 * out of place beside cslytics.com. Inline only: no font, image or stylesheet is fetched.
 */
const PAGE_STYLE = [
  'html{color-scheme:dark}',
  'body{margin:0;min-height:100vh;background:#0B0F14 radial-gradient(ellipse at 50% -10%,#1e2d40 0%,#0B0F14 60%) no-repeat;',
  'color:#E5E7EB;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}',
  'main{box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 3rem);padding:3rem 1rem}',
  'section{box-sizing:border-box;width:100%;max-width:28rem;border:1px solid rgba(255,255,255,.1);border-radius:.75rem;background:#0F172A;padding:2rem}',
  'h1{margin:0;font-size:1.25rem;line-height:1.75rem;font-weight:600;color:#F3F4F6}',
  'p{margin:1rem 0 0;font-size:.875rem;line-height:1.5rem;color:#9CA3AF}'
].join('');

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>CSlytics</title><style>${PAGE_STYLE}</style></head>`
    + `<body><main><section><h1>${title}</h1><p>${message}</p></section></main></body></html>`;
}

const ENDED_PAGE = page('This sign-in did not complete', 'Return to CSlytics Desktop and try again.');

export class CallbackGate {
  constructor(private readonly expectedState: string, private readonly port: number, private readonly landing: Landing) {}

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
    if (error === 'access_denied') return landed(this.landing.declined, { kind: 'declined' });
    if (error !== null) return ended({ kind: 'failed', reason: 'error' });
    const code = params.get('code');
    if (code === null || code === '') return ended({ kind: 'failed', reason: 'code' });
    return landed(this.landing.approved, { kind: 'code', code });
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

export type OpenListener = (state: string, timeoutMs: number, landing: Landing) => Promise<CallbackListener>;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  // The page is self-contained: it may style itself and nothing else, and loads nothing from anywhere.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  Connection: 'close'
};

/** Opens a listener on an ephemeral port of 127.0.0.1 for one sign-in attempt. */
export const openLoopbackListener: OpenListener = (state, timeoutMs, landing) => new Promise((resolve, reject) => {
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
    response.writeHead(reply.status, reply.location === null ? HEADERS : { ...HEADERS, Location: reply.location }).end(reply.body);
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
    gate = new CallbackGate(state, port, landing);
    resolve({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      outcome,
      close: () => { finish({ kind: 'cancelled' }); shutdown(); }
    });
  });
});

function ignored(status: number): CallbackReply {
  return { status, body: '', location: null, outcome: null };
}

function ended(outcome: CallbackOutcome): CallbackReply {
  return { status: 400, body: ENDED_PAGE, location: null, outcome };
}

/** The website answered: send the browser back to its page for that answer. */
function landed(location: string, outcome: CallbackOutcome): CallbackReply {
  return { status: 303, body: '', location, outcome };
}

