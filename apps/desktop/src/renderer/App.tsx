import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import { DEFAULT_SETTINGS, ENGINE_HOST_SURFACE, launchFor, type AccountLaunch, type DesktopSettings, type EngineStatus, type HostPage } from '../shared/api.js';
import { engine, listAccountsWhenReady, type RefreshStatusRow } from './lib/engine.js';
import { launchConnect } from './lib/launch.js';
import type {
  AccountConnection,
  AccountHoldings,
  ConnectionReport
} from './lib/types.js';
import { formatAmount } from './lib/money.js';
import { describeConnection } from './lib/connection.js';
import { plural } from './lib/labels.js';
import { heldCounts } from './lib/portfolio.js';
import { refreshCurrency } from './lib/currency.js';
import { PortfolioPage } from './features/portfolio/PortfolioPage.jsx';
import { ItemsView } from './features/items/ItemsView.jsx';
import { SignIn } from './features/accounts/SignIn.jsx';
import { AccountBar } from './features/accounts/AccountBar.jsx';
import { AccountsPanel, type AccountCard } from './features/accounts/AccountsPanel.jsx';
import { InventoryView, emptyInventorySelection, selectionQuantity, type InventorySelection } from './features/inventory/InventoryView.js';
import { LIST_INTENT, stageItems } from './features/inventory/list-intent.js';
import { REPRICE_INTENT } from './features/listings/listing-actions.js';
import { ListingWorkspace, useListingWorkspace } from './components/ListingWorkspace.js';
import { RecordsView } from './features/records/RecordsView.js';
import { ListingsView } from './features/listings/ListingsView.js';
import { BuyOrdersView } from './features/buy-orders/BuyOrdersView.js';
import { StoreView } from './features/store/StoreView.js';
import { SettingsView, rememberSettingsPage } from './features/settings/SettingsView.js';
import { forgetDismissedSuspension } from './features/settings/CsfloatAccountPage.js';
import { Button, Caption, Empty, Metric, Notice, Panel, Segmented } from './components/ui.jsx';
import { BrandMark, Icon, type IconName } from './components/Icon.jsx';
import { PageHeader, PageHeaderSlotsProvider } from './components/PageHeader.jsx';
import { WorkIndicator, WorkProvider } from './features/work/WorkIndicator.js';
import { NotificationProvider } from './features/notifications/NotificationProvider.js';
import { NotificationBell } from './features/notifications/NotificationBell.js';
import { NotificationStack } from './features/notifications/NotificationStack.js';
import type { Route } from './features/notifications/model.js';
import { RECORD_TABS, type RecordTab, type Section } from './lib/sections.js';
import { setUpByAccount, type VenueId } from './lib/marketplaces.js';
import { TradesView } from './features/trades/TradesView.js';
import { HostPageView } from './features/host/HostPageView.js';

type Status = { tone: 'idle' | 'busy' | 'error'; message: string };
const ENGINE_WAIT: Status = { tone: 'busy', message: 'Waiting for the Engine Runtime to answer.' };
/** Which sign-in screen is open, if any: a brand-new account, or one the app already knows. */
type SignInTarget = { kind: 'new' } | { kind: 'account'; account: AccountCard };

type SectionEntry = {
  id: Section;
  label: string;
  icon: IconName;
  perAccount: boolean;
  group: string;
  blurb: string;
};

/**
 * The navigation, in the order a person works: what they hold, where they sell it, and what has
 * happened. Moving items, listing them and moving them between accounts all start from Inventory.
 */
const SECTIONS: ReadonlyArray<SectionEntry> = [
  { id: 'portfolio', label: 'Portfolio', icon: 'dashboard', perAccount: false, group: 'Overview', blurb: 'Everything observed across your accounts' },
  { id: 'inventory', label: 'Inventory', icon: 'package', perAccount: false, group: 'Overview', blurb: 'Items by name, wherever they are' },
  { id: 'trades', label: 'Trades', icon: 'arrow-left-right', perAccount: false, group: 'Overview', blurb: 'Current and past trades, and what each was for' },
  { id: 'items', label: 'Items', icon: 'trending-up', perAccount: false, group: 'Overview', blurb: 'Any market item: its order book, its price history and its float curve' },
  { id: 'listings', label: 'Listings', icon: 'layers', perAccount: false, group: 'Markets', blurb: 'Everything listed, on every account and venue' },
  { id: 'buy-orders', label: 'Buy orders', icon: 'shopping-cart', perAccount: false, group: 'Markets', blurb: 'Every open buy order, on every account and venue' },
  { id: 'store', label: 'Store', icon: 'tag', perAccount: true, group: 'Markets', blurb: 'Keys, tools and passes from the CS2 in-game store' },
  { id: 'records', label: 'Records', icon: 'history', perAccount: false, group: 'Activity', blurb: 'Orders, market history, trades and the ledger' }
];

/** The Records page's tabs. Each book answers across every account in scope. */
const RECORD_TAB_ENTRIES: Record<RecordTab, { label: string; icon: IconName }> = {
  orders: { label: 'Orders', icon: 'receipt' },
  history: { label: 'History', icon: 'history' },
  trades: { label: 'Trades', icon: 'arrow-left-right' },
  ledger: { label: 'Ledger', icon: 'book' }
};

/** Sections kept in code but omitted from the sidebar until they ship again. */
const HIDDEN_SECTIONS: ReadonlySet<Section> = new Set(['store']);

/** Not in a group: it sits at the foot of the sidebar, above the account controls. */
const SETTINGS: SectionEntry = { id: 'settings', label: 'Settings', icon: 'settings', perAccount: false, group: 'Settings', blurb: 'This window, and the selected account with its marketplaces' };

const GROUPS = ['Overview', 'Markets', 'Activity'] as const;
const SIDEBAR_KEY = 'cslytics.sidebar';
const SIDEBAR_PIN_KEY = 'cslytics.sidebar.pinned';

const NO_CONNECTING: ReadonlySet<string> = new Set<string>();

