import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, powerMonitor, protocol, utilityProcess, type UtilityProcess } from 'electron';
import { CATALOGUE_HOST, HttpCatalogueSource, IMAGE_SCHEME } from '@cslytics/catalogue';
import { ImageCache } from './images/cache.js';
import { imageFetch } from './images/fetch.js';
import { ElectronCredentialVault } from './credential-vault.js';
import { trustInterceptedHostsUnpackaged } from './unpackaged-certificates.js';
import { reapRuntimeLock } from './runtime/runtime-lock.js';
import { purgeArgument, type PurgeOutcome, type PurgeRequest } from './runtime/account-clear.js';
import { CHANGE_CHANNEL, engineCommandSchema } from '../shared/api.js';
import { catalogueFetch, csfloatSchemaFetch } from './catalogue/fetch.js';
import { CatalogueMediator } from './catalogue/mediator.js';
import { openCheckout } from './checkout/checkout-window.js';
import { enrichStoreSheet, resolveStoreLines } from './store-names.js';
import { DESKTOP_PRELOAD_ENTRY } from '../shared/build-contract.js';
import { compareNames } from '../shared/name-order.js';
import type { ReleaseStatus } from '../shared/release.js';
import { desktopUserAgent, policyFetch } from './release/fetch.js';
import { APP_ID, POLICY_URL, profileDirectory } from './release/identity.js';
import { decide, summarize } from './release/policy.js';
import { ReleasePolicySource } from './release/policy-source.js';
import { DesktopUpdater } from './release/updater.js';
import { DESKTOP_VERSION } from './release/version.js';
import { SettingsStore } from './settings-store.js';
import { resolveTheme, THEMES, windowChrome, type ThemePreference } from '../shared/themes/index.js';

// On a network that filters TLS, Chrome reached api.cslytics.com over HTTP/3 while
// TCP :443 to Cloudflare timed out (measured). Electron does not enable QUIC unless asked,
// so catalogue sync was aborting as `timeout` while Firefox and Chrome worked.
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('origin-to-force-quic-on', `${CATALOGUE_HOST}:443`);
app.commandLine.appendSwitch('enable-features', 'UseDnsHttpsSvcb,UseDnsHttpsSvcbAlpn');

// The profile, before anything reads it: the single-instance lock below lives in it. A packaged
// copy is pinned to %APPDATA%\CSlytics so that no rename in a manifest can ever move a user's
// trading record and saved logins; a development run and `--user-data-dir` keep their own
// (desktop release plan D2).
const pinnedProfile = profileDirectory({
  packaged: app.isPackaged,
  explicitUserDataDir: app.commandLine.hasSwitch('user-data-dir'),
  appData: app.getPath('appData')
});
if (pinnedProfile) app.setPath('userData', pinnedProfile);

/**
 * Item art reaches the window over `cs-image:` and never over `https:`.
 *
 * This has to run before `ready`, which is why it is here rather than beside the handler. The
 * scheme is `standard` so the URL parses as authority plus path, and `secure` so a picture does
 * not make the page mixed content; it is deliberately **not** `supportFetchAPI` and **not**
 * `bypassCSP`, because the renderer is still forbidden every programmable network primitive and
 * `img-src` is still the thing that decides what may be loaded declaratively. See
 * `packages/catalogue/src/images.ts` for why the fetch moved out of the window at all.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true } }
]);

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let runtime: UtilityProcess | null = null;
let runtimeReady = false;
let runtimeFailure: string | null = null;
/** Why the runtime refused to open the trading record, in its own words; outlives its exit code. */
let runtimeFatal: string | null = null;
let quitting = false;
let shuttingDownRuntime = false;
/** The runtime `stopRuntime` is stopping, whose exit is therefore not a failure. */
let stoppingRuntime: UtilityProcess | null = null;
/**
 * A remove or reset in progress. Commands that arrive meanwhile wait for it: the runtime that
 * answers them is not running yet, or not yet listening.
 */
let restarting: Promise<void> | null = null;
let lockPath: string | null = null;
let requestSequence = 1;
/** The account the window last said it was showing; `null` is the all-accounts scope. */
let focusedAccountId: string | null = null;
const pending = new Map<number, Pending>();
/** The caption strip's height in pixels; `--cs-titlebar` in `renderer/tokens.css` must equal it. */
const TITLEBAR_HEIGHT = 32;

