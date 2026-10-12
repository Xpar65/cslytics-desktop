import type { ImageRef } from './types.js';

/**
 * The one place an image URL is composed.
 *
 * Two rules live here rather than at each call site, because both fail silently where they are
 * used:
 *
 *  1. **The host allowlist is compiled in, not served.** `index.json` carries an `image_hosts`
 *     field and it is advisory. A server that starts naming a new host does not thereby get to
 *     load from it — widening where the app fetches pixels is a release, deliberately, and
 *     `check:assets` compares this list against the renderer's Content-Security-Policy so the two
 *     cannot drift.
 *  2. **A reference is data; a URL is not.** Nothing accepts a caller-supplied URL, and a
 *     reference that does not resolve returns `null` so the row renders its placeholder rather
 *     than an image element pointed at nothing.
 *
 * Steam serves the same economy image from several hosts. Akamai is the one the upstream corpus
 * publishes, so it is the one used; switching to `community.cloudflare.steamstatic.com`, or to a
 * mirror of our own, is a change to this constant and to the CSP, and to nothing else — which is
 * why the stored form is `econ:<hash>` rather than a full URL.
 */
export const ECON_IMAGE_HOST = 'community.akamai.steamstatic.com';
export const STEAM_CDN_HOST = 'cdn.steamstatic.com';
/**
 * Profile avatars from steam-user `getPersonas` / GetPlayerSummaries.
 *
 * **Not** the host steam-user names in its own `avatar_url_*` fields. Those still say
 * `steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/<xx>/<hash>.jpg`, which is now a
 * `301` to `https://avatars.steamstatic.com/<hash>.jpg` — a flat path, no two-character shard.
 * That redirect is why the old host shipped and every account still showed initials: CSP
 * `img-src` is re-checked against the redirect *target*, the target was not on the allowlist,
 * the image element failed, and `Avatar` fell back to initials exactly as designed. Nothing
 * threw, nothing was logged, and the persona walk had been storing the right hash all along.
 *
 * So the redirect target is the host stored here, and the CSP names it. Composing our own URL
 * from a hash rather than trusting `avatar_url_full` is what kept this a one-constant fix.
 * `fixtures/steam/contracts/personas-getpersonas-offline-live.json` records the old host because
 * that is what the probe observed; it is evidence about Steam's response, never about what this
 * app loads.
 */
export const AVATAR_IMAGE_HOST = 'avatars.steamstatic.com';

/** Every host the renderer may load an image from. Mirrored in the CSP; guarded by `check:assets`. */
export const IMAGE_HOSTS: readonly string[] = [ECON_IMAGE_HOST, STEAM_CDN_HOST, AVATAR_IMAGE_HOST];

/**
 * The Steam Community Market's page for one item, by its market hash name.
 *
 * Not a picture, and nothing loads it: the inspector offers it as text to copy. It is composed here
 * because this is the one module allowed a host name (`check:assets`), and the host is deliberately
 * not in `IMAGE_HOSTS`, so writing it down widens nothing the window can reach.
 */
export const STEAM_MARKET_HOST = 'steamcommunity.com';
export function steamMarketListingUrl(marketHashName: string): string {
  return `https://${STEAM_MARKET_HOST}/market/listings/730/${encodeURIComponent(marketHashName)}`;
}

/**
 * A Steam account's public profile page, for the other party of a trade. Text to copy, like the
 * market page above: the trades page names a stranger by nothing else (their name and picture are a
 * follow-up), so the profile is how a person finds out who they traded with.
 */
export function steamProfileUrl(steamId64: string): string {
  if (!/^\d{17}$/.test(steamId64)) throw new Error('A Steam profile is addressed by a SteamID64');
  return `https://${STEAM_MARKET_HOST}/profiles/${steamId64}`;
}

const ECON_PREFIX = 'econ:';
const AVATAR_PREFIX = 'avatar:';
/** Steam resizes server-side from one stored hash, so a list row costs a list row's bytes. */
export type ImageSize = 64 | 96 | 128 | 256 | 512;

