import { z } from 'zod';
import { runtimeCommandSchema, changeNotificationSchema, type ChangeNotification } from '@cslytics/runtime/api';
import { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCES } from './themes/index.js';

export { changeNotificationSchema };
export type { ChangeNotification };

const accountScope = z.array(z.string().min(1)).min(1).max(32);

/**
 * This desktop's preferences: `settings.json` in the profile, owned by main
 * (`main/settings-store.ts`, notifications plan §5.1). Nothing here is trading state, so none of it
 * reaches the engine. Each section is written whole; a later section is a new key here, filled
 * from `DEFAULT_SETTINGS` in a file written before it existed.
 */
export const appearanceSettingsSchema = z.object({
  /** A theme id from `shared/themes`, or `system` to follow Windows. */
  theme: z.enum(THEME_PREFERENCES)
}).strict();
/**
 * What this desktop does with one saved account when it opens. `signIn` uses the saved sign-in;
 * `cs2` also asks the Game Coordinator for a session, and means nothing while `signIn` is off. An
 * account with no entry gets `DEFAULT_LAUNCH`, so a file written before this section existed, and
 * an account added since, both open the way every account always did.
 */
export const accountLaunchSchema = z.object({
  signIn: z.boolean(),
  cs2: z.boolean()
}).strict();
/**
 * Which currency figures are shown in (portfolio and pricing plan §5.2). `base` is the ISO code
 * every cross-account figure is converted to; `null` until it is pinned from the first account's
 * wallet or chosen. `baseSource` says which, so the settings page can say where the default came
 * from and a later change of the first account never silently moves it. The toggle converts an
 * account's own pages too; a typed price is in the account's own currency whatever it says.
 */
export const currencySettingsSchema = z.object({
  base: z.string().regex(/^[A-Z]{3}$/).nullable(),
  baseSource: z.enum(['first-account', 'chosen']),
  showAccountPagesInBase: z.boolean()
}).strict();
/** The duplicate-protection switch (consolidation plan D13): a preference of this desktop, passed to the engine, which persists nothing. */
export const csfloatSettingsSchema = z.object({ protection: z.boolean() }).strict();
/**
 * Which engine this desktop drives (remote engine host plan D1, D2): the Engine Runtime it forks
 * beside itself, or a host on another machine that answers the same commands over `POST /command`
 * and the `/events` stream. The token that host wants lives in the OS vault under
 * `engine-host:<url>`, never in this file; `label` is what the window calls the host.
 */
/** An engine host's address: http or https, a host and a port, nothing after them. */
const hostUrlSchema = z.string().url().max(512).regex(/^https?:\/\//i, 'An engine host URL starts with http:// or https://');
export const engineConnectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('remote'), url: hostUrlSchema, label: z.string().max(64) }).strict()
]);
export type EngineConnection = z.infer<typeof engineConnectionSchema>;
export const DEFAULT_ENGINE: EngineConnection = { kind: 'local' };
export const settingsSchema = z.object({
  version: z.literal(1),
  appearance: appearanceSettingsSchema,
  accounts: z.record(z.string().min(1), accountLaunchSchema),
  currency: currencySettingsSchema,
  csfloat: csfloatSettingsSchema,
  engine: engineConnectionSchema
}).strict();
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;
export type AccountLaunch = z.infer<typeof accountLaunchSchema>;
export type CurrencySettings = z.infer<typeof currencySettingsSchema>;
export type CsfloatSettings = z.infer<typeof csfloatSettingsSchema>;
export type DesktopSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_LAUNCH: AccountLaunch = { signIn: true, cs2: true };
export const DEFAULT_CURRENCY: CurrencySettings = { base: null, baseSource: 'first-account', showAccountPagesInBase: false };
export const DEFAULT_CSFLOAT: CsfloatSettings = { protection: true };
export const DEFAULT_SETTINGS: DesktopSettings = { version: 1, appearance: { theme: DEFAULT_THEME_PREFERENCE }, accounts: {}, currency: DEFAULT_CURRENCY, csfloat: DEFAULT_CSFLOAT, engine: DEFAULT_ENGINE };

/** How the connection to an engine host is going, as the window shows it (remote engine host plan D7, D8). */
export type EngineHostState = 'connecting' | 'connected' | 'unreachable' | 'refused';
/**
 * Which engine this desktop is driving right now, answered by main to `engine.status`. A remote
 * answer carries the host's state, its build when `/health` named one, and the accounts it holds;
 * never the token.
 */