/**
 * The window and taskbar mark.
 *
 * Windows will not take an SVG here, so this is the raster of `renderer/assets/icon.svg`, the one
 * copy of the mark. Resolved from `out/main`, where this file is compiled.
 */
function appIconPath(): string {
  return join(__dirname, '../../resources/icon.png');
}

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) {
  app.quit();
} else {
  // Windows groups the taskbar button by this id. Without it, an unpackaged Electron run keeps
  // the default Electron icon even when BrowserWindow is given ours.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    lockPath = join(userData, 'trading.sqlite.runtime.lock');
    const vault = new ElectronCredentialVault(join(userData, 'credentials.enc.json'));
    // Preferences, read before the window exists so its first frame is already in the chosen theme.
    const settings = new SettingsStore(join(userData, 'settings.json'));
    settings.load();
    // Telling Chromium which way the theme leans is what makes scrollbars, a select's list and the
    // page's `prefers-color-scheme` agree with it; `system` hands the question back to Windows.
    const followTheme = (preference: ThemePreference): void => {
      nativeTheme.themeSource = preference === 'system' ? 'system' : THEMES[preference].scheme;
    };
    followTheme(settings.current().appearance.theme);
    const chrome = (): ReturnType<typeof windowChrome> =>
      windowChrome(resolveTheme(settings.current().appearance.theme, nativeTheme.shouldUseDarkColors));
    let appWindow: BrowserWindow | null = null;
    const paintWindowChrome = (): void => {
      if (!appWindow || appWindow.isDestroyed()) return;
      const colours = chrome();
      appWindow.setBackgroundColor(colours.background);
      appWindow.setTitleBarOverlay({ color: colours.titlebar, symbolColor: colours.symbols, height: TITLEBAR_HEIGHT });
    };
    // Windows changed its mind; only "Match Windows" listens, and the page repaints itself.
    nativeTheme.on('updated', paintWindowChrome);
    // The stop switch as last heard, then asked again at launch and hourly. No copy refuses
    // nothing; a copy that cannot be refreshed keeps applying (desktop release plan §5).
    const policy = new ReleasePolicySource(join(userData, 'release-policy.json'), POLICY_URL, policyFetch, desktopUserAgent());
    policy.load();
    const refreshPolicy = (): void => {
      void policy.refresh(new Date())
        .then((outcome) => {
          if (outcome === 'applied') notifyReleaseChanged();
          else if (outcome === 'invalid') console.warn('Release policy was not valid; the last good copy stands');
        })
        .catch(() => undefined);
    };
    refreshPolicy();
    setInterval(refreshPolicy, 60 * 60_000);
    const updater = new DesktopUpdater(app.isPackaged, desktopUserAgent(), notifyReleaseChanged);
    updater.start();
    const releaseStatus = (): ReleaseStatus => ({
      version: DESKTOP_VERSION,
      packaged: app.isPackaged,
      update: updater.state(),
      policy: summarize(policy.current(), DESKTOP_VERSION, policy.lastFetchedAt())
    });
    // Names and art live here, in main, and never in the engine runtime. The mediator resolves a
    // search into identity keys on the way in and attaches names on the way out; the runtime below
    // is handed identity and returns identity.
    //
    // A packaged build checks every host's certificate the ordinary way, these included. On a
    // network that re-signs traffic, names and art fail to load rather than arriving as whatever
    // that network chose to call an item. An unpackaged run excuses these hosts so development
    // works behind such a filter; `check:deps` refuses any other override.
    trustInterceptedHostsUnpackaged();
    // Pictures are main's to fetch, keep and serve. Registered before the window is created so a
    // first paint cannot race the handler and turn every tile into a placeholder for one render.
    const images = new ImageCache(join(userData, 'images'), imageFetch);
    protocol.handle(IMAGE_SCHEME, (request) => images.handle(request.url));
    void images.open()
      .then(() => console.info('Image cache', images.stats()))
      .catch((error) => console.warn('Image cache unavailable; art will be fetched every time', error));
    const catalogue = new CatalogueMediator(userData, new HttpCatalogueSource('en', catalogueFetch, 45_000), csfloatSchemaFetch);
    const catalogueOpened = catalogue.open();
    // CSFloat's own catalogue, which says why an item cannot go there (`csfloat-kinds.ts`): read at
    // start, then asked hourly and fetched once the copy held is four hours old. A failure keeps
    // the last copy; with none, rows carry no answer and the window says only what the read said.
    const refreshCsfloatKinds = (): void => {
      void catalogueOpened
        .then(() => catalogue.refreshCsfloatKinds())
        .then((outcome) => {
          if (outcome.kind === 'applied') notifyCatalogueChanged();
          else if (outcome.kind === 'unreachable') console.warn('CSFloat schema unavailable; the last copy stands', outcome.detail);
        })
        .catch((error) => console.warn('CSFloat schema refresh failed', error));
    };
    refreshCsfloatKinds();
    setInterval(refreshCsfloatKinds, 60 * 60_000);
    void catalogueOpened
      .then(() => catalogue.sync())
      .then((outcome) => {
        console.info('Catalogue sync', outcome);
        if (outcome.kind !== 'applied' && outcome.kind !== 'current') {
          if (outcome.kind === 'unreachable' && outcome.detail.includes('HTML error page')) {
            console.warn('Catalogue sync blocked: a web filter or proxy answered api.cslytics.com with an HTML page. Allow that host, then restart.');
          } else console.warn('Catalogue sync did not apply', outcome);
        }
        notifyCatalogueChanged();
      })
      .catch((error) => {
        console.warn('Catalogue sync failed', error);
        notifyCatalogueChanged();
      });
    /**
     * Forks the Engine Runtime and answers once it is ready, with how the purge it was asked for
     * went. Every handler checks that its child is still *the* runtime: across a restart the old
     * one's last messages and its exit can arrive after the new one exists.
     */
    const startRuntime = (purge?: PurgeRequest): Promise<PurgeOutcome | null> => new Promise((resolve, reject) => {
      runtimeReady = false;
      runtimeFailure = null;
      runtimeFatal = null;
      const child = utilityProcess.fork(join(__dirname, 'engine-runtime.js'), [join(userData, 'trading.sqlite'), ...(purge ? [purgeArgument(purge)] : [])], {
        serviceName: 'CSlytics Engine Runtime',
        // The engine persists through `node:sqlite`, which is unflagged only from Node 24.
        // Electron 37 bundles Node 22, where the module exists but throws without this flag —
        // so tests can pass on a modern local Node while the packaged app fails to open its
        // database. Decide from the Node actually running, not from the Electron version.
        execArgv: sqliteRequiresFlag() ? ['--experimental-sqlite'] : []
      });
      runtime = child;
      child.on('message', (message: any) => {
        if (runtime !== child) return;
        if (message?.kind === 'ready') {
          runtimeReady = true;
          console.info('Engine Runtime ready');
          resolve((message.purge ?? null) as PurgeOutcome | null);
          return;
        }
        if (message?.kind === 'fatal') {
          // The record was refused and left untouched: a newer build wrote it, or the backup before
          // an upgrade could not be made. The runtime waits for this kill so the sentence arrives
          // before its exit does, and every later command answers with the sentence.
          runtimeFatal = String(message.reason ?? 'The Engine Runtime could not open the trading record.');
          console.error('Engine Runtime refused the trading record:', runtimeFatal);
          try { child.kill(); } catch { /* already gone */ }
          return;
        }
        if (message?.kind === 'response') {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.ok) waiter.resolve(message.value);
          else waiter.reject(new Error(String(message.error)));
          return;
        }
        if (message?.kind === 'vault-request') {
          void handleVaultRequest(vault, message, child);
          return;
        }
        if (message?.kind === 'checkout-request') {
          void handleCheckoutRequest(message, child);
          return;
        }
        if (message?.kind === 'changed') {
          // Relayed, not interpreted. Main has no read model and must never grow one.
          for (const open of BrowserWindow.getAllWindows()) {
            if (!open.isDestroyed()) open.webContents.send(CHANGE_CHANNEL, {
              kind: 'changed',
              accountId: message.accountId,
              surfaces: message.surfaces,
              at: message.at
            });
          }
        }
      });
      child.on('exit', (code) => {
        const deliberate = quitting || stoppingRuntime === child;
        const phase = deliberate ? 'restarted' : runtimeReady ? `exited with code ${code}` : `failed to start with code ${code}`;
        const error = new Error(runtimeFatal ?? `Engine Runtime ${phase}`);
        reject(error);
        if (runtime !== child) return;
        if (!deliberate) runtimeFailure = error.message;
        runtimeReady = false;
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        runtime = null;
      });
    });
    void startRuntime().catch(() => undefined);

    /**
     * Remove and reset (steam/auth.md, "Removing or resetting an account"): the runtime stopped as
     * closing the app stops it, then started again with the account cleared before it answers
     * anything. Nothing short of that can stop one account's refresh loop, supervisor, event queue
     * and schedulers, so all of them restart; the window reloads and reconnects the other accounts.
     */
    const restartWithPurge = async (request: PurgeRequest): Promise<PurgeOutcome> => {
      if (restarting) throw new Error('Another account is being removed or reset. Try again in a moment.');
      // Asked of the running runtime first, so a refusal costs nobody their session.
      const { refusal } = await invokeRuntime({ type: 'accounts.clearable', accountId: request.accountId }) as { refusal: string | null };
      if (refusal) throw new Error(refusal);
      let finished!: () => void;
      restarting = new Promise<void>((resolve) => { finished = resolve; });
      try {
        await stopRuntime();
        // A runtime that never exited is abandoned; nothing it was asked will be answered.
        for (const waiter of pending.values()) waiter.reject(new Error('Engine Runtime restarted'));
        pending.clear();
        if (quitting) throw new Error('CSlytics is closing.');
        let outcome: PurgeOutcome | null;
        try {
          outcome = await startRuntime(request);
        } catch (error) {
          // The purge is one transaction, so a runtime that died in it left the record whole.
          // Start one without it rather than leave the app with no runtime at all.
          if (lockPath) reapRuntimeLock(lockPath);
          if (!quitting) await startRuntime().catch(() => undefined);
          throw error;
        }
        return outcome ?? { ...request, ok: false, error: 'The Engine Runtime did not say whether the account was cleared.' };
      } finally {
        restarting = null;
        finished();
      }
    };

    ipcMain.handle('trading:command', async (_event, raw: unknown) => {
      const command = engineCommandSchema.parse(raw);
      if (restarting && command.type !== 'accounts.remove' && command.type !== 'accounts.reset') await restarting;
      if (command.type === 'release.status') return releaseStatus();
      if (command.type === 'release.check') {
        await updater.check();
        return releaseStatus();
      }
      if (command.type === 'release.install') {
        updater.install();
        return releaseStatus();
      }
      // The stop switch, before anything is forwarded: a refused command reaches neither the
      // runtime nor a venue, and its reason is the error every page already knows how to show.
      const refusal = decide(policy.current(), DESKTOP_VERSION, command.type);
      if (refusal.refused) throw new Error(refusal.message);
      // This desktop's preferences: main's file, never the runtime's.
      if (command.type === 'settings.read') return settings.current();
      if (command.type === 'settings.write') {
        const stored = settings.writeAppearance(command.appearance);
        followTheme(stored.appearance.theme);
        paintWindowChrome();
        return stored;
      }
      if (command.type === 'settings.launch') return settings.writeLaunch(command.accountId, command.launch);
      if (command.type === 'accounts.remove' || command.type === 'accounts.reset') {
        const mode = command.type === 'accounts.remove' ? 'remove' : 'reset';
        // A refusal throws before anything restarts. Past that point the outcome comes back either
        // way: the runtime has restarted, and the window has sessions to bring back even when the
        // purge rolled back.
        const outcome = await restartWithPurge({ accountId: command.accountId, mode });
        // Its preferences are data about it on this computer too. Reset keeps them.
        if (outcome.ok && mode === 'remove') {
          try { settings.forgetAccount(command.accountId); } catch (error) { console.warn('Could not forget the removed account\'s settings', error); }
        }
        return outcome;
      }
      if (command.type === 'catalogue.status') {
        return {
          ...catalogue.status(),
          categories: catalogue.categories(),
          rarities: catalogue.rarities(),
          collections: catalogue.collections()
        };
      }
      if (command.type === 'catalogue.suggest') return catalogue.suggest(command.text, command.limit);
      if (command.type === 'catalogue.accessories') return catalogue.accessories(command.family, command.text, command.limit);
      // The window is the only thing that knows which account it is showing, and the tier hooks
      // above fire without it. Remembering the last scope it named is what lets a focus event
      // restore the right one rather than guessing.
      if (command.type === 'refresh.scope') focusedAccountId = command.accountId;
      if (command.type === 'work.open' || command.type === 'waiting.open') {
        // Names and pictures, and nothing else. A `waiting.open` offer row carries the identity
        // of the item the trades walk matched to its first given line, so it is named here the
        // way a listing is. One whose line matched no single local item comes with an empty
        // match key; `enrich` answers that with the raw fallback, and the window ignores that
        // fallback for an unmatched row and says "An item", which is the honest rendering. Work
        // about a buy order names no item and is named by its market name (`enrichWork`).
        const answer = await invokeRuntime(command) as { rows?: Array<Record<string, unknown>> };
        if (Array.isArray(answer?.rows)) {
          void resolvePendingAndNotify(catalogue);
          return { ...answer, rows: catalogue.enrichWork(answer.rows) };
        }
        return answer;
      }
      if (command.type === 'trades.list' || command.type === 'trades.items' || command.type === 'trades.entry') {
        // Names and pictures, and nothing else: a trade line is identity, a market name or neither,
        // and `enrichTradeItems` names each as what it is (mediator). A list row is named by its
        // first item and the second it previews; an entry by its first, its groups and the CSFloat
        // trades it carried.
        const answer = await invokeRuntime(command) as { kind?: string; rows?: unknown[] } | null;
        if (answer === null || typeof answer !== 'object') return answer;
        void resolvePendingAndNotify(catalogue);
        if (command.type === 'trades.entry') return catalogue.enrichTradeEntry(answer as Record<string, unknown>);
        if (answer.kind !== 'page' || !Array.isArray(answer.rows)) return answer;
        const rows = answer.rows as Array<Record<string, unknown>>;
        return { ...answer, rows: command.type === 'trades.list' ? catalogue.enrichTradeRows(rows) : catalogue.enrichTradeItems(rows) };
      }
      if (command.type === 'buyOrders.read') {
        // A picture by market name: a buy order names no item this app holds, so there is no
        // identity to resolve for the order itself. The stickers and charms its filters require
        // are identities, and are named as those items would be (`enrichBuyOrders`).
        // The filter is the page's and is answered here: the engine is asked for the whole book,
        // and each order is flagged with whether the bar keeps it (`markBuyOrderMatches`).
        const { filter, ...forwarded } = command;
        const answer = await invokeRuntime(forwarded) as { rows?: Array<Record<string, unknown>> };
        return Array.isArray(answer?.rows)
          ? { ...answer, rows: catalogue.markBuyOrderMatches(catalogue.enrichBuyOrders(answer.rows), filter) }
          : answer;
      }
      if (command.type === 'listings.page' || command.type === 'listings.summary') {
        // Both directions, as for inventory, with one difference on the way in. A typed name is
        // answered by the engine from the venue's own name for the item, so `search` passes
        // through; an item, collection, rarity or normalised-float chip becomes identity keys and
        // wear bands here. On the way out the catalogue adds the picture and the rarity the
        // venue's string cannot carry. The summary has no rows to name.
        const resolved = catalogue.resolveListingFilter(command.filter as Record<string, unknown> | undefined);
        const forwarded = { ...command, ...(resolved === undefined ? {} : { filter: resolved }) };
        if (resolved === undefined) delete (forwarded as { filter?: unknown }).filter;
        const answer = await invokeRuntime(forwarded) as { kind?: string; rows?: unknown[] };
        if (command.type === 'listings.page' && answer?.kind === 'page' && Array.isArray(answer.rows)) {
          void resolvePendingAndNotify(catalogue);
          return { ...answer, rows: catalogue.enrich(answer.rows as Array<Record<string, unknown>>) };
        }
        return answer;
      }
      if (command.type === 'inventory.groups' || command.type === 'inventory.page' || command.type === 'selection.matching') {
        // The catalogue join the engine cannot do, in both directions: a name becomes identity
        // keys here, and identity comes back wearing a name.
        const resolved = catalogue.resolveFilter(command.filter as Record<string, unknown> | undefined);
        const forwarded = { ...command, ...(resolved === undefined ? {} : { filter: resolved }) };
        if (resolved === undefined) delete (forwarded as { filter?: unknown }).filter;
        if (command.type === 'inventory.page' && command.sort === 'name') {
          // The same join in a third place: a name order is worked out here and handed on as
          // identity keys in that order. The first page works it out afresh; later pages of the
          // same walk reuse it, so one walk has one order and its cursors stay valid.
          Object.assign(forwarded, {
            sort: 'keys',
            keyOrder: await tileNameOrder(catalogue, command.accountIds, resolved, command.cursor === undefined)
          });
        }
        const answer = await invokeRuntime(forwarded);
        if (command.type === 'selection.matching') return answer;
        const envelope = answer as { kind?: string; rows?: unknown[] };
        if (envelope?.kind === 'page' && Array.isArray(envelope.rows)) {
          // A miss found while naming this page is worth one batched question later, never a
          // request per row or per render.
          void resolvePendingAndNotify(catalogue);
          return { ...envelope, rows: catalogue.enrich(envelope.rows as Array<Record<string, unknown>>) };
        }
        return answer;
      }
      if (command.type === 'store.sheet' || command.type === 'store.refresh') {
        // Names and images are the host's to attach; the engine answers with Valve's item keys.
        return enrichStoreSheet(catalogue, await invokeRuntime(command) as Parameters<typeof enrichStoreSheet>[1]);
      }
      if (command.type === 'store.buy') {
        // The def index is resolved here from Valve's item names and frozen by the engine; a
        // line that does not resolve refuses the whole command before anything is written.
        return invokeRuntime({ ...command, lines: resolveStoreLines(command.lines) });
      }
      return invokeRuntime(command);
    });

    // No File/Edit/View menu in any build, and so none of its hidden shortcuts. Text fields keep
    // cut, copy and paste, which Chromium handles itself on Windows. A development run gets back
    // the two that matter while building, below the window.
    Menu.setApplicationMenu(null);

    const colours = chrome();
    const window = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 980,
      minHeight: 680,
      icon: appIconPath(),
      // No native title bar. The window is dragged by the renderer's `.titlebar` strip, and Windows
      // draws minimise, maximise and close over its right-hand end in the theme's `--cs-titlebar-bg`
      // and `--cs-titlebar-text`, at `--cs-titlebar` high (`renderer/tokens.css`). `backgroundColor`
      // is its `--cs-bg`, so the window never flashes white before the page paints. A theme change
      // repaints both (`paintWindowChrome`).
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colours.titlebar, symbolColor: colours.symbols, height: TITLEBAR_HEIGHT },
      backgroundColor: colours.background,
      webPreferences: {
        // This must match the explicit CommonJS output in electron.vite.config.ts. Sandboxed
        // preload scripts cannot run as ESM, even though the rest of this package does.
        preload: join(__dirname, `../preload/${DESKTOP_PRELOAD_ENTRY}`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    appWindow = window;
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(__dirname, '../renderer/index.html'));

    // Developer tools (F12 or Ctrl+Shift+I) and reload (Ctrl+R), which the default menu used to
    // provide. Never in an installed copy: a user has no use for either.
    if (!app.isPackaged) {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const key = input.key.toLowerCase();
        if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
          event.preventDefault();
          window.webContents.toggleDevTools();
        } else if (input.control && !input.shift && key === 'r') {
          event.preventDefault();
          window.webContents.reload();
        }
      });
    }

    /**
     * What the machine and the window are doing decides how hard the engine works.
     *
     * A hidden window has nobody reading it, so every account drops to the background cadence;
     * `powerMonitor`'s resume is treated the way a reconnect is, because a suspended machine is
     * exactly the blind window in which the world can move unobserved — see the continuous
     * freshness plan §1. Both are hints to the runtime, not commands: it still applies its own
     * budget.
     */
    const tier = (accountId: string | null): void => {
      void invokeRuntime({ type: 'refresh.scope', accountId }).catch(() => undefined);
    };
    window.on('focus', () => tier(focusedAccountId));
    window.on('blur', () => tier(null));
    window.on('minimize', () => tier(null));
    window.on('restore', () => tier(focusedAccountId));
    powerMonitor.on('suspend', () => tier(null));
    powerMonitor.on('resume', () => {
      tier(focusedAccountId);
      // Only the accounts the runtime is already keeping current. Naming every account here would
      // sign in the ones their owner left signed out, because reading an account signs it in.
      void invokeRuntime({ type: 'refresh.resume' }).catch(() => undefined);
    });
  });

  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    quitting = true;
    if (!runtime || shuttingDownRuntime) {
      if (lockPath) reapRuntimeLock(lockPath);
      return;
    }
    event.preventDefault();
    shuttingDownRuntime = true;
    void stopRuntime().then(() => {
      runtime = null;
      app.quit();
    });
  });
}

