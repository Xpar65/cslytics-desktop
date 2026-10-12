import { net } from 'electron';
import { IMAGE_HOSTS } from '@cslytics/catalogue';

/** What the cache needs from a transport, so a test can hand it one that never leaves the process. */
export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Item art downloads go through Chromium's `net.fetch`, as catalogue JSON does. The fetch that used
 * to happen implicitly inside an `<img>` element stays on Chromium's stack now that main makes it
 * explicitly: the same proxy settings and the same certificate checks, with no host excused. A
 * refusal is now a logged error rather than a silently broken `<img>`.
 *
 * The URL is refused if it names anything outside the compiled allowlist. `parseCachedImageUrl`
 * has already put the reference through `imageUrl`, so this is the second of two gates rather
 * than the only one — but the point of a host allowlist is that it is checked where the socket is
 * opened, not only where the string was built.
 */
export function imageFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.includes(parsed.hostname)) {
    return Promise.reject(new Error(`image: refused ${parsed.hostname}`));
  }
  // A 30x must never be allowed to choose the host: img-src is gone as a backstop now that the
  // renderer no longer makes this request, so the redirect that silently killed every avatar
  // (`packages/catalogue/src/images.ts`) has to be refused here instead of followed.
  return net.fetch(parsed.toString(), { ...init, redirect: 'manual' }) as Promise<Response>;
}
