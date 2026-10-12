/**
 * The only shared contract surface. No dependencies, ever — `check:deps` fails if `package.json`
 * gains one, because a type everyone shares must not drag a runtime with it.
 *
 * `kernel.ts` and `vault.ts` are venue-neutral; each venue gets a directory whose filenames match
 * its adapter, its Oracle and its contract test. Adding a port method is then the same four
 * filenames every time — see cslytics-app-docs/architecture.md.
 */
import type { SteamPorts } from './steam/index.js';
import type { CsfloatPorts } from './csfloat/index.js';

export type * from './kernel.js';
export type * from './vault.js';
export type * from './steam/index.js';
export type * from './csfloat/index.js';
export { DEFAULT_AVATAR_HASH } from './steam/persona.js';
export type { FeeLine, MarketplaceFee, MarketplaceFeeSchedule, MarketplaceId, PriceQuote } from './fees.js';
export { MARKETPLACE_FEES, buyerPaysFor, listPriceOf, quoteFromBuyer, quoteFromReceive, receiveFor } from './fees.js';
export { KIT_ATTRIBUTES_BY_ITEM, KIT_ATTRIBUTES_BY_QUALITY, attributeValue, commodityMatchKey, kitToken, matchKey } from './item-key.js';
export { STEAM_ID64_BASE, accountIdFromSteamId64, steamId64FromAccountId } from './steam-id.js';

/**
 * What one Engine Runtime is composed from.
 *
 * CSFloat is optional because a Steam-only profile is a supported product state, not a
 * degraded one: no key, no venue, and every Steam surface still works (plan §4.1).
 */
export type EnginePorts = SteamPorts & { csfloat?: CsfloatPorts };