/**
 * Asks the Engine Runtime to stop the way closing the app does, and resolves once it has gone: a
 * clean shutdown, or a kill after two seconds and up to two more for the exit to land. A restart
 * needs the exit itself, because the next runtime refuses the record while this one holds its
 * lock. The lock is reaped either way.
 */
function stopRuntime(): Promise<void> {
  const child = runtime;
  if (!child) {
    if (lockPath) reapRuntimeLock(lockPath);
    return Promise.resolve();
  }
  stoppingRuntime = child;
  return new Promise((resolve) => {
    let finished = false;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(kill);
      if (giveUp) clearTimeout(giveUp);
      if (lockPath) reapRuntimeLock(lockPath);
      resolve();
    };
    child.once('exit', finish);
    const kill = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      giveUp = setTimeout(finish, 2_000);
    }, 2_000);
    try {
      child.postMessage({ kind: 'shutdown' });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
}

/**
 * Ask the server about keys this generation never had, and tell the window if it learned any.
 *
 * The missing half before: a page that revealed an unknown skin queued the lookup and nothing
 * announced the answer, so the row kept its raw fallback name and its empty picture until some
 * unrelated change happened to refetch the page. A resolved key is new catalogue knowledge and is
 * broadcast exactly as a sync is — `InventoryView` already refetches on the `catalogue` surface.
 */
