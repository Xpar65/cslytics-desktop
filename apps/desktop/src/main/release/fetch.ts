import { net } from 'electron';
import { clientUserAgent, POLICY_URL } from './identity.js';
import { DESKTOP_VERSION } from './version.js';

/** This build's `User-Agent` for CSlytics hosts (desktop release plan D7). */
export function desktopUserAgent(): string {
  return clientUserAgent(DESKTOP_VERSION, process.platform, process.arch);
}

/**
 * The stop-switch file, through Chromium's stack like the catalogue, and that one URL only.
 *
 * Certificate checks are the ordinary ones, even in an unpackaged run, which excuses only the
 * catalogue and image hosts: a policy that could be forged on an intercepting network is a stop
 * switch someone else can pull.
 */
export function policyFetch(url: string, init: RequestInit): Promise<Response> {
  if (url !== POLICY_URL) return Promise.reject(new Error(`release policy: refused ${url}`));
  return net.fetch(url, init) as Promise<Response>;
}
