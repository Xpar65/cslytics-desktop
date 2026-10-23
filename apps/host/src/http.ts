import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { runtimeCommandSchema, type ChangeNotification } from '@cslytics/runtime';
import type { Host } from './host.js';

/** One request, as the handler sees it: the framing is the server's, the answer is pure. */
export type HostRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
export type HostResponse = { status: number; headers: Record<string, string>; body: string };
export type RequestHandler = (request: HostRequest) => Promise<HostResponse>;

export type HandlerOptions = {
  /** The bearer token every request but `/health` must carry. */
  token: string;
  /** What `POST /shutdown` does after it has answered. */
  onShutdown?: () => void;
};

/** The largest command body accepted. A selection of six thousand members is well under it. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status: number, value: unknown): HostResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(value) };
}

function bearer(headers: HostRequest['headers']): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The HTTP surface of a host, as a pure function of the request so it can be tested without a
 * socket. Three routes:
 *
 * - `GET /health` — alive, which accounts the record holds, the time. No token: it carries nothing
 *   a stranger could use and it is what a supervisor polls.
 * - `POST /command` — one runtime command as JSON. `400` when the body is not a command the
 *   runtime knows; `200 {ok:true, value}` with the engine's answer; `200 {ok:false, error}` when
 *   the engine refused, because a refusal is an answer, not a transport failure.
 * - `POST /shutdown` — answers `202`, then the host closes.
 *
 * `GET /events` is the one route the pure handler cannot serve: it is a stream, and `serveHost`
 * answers it on the socket.
 */
export function createRequestHandler(host: Pick<Host, 'invoke' | 'accounts'>, options: HandlerOptions): RequestHandler {
  if (!options.token) throw new Error('A host token is required; set CSLYTICS_HOST_TOKEN');
  return async (request) => {
    const path = request.url.split('?')[0] ?? '/';
    if (request.method === 'GET' && path === '/health') {
      return json(200, { ok: true, accounts: host.accounts().map((row) => row.id), at: new Date().toISOString() });
    }
    if (!tokenMatches(bearer(request.headers), options.token)) return json(401, { ok: false, error: 'unauthorized' });
    if (request.method === 'POST' && path === '/command') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        return json(400, { ok: false, error: 'the body is not JSON' });
      }
      const command = runtimeCommandSchema.safeParse(parsed);
      if (!command.success) {
        const type = (parsed as { type?: unknown } | null)?.type;
        return json(400, { ok: false, error: `not a runtime command${typeof type === 'string' ? ` (${type})` : ''}: ${command.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`).join('; ')}` });
      }
      try {
        return json(200, { ok: true, value: await host.invoke(command.data) ?? null });
      } catch (error) {
        return json(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === 'POST' && path === '/shutdown') {
      setTimeout(() => options.onShutdown?.(), 0);
      return json(202, { ok: true });
    }
    return json(404, { ok: false, error: `no route for ${request.method} ${path}` });
  };
}

export type ServeOptions = HandlerOptions & {
  /** `host:port`. Default `127.0.0.1:7411`; bind an interface address only behind a token and a firewall. */
  listen?: string;
  /** How often an idle event stream is written a comment, so a proxy does not close it. */
  heartbeatMs?: number;
};

export type ServingHost = { server: Server; address: string; close(): Promise<void> };

/**
 * Serves a host over HTTP. `/events` is Server-Sent Events: one `changed` event per engine
 * notice, surfaces never rows, as the desktop's window hears them.
 */
export async function serveHost(host: Host, options: ServeOptions): Promise<ServingHost> {
  const handler = createRequestHandler(host, options);
  const [hostname, portText] = (options.listen ?? '127.0.0.1:7411').split(':');
  const port = Number(portText ?? '7411');
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--listen must be host:port, got ${options.listen}`);
  const streams = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'GET' && path === '/events') {
      if (!tokenMatches(bearer(request.headers), options.token)) {
        response.writeHead(401, JSON_HEADERS);
        response.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(': connected\n\n');
      streams.add(response);
      const unsubscribe = host.subscribe((notice: ChangeNotification) => {
        response.write(`event: changed\ndata: ${JSON.stringify(notice)}\n\n`);
      });
      request.on('close', () => { unsubscribe(); streams.delete(response); });
      return;
    }
    void readBody(request).then(async (body) => {
      const answer = await handler({ method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers, body });
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    }).catch((error: unknown) => {
      response.writeHead(error instanceof BodyTooLarge ? 413 : 500, JSON_HEADERS);
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  });

  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => { server.off('error', reject); resolve(); });
  });
  const bound = server.address();
  const address = typeof bound === 'object' && bound ? `http://${bound.address.includes(':') ? `[${bound.address}]` : bound.address}:${bound.port}` : `http://${hostname}:${port}`;
  return {
    server,
    address,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      streams.clear();
      server.close(() => resolve());
    })
  };
}

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge(`the body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