async function resolvePendingAndNotify(catalogue: CatalogueMediator): Promise<void> {
  try {
    if (await catalogue.resolvePending()) notifyCatalogueChanged();
  } catch { /* a lookup that failed is a miss with a backoff, not an error the window can act on */ }
}

/** The name order of the last tile walk, so turning its pages does not read the summary again. */
let lastTileOrder: { key: string; order: string[] } | null = null;

/**
 * Identity keys in name order, for a tile page sorted by name.
 *
 * The engine can page every handle in an order of identity keys, and cannot page them by name,
 * because it has none. The group summary for the same scope and filter is bounded, so main reads
 * it whole, names it, and sorts the keys; the engine then orders handles by them. A scope past the
 * summary's cap cannot be ordered by name at all, and says so rather than falling back to another
 * order under a name heading.
 */
async function tileNameOrder(
  catalogue: CatalogueMediator,
  accountIds: readonly string[],
  filter: Record<string, unknown> | undefined,
  fresh: boolean
): Promise<string[]> {
  const key = JSON.stringify([accountIds, filter ?? null]);
  if (!fresh && lastTileOrder?.key === key) return lastTileOrder.order;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let stale = false;
    do {
      const envelope = await invokeRuntime({
        type: 'inventory.groups', accountIds, pageSize: 250, ...(filter === undefined ? {} : { filter }), ...(cursor ? { cursor } : {})
      }) as { kind: string; rows?: Array<Record<string, unknown>>; hasNext?: boolean; nextCursor?: string | null; groups?: number; cap?: number };
      if (envelope.kind === 'needs-filter') {
        throw new Error(`${(envelope.groups ?? 0).toLocaleString()} item types in this view, above the ${(envelope.cap ?? 0).toLocaleString()} that can be put in name order at once. Narrow it with a search, a category or a location, or sort by float or by when it was detected.`);
      }
      if (envelope.kind !== 'page') { stale = true; break; }
      rows.push(...(envelope.rows ?? []));
      cursor = envelope.hasNext ? envelope.nextCursor ?? undefined : undefined;
    } while (cursor);
    if (stale) continue;
    const named = new Map<string, string>();
    for (const row of catalogue.enrich(rows)) if (!named.has(row.matchKey)) named.set(row.matchKey, row.name);
    const order = [...named.entries()]
      .sort(([leftKey, leftName], [rightKey, rightName]) => compareNames(leftName, rightName) || leftKey.localeCompare(rightKey))
      .map(([matchKey]) => matchKey);
    lastTileOrder = { key, order };
    return order;
  }
  throw new Error('The inventory kept changing while it was being put in name order. Try again in a moment.');
}