/** What the window calls a surface a failed walk backed off, so "sales history" rests and not "the account". */
const HELD_SURFACE_WORDS: Readonly<Record<string, string>> = {
  'steam-market-history': 'sales history', 'steam-market': 'listings', 'steam-wallet': 'the wallet', 'steam-persona': 'the profile',
  'steam-trade-offers': 'trade offers', 'steam-trade-history': 'trade history', 'steam-trade-inventory': 'the trade inventory',
  'gc-inventory': 'the inventory', 'gc-storage-units': 'storage units', 'gc-casket': 'a storage unit', 'gc-store-price-sheet': 'the store',
  'csfloat-account-status': 'CSFloat', 'csfloat-stall': 'CSFloat listings', 'csfloat-trades': 'CSFloat sales', 'csfloat-inventory': 'the CSFloat inventory',
  'csfloat-buy-orders': 'CSFloat buy orders', 'csfloat-listing': 'a CSFloat listing', 'csfloat-trade': 'a CSFloat trade'
};

/**
 * Turns a refresh hold into something a person can act on.
 *
 * The two causes need different responses and must not read alike: one is another computer
 * holding the CS2 session, which only that computer can release; the other is this app waiting
 * out a failure, which fixes itself. A failed walk's hold is one surface's, and the text names
 * it, because the rest of the account is still being read.
 */
function describeHold(hold: RefreshStatusRow): string {
  if (hold.reason === 'blocked-elsewhere') return 'CS2 is open on another computer';
  if (hold.reason === 'gc-disconnected') return 'reconnecting to the Game Coordinator';
  const surface = hold.heldSurface ? HELD_SURFACE_WORDS[hold.heldSurface] ?? hold.heldSurface : undefined;
  return surface ? `${surface} is retrying after ${hold.reason}` : `retrying after ${hold.reason}`;
}

