import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, powerMonitor, protocol } from 'electron';
import { RUNTIME_COMMAND_TYPES } from '@cslytics/runtime/api';
import { CATALOGUE_HOST, HttpCatalogueSource, IMAGE_SCHEME } from '@cslytics/catalogue';
import { currencyById } from '@cslytics/market-data';
import { MarketDataHost } from './market-data/host.js';
import { AccountBooks } from './market-data/account-books.js';
import { marketFetch } from './market-data/fetch.js';
import { itemCurve, itemHistory, itemPage, itemVariants, itemWatch, portfolioValuation } from './market-data/portfolio.js';
import { ImageCache } from './images/cache.js';
import { imageFetch } from './images/fetch.js';
import { ElectronCredentialVault } from './credential-vault.js';
import { answerCslytics, createCslyticsAccount } from './cslytics-account/index.js';
import { trustInterceptedHostsUnpackaged } from './unpackaged-certificates.js';
import { createEngineSide, type EngineSide } from './engine/engine-side.js';
import { LocalRuntimeTransport } from './engine/local-runtime.js';
import { HostPageView } from './engine/host-page-view.js';
import { CHANGE_CHANNEL, ENGINE_HOST_SURFACE, engineCommandSchema, type ChangeNotification, type EngineCommand, type EngineConnection, type HostPage } from '../shared/api.js';
import { catalogueFetch, csfloatSchemaFetch } from './catalogue/fetch.js';
import { CatalogueMediator } from './catalogue/mediator.js';
import { HoldingCounts, type GroupPage } from './catalogue/holding-counts.js';
import { openCheckout } from './checkout/checkout-window.js';
import { enrichStoreSheet, resolveStoreLines } from './store-names.js';
import { DESKTOP_PRELOAD_ENTRY, HOST_PAGE_PRELOAD_ENTRY } from '../shared/build-contract.js';
import { compareNames } from '../shared/name-order.js';
import type { ReleaseStatus } from '../shared/release.js';
import { desktopUserAgent, policyFetch } from './release/fetch.js';
import { APP_ID, POLICY_URL, profileDirectory } from './release/identity.js';
import { decide, summarize } from './release/policy.js';
import { ReleasePolicySource } from './release/policy-source.js';
import { DesktopUpdater } from './release/updater.js';
import { DESKTOP_VERSION } from './release/version.js';
import { SettingsStore } from './settings-store.js';
import { NotificationsStateStore } from './notifications-state-store.js';
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

let quitting = false;
let shuttingDownRuntime = false;
/** The account the window last said it was showing; `null` is the all-accounts scope. */
let focusedAccountId: string | null = null;
/**
 * The engine this desktop drives, local or on another machine, behind the one seam every command
 * goes through (remote engine host plan D1). Set once the app is ready.
 */
