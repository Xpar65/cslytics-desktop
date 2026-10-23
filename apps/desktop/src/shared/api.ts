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
export const settingsSchema = z.object({
  version: z.literal(1),
  appearance: appearanceSettingsSchema,
  accounts: z.record(z.string().min(1), accountLaunchSchema),
  currency: currencySettingsSchema,
  csfloat: csfloatSettingsSchema
}).strict();
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;
export type AccountLaunch = z.infer<typeof accountLaunchSchema>;
export type CurrencySettings = z.infer<typeof currencySettingsSchema>;
export type CsfloatSettings = z.infer<typeof csfloatSettingsSchema>;
export type DesktopSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_LAUNCH: AccountLaunch = { signIn: true, cs2: true };
export const DEFAULT_CURRENCY: CurrencySettings = { base: null, baseSource: 'first-account', showAccountPagesInBase: false };
export const DEFAULT_CSFLOAT: CsfloatSettings = { protection: true };
export const DEFAULT_SETTINGS: DesktopSettings = { version: 1, appearance: { theme: DEFAULT_THEME_PREFERENCE }, accounts: {}, currency: DEFAULT_CURRENCY, csfloat: DEFAULT_CSFLOAT };

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
  // Prices, answered by main from its own cache and the engine's reads (portfolio and pricing plan
  // §3): the runtime never sees a price. `item.watch` is the open Items page's 5 s poll.
  z.object({ type: z.literal('portfolio.valuation'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('market.status') }).strict(),
  // The newest FX snapshot main holds, for the read-only conversion hint beside a typed price.
  z.object({ type: z.literal('market.fx') }).strict(),
  z.object({ type: z.literal('portfolio.history'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('item.page'), name: z.string().min(1).max(200), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  z.object({ type: z.literal('item.watch'), name: z.string().min(1).max(200) }).strict(),
  // The Items page: the series and the curve on their own, because either may wait on the network
  // and the book must not wait with them; and the market names one item is sold under.
  z.object({ type: z.literal('item.history'), name: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('item.curve'), name: z.string().min(1).max(200), venue: z.enum(['steam', 'csfloat']).optional() }).strict(),
  z.object({ type: z.literal('item.variants'), name: z.string().min(1).max(200), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict()
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
