import type { ChangeNotification, EngineCommand } from '../../shared/api.js';
import type { CslyticsStatus } from '@cslytics/cslytics-account';
import { RESPONSE_DEADLINE_MS, type QrState } from '../features/accounts/login-machine.js';
import type {
  AccountConnection,
  AccountHoldings,
  ConnectionReport,
  ItemRow,
  StorageUnitRow
} from './types.js';

export type AuthedSession = {
  kind: 'authed';
  accountId: string;
  accountName: string;
  steamId64: string;
};

/** What the runtime says about one account's automatic refresh. */
export type RefreshStatusRow = {
  accountId: string;
  tier: 'ACTIVE' | 'BACKGROUND';
  running: boolean;
  /** Set only while every due read is being held off. */
  heldUntil?: string;
  reason?: string;
};

export type SavedAccount = {
  id: string;
  accountName: string;
  steamId64: string;
  /** True when the OS vault still holds a refresh token for this account. */
  hasSession: boolean;
  /** `avatar:<40hex>` when a persona walk has observed a hash; otherwise null. */
  avatarRef: string | null;
  /** Current Steam display name when observed; unused for labels this slice. */
  personaName: string | null;
};

/**
 * Typed client over the preload bridge.
 *
 * The renderer has no network primitive and no filesystem access; every capability it has is
 * one of these calls, validated again by a zod schema in the main process before it reaches
 * the Engine Runtime.
 */

export class DesktopBridgeUnavailableError extends Error {
  constructor() {
    super('The desktop connection is unavailable. Restart the CSlytics desktop app; no Steam request was made.');
    this.name = 'DesktopBridgeUnavailableError';
  }
}

/**
 * What a rename reports: the attempt's outcome and the action's state, plus the label as it
 * was *observed* afterwards. The requested name is deliberately absent — the window already
 * knows what it asked for, and must never show it as though Steam had confirmed it.
 */
export type RenameStorageUnitResult = {
  actionId: string;
  outcome: 'SUBMITTED' | 'DEFINITIVELY_REJECTED' | 'AMBIGUOUS';
  state: 'READY' | 'RUNNING' | 'AWAITING_OBSERVATION' | 'DONE' | 'FAILED' | null;
  label: string | null;
};

async function invoke<T>(command: EngineCommand): Promise<T> {
  const bridge = window.trading;
  if (!bridge || typeof bridge.invoke !== 'function') throw new DesktopBridgeUnavailableError();
  return await bridge.invoke(command) as T;
}

/** Thrown when a call passes the window's deadline. The request itself is still in flight. */
export class ResponseDeadlineError extends Error {
  constructor() {
    super('The Engine Runtime did not answer in time');
    this.name = 'ResponseDeadlineError';
  }
}

/**
 * Bounds how long the caller waits, without pretending the request was cancelled.
 *
 * Nothing on the other side is aborted — Electron's IPC has no cancel — so a call that passes
 * the deadline is *ambiguous*, not failed. Only sign-in uses this, because sign-in is the one
 * screen where a silent, unbounded wait leaves the user with nothing at all to look at.
 */
async function withDeadline<T>(work: Promise<T>, ms = RESPONSE_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ResponseDeadlineError()), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type { EnrichedStoreSheet, EnrichedStoreEntry } from '../../main/store-names.js';
/** How a remove or reset went; only a success comes back, a failure arrives as the error. */
export type AccountClearOutcome = import('../../main/runtime/account-clear.js').PurgeOutcome;