/**
 * Compose a loadable URL, or `null`.
 *
 * `null` means *render the placeholder*, and it is returned for every doubtful case rather than a
 * best guess: an unknown reference form, a host off the allowlist, or anything carrying a path
 * escape, a nested scheme or a query string. The reference came from the network, and this is
 * where it stops being trusted.
 */
export function imageUrl(ref: ImageRef | null | undefined, size: ImageSize = 128): string | null {
  if (!ref) return null;
  if (ref.startsWith(AVATAR_PREFIX)) {
    const hash = ref.slice(AVATAR_PREFIX.length).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    const base = `https://${AVATAR_IMAGE_HOST}/${hash}`;
    // Steam publishes three fixed sizes and resizes nothing on demand: bare is 32×32, `_medium`
    // 64×64, `_full` 184×184. The bare icon is never asked for — every face here is 14–44 CSS px,
    // which is 28–88 device px on the 2× displays these run on, so 32×32 would be visibly soft on
    // half of them and read as the same bug. A face costs 2 KB at medium, 8.5 KB at full, once.
    return size >= 96 ? `${base}_full.jpg` : `${base}_medium.jpg`;
  }
  if (ref.startsWith(ECON_PREFIX)) {
    const hash = ref.slice(ECON_PREFIX.length);
    // Steam's economy hashes are URL-safe base64-ish; anything else is not one of ours.
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(hash)) return null;
    return `https://${ECON_IMAGE_HOST}/economy/image/${hash}/${size}fx${size}f`;
  }
  if (!ref.startsWith('https://')) return null;
  // Checked on the raw string, before parsing, because `new URL` *resolves* `..` rather than
  // rejecting it: `https://<host>/economy/image/../../etc/passwd` parses cleanly into
  // `https://<host>/etc/passwd`, which passes every check made after the fact. Caught by
  // `U-IMG-URL` before it shipped, and the reason that test enumerates escapes rather than trusting
  // one guard.
  if (ref.includes('..')) return null;
  let parsed: URL;
  try {
    parsed = new URL(ref);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!IMAGE_HOSTS.includes(parsed.hostname)) return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return null;
  // An allowlisted host is not an allowlisted path. Steam serves the whole store from these
  // names; only the econ trees and the avatar tree are loadable.
  if (parsed.hostname === AVATAR_IMAGE_HOST) {
    if (!/^\/[0-9a-f]{40}(_medium|_full)?\.jpg$/.test(parsed.pathname)) {
      return null;
    }
  } else if (!/^\/(economy\/image|apps\/730\/icons)\//.test(parsed.pathname)) {
    return null;
  }
  if (!/^[A-Za-z0-9._\-/]+$/.test(parsed.pathname)) return null;
  return parsed.toString();
}

/** Whether a reference is one this build would load, used when validating a fetched entry. */
export function isLoadableRef(ref: unknown): ref is ImageRef {
  return typeof ref === 'string' && imageUrl(ref) !== null;
}

/**
 * The scheme the window actually loads from. Nothing above this line is ever an `<img src>`.
 *
 * Item art used to be fetched by the renderer straight from Steam's CDN, and every way that
 * failed failed *invisibly*: a blocked redirect, an intercepting proxy serving an HTML page with
 * a `200`, a cold start before the network came up, a cert verdict the compiled exception did not
 * name. `<img onerror>` fires identically for all of them, so the app could only ever draw the
 * same placeholder and could never say which had happened, retry the ones worth retrying, or keep
 * what it had already seen.
 *
 * So the renderer now asks the main process for a picture by *reference*, over `cs-image:`, and
 * main is the only thing that talks to a CDN. That single move buys four things at once:
 *
 *  1. **Persistence.** Bytes land in a directory main owns, so art seen once survives a restart,
 *     an offline launch and a dead CDN. An economy hash is content-addressed and an avatar hash
 *     changes when the avatar does, so nothing here is ever revalidated — a hit is final.
 *  2. **Diagnosis.** A failure happens in a process that can log the status, the content type and
 *     the host, instead of in an element that can only stop displaying.
 *  3. **Retry.** A transient failure is retried with a backoff and then forgotten on success,
 *     rather than latching the tile off for the life of the window.
 *  4. **Reach.** `img-src` collapses to this one scheme, so the window has no remote origin left
 *     at all — SYS-03 goes from "no programmable network access" to "no network access".
 *
 * The URL is readable on purpose (`cs-image://econ/<hash>/128`), because the first question asked
 * of a missing picture is which reference it was. It carries no authority of its own: the handler
 * turns it back into a reference and puts it through `imageUrl` above, so this scheme widens the
 * set of loadable bytes by exactly nothing. A forged `cs-image:` URL is refused by the same
 * allowlist a forged `https:` reference was.
 */