export type EngineStatus =
  | { kind: 'local'; desktopVersion: string }
  | {
    kind: 'remote';
    desktopVersion: string;
    url: string;
    label: string;
    state: EngineHostState;
    /** When the state last changed. */
    since: string;
    build: string | null;
    accounts: readonly string[];
    /** Why, when the state is not `connected`. */
    detail: string | null;
  };
/** A page a connected host serves, as its `GET /ui/pages` lists it (plan D12). `path` is on the host's origin. */
export const hostPageSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  path: z.string().min(1).max(200).startsWith('/')
}).strict();
export const hostPagesSchema = z.object({ pages: z.array(hostPageSchema).max(32) });
export type HostPage = z.infer<typeof hostPageSchema>;
/** Where the window wants a host page drawn: the frame's rectangle in the window's own pixels. */
export const hostPageBoundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) }).strict();
export type HostPageBounds = z.infer<typeof hostPageBoundsSchema>;
/** The surface a change in the engine connection's state is announced on; the account id of that notice is the same word. */
export const ENGINE_HOST_SURFACE = 'engine-host';

/**
 * `notifications-state.json`: what this desktop has told the person of the facts the engine
 * observed (notifications plan §7.2). Per account, the watermark below which every fact the bell
 * carries has been raised: the last fact's instant and id. An account with an entry and no
 * watermark has been looked at and had nothing; one with no entry has never been looked at, and
 * what the record already holds is history rather than news. Main's file, never the engine's.
 */
export const factCursorSchema = z.object({ at: z.string(), id: z.string() }).strict();
export const notificationsStateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string().min(1), z.object({ watermark: factCursorSchema.nullable() }).strict())
}).strict();
export type FactCursor = z.infer<typeof factCursorSchema>;
export type NotificationsState = z.infer<typeof notificationsStateSchema>;
export const EMPTY_NOTIFICATIONS_STATE: NotificationsState = { version: 1, accounts: {} };

/** The code figures are shown in: the pinned or chosen base, or USD until any wallet has been seen. */
export function baseCurrencyOf(settings: DesktopSettings): string {
  return settings.currency.base ?? 'USD';
}

/**
 * One account's launch preferences, defaulted. Own keys only: Steam allows an account named
 * `constructor` or `toString`, and an inherited function is not a preference.
 */
export function launchFor(settings: DesktopSettings, accountId: string): AccountLaunch {
  return Object.hasOwn(settings.accounts, accountId) ? settings.accounts[accountId]! : DEFAULT_LAUNCH;
}

/**
 * The IPC contract: every command the Engine Runtime answers (`@cslytics/runtime/api`), plus the
 * ones this desktop answers itself in main — names, prices, settings, releases, the CSlytics
 * sign-in and the two that erase an account — which it never forwards. The runtime's half is
 * spread in rather than copied, so a command added there is a command here the same day.
 */
