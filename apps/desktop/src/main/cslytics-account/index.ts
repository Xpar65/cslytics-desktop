import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, net, shell } from 'electron';
import {
  AccountFile, CslyticsAccount, HttpAccountIssuer, OracleAccountIssuer, deviceLabel, isAllowedBrowserUrl, websiteOrigin,
  type AccountIssuer, type CslyticsStatus, type FetchLike, type OracleUser
} from '@cslytics/cslytics-account';
import type { CredentialVault } from '@cslytics/ports';
import type { EngineCommand } from '../../shared/api.js';
import { desktopUserAgent } from '../release/fetch.js';

/**
 * The optional CSlytics sign-in, composed for this process (CSlytics account sign-in plan §6).
 *
 * Main holds it and the engine never sees it. Requests go through Chromium's stack like every other
 * CSlytics request, and are refused if they ever leave the website's origin; certificates are
 * checked the ordinary way even in an unpackaged run, because these requests carry a refresh token.
 * The browser is opened only at the website's authorize page. A profile carrying `cslytics-seed.json`
 * gets the Oracle issuer in its place, which is how an offline journey starts signed in.
 */
export function createCslyticsAccount(options: { userData: string; vault: CredentialVault; onChange: () => void; issuer?: AccountIssuer }): CslyticsAccount {
  const chosen = websiteOrigin(app.isPackaged, process.env.CSLYTICS_WEBSITE_ORIGIN);
  if (chosen.refused) console.warn(`CSLYTICS_WEBSITE_ORIGIN ignored: ${chosen.refused}`);
  const origin = chosen.origin;
  const fetchImpl: FetchLike = async (url, init) => {
    const target = new URL(url);
    if (target.origin !== origin) throw new Error(`cslytics account: refused ${target.host}`);
    // Which build is asking, and nothing about who (desktop release plan D7).
    const headers = new Headers(init.headers);
    headers.set('User-Agent', desktopUserAgent());
    return net.fetch(target.toString(), { ...init, headers });
  };
  return new CslyticsAccount({
    issuer: options.issuer ?? new HttpAccountIssuer(origin, fetchImpl),
    vault: options.vault,
    file: new AccountFile(join(options.userData, 'cslytics-account.json')),
    openBrowser: async (url) => {
      if (!isAllowedBrowserUrl(url, origin)) throw new Error('cslytics account: refused to open that page');
      await shell.openExternal(url);
    },
    deviceLabel: deviceLabel(process.platform),
    onChange: options.onChange
  });
}

export const CSLYTICS_SEED_FILE = 'cslytics-seed.json';

/** What a journey writes to start signed in: one user, and the refresh token of a session the issuer already holds. */
export type CslyticsSeed = { user: OracleUser; refreshToken: string };

/**
 * A journey's signed-in profile (portfolio prices plan §7.6): the Oracle issuer holding the seeded
 * user and one session, and the refresh token the caller puts in the vault before the account
 * starts, so recovery finds a stored sign-in and the first verification confirms it with no
 * browser and no website. `null` on a live profile, which is every profile a person has.
 */
export function readCslyticsSeed(userData: string): { issuer: OracleAccountIssuer; refreshToken: string } | null {
  const path = join(userData, CSLYTICS_SEED_FILE);
  if (!existsSync(path)) return null;
  let seed: CslyticsSeed;
  try {
    seed = JSON.parse(readFileSync(path, 'utf8')) as CslyticsSeed;
  } catch {
    return null;
  }
  if (typeof seed !== 'object' || seed === null || typeof seed.refreshToken !== 'string' || typeof seed.user?.userId !== 'string') return null;
  const issuer = new OracleAccountIssuer(() => Date.now());
  issuer.addUser(seed.user);
  issuer.seedSession(seed.user.userId, seed.refreshToken, deviceLabel(process.platform));
  return { issuer, refreshToken: seed.refreshToken };
}

/**
 * Answers the window's `cslytics.*` commands once the stored sign-in has been read, and returns
 * null for every other command. No answer carries a token: the window gets `CslyticsStatus` only.
 */
export function answerCslytics(account: CslyticsAccount, ready: Promise<void>, command: EngineCommand): Promise<CslyticsStatus> | null {
  switch (command.type) {
    case 'cslytics.status': return ready.then(() => account.status());
    case 'cslytics.signIn': return ready.then(() => account.signIn());
    case 'cslytics.cancelSignIn': return ready.then(() => account.cancelSignIn());
    case 'cslytics.verify': return ready.then(() => account.verify());
    case 'cslytics.signOut': return ready.then(() => account.signOut());
    default: return null;
  }
}
