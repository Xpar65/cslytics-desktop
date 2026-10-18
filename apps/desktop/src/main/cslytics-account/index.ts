import { join } from 'node:path';
import { app, net, shell } from 'electron';
import {
  AccountFile, CslyticsAccount, HttpAccountIssuer, deviceLabel, isAllowedBrowserUrl, websiteOrigin,
  type CslyticsStatus, type FetchLike
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
 * The browser is opened only at the website's authorize page.
 */
export function createCslyticsAccount(options: { userData: string; vault: CredentialVault; onChange: () => void }): CslyticsAccount {
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
    issuer: new HttpAccountIssuer(origin, fetchImpl),
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