/**
 * Tells the window that this build's update or stop-switch state moved, the way a catalogue sync
 * is announced: a surface to re-read, never the state itself.
 */
function notifyReleaseChanged(): void {
  for (const open of BrowserWindow.getAllWindows()) {
    if (open.isDestroyed()) continue;
    open.webContents.send(CHANGE_CHANNEL, {
      kind: 'changed',
      accountId: 'release',
      surfaces: ['release'],
      at: new Date().toISOString()
    });
  }
}

function notifyCatalogueChanged(): void {
  for (const open of BrowserWindow.getAllWindows()) {
    if (open.isDestroyed()) continue;
    open.webContents.send(CHANGE_CHANNEL, {
      kind: 'changed',
      accountId: 'catalogue',
      surfaces: ['catalogue'],
      at: new Date().toISOString()
    });
  }
}

/** True when this Node needs `--experimental-sqlite` to expose `node:sqlite`. */
function sqliteRequiresFlag(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major < 24;
}

/**
 * One request to the Engine Runtime. Rejects rather than throws, so a caller that does not await
 * it — the focus and wake hints — cannot become an uncaught exception in main; and waits out a
 * remove or reset, whose runtime is not listening yet.
 */
async function invokeRuntime(command: unknown): Promise<unknown> {
  if (restarting) await restarting;
  const child = runtime;
  if (!child) throw new Error(runtimeFailure ?? 'Engine Runtime is not running');
  const id = requestSequence++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.postMessage({ kind: 'request', id, command });
  });
}