export function App(): React.JSX.Element {
  /**
   * Every account the Engine Runtime has a row for, in the order it lists them.
   *
   * These are *known* accounts, not connected ones. The window opens on the portfolio with all
   * of them loaded from SQLite and reconnects what it can from the refresh tokens in the OS
   * vault; whether any given one has a live Steam session, a live CS2 session, or neither, is a
   * separate question answered per account by `connections` and never by this list.
   */
  const [accounts, setAccounts] = useState<AccountCard[]>([]);
  /** False until the runtime has answered `accounts.list` once. */
  const [loaded, setLoaded] = useState(false);
  /** `null` is the all-accounts scope; otherwise the account every per-account tab is showing. */
  const [scope, setScope] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('portfolio');
  /**
   * The Items page's open market name, and the page it was opened from, which is where its Back
   * goes. `from` is null when the page was reached from the sidebar: there is nowhere to go back to.
   */
  const [itemView, setItemView] = useState<{ name: string | null; from: Section | null }>({ name: null, from: null });
  /** The Records page's open tab. Kept here rather than in the page, which remounts on every scope change. */
  const [recordTab, setRecordTab] = useState<RecordTab>('orders');
  const [signingIn, setSigningIn] = useState<SignInTarget | null>(null);
  const [status, setStatus] = useState<Status>(ENGINE_WAIT);
  const [busy, setBusy] = useState(false);

  const [holdings, setHoldings] = useState<AccountHoldings[]>([]);
  const [connections, setConnections] = useState<AccountConnection[]>([]);
  /** Each account's CSFloat status: the venue's ruling and the stall, for the bar and Settings. */
  const [venues, setVenues] = useState<Record<string, MarketplaceStatus | undefined>>({});
  /** Accounts with a connect attempt in flight, so their cards stop offering another one. */
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(NO_CONNECTING);
  /** How each account's last connect ended. Read only to choose between Connect and Sign in. */
  const [connectErrors, setConnectErrors] = useState<Record<string, string | null>>({});
  /** Why an account is not refreshing, when it is not. Empty is the normal, quiet case. */
  const [refreshHolds, setRefreshHolds] = useState<RefreshStatusRow[]>([]);
  /**
   * This desktop's `settings.json`, for each account's launch preferences. `null` until read: the
   * launch sweep waits for it, because connecting an account its owner asked to leave signed out,
   * even once, is the thing those preferences exist to prevent.
   */
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  /**
   * Which engine this window drives (remote engine host plan D5, D6, D12): `null` until main has
   * answered. A host owns its sessions, so with a remote engine the launch sweep does not run and
   * connect, sign-in, sign-out, add, remove and reset are not offered; the pages the host serves
   * are listed in the sidebar instead, and the open one is shown in main's view over the content.
   */
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [hostPages, setHostPages] = useState<HostPage[]>([]);
  const [hostPage, setHostPage] = useState<HostPage | null>(null);
  const remote = engineStatus?.kind === 'remote';
  const [inventorySelection, setInventorySelection] = useState<InventorySelection>(emptyInventorySelection);
  /**
   * The two listing workspaces: items staged for sale, and standing listings staged for a new
   * price. The shell holds them with the selection, for the same reason: all three outlive the
   * page. A person who stages items and opens one's Items page keeps the pill in the strip and the
   * rows behind it, and comes back to the same selection; a listing staged for a new price survives
   * leaving the Listings page the same way.
   */
  const listing = useListingWorkspace(LIST_INTENT, (keys) => {
    // The workspace sends row by row, so only the rows that went leave the selection. A blanket
    // clear would throw away the ones still waiting for a price.
    setInventorySelection((current) => {
      const rows = { ...current.rows };
      for (const key of keys) delete rows[key];
      return { rows };
    });
  });
  const reprice = useListingWorkspace(REPRICE_INTENT);
  const [sidebarPinned, setSidebarPinned] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_PIN_KEY) === '1'
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    if (localStorage.getItem(SIDEBAR_PIN_KEY) === '1') return false;
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  });

  /** The account a per-account tab returns to when it is picked from the all-accounts scope. */
  const lastAccount = useRef<string | null>(null);
  /** Accounts the launch sweep has already tried, so it never asks Steam for the same one twice. */
  const swept = useRef(new Set<string>());
  /**
   * Connects in flight, as a ref rather than the state above.
   *
   * The state drives what a card renders; this decides whether to start another attempt, and it
   * has to be readable *now* — React state read inside a callback is one render behind, which
   * is exactly long enough for a sweep and a button press to log the same account on twice.
   */
  const inFlight = useRef(new Set<string>());

  const accountIds = useMemo(() => accounts.map((entry) => entry.accountId), [accounts]);
  const accountNames = useMemo(
    () => accounts.map((entry) => ({
      id: entry.accountId, name: entry.accountName, avatarRef: entry.avatarRef, steamId64: entry.steamId64,
      // The wallet currency, once a market read has named it: every Steam figure a page prints for the account is in it.
      currency: holdings.find((row) => row.accountId === entry.accountId)?.currency ?? null
    })),
    [accounts, holdings]
  );
  const activeAccount = accounts.find((entry) => entry.accountId === scope) ?? null;
  const key = activeAccount?.accountId ?? '';

  /** Where the open page puts its badge and controls in the header (`PageHeader`). */
  const [badgeSlot, setBadgeSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const headerSlots = useMemo(
    () => ({ badge: badgeSlot, actions: actionsSlot }),
    [badgeSlot, actionsSlot]
  );

  /** Holdings and connection state for every known account. Both reach no network. */
  const refreshPortfolio = useCallback(async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) {
      setHoldings([]);
      setConnections([]);
      return;
    }
    const [nextHoldings, nextConnections, nextVenues] = await Promise.all([
      engine.readPortfolio(ids),
      engine.readConnections(ids),
      Promise.all(ids.map((id) => engine.marketplaceStatus(id).then((status) => [id, status] as const).catch(() => null)))
    ]);
    setHoldings(nextHoldings);
    setConnections(nextConnections);
    setVenues(Object.fromEntries(nextVenues.filter((entry): entry is readonly [string, MarketplaceStatus] => entry !== null)));
    // Main may have just pinned the base currency from the first wallet it saw (lib/currency.ts).
    void refreshCurrency();
  }, []);

  /** One account's CSFloat status, as a Settings action just read it back. */
  const venueChanged = useCallback((accountId: string, status: MarketplaceStatus): void => {
    setVenues((current) => ({ ...current, [accountId]: status }));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await refreshPortfolio(accountIds);
  }, [refreshPortfolio, accountIds]);

  /** Runs one operation, keeping the status line honest about what happened. */
  // `work` may answer with its own closing line, for an operation whose "done" is not a plain done.
  const run = useCallback(async (label: string, work: () => Promise<void | string>): Promise<void> => {
    setBusy(true);
    setStatus({ tone: 'busy', message: label });
    try {
      const outcome = await work();
      await refresh();
      setStatus({ tone: 'idle', message: outcome ?? `${label} — done` });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
      // A failed operation is very often *about* the connection — the CS2 session was taken by
      // another computer, say. Re-read it now instead of leaving the indicator stale until the
      // next poll, so the status line and the indicator never disagree about what just happened.
      if (accountIds.length > 0) {
        void engine.readConnections(accountIds).then(setConnections).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }, [refresh, accountIds]);

  /** Folds one `session.connect` or `session.signOut` answer into what the window is showing. */
  const applyReport = useCallback((report: ConnectionReport): void => {
    setConnections((current) => {
      const rest = current.filter((row) => row.accountId !== report.accountId);
      return [...rest, report];
    });
    setConnectErrors((current) => ({ ...current, [report.accountId]: report.lastError }));
  }, []);

  /**
   * One account, brought online from what is already stored.
   *
   * Never throws: this is called in a loop over every saved account at launch, and an account
   * whose CS2 session is held elsewhere must not stop the ones after it. The answer carries the
   * observed state either way, so a failure still updates the card rather than leaving it
   * showing whatever it said a moment ago.
   */
  const connect = useCallback(async (accountId: string, options: { cs2?: boolean } = {}): Promise<ConnectionReport | null> => {
    // A second attempt while the first is still out is not a retry, it is two Steam logons for
    // one account racing each other, and the loser's failure would be reported as the truth.
    if (inFlight.current.has(accountId)) return null;
    inFlight.current.add(accountId);
    setConnecting((current) => new Set(current).add(accountId));
    try {
      const report = await engine.connectAccount(accountId, options);
      applyReport(report);
      return report;
    } catch (error) {
      // The runtime itself did not answer — a very different thing from Steam refusing, and the
      // only case where nothing at all was observed about the account.
      setConnectErrors((current) => ({
        ...current,
        [accountId]: error instanceof Error ? error.message : String(error)
      }));
      return null;
    } finally {
      inFlight.current.delete(accountId);
      setConnecting((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
    }
  }, [applyReport]);

  /**
   * One connect, with its failure raised rather than swallowed.
   *
   * `connect` deliberately never throws, because the launch sweep must survive one bad account.
   * A button press is the opposite case: the user asked for exactly this account, and a status
   * line reading "done" over a connection that was refused is the kind of quiet lie this app is
   * built not to tell.
   */
  const attempt = useCallback(async (accountId: string): Promise<void> => {
    if (inFlight.current.has(accountId)) return;
    const report = await connect(accountId);
    if (!report) throw new Error('The Engine Runtime did not answer the connect request.');
    if (report.lastError) throw new Error(report.lastError);
  }, [connect]);

  useEffect(() => { if (scope) lastAccount.current = scope; }, [scope]);

  /** Re-reads the account list from SQLite. The one place `accounts` is set from. */
  const reloadAccounts = useCallback(async (): Promise<AccountCard[]> => {
    const listed = await listAccountsWhenReady();
    const cards = listed.map((row) => ({
      accountId: row.id,
      accountName: row.accountName,
      steamId64: row.steamId64,
      hasSession: row.hasSession,
      avatarRef: row.avatarRef,
      personaName: row.personaName
    }));
    setAccounts(cards);
    setLoaded(true);
    return cards;
  }, []);

  useEffect(() => {
    // A settings file that cannot be read is the defaults, which is how every account always opened.
    void engine.settings().then(setSettings).catch(() => setSettings(DEFAULT_SETTINGS));
  }, []);

  /** Which engine, and a host's pages, read again whenever main says the connection's state moved. */
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void engine.engineStatus().then((status) => {
        if (cancelled) return;
        setEngineStatus(status);
        if (status.kind !== 'remote') {
          setHostPages([]);
          return;
        }
        if (status.state === 'connected') {
          void engine.hostPages().then((pages) => { if (!cancelled) setHostPages(pages); }).catch(() => undefined);
        }
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = engine.subscribeToChanges((notice) => {
      if (notice.surfaces.includes(ENGINE_HOST_SURFACE)) read();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    void reloadAccounts()
      .then(() => {
        setStatus((current) => current.message === ENGINE_WAIT.message ? { tone: 'idle', message: 'Ready' } : current);
      })
      .catch((error: unknown) => {
        // An empty account list and an unreachable Engine Runtime look identical on screen, and
        // only one of them means "add your first account". Say which this is.
        setLoaded(true);
        setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
      });
  }, [reloadAccounts]);

  /**
   * The launch sweep: every saved account reconnected from its stored refresh token.
   *
   * One at a time, and that is the point rather than an accident. Each connect is a real Steam
   * client logon followed by a CS2 Game Coordinator handshake; firing all of them at once
   * spends a machine's worth of Steam's rate budget in one second, and the accounts that lose
   * that race fail for a reason that has nothing to do with their credentials.
   *
   * Each account opens the way `settings.json` says (steam/auth.md, "Launch preferences"):
   * signed in to Steam and CS2, to Steam alone, or not at all until someone presses Connect. An
   * account left out is still marked swept, so a later re-list does not sign it in either.
   */
  useEffect(() => {
    // The sweep is the local engine's: a host connected its accounts when it started, and a second
    // handshake per account per window open would cost it with no information in it (plan D6).
    if (settings === null || engineStatus === null || engineStatus.kind === 'remote') return undefined;
    const pending = accounts.filter((account) => account.hasSession && !swept.current.has(account.accountId));
    if (pending.length === 0) return undefined;
    for (const account of pending) swept.current.add(account.accountId);

    void (async () => {
      for (const account of pending) {
        const options = launchConnect(settings, account.accountId);
        if (options) await connect(account.accountId, options);
      }
    })();
    return undefined;
  }, [accounts, connect, settings, engineStatus]);

  /**
   * The GC session can end while nobody is clicking — another computer starts CS2 and Steam
   * hands it the session. The runtime watches for that itself and reconnects, but the window
   * still asks: this is a local read that reaches no network, and it is what keeps the
   * indicator honest between the runtime's own supervisor ticks.
   */
  useEffect(() => {
    if (accountIds.length === 0) return undefined;
    const poll = (): void => {
      void engine.readConnections(accountIds).then(setConnections).catch(() => undefined);
      void engine.readRefreshStatus(accountIds).then(setRefreshHolds).catch(() => undefined);
    };
    const timer = setInterval(poll, 10_000);
    return () => clearInterval(timer);
  }, [accountIds]);

  /**
   * The window's half of automatic freshness.
   *
   * The Engine Runtime writes to SQLite whenever a GC event lands or a scheduled walk finishes.
   * The notice carries *surfaces*, never rows, so the response is to re-read through the same
   * read models a click would have used.
   */
  useEffect(() => {
    if (accountIds.length === 0) return undefined;
    return engine.subscribeToChanges((notice) => {
      if (!accountIds.includes(notice.accountId)) return;
      if (notice.surfaces.includes('steam-persona')) {
        void reloadAccounts().catch(() => undefined);
      }
      void refreshPortfolio(accountIds).catch(() => undefined);
    });
  }, [accountIds, refreshPortfolio, reloadAccounts]);

  /**
   * Tells the runtime which account is on screen, so it can spend its budget there. Rule 8
   * forbids the scheduler having an ambient current account to guess with.
   */
  useEffect(() => {
    // A host sets its own cadence (plan D5); the hint would re-tier its accounts.
    if (engineStatus?.kind !== 'local') return;
    void engine.setRefreshScope(scope).catch(() => undefined);
  }, [scope, engineStatus]);

  useEffect(() => {
    if (accountIds.length > 0) void refresh().catch(() => undefined);
  }, [refresh, accountIds]);

  const signedIn = useCallback((next: { accountId: string; accountName: string; steamId64: string }) => {
    setSigningIn(null);
    setStatus({ tone: 'idle', message: `Connected as ${next.accountName}` });
    // Land on the account that was just connected: it is the one the user was thinking about.
    setScope(next.accountId);
    // Authentication is not a Game Coordinator session. Re-list first so the account exists as
    // a card with its saved-session flag set, then connect it the same way the sweep does —
    // claimed from the sweep before the list changes, so the two do not both start one.
    swept.current.add(next.accountId);
    void reloadAccounts()
      .then(() => connect(next.accountId))
      .catch(() => undefined);
  }, [reloadAccounts, connect]);

  /**
   * Ends one account's session in this window.
   *
   * The account stays on screen and its refresh token stays in the OS vault, so its card falls
   * back to Connect rather than disappearing.
   */
  const signOut = useCallback(async (accountId: string): Promise<void> => {
    const report = await engine.signOutAccount(accountId);
    applyReport(report);
    // Deliberately still marked swept. A deliberate sign-out must not be undone by the next
    // sweep — the account reconnects when someone presses Connect, and not before.
    const name = accounts.find((row) => row.accountId === accountId)?.accountName ?? accountId;
    setStatus({ tone: 'idle', message: `Signed out of ${name}` });
  }, [applyReport, accounts]);

  /**
   * The rare button.
   *
   * The Engine Runtime keeps every signed-in account current on its own, so this exists for the
   * one thing a scheduler cannot know about: something the user just did on the Steam website.
   */
  /** Answers with the surfaces each account's pass read, so the caller can say when that was nothing. */
  const refreshNow = useCallback(async (accountIds: readonly string[]): Promise<Record<string, string[]>> => {
    if (accountIds.length === 0) return {};
    const refreshed = await engine.refreshNow(accountIds);
    // Persona hashes land in `account` during the pass; re-list so faces update without
    // waiting on the change-notice relay (same reason inventory re-reads after a sync).
    await reloadAccounts();
    return refreshed;
  }, [reloadAccounts]);

  /** One account's launch preferences, written; the switches then show what came back. */
  const writeLaunch = useCallback(async (accountId: string, launch: AccountLaunch): Promise<void> => {
    setSettings(await engine.writeLaunch(accountId, launch));
  }, []);

  /**
   * Removes or resets one account. Main restarts the Engine Runtime to do it, so on success the
   * window reloads: every read, cursor and connection it holds belongs to a runtime that is gone,
   * and the reload's launch sweep reconnects the other accounts the way each is set to open. A
   * failure throws, and the dialog that asked shows it.
   */
  const clearAccount = useCallback(async (accountId: string, mode: 'remove' | 'reset'): Promise<void> => {
    const outcome = mode === 'remove' ? await engine.removeAccount(accountId) : await engine.resetAccount(accountId);
    if (!outcome.ok) {
      // The runtime restarted and the purge rolled back, so the record is as it was and only the
      // sessions are gone: sweep again rather than reload, so the dialog can still say why.
      swept.current.clear();
      void reloadAccounts().catch(() => undefined);
      throw new Error(outcome.error);
    }
    forgetDismissedSuspension(accountId);
    window.location.reload();
  }, [reloadAccounts]);

  const totals = useMemo(() => {
    const scoped = scope === null ? holdings : holdings.filter((row) => row.accountId === scope);
    const sum = (pick: (row: AccountHoldings) => number): number => scoped.reduce((total, row) => total + pick(row), 0);
    return {
      items: sum((row) => heldCounts(row.counts).total),
      buyOrders: sum((row) => row.counts.buyOrdersActive + row.counts.csfloatBuyOrdersActive)
    };
  }, [holdings, scope]);

  const counts: Record<Section, number> = {
    store: 0,
    // No count: an honest one spans both venues, and `holdings` only knows Steam's. A number
    // that silently omits CSFloat is worse here than no number at all — the page carries its own.
    listings: 0,
    // Buy orders are Steam's alone, so the holdings count is the whole of it, unlike Listings'.
    'buy-orders': totals.buyOrders,
    // No count: four books have no one number between them.
    records: 0,
    // No count yet: the Trades page carries its own, per list.
    trades: 0,
    // No count: the page is a search over the catalogue, not a list of anything held.
    items: 0,
    settings: 0,
    'host-page': 0,
    portfolio: accounts.length,
    inventory: totals.items
  };

  const activeHoldings = holdings.find((row) => row.accountId === key);
  const activeHeld = activeHoldings ? heldCounts(activeHoldings.counts) : null;
  const wallet = activeHoldings?.wallet
    ? { balance_cents: activeHoldings.wallet.balanceCents, currency: activeHoldings.currency }
    : null;
  /** The open host page as a section entry, so the header names it like any other page. */
  const hostEntry: SectionEntry | null = hostPage
    ? { id: 'host-page', label: hostPage.title, icon: 'globe', perAccount: false, group: 'Host', blurb: `A page served by ${engineStatus?.kind === 'remote' ? engineStatus.label : 'the engine host'}` }
    : null;
  const current = (section === 'host-page' && hostEntry) ? hostEntry : [...SECTIONS, SETTINGS].find((entry) => entry.id === section) ?? SECTIONS[0]!;
  const connection = describeConnection(connections.find((row) => row.accountId === key));
  // A frozen screen with no explanation is the failure this whole scheduler exists to remove,
  // so when an account is not refreshing the window says which problem it is.
  const hold = refreshHolds.find((row) => row.accountId === key && row.reason);
  const selectedCount = selectionQuantity(inventorySelection);
  const scopedAccounts = scope === null ? accounts : accounts.filter((row) => row.accountId === scope);
  // The indicator's scope follows the tab, not the window: a per-account tab shows that account's
  // work and nothing else, which is what every other read in the app does (rule 8).
  const workScope = useMemo(() => (scope ? [scope] : accountIds), [scope, accountIds]);
  /** Which marketplaces each account has set up, for the pages whose venue control offers a plus. */
  const marketplaces = useMemo(() => setUpByAccount(accountIds, { csfloat: venues }), [accountIds, venues]);

  const expandSidebar = (): void => {
    setSidebarCollapsed(false);
    localStorage.setItem(SIDEBAR_KEY, 'expanded');
  };

  const pinSidebar = (next: boolean): void => {
    setSidebarPinned(next);
    localStorage.setItem(SIDEBAR_PIN_KEY, next ? '1' : '0');
    if (next) {
      setSidebarCollapsed(false);
      localStorage.setItem(SIDEBAR_KEY, 'expanded');
    }
  };

  const navItem = (entry: SectionEntry): React.JSX.Element => (
    <button
      key={entry.id}
      type="button"
      className="nav-item"
      data-selected={section === entry.id}
      aria-current={section === entry.id ? 'page' : undefined}
      aria-label={entry.label}
      title={counts[entry.id] ? `${entry.label} · ${counts[entry.id].toLocaleString()}. ${entry.blurb}` : `${entry.label}. ${entry.blurb}`}
      onClick={() => pick(entry)}
    >
      <Icon name={entry.icon} size={16} />
      <span className="nav-text">{entry.label}</span>
      {counts[entry.id] ? <span className="nav-count num">{counts[entry.id].toLocaleString()}</span> : null}
    </button>
  );

  /** Opens one market name on the Items page, remembering the page it came from for Back. */
  const openItem = (name: string, from: Section): void => {
    setItemView({ name, from });
    setSection('items');
  };

  // Back is offered only to an item opened from another page; from the sidebar there is nowhere to
  // go back to. Going back keeps the name, so Items reopens on it, and forgets where it came from.
  const itemsFrom = itemView.from;
  const backFromItems = useMemo(() => {
    if (itemsFrom === null) return null;
    const label = [...SECTIONS, SETTINGS].find((entry) => entry.id === itemsFrom)?.label ?? 'the last page';
    return {
      label,
      onBack: () => {
        setItemView((view) => ({ ...view, from: null }));
        setSection(itemsFrom);
      }
    };
  }, [itemsFrom]);

  const pick = (entry: SectionEntry): void => {
    // The sidebar is a fresh visit: Items keeps the item it last showed, but there is no Back.
    if (entry.id === 'items') setItemView((view) => ({ ...view, from: null }));
    setSection(entry.id);
    // A per-account page has to be about an account. Picking one from the all-accounts scope
    // selects the account that was last open rather than leaving the user on a page that
    // cannot answer the question they just asked.
    if (entry.perAccount && scope === null) {
      setScope(lastAccount.current ?? accounts[0]?.accountId ?? null);
    }
  };

  /**
   * Where a notification's action goes: the same move as picking the section from the sidebar,
   * and the tab or Settings page when it names one, with the account the message was about put in
   * scope when it named one. That account is set last, so the fallback above cannot overwrite it.
   * Settings opens on the page it last showed, so naming one is remembering it before it mounts.
   */
  const navigate = (route: Route): void => {
    const entry = [...SECTIONS, SETTINGS].find((candidate) => candidate.id === route.section);
    if (!entry) return;
    if (route.settings) rememberSettingsPage(route.settings);
    pick(entry);
    if (route.tab) setRecordTab(route.tab);
    if (route.accountId) setScope(route.accountId);
  };

  /** A venue's plus on Listings or Buy orders: that venue's page in Settings, for that account. */
  const addVenue = (accountId: string, venue: VenueId): void => navigate({ section: 'settings', settings: venue, accountId });

  /** The one way in from an empty page. A host's accounts are added on the host, so it offers none. */
  const addAccount = remote ? undefined : <Button variant="primary" icon="plus" onClick={() => setSigningIn({ kind: 'new' })}>Add a Steam account</Button>;

  return (
    <WorkProvider accountIds={workScope}>
    <NotificationProvider onNavigate={navigate}>
    <PageHeaderSlotsProvider value={headerSlots}>
    <div className="shell" data-sidebar-collapsed={sidebarCollapsed ? 'true' : undefined} data-sidebar-pinned={sidebarPinned ? 'true' : undefined}>
      <NotificationStack />
      <div className="sidebar-slot">
        <nav id="app-nav" className="sidebar" data-collapsed={sidebarCollapsed ? 'true' : undefined} aria-label="Sections">
        <div className="sidebar-head">
          <div
            className="brand"
            role={sidebarCollapsed ? 'button' : undefined}
            tabIndex={sidebarCollapsed ? 0 : undefined}
            title={sidebarCollapsed ? 'Expand navigation' : undefined}
            onClick={sidebarCollapsed ? expandSidebar : undefined}
            onKeyDown={sidebarCollapsed ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                expandSidebar();
              }
            } : undefined}
          >
            <BrandMark />
            <div className="brand-text">
              <div className="brand-mark">CS<span>lytics</span></div>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-pin"
            aria-pressed={sidebarPinned}
            aria-label={sidebarPinned ? 'Unpin navigation' : 'Pin navigation'}
            title={sidebarPinned ? 'Unpin navigation' : 'Pin navigation'}
            onClick={() => pinSidebar(!sidebarPinned)}
          >
            <Icon name={sidebarPinned ? 'pin-filled' : 'pin'} size={15} />
          </button>
        </div>
        {GROUPS.map((group) => {
          const entries = SECTIONS.filter((entry) => entry.group === group && !HIDDEN_SECTIONS.has(entry.id));
          if (entries.length === 0) return null;
          return (
            <React.Fragment key={group}>
              <div className="nav-label">{group}</div>
              {entries.map(navItem)}
            </React.Fragment>
          );
        })}
        {/* The pages a connected host serves, under its label (plan D12): the window lists them and
            shows one; what each is about is the host's business. */}
        {engineStatus?.kind === 'remote' && hostPages.length > 0 ? (
          <>
            <div className="nav-label">{engineStatus.label}</div>
            {hostPages.map((page) => (
              <button
                key={page.id}
                type="button"
                className="nav-item"
                data-selected={section === 'host-page' && hostPage?.id === page.id}
                aria-current={section === 'host-page' && hostPage?.id === page.id ? 'page' : undefined}
                aria-label={page.title}
                title={`${page.title}. A page served by ${engineStatus.label}`}
                onClick={() => { setHostPage(page); setSection('host-page'); }}
              >
                <Icon name="globe" size={16} />
                <span className="nav-text">{page.title}</span>
              </button>
            ))}
          </>
        ) : null}

        <div className="sidebar-foot">
          {/* Connect and sign out are the local engine's: a host's sessions are its own (plan D5). */}
          {remote ? null : <button
            type="button"
            className="nav-item"
            aria-label={activeAccount ? 'Connect this account' : 'Connect all'}
            disabled={busy || accounts.length === 0}
            title="Reconnects from the saved sessions. Use it after CS2 was closed on another computer."
            onClick={() => void run('Connecting accounts', async () => {
              // Same one-at-a-time sweep as the launch. One blocked account must not stop the
              // ones after it, so the failures are collected rather than thrown — but they are
              // still reported.
              // Every account is the launch sweep again, so each connects the way it opens; this
              // account alone is a person asking for it, and connects in full.
              const failures: string[] = [];
              for (const account of activeAccount ? [activeAccount] : accounts) {
                if (inFlight.current.has(account.accountId)) continue;
                const options = activeAccount ? {} : launchConnect(settings ?? DEFAULT_SETTINGS, account.accountId);
                if (!options) continue;
                const report = await connect(account.accountId, options);
                if (report?.lastError) failures.push(`${account.accountName}: ${report.lastError}`);
                else if (!report) failures.push(`${account.accountName}: the Engine Runtime did not answer`);
              }
              if (failures.length > 0) throw new Error(failures.join(' · '));
            })}
          >
            <Icon name="link" size={16} />
            <span className="nav-text">{activeAccount ? 'Connect this account' : 'Connect all'}</span>
          </button>}
          <button
            type="button"
            className="nav-item"
            aria-label={activeAccount ? 'Refresh now' : 'Refresh all now'}
            data-busy={busy && status.message.startsWith('Refreshing') ? 'true' : undefined}
            disabled={busy || accounts.length === 0}
            title="Everything refreshes on its own. Use this after changing something on the Steam website."
            onClick={() => void run('Refreshing now', async () => {
              // The runtime reads only the accounts it is keeping current: one left signed out
              // stays that way until someone presses Connect for it.
              const refreshed = await refreshNow(activeAccount ? [activeAccount.accountId] : accountIds);
              // A pass right after a sign-in finds every surface current or still being read by the
              // launch sweep, and the CS2 session not yet up, so it reads nothing. That is not a
              // refresh done: say what happened, and that the rest arrives on its own.
              const read = Object.values(refreshed).flat().length;
              return read === 0 ? 'Refreshing now — nothing new to read: everything is current or still loading, and will refresh on its own' : undefined;
            })}
          >
            <Icon name="refresh" size={16} />
            <span className="nav-text">{activeAccount ? 'Refresh now' : 'Refresh all now'}</span>
          </button>
          {navItem(SETTINGS)}
          {activeAccount && !remote ? (
            <button
              type="button"
              className="nav-item"
              aria-label={`Sign out ${activeAccount.accountName}`}
              title={`Sign out ${activeAccount.accountName}`}
              disabled={busy}
              onClick={() => void run(`Signing out of ${activeAccount.accountName}`, () => signOut(activeAccount.accountId))}
            >
              <Icon name="log-out" size={16} />
              <span className="nav-text">Sign out {activeAccount.accountName}</span>
            </button>
          ) : null}
        </div>
      </nav>
      {sidebarCollapsed ? (
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={false}
          aria-controls="app-nav"
          aria-label="Expand navigation"
          title="Expand navigation"
          onClick={expandSidebar}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      ) : null}
      </div>

      <main
        className="main"
        onPointerDown={() => {
          if (sidebarPinned || sidebarCollapsed) return;
          setSidebarCollapsed(true);
          localStorage.setItem(SIDEBAR_KEY, 'collapsed');
        }}
      >
        <AccountBar
          accounts={accounts}
          holdings={holdings}
          connections={connections}
          connecting={connecting}
          scope={scope}
          onSelect={(next) => {
            setScope(next);
            // A per-account page cannot answer "all accounts".
            if (next === null && current.perAccount) setSection('portfolio');
          }}
          onAddAccount={() => setSigningIn({ kind: 'new' })}
          canAdd={!remote}
          busy={busy}
          venues={venues}
          // What is happening, in its own area at the right-hand end of the account strip. It
          // belongs to the window rather than to the open section, so it sits on the row the
          // accounts are on rather than on the section header below. Scope follows the tab, like
          // every other read (rule 8). The empty slot ahead of it is where each listing workspace
          // puts its pill while it holds a row, on every page: the shell holds the staging, so
          // the pill outlives the view that filled it.
          aside={<>
            <span className="listing-slot" data-slot="listing-workspace" />
            <ListingWorkspace workspace={listing} accounts={accountNames} />
            <ListingWorkspace workspace={reprice} accounts={accountNames} />
            <WorkIndicator
              accountIds={workScope}
              accounts={accountNames}
              onOpenListings={() => setSection('listings')}
            />
            {/* After the indicator: it says what is happening, the bell says what happened. */}
            <NotificationBell />
          </>}
        />

        {/* The page's one header. Which accounts are in view, and their wallets, are the account
            strip's to say, directly above; this names the section, and the open page says what
            it is about and carries its controls through `PageHeader`. Until a page does, the
            section's own line stands in. */}
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-icon"><Icon name={current.icon} size={18} /></span>
            <div className="topbar-text">
              <div className="topbar-title-row">
                <h1>{current.label}</h1>
                <span className="topbar-badge" ref={setBadgeSlot} />
                {hold ? <Caption icon="pause" tone="warn">Not refreshing: {describeHold(hold)}</Caption> : null}
                {selectedCount > 0 ? <Caption icon="list-checks" tone="accent">{selectedCount.toLocaleString()} selected</Caption> : null}
              </div>
            </div>
          </div>
          <div className="topbar-right">
            <div className="topbar-actions toolbar" ref={setActionsSlot} />
            {activeAccount ? (
              <div className="conn" data-tone={connection.tone} title={connection.detail}>
                <span className="conn-dot" data-tone={connection.tone} />
                <span>{connection.label}</span>
              </div>
            ) : null}
            <div className="status" data-tone={status.tone} key={`${status.tone}:${status.message}`} title={status.message}>
              <span className="status-icon">
                <Icon name={status.tone === 'busy' ? 'loader' : status.tone === 'error' ? 'alert-circle' : 'check-circle'} size={14} />
              </span>
              <span className="status-text">{status.message}</span>
            </div>
          </div>
        </header>

        <div className="content">
          <div className="view" key={`${section}:${scope ?? 'all'}`}>
            {section === 'store' && activeAccount ? <StoreView key={activeAccount.accountId} accountId={activeAccount.accountId} /> : null}

            {section === 'portfolio' && loaded && accounts.length === 0 ? (
              <Panel>
                {remote ? (
                  <Empty
                    icon="globe"
                    title="The engine host holds no accounts"
                    hint="Accounts are added on the host, not here."
                  />
                ) : (
                  <Empty
                    icon="user-plus"
                    title="Welcome to CSlytics"
                    action={<Button variant="primary" icon="plus" size="lg" onClick={() => setSigningIn({ kind: 'new' })}>Add your first account</Button>}
                  />
                )}
              </Panel>
            ) : null}
            {section === 'host-page' && hostPage ? <HostPageView page={hostPage} /> : null}

            {/* Gated on `loaded` for the same reason the account list is: before the runtime has
                answered, "no accounts yet" is a guess, and it is the one guess that reads as a
                lost database. */}
            {section === 'items' && accountIds.length > 0 ? (
              <ItemsView
                name={itemView.name}
                accountIds={scope ? [scope] : accountIds}
                onOpen={(name) => setItemView((view) => ({ ...view, name }))}
                back={backFromItems}
              />
            ) : null}
            {section === 'items' && loaded && accountIds.length === 0 ? (
              <Panel><Empty icon="trending-up" title="No accounts yet" action={addAccount} /></Panel>
            ) : null}
            {section === 'portfolio' && loaded && accounts.length > 0 ? (
              <PortfolioPage
                accountIds={scope ? [scope] : accountIds}
                holdings={scope ? holdings.filter((row) => row.accountId === scope) : holdings}
                scope={scope}
                avatars={Object.fromEntries(accounts.map((entry) => [entry.accountId, entry.avatarRef]))}
                onSelectAccount={(accountId) => { setScope(accountId); setSection('inventory'); }}
              />
            ) : null}

            {section === 'portfolio' && loaded && accounts.length > 0 ? (
              <AccountsPanel
                accounts={scopedAccounts}
                holdings={holdings}
                connections={connections}
                connecting={connecting}
                busy={busy}
                onOpen={(accountId) => { setScope(accountId); setSection('inventory'); }}
                onManage={(accountId) => { setScope(accountId); setSection('settings'); }}
                onAddAccount={() => setSigningIn({ kind: 'new' })}
                canAdd={!remote}
              />
            ) : null}

            {section === 'inventory' && activeAccount ? (
              <div className="metrics">
                <Metric label="In inventory" icon="package" value={(activeHeld?.main ?? 0).toLocaleString()} />
                <Metric label="In storage" icon="archive" value={(activeHeld?.crated ?? 0).toLocaleString()} note={`in ${plural(activeHoldings?.counts.storageUnits ?? 0, 'unit')}`} />
                <Metric label="On the market" icon="tag" value={(activeHeld?.listed ?? 0).toLocaleString()} />
                <Metric
                  label="Wallet"
                  icon="wallet"
                  tone="accent"
                  value={formatAmount(wallet?.balance_cents ?? null, wallet?.currency ?? null)}
                />
              </div>
            ) : null}

            {section === 'inventory' && activeAccount && !connection.gcReady ? (
              <Notice tone={connection.tone === 'blocked' ? 'warn' : 'unknown'} role="status" title={`Inventory needs a CS2 Game Coordinator session — ${connection.label}`}>
                {connection.detail}
              </Notice>
            ) : null}

            {section === 'inventory' && accountIds.length > 0 ? (
              <InventoryView
                accountIds={scope ? [scope] : accountIds}
                accounts={accountNames}
                selection={inventorySelection}
                onSelection={setInventorySelection}
                onStage={(selected) => listing.stage(stageItems(selected))}
                onOpenItem={(name) => openItem(name, 'inventory')}
              />
            ) : null}
            {section === 'trades' && accountIds.length > 0 ? (
              <TradesView accountIds={scope ? [scope] : accountIds} accounts={accountNames} />
            ) : null}
            {section === 'trades' && loaded && accountIds.length === 0 ? (
              <Panel><Empty icon="arrow-left-right" title="No accounts yet" action={addAccount} /></Panel>
            ) : null}
            {section === 'records' && accountIds.length > 0 ? (
              <PageHeader actions={(
                <Segmented
                  label="Records"
                  value={recordTab}
                  onChange={setRecordTab}
                  options={RECORD_TABS.map((id) => ({ id, ...RECORD_TAB_ENTRIES[id] }))}
                />
              )} />
            ) : null}
            {section === 'records' && accountIds.length > 0 ? (
              <RecordsView key={`${recordTab}:${scope ?? 'all'}`} domain={recordTab} accountIds={scope ? [scope] : accountIds} accounts={accountNames} />
            ) : null}
            {section === 'listings' && accountIds.length > 0 ? (
              <ListingsView accountIds={scope ? [scope] : accountIds} accounts={accountNames} setUp={marketplaces} onAddVenue={addVenue} reprice={reprice} />
            ) : null}
            {section === 'listings' && loaded && accountIds.length === 0 ? (
              <Panel><Empty icon="layers" title="No accounts yet" action={addAccount} /></Panel>
            ) : null}
            {section === 'buy-orders' && accountIds.length > 0 ? (
              <BuyOrdersView key={scope ?? 'all'} accountIds={scope ? [scope] : accountIds} accounts={accountNames} setUp={marketplaces} onAddVenue={addVenue} />
            ) : null}
            {section === 'buy-orders' && loaded && accountIds.length === 0 ? (
              <Panel><Empty icon="shopping-cart" title="No accounts yet" action={addAccount} /></Panel>
            ) : null}

            {section === 'settings' ? (
              <SettingsView
                accounts={accounts}
                loaded={loaded}
                remote={remote}
                account={activeAccount}
                connection={connections.find((row) => row.accountId === key)}
                connecting={connecting.has(key)}
                lastError={connectErrors[key] ?? null}
                holding={activeHoldings}
                venue={venues[key] ?? null}
                onVenue={venueChanged}
                busy={busy}
                launch={settings && activeAccount ? launchFor(settings, activeAccount.accountId) : null}
                onLaunch={writeLaunch}
                onClear={clearAccount}
                onSelectAccount={setScope}
                onConnect={(accountId) => void run(`Connecting ${accounts.find((row) => row.accountId === accountId)?.accountName ?? accountId}`, () => attempt(accountId))}
                onSignIn={(account) => setSigningIn({ kind: 'account', account })}
                onSignOut={(accountId) => void run('Signing out', () => signOut(accountId))}
                sidebarPinned={sidebarPinned}
                onSidebarPinned={pinSidebar}
              />
            ) : null}


            {!loaded && section === 'portfolio' ? (
              <Panel><Empty icon="loader" title="Opening your accounts…" /></Panel>
            ) : null}
          </div>
        </div>
      </main>

      {/*
        * Sign-in is a screen over the window rather than instead of it. Nothing here needs it
        * to have happened first — the portfolio, the account cards and every read model are
        * SQLite — so making it the front door only ever hid work the app had already done.
        */}
      {signingIn ? (
        <SignIn
          onSignedIn={signedIn}
          onCancel={() => setSigningIn(null)}
          connectedAccountIds={connections
            .filter((row) => row.steam.kind === 'authenticated')
            .map((row) => row.accountId)}
          title={signingIn.kind === 'account'
            ? undefined
            : accounts.length === 0 ? 'Connect a Steam account' : 'Add another Steam account'}
          account={signingIn.kind === 'account'
            ? {
                accountId: signingIn.account.accountId,
                accountName: signingIn.account.accountName,
                hasSavedSession: signingIn.account.hasSession
              }
            : undefined}
        />
      ) : null}
    </div>
    </PageHeaderSlotsProvider>
    </NotificationProvider>
    </WorkProvider>
  );
}