export const IMAGE_SCHEME = 'cs-image';

/** The sizes a reference may be asked for. Anything else is a caller bug, not a smaller picture. */
export const IMAGE_SIZES: readonly ImageSize[] = [64, 96, 128, 256, 512];

/** `cs-image://<kind>/<segments…>/<size>`, kept to the characters `imageUrl` already permits. */
const CACHED_URL = /^cs-image:\/\/(econ|avatar|cdn)\/([A-Za-z0-9._\-/]+)\/([0-9]{2,3})$/;

/**
 * The reference a window may put in an `<img src>`, or `null`.
 *
 * `null` for anything `imageUrl` would refuse, checked here rather than at the handler: a handle
 * that exists is a handle that resolves, so a placeholder is drawn at render time instead of after
 * a round trip that was never going to succeed.
 */
export function cachedImageUrl(ref: ImageRef | null | undefined, size: ImageSize = 128): string | null {
  if (!ref || imageUrl(ref, size) === null) return null;
  if (ref.startsWith(AVATAR_PREFIX)) return `${IMAGE_SCHEME}://avatar/${ref.slice(AVATAR_PREFIX.length).toLowerCase()}/${size}`;
  if (ref.startsWith(ECON_PREFIX)) return `${IMAGE_SCHEME}://econ/${ref.slice(ECON_PREFIX.length)}/${size}`;
  // An absolute reference on an allowlisted host: 85 of 110 collection icons are one of these
  // rather than an economy hash, so the third form is not a corner case.
  const parsed = new URL(imageUrl(ref, size)!);
  return `${IMAGE_SCHEME}://cdn/${parsed.hostname}${parsed.pathname}/${size}`;
}

/**
 * The same picture at another size, from a handle the window already holds, or `null`.
 *
 * A row arrives carrying one handle at list size, and nearly every place draws it at list size.
 * The inspector does not: its preview fills an aside up to 720 CSS px wide, which is over a
 * thousand device pixels on a 2× display, and a 128 px picture stretched across that is the soft,
 * blocky art the item inspector used to show. Sending every row a second handle it will almost
 * never use would put a field on every page for one panel, so the window asks for the size it is
 * about to draw instead.
 *
 * The handle is parsed and recomposed, never edited as a string, so a resized handle is refused on
 * exactly the terms the original would have been. An absolute reference is a fixed-size file
 * upstream: its resized handle names the same upstream URL, so main answers it from the same
 * stored file rather than fetching a second copy.
 */
export function resizedImageUrl(handle: string | null | undefined, size: ImageSize): string | null {
  if (!handle) return null;
  const parsed = parseCachedImageUrl(handle);
  return parsed ? cachedImageUrl(parsed.ref, size) : null;
}

/**
 * Turn a `cs-image:` URL back into the reference it names and the upstream URL to fetch.
 *
 * The inverse of `cachedImageUrl`, and the only way the handler learns what to ask for. The
 * reference is rebuilt and then re-validated through `imageUrl`, so this function cannot be
 * argued into a host, a path or a size that a catalogue entry could not have produced — which is
 * what lets the URL be readable and forgeable without that mattering.
 */
export function parseCachedImageUrl(raw: string): { ref: ImageRef; size: ImageSize; upstream: string } | null {
  const match = CACHED_URL.exec(raw);
  if (!match) return null;
  const [, kind, body, rawSize] = match;
  const size = Number(rawSize) as ImageSize;
  if (!IMAGE_SIZES.includes(size)) return null;
  const segments = body!.split('/');
  const ref = kind === 'cdn'
    ? `https://${segments[0]}/${segments.slice(1).join('/')}`
    : `${kind}:${segments.join('/')}`;
  const upstream = imageUrl(ref, size);
  return upstream === null ? null : { ref, size, upstream };
}
