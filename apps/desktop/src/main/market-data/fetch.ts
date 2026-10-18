import { CSLYTICS_HOST, STEAM_MARKET_HOST, type FetchLike } from '@cslytics/market-data';
import { catalogueFetch } from '../catalogue/fetch.js';

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
