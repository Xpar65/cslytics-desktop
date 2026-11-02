import type { CslyticsStatus } from '@cslytics/cslytics-account';
import type { EngineCommand } from './api.js';
import type { CommandType } from './command-effects.js';

/**
 * What a CSlytics sign-in unlocks in this desktop, and the one table that says which command needs
 * which (pricing behind sign-in plan §4, §7.2).
 *
 * A **feature** is a key the website's map grants a tier (CSlytics `lib/entitlements/features.ts`,
 * the one authority); the access token and `/api/desktop/me` carry the person's list, and main
 * keeps the last verified one. Nothing here compares tier names: the one question is whether the
 * grant holds a key. Signed out is the empty list.
 *
 * There are two kinds of key, and they differ only in who else refuses:
 *
 * - **Served** (`pricing.steam`, `curves.steam`, `curves.csfloat`): data CSlytics serves. Main
 *   refuses first, and cslytics-api refuses a token without the key, so the data never reaches a
 *   desktop that lacks it.
 * - **Walls** (`market.steam`, `portfolio`): the desktop reads the data from Steam itself, so main
 *   is the only check. The code is public and a fork can remove it; a wall is a reason to sign in,
 *   not protection (plan D2).
 *
 * The key list lives here once, for main and the window alike.
 */
export const FEATURES = ['pricing.steam', 'curves.steam', 'curves.csfloat', 'market.steam', 'portfolio'] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_STEAM_PRICES = 'pricing.steam' satisfies Feature;
export const FEATURE_STEAM_CURVES = 'curves.steam' satisfies Feature;
export const FEATURE_CSFLOAT_CURVES = 'curves.csfloat' satisfies Feature;
export const FEATURE_STEAM_MARKET = 'market.steam' satisfies Feature;
export const FEATURE_PORTFOLIO = 'portfolio' satisfies Feature;

/** The key a float curve of a venue needs. */
export function curveFeature(venue: 'steam' | 'csfloat'): Feature {
  return venue === 'csfloat' ? FEATURE_CSFLOAT_CURVES : FEATURE_STEAM_CURVES;
}

/**
 * What one command needs: `open`, a key, or for the one command that names its venue, a key per
 * venue. Keyed by every command type, so adding a command to `api.ts` fails the typecheck until
 * someone decides whether it carries a price. Prices exist only in main (the engine never sees one,
 * portfolio and pricing plan D3), so the commands below that carry one are the whole set. Buy
 * orders, listing at a typed price, delisting and everything else that is not a price stay open
 * (plan D6).
 */
export type Access = 'open' | Feature | { byVenue: Record<'steam' | 'csfloat', Feature> };

