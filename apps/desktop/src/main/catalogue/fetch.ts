import { net } from 'electron';
import { CATALOGUE_HOST, CSFLOAT_SCHEMA_URL } from '@cslytics/catalogue';
import { desktopUserAgent } from '../release/fetch.js';

/**
 * Catalogue downloads go through Chromium's `net.fetch`.
 *
 * Chrome and Firefox reach this host on networks where Node, curl and a default
 * Electron TCP fetch time out — Cloudflare is on HTTP/3, and TCP :443 is what
 * dies. `index.ts` enables QUIC before `ready` so this call can take the same
 * path. The URL is refused if it ever leaves the compiled catalogue host.
 */
export function catalogueFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'https:' || url.hostname !== CATALOGUE_HOST) {
    return Promise.reject(new Error(`catalogue: refused ${url.hostname}`));
  }
  // Which build is asking, and nothing about who (desktop release plan D7). Added here rather than
  // in the catalogue package, which `check:assets` keeps free of every header that could identify.
  const headers = new Headers(init?.headers);
  headers.set('User-Agent', desktopUserAgent());
  return net.fetch(url.toString(), { ...init, headers }) as Promise<Response>;
}

/**
 * CSFloat's public item catalogue (`csfloat-kinds.ts`), by the same network stack, and that one
 * URL only: nothing else on CSFloat is main's to read — the account's own routes are the engine
 * runtime's, through the adapter and the account's key, and this request carries no key at all.
 */
export function csfloatSchemaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.toString() !== CSFLOAT_SCHEMA_URL) return Promise.reject(new Error(`csfloat schema: refused ${url.toString()}`));
  return net.fetch(url.toString(), init) as Promise<Response>;
}