export const engine = {
  storeSheet: (accountId: string) => invoke<import('../../main/store-names.js').EnrichedStoreSheet | null>({ type: 'store.sheet', accountId }),
  storeRefresh: (accountId: string) => invoke<import('../../main/store-names.js').EnrichedStoreSheet | null>({ type: 'store.refresh', accountId }),
  storePurchases: (accountId: string, cursor?: string) => invoke<import('@cslytics/engine').StorePurchasePage>({ type: 'store.purchases', accountId, ...(cursor ? { cursor } : {}) }),
  storeBuy: (request: { commandId: string; accountId: string; lines: Array<{ entryKey: string; quantity: number; unitPriceCents: number }> }) =>
    invoke<import('@cslytics/engine').StorePurchaseView | null>({ type: 'store.buy', commandId: request.commandId, accountId: request.accountId, lines: request.lines }),
  storeCancel: (accountId: string, purchaseId: string) => invoke<import('@cslytics/engine').StorePurchaseView | null>({ type: 'store.cancel', accountId, purchaseId }),
  storeContinue: (accountId: string, purchaseId: string) => invoke<import('@cslytics/engine').StorePurchaseView | null>({ type: 'store.continue', accountId, purchaseId }),
  csfloatOverview: (accountId: string) => invoke<import('@cslytics/engine').CsfloatOverview>({type:'csfloat.overview',accountId}),
  csfloatRefresh: (accountId: string, eligibility = false) => invoke<import('@cslytics/engine').CsfloatOverview>({type:'csfloat.refresh',accountId,eligibility}),
  csfloatProtection: (enabled: boolean) => invoke<void>({type:'csfloat.protection',enabled}),
  // This build, its updates and the stop switch; answered by main (desktop release plan §4).
  releaseStatus: () => invoke<import('../../shared/release.js').ReleaseStatus>({ type: 'release.status' }),
  checkForUpdate: () => invoke<import('../../shared/release.js').ReleaseStatus>({ type: 'release.check' }),
  installUpdate: () => invoke<import('../../shared/release.js').ReleaseStatus>({ type: 'release.install' }),
  // The optional CSlytics sign-in, answered by main. Each answers with the account's status, never a token.
  cslyticsStatus: () => invoke<CslyticsStatus>({ type: 'cslytics.status' }),
  cslyticsSignIn: () => invoke<CslyticsStatus>({ type: 'cslytics.signIn' }),
  cslyticsCancelSignIn: () => invoke<CslyticsStatus>({ type: 'cslytics.cancelSignIn' }),
  cslyticsVerify: () => invoke<CslyticsStatus>({ type: 'cslytics.verify' }),
  cslyticsSignOut: () => invoke<CslyticsStatus>({ type: 'cslytics.signOut' }),
  // This desktop's preferences, answered by main from `settings.json`.
  settings: () => invoke<import('../../shared/api.js').DesktopSettings>({ type: 'settings.read' }),
  writeAppearance: (appearance: import('../../shared/api.js').AppearanceSettings) =>
    invoke<import('../../shared/api.js').DesktopSettings>({ type: 'settings.write', appearance }),
  /** What this desktop does with one account when it opens; answers with the settings as stored. */
  writeLaunch: (accountId: string, launch: import('../../shared/api.js').AccountLaunch) =>
    invoke<import('../../shared/api.js').DesktopSettings>({ type: 'settings.launch', accountId, launch }),
  /** The currency section whole: the base code and the account-pages toggle. */
  writeCurrency: (currency: import('../../shared/api.js').CurrencySettings) =>
    invoke<import('../../shared/api.js').DesktopSettings>({ type: 'settings.currency', currency }),
  // Prices, answered by main from its own cache (portfolio and pricing plan §3). The window
  // formats these figures and computes none of them.
  readValuation: (accountIds: readonly string[]) =>
    invoke<import('../../shared/market.js').PortfolioValuation>({ type: 'portfolio.valuation', accountIds: [...accountIds] }),
  marketStatus: () => invoke<import('@cslytics/market-data').SchedulerStatus>({ type: 'market.status' }),
  marketFx: () => invoke<import('@cslytics/market-data').FxRates | null>({ type: 'market.fx' }),
  portfolioHistory: (accountIds: readonly string[]) =>
    invoke<import('../../shared/market.js').MarketHistoryRow[]>({ type: 'portfolio.history', accountIds: [...accountIds] }),
  itemPage: (name: string, accountIds: readonly string[]) =>
    invoke<import('../../shared/market.js').ItemPage>({ type: 'item.page', name, accountIds: [...accountIds] }),
  /** The open item page's poll: asks for the name and returns the newest book held. */
  itemWatch: (name: string) => invoke<import('@cslytics/market-data').StoredBook | null>({ type: 'item.watch', name }),
  /** Steam's price series for a name; may wait on a fetch the first time, so the page asks it on its own. */
  itemHistory: (name: string) => invoke<import('../../shared/market.js').ItemHistory>({ type: 'item.history', name }),
  /** The published float curve for a name on Steam or CSFloat, or a recorded absence. */
  itemCurve: (name: string, venue: 'steam' | 'csfloat' = 'steam') => invoke<import('../../shared/market.js').ItemCurve>({ type: 'item.curve', name, venue }),
  /** The market names one item is sold under, each with the units the scope holds. */
  itemVariants: (name: string, accountIds: readonly string[]) =>
    invoke<import('../../shared/market.js').ItemVariants>({ type: 'item.variants', name, accountIds: [...accountIds] }),
  /** The catalogue's item names for a typed text, held ones first when a scope is named. */
  suggestItems: (text: string, accountIds?: readonly string[]) =>
    invoke<{ items?: Array<{ name: string; category: string; image?: string | null; owned?: number }>; pending?: boolean }>(
      { type: 'catalogue.suggest', text, limit: 1, ...(accountIds && accountIds.length > 0 ? { accountIds: [...accountIds] } : {}) }
    ),
  beginQrLogin: () =>
    withDeadline(invoke<{ challengeUrl: string; sessionHandle: string; expiresAtMs: number }>(
      { type: 'auth.beginQr' }
    )),

  // Deliberately not deadlined: this runs on a timer, and a slow poll is answered by the next.
  pollQrLogin: (sessionHandle: string) =>
    invoke<QrState>({ type: 'auth.pollQr', sessionHandle }),

  beginCredentialLogin: (username: string, password: string) =>
    withDeadline(invoke<
      | { kind: 'guard-prompt'; sessionHandle: string; methods: string[]; expiresAtMs: number }
      | AuthedSession
    >({ type: 'auth.credentials', username, password })),

  submitGuardCode: (sessionHandle: string, code: string) =>
    withDeadline(invoke<AuthedSession>(
      { type: 'auth.guard', sessionHandle, code }
    )),

  cancelLogin: (sessionHandle: string) =>
    invoke<unknown>({ type: 'auth.cancel', sessionHandle }),

  refreshSession: (accountId: string) =>
    withDeadline(invoke<AuthedSession>(
      { type: 'auth.refresh', accountId }
    )),

  /**
   * Marketplace credentials.
   *
   * `connectMarketplace` is the only call that carries a key, and it carries it one way: there is
   * deliberately no `readMarketplaceKey`, because a bridge method that could return one would put
   * a secret in the renderer's reach forever after (plan CSF-03).
   */
  connectMarketplace: (accountId: string, apiKey: string) =>
    invoke<import('@cslytics/engine').ConnectResult>({ type: 'marketplace.connect', accountId, venue: 'csfloat', apiKey }),
  disconnectMarketplace: (accountId: string, mode: 'disconnect' | 'forget') =>
    invoke<import('@cslytics/engine').MarketplaceStatus>({ type: 'marketplace.disconnect', accountId, venue: 'csfloat', mode }),
  marketplaceStatus: (accountId: string) =>
    invoke<import('@cslytics/engine').MarketplaceStatus>({ type: 'marketplace.status', accountId, venue: 'csfloat' }),
  refreshMarketplace: (accountId: string) =>
    invoke<import('@cslytics/engine').MarketplaceStatus>({ type: 'marketplace.refresh', accountId, venue: 'csfloat' }),
  /** Away or public, at the venue. What comes back is `/me` read again, so a switch shows the read-back. */
  updateMarketplaceStall: (accountId: string, patch: { away?: boolean; stallPublic?: boolean }) =>
    invoke<import('@cslytics/engine').MarketplaceStatus>({ type: 'marketplace.stall', accountId, venue: 'csfloat', ...patch }),

  listAccounts: () =>
    invoke<SavedAccount[]>({ type: 'accounts.list' }),
  /**
   * Takes the account off this computer: its saved sign-ins, its settings and every row. Main
   * restarts the Engine Runtime to do it, so the window reloads once this answers. Not deadlined:
   * a large record takes a while to clear, and the runtime is not answering anything else meanwhile.
   */
  /** Why the account cannot be removed or reset right now, or null. The dialog asks before offering it. */
  accountClearRefusal: async (accountId: string) =>
    (await invoke<{ refusal: string | null }>({ type: 'accounts.clearable', accountId })).refusal,
  removeAccount: (accountId: string) =>
    invoke<AccountClearOutcome>({ type: 'accounts.remove', accountId }),
  /** Empties the account and keeps it signed in, the same way. */
  resetAccount: (accountId: string) =>
    invoke<AccountClearOutcome>({ type: 'accounts.reset', accountId }),

  syncInventory: (accountId: string) => invoke<number>({ type: 'inventory.sync', accountId }),
  readInventory: (accountId: string) => invoke<ItemRow[]>({ type: 'inventory.read', accountId }),
  pageInventory: (input: {
    accountIds: string[];
    pageSize?: number;
    sort?: 'localId' | 'defIndex';
    cursor?: string;
    filter?: { search?: string; location?: 'MAIN' | 'CASKET' | 'MISSING'; listed?: boolean };
  }) => invoke<{
    kind: 'page' | 'stale-page';
    rows?: Array<{
      unitKind: 'individual' | 'fungible';
      accountId: string;
      localId: string;
      location: string;
      casketId: string | null;
      quantity: number;
      defIndex: number;
      quality: number;
      matchKey: string;
      /** Attached by the main process from the catalogue; the engine returns none of these. */
      name: string;
      imageUrl: string | null;
      unresolved: string | null;
    }>;
    nextCursor?: string | null;
    total?: { handles: number; groups: number; quantity: number };
    reason?: string;
  }>({ type: 'inventory.page', ...input }),
  pageHistory: (input: { accountIds: string[]; pageSize?: number; cursor?: string }) =>
    invoke<{ kind: 'page' | 'stale-page'; rows?: Array<{ accountId: string; sourceKey: string; occurredAt: string; eventType: number; amountCents: number | null }>; reason?: string }>({
      type: 'history.page',
      ...input
    }),
  pageStorage: (input: { accountIds: string[]; pageSize?: number; cursor?: string }) =>
    invoke<{ kind: 'page' | 'stale-page'; rows?: Array<{ accountId: string; casketId: string; localId: string | null; label: string | null; reportedCount: number; knownQuantity: number; complete: boolean }>; reason?: string }>({
      type: 'storage.page',
      ...input
    }),
  pageOrders: (input: { accountIds: string[]; pageSize?: number; cursor?: string }) =>
    invoke<{ kind: 'page' | 'stale-page'; rows?: Array<{ accountId: string; orderId: string; state: string; side: string; openedAt: string }>; reason?: string }>({
      type: 'orders.page',
      ...input
    }),
  captureSelection: (input: {
    accountIds: string[];
    members: Array<{ accountId: string; localId: string; quantity?: number }>;
  }) => invoke<{ token: string; revision: number; state: string; counts: { handles: number; quantity: number } }>({
    type: 'selection.capture',
    ...input
  }),
  readSelection: (token: string) =>
    invoke<{ token: string; revision: number; state: string; counts: { handles: number; quantity: number } }>({
      type: 'selection.read',
      token
    }),
  readCommand: (commandId: string) =>
    invoke<{ commandId: string; state: string; observedCompleted: number }>({ type: 'command.read', commandId }),
  stopCommand: (commandId: string) => invoke<unknown>({ type: 'command.stop', commandId }),

  syncStorage: (accountId: string) => invoke<number[]>({ type: 'storage.sync', accountId }),
  readStorage: (accountId: string) => invoke<StorageUnitRow[]>({ type: 'storage.read', accountId }),
  store: (accountId: string, localIds: string[], casketId: string) =>
    invoke<unknown>({ type: 'storage.store', accountId, localIds, casketId }),
  retrieve: (accountId: string, localIds: string[], casketId: string) =>
    invoke<unknown>({ type: 'storage.retrieve', accountId, localIds, casketId }),
  renameStorageUnit: (accountId: string, casketId: string, name: string) =>
    invoke<RenameStorageUnitResult>({ type: 'storage.rename', accountId, casketId, name }),

  syncMarket: (accountId: string) =>
    invoke<{ complete: boolean; pagesWalked: number; totalExpected: number | null; error?: string }>({ type: 'market.sync', accountId }),
  syncWallet: (accountId: string) => invoke<number>({ type: 'wallet.sync', accountId }),

  createListing: (accountId: string, localId: string, priceReceiveCents: number) =>
    invoke<unknown>({ type: 'listing.create', accountId, localId, priceReceiveCents }),

  submitCommand: (input: {
    commandId: string;
    kind: 'STORE' | 'RETRIEVE' | 'LIST' | 'TRANSFER' | 'REPRICE' | 'DELIST_TO_STORE';
    members?: Array<{
      accountId: string;
      localId: string;
      quantity?: number;
      sourceCasketId?: string;
      destinationCasketId?: string;
      priceReceiveCents?: number;
    }>;
    manifestToken?: string;
    manifestRevision?: number;
    destinations?: Record<string, string>;
    priceReceiveCents?: number;
  }) => invoke<unknown>({ type: 'command.submit', ...input }),

  /**
   * The one read that spans accounts. It names them because the window is the only thing that
   * knows which accounts are signed in — there is no current-account singleton to ask.
   */
  readPortfolio: (accountIds: readonly string[]) =>
    invoke<AccountHoldings[]>({ type: 'portfolio.read', accountIds: [...accountIds] }),

  /** Steam and CS2 GC connection state per account. Local to the runtime; reaches no network. */
  readConnections: (accountIds: readonly string[]) =>
    invoke<AccountConnection[]>({ type: 'session.status', accountIds: [...accountIds] }),

  /**
   * Brings one account online from the refresh token already in the OS vault, and connects
   * its CS2 Game Coordinator session.
   *
   * Deliberately not deadlined. A GC handshake can legitimately take most of a minute, and a
   * deadline here would only make the window stop watching a connection that is still being
   * made — the card shows it as connecting until the runtime answers, which is the truth.
   */
  connectAccount: (accountId: string, options: { cs2?: boolean } = {}) =>
    invoke<ConnectionReport>({ type: 'session.connect', accountId, ...(options.cs2 === undefined ? {} : { cs2: options.cs2 }) }),

  /** Ends the session in this window. The saved refresh token stays; `connectAccount` reuses it. */
  signOutAccount: (accountId: string) =>
    invoke<ConnectionReport>({ type: 'session.signOut', accountId }),

  /**
   * `Refresh now`: every surface for the named accounts, past its due time.
   *
   * The rare button. The Engine Runtime keeps each signed-in account current on its own, so
   * this is for the case a cadence cannot know about — something the user just did on the Steam
   * website — not for routine use.
   */
  refreshNow: (accountIds: readonly string[]) =>
    invoke<Record<string, string[]>>({ type: 'refresh.now', accountIds: [...accountIds] }),

  /** Why an account is not refreshing right now, when it is not. Reaches no network. */
  readRefreshStatus: (accountIds: readonly string[]) =>
    invoke<RefreshStatusRow[]>({ type: 'refresh.status', accountIds: [...accountIds] }),

  /** Tells the runtime which account is on screen, so it can spend its budget there. */
  setRefreshScope: (accountId: string | null) =>
    invoke<{ kind: 'scoped' }>({ type: 'refresh.scope', accountId }),

  /**
   * Unprompted change notices.
   *
   * The notice carries surfaces, never rows, so this hands the caller a reason to re-read
   * rather than something to render. A dropped notice costs freshness, not correctness.
   */
  subscribeToChanges: (listener: (notification: ChangeNotification) => void): (() => void) => {
    const bridge = window.trading;
    if (!bridge || typeof bridge.subscribe !== 'function') return () => undefined;
    return bridge.subscribe(listener);
  }
};

/**
 * The saved accounts, waited for rather than asked once.
 *
 * The Engine Runtime is a separate process that imports the whole Steam dependency tree and
 * opens SQLite before it answers anything, so the window is routinely up first. A single
 * failed list is not evidence that there are no saved accounts — and treating it as such is
 * how an app with three accounts opens looking like a fresh install.
 */
export async function listAccountsWhenReady(
  attempts = 40,
  intervalMs = 250,
  stillWanted: () => boolean = () => true
): Promise<SavedAccount[]> {
  let last: unknown = new Error('The Engine Runtime was never asked for the account list');
  for (let n = 0; n < attempts; n += 1) {
    if (!stillWanted()) return [];
    try {
      return await engine.listAccounts();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  // Not an empty list. "No accounts saved" and "the Engine Runtime never came up" look
  // identical on screen and mean opposite things, and only one of them is fixed by adding an
  // account. The caller decides how to say so; it may not silently pick the cheerful reading.
  throw last instanceof Error ? last : new Error(String(last));
}
