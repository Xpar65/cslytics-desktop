/**
 * The CSlytics website: the issuer of a desktop sign-in, and the only host this package talks to.
 */
export const CSLYTICS_WEBSITE_ORIGIN = 'https://cslytics.com';

/** The desktop's registered client id. A public client: there is no secret to go with it. */
export const DESKTOP_CLIENT_ID = 'cslytics-desktop';

export const AUTHORIZE_PATH = '/desktop/authorize';

/**
 * The pages the desktop may open in the person's browser, matched exactly. A prefix match would
 * accept `https://cslytics.com.example.net/…` as readily as the real site.
 */
const BROWSER_PATHS: ReadonlySet<string> = new Set([AUTHORIZE_PATH]);

export function isAllowedBrowserUrl(candidate: string, origin: string = CSLYTICS_WEBSITE_ORIGIN): boolean {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(candidate);
    expected = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === expected.protocol
    && url.username === ''
    && url.password === ''
    && url.host === expected.host
    && BROWSER_PATHS.has(url.pathname)
    && url.hash === '';
}

/**
 * The origin this build signs in against.
 *
 * A packaged build always uses the real website. A development build may point at a preview
 * deployment through an override, but only over https or at this computer's loopback address: a
 * refresh token is sent to whatever this returns, so a plain-http host anywhere else is refused
 * and the real website is used instead.
 */
export function websiteOrigin(packaged: boolean, override: string | undefined): { origin: string; refused: string | null } {
  if (packaged || override === undefined || override === '') return { origin: CSLYTICS_WEBSITE_ORIGIN, refused: null };
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    return { origin: CSLYTICS_WEBSITE_ORIGIN, refused: 'not a URL' };
  }
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) return { origin: CSLYTICS_WEBSITE_ORIGIN, refused: 'must be https, or http on 127.0.0.1' };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { origin: CSLYTICS_WEBSITE_ORIGIN, refused: 'must be an origin with no path, query or credentials' };
  }
  return { origin: url.origin, refused: null };
}

/** How a connected desktop is named on the website. Never the hostname, which is personal. */
export function deviceLabel(platform: string): string {
  const name = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'a computer';
  return `CSlytics Desktop on ${name}`;
}