export const engineCommandSchema = z.discriminatedUnion('type', [
  ...runtimeCommandSchema.options,
  // The two that erase. Main answers both by restarting the Engine Runtime with the account's rows
  // deleted before it starts again; `remove` also deletes the saved sign-ins and this desktop's
  // settings for it, `reset` keeps them (steam/auth.md, "Removing or resetting an account").
  z.object({ type: z.literal('accounts.remove'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('accounts.reset'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('catalogue.status') }).strict(),
  // Answered by the host from memory against its own index. No network. With `accountIds`, item
  // names those accounts hold come first, counted from the engine's group summary, which main reads
  // once per account set and keeps until one of them changes.
  z.object({ type: z.literal('catalogue.suggest'), text: z.string().max(200), limit: z.number().int().min(1).max(25).optional(), accountIds: accountScope.optional() }).strict(),
  // Stickers or charms by name, with the definition id a buy-order filter names them by: the change
  // editor's pickers. Answered by main from the catalogue, like `catalogue.suggest`.
  z.object({ type: z.literal('catalogue.accessories'), family: z.enum(['sticker', 'patch', 'charm']), text: z.string().max(200), limit: z.number().int().min(1).max(25).optional() }).strict(),
  // This build, its updates and the stop switch. Answered by main, never the Engine Runtime: none
  // of it is trading state (desktop release plan §4). `install` quits and runs a downloaded update.
  z.object({ type: z.literal('release.status') }).strict(),
  z.object({ type: z.literal('release.check') }).strict(),
  z.object({ type: z.literal('release.install') }).strict(),
  // This desktop's preferences, answered by main from `settings.json`. A write carries a whole
  // section and gets back what was stored, which is what the window then shows.
  z.object({ type: z.literal('settings.read') }).strict(),
  z.object({ type: z.literal('settings.write'), appearance: appearanceSettingsSchema }).strict(),
  z.object({ type: z.literal('settings.launch'), accountId: z.string().min(1), launch: accountLaunchSchema }).strict(),
  // The optional CSlytics sign-in, answered by main (CSlytics account sign-in plan §6.4). No command
  // carries a token, a code or a URL, in either direction: the window gets `CslyticsStatus` only.
  z.object({ type: z.literal('cslytics.status') }).strict(),
  z.object({ type: z.literal('cslytics.signIn') }).strict(),
  z.object({ type: z.literal('cslytics.cancelSignIn') }).strict(),
  z.object({ type: z.literal('cslytics.verify') }).strict(),
  z.object({ type: z.literal('cslytics.signOut') }).strict(),
  z.object({ type: z.literal('settings.currency'), currency: currencySettingsSchema }).strict(),
  // What the bell has told the person, answered by main from `notifications-state.json` (notifications
  // plan §7.2): the watermark per account, and the window moving it once it has raised a page of facts.
  z.object({ type: z.literal('notifications.state') }).strict(),
  z.object({ type: z.literal('notifications.seen'), accountId: z.string().min(1), watermark: factCursorSchema.nullable() }).strict(),
  // Prices, answered by main from its own cache and the engine's reads (portfolio and pricing plan
  // §3): the runtime relays one price, an account's own book, and keeps none. `item.watch` is the
  // open Items page's live read, answered once it lands; asked for an account, as the listing
  // workspace asks, a wallet the anonymous book is not priced for gets the account's own read (D17).
  z.object({ type: z.literal('portfolio.valuation'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('market.status') }).strict(),
  // The newest FX snapshot main holds, for the read-only conversion hint beside a typed price.
  z.object({ type: z.literal('market.fx') }).strict(),
  z.object({ type: z.literal('portfolio.history'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('item.page'), name: z.string().min(1).max(200), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('item.watch'), name: z.string().min(1).max(200), accountId: z.string().min(1).optional() }).strict(),
  // The Items page: the series and the curve on their own, because either may wait on the network
  // and the book must not wait with them; and the market names one item is sold under.
  z.object({ type: z.literal('item.history'), name: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('item.curve'), name: z.string().min(1).max(200), venue: z.enum(['steam', 'csfloat']).optional() }).strict(),
  z.object({ type: z.literal('item.variants'), name: z.string().min(1).max(200), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  // Which engine this desktop drives (remote engine host plan). Answered by main: the connection is a
  // setting, the token goes to the vault and is never answered back, and `connect` or `disconnect`
  // swaps the engine side under the window, which then reloads. An empty token on `connect` reuses
  // the one the vault holds for that URL.
  z.object({ type: z.literal('engine.status') }).strict(),
  z.object({ type: z.literal('engine.connect'), url: hostUrlSchema, label: z.string().max(64), token: z.string().max(512) }).strict(),
  z.object({ type: z.literal('engine.disconnect') }).strict(),
  // The pages a connected host serves, and the one the window wants shown in a view over its
  // content area at these bounds (plan D12). A local engine has no pages.
  z.object({ type: z.literal('engine.pages') }).strict(),
  z.object({ type: z.literal('engine.showPage'), id: z.string().min(1).max(64), bounds: hostPageBoundsSchema }).strict(),
  z.object({ type: z.literal('engine.hidePage') }).strict()
]);

export type EngineCommand = z.infer<typeof engineCommandSchema>;

/** The renderer channel a notification arrives on. Requests keep using `trading:command`. */
export const CHANGE_CHANNEL = 'trading:changed';

export type TradingDesktopApi = {
  invoke(command: EngineCommand): Promise<unknown>;
  /** Registers a listener for unprompted change notices. Returns its unsubscribe. */
  subscribe(listener: (notification: ChangeNotification) => void): () => void;
};

declare global {
  interface Window {
    trading: TradingDesktopApi;
  }
}
