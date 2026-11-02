import { session } from 'electron';
import { CSLYTICS_HOST, STEAM_MARKET_HOST, type FetchLike } from '@cslytics/market-data';
import { catalogueFetch } from '../catalogue/fetch.js';
import { desktopUserAgent } from '../release/fetch.js';

/**
 * How market data leaves this machine (portfolio and pricing plan D4, D15).
 *
 * Steam goes through Node's own `fetch`: no Electron session, so no cookie from any in-app window
 * can ride along, and the answer's currency is the egress IP's and nothing else. CSlytics's free
 * CDN goes the way the catalogue does, through Chromium's stack, because that host is reached on
 * networks where Node's TCP path is not (`catalogue/fetch.ts`). Either way the only hosts are the
 * two compiled into the package, over HTTPS, and anything else is refused before a request is
 * made. A redirect is refused too: following one would let the answer choose the host.
 */
export const marketFetch: FetchLike = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`market-data: refused ${parsed.protocol}//${parsed.hostname}`);
  const host = parsed.hostname;
  if (host === CSLYTICS_HOST) {
    const response = await catalogueFetch(url, { headers: init.headers, ...(init.signal ? { signal: init.signal } : {}) });
    return { status: response.status, headers: response.headers, text: () => response.text() };
  }
  if (host !== STEAM_MARKET_HOST) throw new Error(`market-data: refused ${host}`);
  const response = await fetch(url, { headers: init.headers, redirect: 'error', ...(init.signal ? { signal: init.signal } : {}) });
  return { status: response.status, headers: response.headers, text: () => response.text() };
};

/** The one partition a bearer token travels in. In memory: nothing it holds outlives the run. */
const MEMBER_PARTITION = 'cslytics-member';
const MEMBER_PATH = '/member/v1/';

/**
 * How a request carrying a CSlytics access token leaves this machine (portfolio prices plan D11).
 *
 * Its own Electron session partition, so the certificate check is the ordinary one even in an
 * unpackaged run: `unpackaged-certificates.ts` excuses the catalogue host on the default session
 * alone, and a bearer token must never go to whoever can re-sign that host's traffic. Chromium's
 * stack still, for the reason the catalogue uses it. Refused for any host but the API's and any
 * path outside the member namespace, so the free CDN path is not widened by this transport and
 * the token can go nowhere else. A redirect is refused as above.
 */
export const memberFetch: FetchLike = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== CSLYTICS_HOST || !parsed.pathname.startsWith(MEMBER_PATH)) {
    throw new Error(`member: refused ${parsed.hostname}${parsed.pathname}`);
  }
  const headers = new Headers(init.headers);
  headers.set('User-Agent', desktopUserAgent());
  const response = await session.fromPartition(MEMBER_PARTITION).fetch(parsed.toString(), { headers, redirect: 'error', ...(init.signal ? { signal: init.signal } : {}) });
  return { status: response.status, headers: response.headers, text: () => response.text() };
};