/**
 * The Engine Runtime cannot open a window, so Valve's checkout page is main's to show. The URL
 * and the cookies arrive here and go to the checkout session only; the answer is one word.
 */
async function handleCheckoutRequest(message: any, child: UtilityProcess): Promise<void> {
  try {
    const outcome = await openCheckout({
      accountId: String(message.accountId),
      txnId: String(message.txnId),
      url: String(message.url),
      cookies: Array.isArray(message.cookies) ? message.cookies.map(String) : [],
      timeoutMs: Number(message.timeoutMs) || 600_000
    }, BrowserWindow.getAllWindows()[0]);
    replyTo(child, { kind: 'checkout-response', id: message.id, ok: true, outcome });
  } catch (error) {
    replyTo(child, { kind: 'checkout-response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Answers the runtime that asked, and only while it is still the runtime. Request ids restart in
 * every runtime, so an answer meant for one that a remove or reset stopped could otherwise settle
 * an unrelated request in the next.
 */
function replyTo(child: UtilityProcess, message: unknown): void {
  if (runtime !== child) return;
  try { child.postMessage(message); } catch { /* it has gone */ }
}

async function handleVaultRequest(vault: ElectronCredentialVault, message: any, child: UtilityProcess): Promise<void> {
  try {
    let value: unknown;
    if (message.operation === 'get') value = await vault.get(String(message.key));
    else if (message.operation === 'set') value = await vault.set(String(message.key), String(message.value));
    else if (message.operation === 'delete') value = await vault.delete(String(message.key));
    else throw new Error('Unknown vault operation');
    replyTo(child, { kind: 'vault-response', id: message.id, ok: true, value });
  } catch (error) {
    replyTo(child, { kind: 'vault-response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