let engineSide: EngineSide | null = null;
/** The view a connected host's page is shown in (plan D12), once there is a window to show it over. */
let hostPageView: HostPageView | null = null;
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
    const vault = new ElectronCredentialVault(join(userData, 'credentials.enc.json'));
    // The optional CSlytics sign-in (CSlytics account sign-in plan §6). Read and verified beside the
    // runtime, never ahead of it: nothing about Steam waits on the website.
    const cslytics = createCslyticsAccount({ userData, vault, onChange: notifyCslyticsChanged });
    const cslyticsReady = cslytics.start().catch(() => undefined);
    void cslyticsReady.then(() => cslytics.verify()).catch(() => undefined);
    setInterval(() => { void cslytics.verify().catch(() => undefined); }, 60 * 60_000);
    // Preferences, read before the window exists so its first frame is already in the chosen theme.
    const settings = new SettingsStore(join(userData, 'settings.json'));
    settings.load();
    // What the bell has told the person: main's file beside the settings (notifications plan §7.2),
    // kept per connection so a host's account and a local one that share an id never share a
    // watermark (remote engine host plan D11).
    let notificationsState = notificationsStateFor(userData, settings.current().engine);
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
    // Prices: the market-data cache, its scheduler and the FX refresh, composed here and never in
    // the runtime (portfolio and pricing plan D3). A read, an absence, a stop or a rate change
    // reaches the window as a `market` surface change, coalesced so a 4 rps fill is not 4 repaints.
    const market = new MarketDataHost(userData, {
      fetch: marketFetch,
      userAgent: desktopUserAgent(),
      log: (message, detail) => console.warn(message, detail ?? ''),
      onEvent: (event) => {
        if (event.kind === 'book' || event.kind === 'absent' || event.kind === 'fill-complete' || event.kind === 'stopped' || event.kind === 'rate') notifyMarketChanged();
      }
    });
    marketHost = market;
    market.start();
    // An account's own read of a book, for a wallet the anonymous book is not priced for (plan
    // D17): relayed by the runtime, or a journey's seed when the profile carries one.
    const accountBooks = new AccountBooks({
      invoke: invokeRuntime,
      now: () => new Date(),
      ...(market.oracle ? { seeded: (accountId: string, name: string) => market.seededAccountBook(accountId, name) } : {})
    });
    const marketDeps = { host: market, catalogue, settings: () => settings.current(), invoke: invokeRuntime, accountBooks };
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
     * The engine side (remote engine host plan D1–D3): the Engine Runtime forked beside the window
     * over this profile's record, or a host on another machine over its four routes, as
     * `settings.json` says. Either way every command below goes through `invokeRuntime`, and every
     * change notice comes back through `relayChanged`; the local transport keeps the fork, the vault
     * and checkout relays and the purge restart that used to live here.
     */
    const engine = createEngineSide({
      settings,
      vault,
      desktopVersion: DESKTOP_VERSION,
      local: () => new LocalRuntimeTransport({
        userData,
        entry: join(__dirname, 'engine-runtime.js'),
        vault,
        checkout: (request) => openCheckout(request, BrowserWindow.getAllWindows()[0]),
        onNotice: relayChanged,
        // The preference the engine steers by, applied before any page can ask it (consolidation plan D13).
        onReady: () => { void invokeRuntime({ type: 'csfloat.protection', enabled: settings.current().csfloat.protection }).catch(() => undefined); },
        isQuitting: () => quitting
      }),
      onNotice: relayChanged,
      onHostState: notifyEngineHostChanged
    });
    engineSide = engine;
    engine.start();
    // A connected host's pages, over the content area (plan D12). The list is read when the window
    // asks for it and kept until the connection changes, so moving a page's frame reads nothing.
    const hostPage = new HostPageView({
      preload: join(__dirname, `../preload/${HOST_PAGE_PRELOAD_ENTRY}`),
      host: () => {
        const origin = engine.hostOrigin();
        const token = engine.hostToken();
        return origin !== null && token !== null ? { origin, token } : null;
      },
      window: () => appWindow
    });
    hostPageView = hostPage;
    let hostPages: HostPage[] | null = null;
    const pagesOfHost = async (): Promise<HostPage[]> => {
      hostPages ??= await engine.pages();
      return hostPages;
    };
    /** The connection changed under the window: its per-connection files and the host's pages start over. */
    const reconnected = (): void => {
      hostPage.close();
      hostPages = null;
      notificationsState = notificationsStateFor(userData, engine.connection);
      holdingCounts.forgetAll();
    };

    const answer = async (command: EngineCommand): Promise<unknown> => {
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
      // Which engine this desktop drives (remote engine host plan): answered here, never forwarded.
      if (command.type === 'engine.status') return engine.status();
      if (command.type === 'engine.connect') {
        const status = await engine.connect(command);
        reconnected();
        return status;
      }
      if (command.type === 'engine.disconnect') {
        const status = await engine.disconnect();
        reconnected();
        return status;
      }
      if (command.type === 'engine.pages') {
        hostPages = null;
        return pagesOfHost();
      }
      if (command.type === 'engine.showPage') {
        const page = (await pagesOfHost()).find((row) => row.id === command.id);
        if (!page) throw new Error('The engine host no longer serves that page.');
        hostPage.show(page, command.bounds);
        return null;
      }
      if (command.type === 'engine.hidePage') {
        hostPage.hide();
        return null;
      }
      // What the host owns when the engine is on another machine (plan D5): the sessions, the
      // process, its cadence and its one preference. Each answers with the sentence, and nothing is sent.
      const owned = engine.refusal(command.type);
      if (owned) throw new Error(owned);
      // This desktop's preferences: main's file, never the runtime's.
      if (command.type === 'settings.read') return settings.current();
      if (command.type === 'csfloat.protection') {
        // Kept here and passed on: the engine steers by it and persists nothing (consolidation plan D13).
        settings.writeCsfloatProtection(command.enabled);
        return invokeRuntime(command);
      }
      if (command.type === 'settings.write') {
        const stored = settings.writeAppearance(command.appearance);
        followTheme(stored.appearance.theme);
        paintWindowChrome();
        return stored;
      }
      if (command.type === 'settings.launch') return settings.writeLaunch(command.accountId, command.launch);
      // The CSlytics account: main's, never the runtime's.
      const cslyticsAnswer = answerCslytics(cslytics, cslyticsReady, command);
      if (cslyticsAnswer) return cslyticsAnswer;
      if (command.type === 'settings.currency') return settings.writeCurrency(command.currency);
      // The bell's watermarks: main's file, never the runtime's.
      if (command.type === 'notifications.state') return notificationsState.current();
      if (command.type === 'notifications.seen') return notificationsState.markSeen(command.accountId, command.watermark);
      // Prices, from main's own cache over the engine's reads; the runtime never sees one.
      if (command.type === 'portfolio.valuation') return portfolioValuation(marketDeps, command.accountIds);
      if (command.type === 'market.status') return market.status();
      if (command.type === 'market.fx') return market.store.latestFx() ?? null;
      if (command.type === 'portfolio.history') return market.store.valuationSnapshots(command.accountIds);
      if (command.type === 'item.page') return itemPage(marketDeps, command.name, command.accountIds);
      if (command.type === 'item.watch') return itemWatch(marketDeps, command.name, command.accountId);
      if (command.type === 'item.history') return itemHistory(marketDeps, command.name);
      if (command.type === 'item.curve') return itemCurve(marketDeps, command.name, command.venue ?? 'steam');
      if (command.type === 'item.variants') return itemVariants(marketDeps, command.name, command.accountIds);
      if (command.type === 'portfolio.read') {
        // The base currency defaults to the first account's wallet, pinned the first time one is
        // observed (portfolio and pricing plan D9). Pinned once: a base already set, or chosen,
        // is never moved by an account added or removed later.
        const rows = await invokeRuntime(command) as Array<{ accountId: string; currency: number | null }>;
        if (settings.current().currency.base === null && rows.some((row) => row.currency !== null)) {
          const listed = await invokeRuntime({ type: 'accounts.list' }) as Array<{ id: string }>;
          const byId = new Map(rows.map((row) => [row.accountId, row.currency]));
          const first = listed.map((account) => byId.get(account.id) ?? null).find((currency) => currency !== null) ?? rows.find((row) => row.currency !== null)?.currency ?? null;
          const code = currencyById(first)?.code;
          if (code !== undefined) settings.pinBaseCurrency(code);
        }
        return rows;
      }
      if (command.type === 'accounts.remove' || command.type === 'accounts.reset') {
        const mode = command.type === 'accounts.remove' ? 'remove' : 'reset';
        // A refusal throws before anything restarts. Past that point the outcome comes back either
        // way: the runtime has restarted, and the window has sessions to bring back even when the
        // purge rolled back.
        const outcome = await engine.restartWithPurge({ accountId: command.accountId, mode });
        holdingCounts.forget(command.accountId);
        // Its preferences are data about it on this computer too. Reset keeps them.
        if (outcome.ok && mode === 'remove') {
          try { settings.forgetAccount(command.accountId); } catch (error) { console.warn('Could not forget the removed account\'s settings', error); }
          try { notificationsState.forgetAccount(command.accountId); } catch (error) { console.warn('Could not forget the removed account\'s notifications watermark', error); }
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
      if (command.type === 'catalogue.suggest') {
        if (!command.accountIds) return catalogue.suggest(command.text, command.limit);
        // Counts still loading: the plain order now, and `pending` asks the bar to ask again.
        const holdings = await holdingCounts.get(command.accountIds);
        const answer = catalogue.suggest(command.text, command.limit, holdings.counts);
        return holdings.pending ? { ...answer, pending: true } : answer;
      }
      if (command.type === 'catalogue.accessories') return catalogue.accessories(command.family, command.text, command.limit);
      // The window is the only thing that knows which account it is showing, and the tier hooks
      // above fire without it. Remembering the last scope it named is what lets a focus event
      // restore the right one rather than guessing.
      if (command.type === 'refresh.scope') focusedAccountId = command.accountIds[0] ?? null;
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
      if (command.type === 'inventory.groups' || command.type === 'inventory.page' || command.type === 'selection.matching' || command.type === 'inventory.positions') {
        // The catalogue join the engine cannot do, in both directions: a name becomes identity
        // keys here, and identity comes back wearing a name. A positions envelope is not a page:
        // it goes back as the engine answered it, and `portfolioValuation` is what names its rows.
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
    };
    ipcMain.handle('trading:command', (_event, raw: unknown) => answer(engineCommandSchema.parse(raw)));

    // A connected host's page, in its view (plan D12): the engine's commands and the reads main
    // makes over them, answered as the window's are, and nothing this desktop answers about itself.
    // Only the view may ask; a page cannot change this desktop's settings, sign-in or connection.
    ipcMain.handle('host-page:command', (event, raw: unknown) => {
      if (!hostPage.isSender(event.sender)) throw new Error('Not a host page.');
      const command = engineCommandSchema.parse(raw);
      if (!hostPageMaySend(command.type)) throw new Error(`A host page may not send ${command.type}.`);
      return answer(command);
    });
    ipcMain.handle('host-page:host', async (event, raw: unknown) => {
      if (!hostPage.isSender(event.sender)) throw new Error('Not a host page.');
      const reply = await engine.hostRequest('POST', '/host/command', raw);
      let parsed: unknown = null;
      try {
        parsed = reply.body ? JSON.parse(reply.body) : null;
      } catch {
        throw new Error(`The engine host answered ${reply.status} with something that is not JSON.`);
      }
      if (reply.status < 200 || reply.status >= 300) {
        const error = (parsed as { error?: unknown } | null)?.error;
        throw new Error(typeof error === 'string' ? error : `The engine host answered ${reply.status}.`);
      }
      return parsed;
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
      // A host sets its own cadence (plan D5); a hint from this window would re-tier its accounts.
      if (engine.connection.kind !== 'local') return;
      void invokeRuntime({ type: 'refresh.scope', accountIds: accountId === null ? [] : [accountId] }).catch(() => undefined);
    };
    window.on('focus', () => tier(focusedAccountId));
    window.on('blur', () => tier(null));
    window.on('minimize', () => tier(null));
    window.on('restore', () => tier(focusedAccountId));
    // The price scheduler keeps its trickle while the window is shown and lets it go ten minutes
    // after it is hidden (portfolio and pricing plan D13); a hidden renderer's timers are
    // throttled, not stopped, so the hold is main's to apply, not the page's.
    const marketVisible = (): void => market.setVisible(!window.isDestroyed() && window.isVisible() && !window.isMinimized());
    window.on('show', marketVisible);
    window.on('hide', marketVisible);
    window.on('minimize', marketVisible);
    window.on('restore', marketVisible);
    powerMonitor.on('suspend', () => { tier(null); market.setVisible(false); });
    powerMonitor.on('resume', () => {
      tier(focusedAccountId);
      marketVisible();
      // Only the accounts the runtime is already keeping current. Naming every account here would
      // sign in the ones their owner left signed out, because reading an account signs it in.
      if (engine.connection.kind === 'local') void invokeRuntime({ type: 'refresh.resume' }).catch(() => undefined);
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
    // The price cache closes with the app: its scheduler stops dispatching and the file is closed
    // cleanly. Nothing waits on it; a read still in flight is dropped, and the store never evicts.
    const market = marketHost;
    marketHost = null;
    if (market) void market.stop().catch(() => undefined);
    if (shuttingDownRuntime) return;
    const side = engineSide;
    if (!side) return;
    hostPageView?.close();
    const local = side.local;
    if (!local || !local.running) {
      // Nothing to wait for: a remote stream ends as the process does, and a lock left by a
      // runtime that already went is reaped.
      local?.reapLock();
      shuttingDownRuntime = true;
      void side.close().catch(() => undefined);
      return;
    }
    event.preventDefault();
    shuttingDownRuntime = true;
    void side.close().then(() => app.quit());
  });
}

/**
 * The bell's watermark file for this connection (remote engine host plan D11): beside the settings
 * for the local engine, under `remote/<host>/` for a host, so two records never share one.
 */
function notificationsStateFor(userData: string, connection: EngineConnection): NotificationsStateStore {
  let directory = userData;
  if (connection.kind === 'remote') {
    directory = join(userData, 'remote', hostFolderName(connection.url));
    mkdirSync(directory, { recursive: true });
  }
  const store = new NotificationsStateStore(join(directory, 'notifications-state.json'));
  store.load();
  return store;
}

/** A host URL as a folder name: its host and port, every other character replaced. */
function hostFolderName(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}_${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`.replace(/[^A-Za-z0-9._-]/g, '_');
  } catch {
    return url.replace(/[^A-Za-z0-9._-]/g, '_');
  }
}

/**
 * What a connected host's page may ask through its view (plan D12): the engine's own commands and
 * the reads main makes over them, which name items and price them. Nothing about this desktop.
 */
function hostPageMaySend(type: string): boolean {
  return RUNTIME_COMMAND_TYPES.has(type)
    || type.startsWith('catalogue.')
    || type.startsWith('item.')
    || type === 'portfolio.valuation'
    || type === 'portfolio.history'
    || type === 'market.status'
    || type === 'market.fx';
}

/**
 * A change notice from whichever engine is driven: relayed, not interpreted. Main has no read model
 * and must never grow one; the one thing it does with a notice is let go of the suggestion counts
 * it kept for that account. A host's page hears it the way the window does.
 */
function relayChanged(notice: ChangeNotification): void {
  holdingCounts.forget(notice.accountId);
  for (const open of BrowserWindow.getAllWindows()) {
    if (!open.isDestroyed()) open.webContents.send(CHANGE_CHANNEL, notice);
  }
  hostPageView?.notify(notice);
}

/** The engine connection's state moved: the window re-reads `engine.status`. */
function notifyEngineHostChanged(): void {
  for (const open of BrowserWindow.getAllWindows()) {
    if (open.isDestroyed()) continue;
    open.webContents.send(CHANGE_CHANNEL, {
      kind: 'changed',
      accountId: ENGINE_HOST_SURFACE,
      surfaces: [ENGINE_HOST_SURFACE],
      at: new Date().toISOString()
    });
  }
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

/** What each recently searched account set holds, so the filter bar can offer it first. */
const holdingCounts = new HoldingCounts((accountIds, cursor) => invokeRuntime({
  type: 'inventory.groups', accountIds, pageSize: 250, ...(cursor ? { cursor } : {})
}) as Promise<GroupPage>);

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

/** The CSlytics account's status moved: the window re-reads `cslytics.status`. */
function notifyCslyticsChanged(): void {
  for (const open of BrowserWindow.getAllWindows()) {
    if (open.isDestroyed()) continue;
    open.webContents.send(CHANGE_CHANNEL, {
      kind: 'changed',
      accountId: 'cslytics',
      surfaces: ['cslytics-account'],
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

/** The price cache, held at module level so quitting can close it (set once the app is ready). */
let marketHost: MarketDataHost | null = null;
let marketNotice: ReturnType<typeof setTimeout> | null = null;

/**
 * Tells the window prices moved, the way a catalogue sync is announced: a `market` surface to
 * re-read, never a figure. Coalesced to one notice per 1.5 s, because a fill reads four books a
 * second and a portfolio recomputed four times a second is a window that never settles.
 */
function notifyMarketChanged(): void {
  if (marketNotice !== null) return;
  marketNotice = setTimeout(() => {
    marketNotice = null;
    for (const open of BrowserWindow.getAllWindows()) {
      if (open.isDestroyed()) continue;
      open.webContents.send(CHANGE_CHANNEL, {
        kind: 'changed',
        accountId: 'market',
        surfaces: ['market'],
        at: new Date().toISOString()
      });
    }
  }, 1_500);
}

/**
 * One request to whichever engine is driven. Rejects rather than throws, so a caller that does not
 * await it — the focus and wake hints — cannot become an uncaught exception in main. The local
 * transport waits out a remove or reset itself; the remote one answers with the host's sentence.
 */
async function invokeRuntime(command: unknown): Promise<unknown> {
  const side = engineSide;
  if (!side) throw new Error('Engine Runtime is not running');
  return side.invoke(command);
}