export const COMMAND_ACCESS = {
  'csfloat.page': 'open',
  'csfloat.overview': 'open',
  'csfloat.refresh': 'open',
  'csfloat.protection': 'open',
  'csfloat.list': 'open',
  'csfloat.reprice': 'open',
  'csfloat.cancel': 'open',
  'csfloat.buyOrderEdit': 'open',
  'csfloat.buyOrderCancel': 'open',
  'csfloat.deliver': 'open',
  'csfloat.deliveryRefresh': 'open',
  'csfloat.deliverMany': 'open',
  'csfloat.cannotDeliver': 'open',
  'store.sheet': 'open',
  'store.refresh': 'open',
  'store.purchases': 'open',
  'store.buy': 'open',
  'store.cancel': 'open',
  'store.continue': 'open',
  'storage.contentsPage': 'open',
  'inventory.detail': 'open',
  'orders.detail': 'open',
  'orders.close': 'open',
  'history.detail': 'open',
  'trades.detail': 'open',
  'ledger.detail': 'open',
  'activity.detail': 'open',
  'command.membersPage': 'open',
  'selection.matching': 'open',
  'auth.beginQr': 'open',
  'auth.pollQr': 'open',
  'auth.credentials': 'open',
  'auth.guard': 'open',
  'auth.cancel': 'open',
  'auth.refresh': 'open',
  'accounts.list': 'open',
  'accounts.add': 'open',
  'accounts.clearable': 'open',
  'accounts.remove': 'open',
  'accounts.reset': 'open',
  'marketplace.connect': 'open',
  'marketplace.disconnect': 'open',
  'marketplace.status': 'open',
  'marketplace.refresh': 'open',
  'marketplace.stall': 'open',
  'inventory.sync': 'open',
  'inventory.read': 'open',
  'inventory.page': 'open',
  'inventory.groups': 'open',
  'inventory.positions': 'open',
  'catalogue.status': 'open',
  'catalogue.suggest': 'open',
  'catalogue.accessories': 'open',
  'work.open': 'open',
  'waiting.open': 'open',
  'facts.since': 'open',
  'notifications.state': 'open',
  'notifications.seen': 'open',
  'csfloat.eligibility': 'open',
  'history.page': 'open',
  'activity.page': 'open',
  'storage.page': 'open',
  'orders.page': 'open',
  'trades.page': 'open',
  'ledger.page': 'open',
  'listings.page': 'open',
  'listings.summary': 'open',
  'trades.sync': 'open',
  'trades.list': 'open',
  'trades.summary': 'open',
  'trades.entry': 'open',
  'trades.items': 'open',
  'transfer.plan': 'open',
  'transfer.submit': 'open',
  'transfer.refresh': 'open',
  'transfer.cancel': 'open',
  'transfers.page': 'open',
  'selection.capture': 'open',
  'selection.read': 'open',
  'selection.exclude': 'open',
  'store.precheck': 'open',
  'command.read': 'open',
  'command.stop': 'open',
  'storage.sync': 'open',
  'storage.read': 'open',
  'storage.store': 'open',
  'storage.retrieve': 'open',
  'storage.rename': 'open',
  'market.sync': 'open',
  'market.read': 'open',
  'plan.read': 'open',
  'goals.preview': 'open',
  'conflicts.read': 'open',
  'conflicts.resolve': 'open',
  'market.history': 'open',
  'orders.read': 'open',
  'wallet.sync': 'open',
  'listing.create': 'open',
  'command.submit': 'open',
  'listing.remove': 'open',
  'buyOrder.create': 'open',
  'buyOrder.cancel': 'open',
  'buyOrders.read': 'open',
  'buyOrders.refresh': 'open',
  'portfolio.read': 'open',
  'steam.orderBook': 'market.steam',
  'session.status': 'open',
  'session.connect': 'open',
  'session.signOut': 'open',
  'refresh.now': 'open',
  'refresh.resume': 'open',
  'refresh.status': 'open',
  'history.coverage': 'open',
  'refresh.scope': 'open',
  'authority.read': 'open',
  'authority.set': 'open',
  'release.status': 'open',
  'release.check': 'open',
  'release.install': 'open',
  'release.notes': 'open',
  'settings.read': 'open',
  'settings.write': 'open',
  'settings.launch': 'open',
  'settings.prompts': 'open',
  'cslytics.status': 'open',
  'cslytics.signIn': 'open',
  'cslytics.cancelSignIn': 'open',
  'cslytics.verify': 'open',
  'cslytics.signOut': 'open',
  'settings.currency': 'open',
  'portfolio.valuation': 'portfolio',
  'market.status': 'open',
  'market.fx': 'open',
  'portfolio.history': 'portfolio',
  'item.page': 'market.steam',
  'item.watch': 'market.steam',
  'item.history': 'market.steam',
  'item.curve': { byVenue: { steam: 'curves.steam', csfloat: 'curves.csfloat' } },
  'item.variants': 'open',
  'engine.status': 'open',
  'engine.connect': 'open',
  'engine.disconnect': 'open',
  'engine.pages': 'open',
  'engine.showPage': 'open',
  'engine.hidePage': 'open'
} as const satisfies Record<CommandType, Access>;

/** The key a command needs, or `null` when it is open. */
export function requiredFeature(command: EngineCommand): Feature | null {
  const access: Access = COMMAND_ACCESS[command.type];
  if (access === 'open') return null;
  if (typeof access === 'string') return access;
  const venue = 'venue' in command && command.venue === 'csfloat' ? 'csfloat' : 'steam';
  return access.byVenue[venue];
}

/** Whether the last verified grant holds a feature. */
export function hasFeature(status: Pick<CslyticsStatus, 'features'>, feature: string): boolean {
  return status.features.includes(feature);
}

/**
 * Why a feature is locked for this desktop; `null` when it is not. `signed-out` asks for a sign-in,
 * `tier` for a plan that grants it. A stored sign-in the website has not confirmed keeps its
 * features (plan D7), so being offline is never a reason.
 */
export type LockReason = 'signed-out' | 'tier';

export function lockReason(status: Pick<CslyticsStatus, 'state' | 'features'>, feature: string): LockReason | null {
  if (hasFeature(status, feature)) return null;
  return status.state === 'signedIn' || status.state === 'unconfirmed' ? 'tier' : 'signed-out';
}

/** The sentence main refuses a locked command with. The window never sends one, so nobody should read it. */
export const LOCKED_MESSAGE = 'Sign in to CSlytics to see prices.';

/** Main's gate: the refusal for a command the grant does not cover, or `null` to let it through. */
export function accessRefusal(command: EngineCommand, status: Pick<CslyticsStatus, 'features'>): string | null {
  const feature = requiredFeature(command);
  return feature === null || hasFeature(status, feature) ? null : LOCKED_MESSAGE;
}
