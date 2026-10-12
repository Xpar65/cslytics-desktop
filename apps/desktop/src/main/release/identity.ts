import { join } from 'node:path';

/**
 * The installed app's identity (desktop release plan D1–D3, D7).
 *
 * Every value here is effectively permanent once a public build ships. The profile folder holds
 * each user's trading record and saved logins, so moving it strands them; the feed and publisher
 * are baked into every installed copy's `app-update.yml`, so changing them silently stops updates.
 * `electron-builder.config.mjs` repeats the ones it needs, and `desktop-packaging.test.ts` holds the
 * two copies equal.
 *
 * No Electron import: the pure half, so a unit test can read it.
 */
export const APP_ID = 'com.cslytics.desktop';
export const PRODUCT_NAME = 'CSlytics';

/** The folder under `%APPDATA%` a packaged copy keeps its profile in. */
export const PACKAGED_PROFILE_FOLDER = 'CSlytics';

/**
 * Installers, the update feed and the stop switch. A host of its own rather than a path under the
 * API host, because the feed needs short cache lifetimes the API does not.
 */
export const RELEASE_HOST = 'downloads.cslytics.com';
export const UPDATE_FEED_URL = `https://${RELEASE_HOST}/win`;
export const POLICY_URL = `https://${RELEASE_HOST}/desktop-policy.json`;

/**
 * Where a copy keeps its profile, or `null` to leave Electron's own choice.
 *
 * A packaged copy is pinned so that no later rename in a manifest can move it. An unpackaged run
 * keeps Electron's default, `%APPDATA%\@cslytics\desktop`, so that development never migrates the
 * installed app's record. `--user-data-dir` always wins: every journey passes one.
 */
export function profileDirectory(options: { packaged: boolean; explicitUserDataDir: boolean; appData: string }): string | null {
  if (options.explicitUserDataDir || !options.packaged) return null;
  return join(options.appData, PACKAGED_PROFILE_FOLDER);
}

/**
 * The `User-Agent` sent to CSlytics hosts, and only to them.
 *
 * It says which build is asking — enough to count the copies still running a version before a
 * contract they depend on is retired — and nothing about who: no account, no machine. The window's
 * global user agent is left alone, because Valve's checkout page runs under it.
 */
export function clientUserAgent(version: string, platform: string, arch: string): string {
  return `CSlytics-Desktop/${version} (${platform}; ${arch})`;
}
