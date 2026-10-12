import { BrowserWindow, session as electronSession, type Session } from 'electron';
import { cookiePairs, isAllowedCheckoutUrl, readApproval, type CheckoutOutcome } from './checkout-approval.js';

/**
 * Valve's checkout page, in a window this app owns, for one in-game store transaction.
 *
 * The Engine Runtime asks for this over `parentPort` (`checkout-request`), the way it asks the
 * vault, because a utility process has no window. The account's web cookies are set on a
 * non-persistent session partition so the page loads signed in, the approve POST the page sends
 * is read on its way out, and the partition is cleared when the window closes. The renderer
 * never sees the URL or the cookies, and nothing here writes either anywhere (STORE-05,
 * STORE-13). One checkout at a time: a second request waits for the first window to close.
 *
 * What the page posts is decided in `checkout-approval.ts`, where a unit test can hold it.
 */
export type { CheckoutOutcome } from './checkout-approval.js';

export type CheckoutOpenRequest = { accountId: string; txnId: string; url: string; cookies: string[]; timeoutMs: number };

const COOKIE_HOSTS = ['store.steampowered.com', 'checkout.steampowered.com', 'help.steampowered.com', 'steamcommunity.com'];
const CHECKOUT_URLS = ['https://checkout.steampowered.com/*', 'https://store.steampowered.com/checkout/*'];
/** After the approve POST completes, Steam shows a receipt; the person gets a moment to see it. */
const RECEIPT_LINGER_MS = 1_500;

let queue: Promise<unknown> = Promise.resolve();

export function openCheckout(request: CheckoutOpenRequest, parent?: BrowserWindow): Promise<CheckoutOutcome> {
  const next = queue.then(() => run(request, parent), () => run(request, parent));
  queue = next.catch(() => undefined);
  return next;
}

async function run(request: CheckoutOpenRequest, parent?: BrowserWindow): Promise<CheckoutOutcome> {
  if (!isAllowedCheckoutUrl(request.url)) throw new Error('The checkout URL is not a Steam page');
  const ses = electronSession.fromPartition(`checkout:${request.accountId}`, { cache: false });
  await seed(ses, request.cookies);
  let outcome: CheckoutOutcome | null = null;
  ses.webRequest.onBeforeRequest({ urls: CHECKOUT_URLS }, (details, callback) => {
    if (details.method === 'POST' && details.uploadData?.length) {
      const body = details.uploadData.map((part) => (part.bytes ? Buffer.from(part.bytes).toString('utf8') : '')).join('');
      outcome = readApproval(body) ?? outcome;
    }
    callback({});
  });
  const window = new BrowserWindow({
    width: 940, height: 800, title: 'Steam checkout', ...(parent ? { parent } : {}),
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (!isAllowedCheckoutUrl(target)) event.preventDefault(); });
  try {
    return await new Promise<CheckoutOutcome>((resolve) => {
      let done = false;
      const finish = (result: CheckoutOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
        if (!window.isDestroyed()) window.close();
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), request.timeoutMs);
      window.on('closed', () => finish(outcome ?? { kind: 'closed' }));
      ses.webRequest.onCompleted({ urls: CHECKOUT_URLS }, (details) => {
        if (outcome && details.method === 'POST') setTimeout(() => finish(outcome!), RECEIPT_LINGER_MS);
      });
      void window.loadURL(request.url).catch(() => finish(outcome ?? { kind: 'closed' }));
    });
  } finally {
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onCompleted(null);
    await ses.clearStorageData().catch(() => undefined);
  }
}

async function seed(ses: Session, cookies: string[]): Promise<void> {
  await ses.clearStorageData();
  for (const { name, value } of cookiePairs(cookies)) {
    for (const host of COOKIE_HOSTS) {
      await ses.cookies.set({ url: `https://${host}/`, name, value, secure: true, sameSite: 'no_restriction' });
    }
  }
}
