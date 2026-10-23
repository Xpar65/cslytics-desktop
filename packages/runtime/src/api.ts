import { z } from 'zod';

/**
 * The commands an Engine Runtime answers, and the one notice it sends unprompted.
 *
 * This is the narrow waist between the engine and whatever drives it: the desktop's main process
 * over an Electron utility-process port, or the headless host over HTTP. Both validate with this
 * schema and dispatch through `createRuntimeDispatch`, so a command takes the same path whoever
 * sent it. The desktop adds its own commands beside these (names, prices, settings, releases),
 * answers them itself and never forwards them.
 *
 * This file imports Zod and nothing else, so a renderer or a thin client can bundle the schema
 * without pulling the engine, and `node:sqlite` with it, into a process that must not have it.
 */

const accountScope = z.array(z.string().min(1)).min(1).max(32);
const pageSize = z.number().int().positive().max(250).optional();
const cursor = z.string().min(1).max(4096).optional();
/** `offer:<tradeofferid>` or `trade:<tradeid>`, as `trades.list` issued it. Steam ids are digits; seeded ones are not. */
const tradeEntryKey = z.string().regex(/^(offer|trade):[A-Za-z0-9_-]{1,64}$/);
/**
 * Two halves that never travel together.
 *
 * `search` and `category` are questions about what an item is *called*, and only a caller with a
 * catalogue can answer them. It resolves them into `matchKeys` and strips them before the command
 * reaches the engine runtime, which has no catalogue and never will.
 *
 * `matchKeys: []` is meaningful and must survive the trip: it says a name filter was asked for and
 * nothing matched. Dropping it as "empty" would show the whole inventory instead of none of it.
 */
const wearBand = z.object({
  matchKeys: z.array(z.string().max(64)).min(1).max(20000).readonly(),
  minWear: z.number().min(0).max(1),
  maxWear: z.number().min(0).max(1)
}).strict();
/**
 * A chip, as a filter bar sends it.
 *
 * Chips the caller resolves stay as chips all the way across, because resolving them needs the
 * catalogue: an item chip is a name, a rarity chip is a grade, a `norm` chip is a normalised
 * float that only float ranges can turn into absolute wear. Everything a window can decide by
 * itself — a wear tier, a seed, a location — is already a number or an enum on the filter beside
 * this, and never arrives as a name.
 */
const filterChip = z.object({
  kind: z.enum(['item','name','category','rarity','collection','norm']),
  text: z.string().max(200),
  rarityId: z.string().max(64).optional(),
  quality: z.enum(['stattrak','souvenir','normal']).optional(),
  op: z.enum(['>','>=','<','<=','=']).optional(),
  value: z.number().min(0).max(1).optional()
}).strict();
export const inventoryFilterSchema = z.object({ search: z.string().max(200).optional(), location: z.enum(['MAIN','CASKET','MISSING']).optional(),
  // Listed is not a place: a listed item is in main inventory (engine `db/commitment.ts`).
  listed: z.boolean().optional(),
  casketId: z.string().optional(), category: z.string().optional(), tradableOnly: z.boolean().optional(),
  matchKeys: z.array(z.string().max(64)).max(20000).readonly().optional(),
  // Wear is a float in [0, 1]; a paint seed is an integer pattern index; a lock names which of the
  // two per-item locks is meant, which `tradableOnly` cannot express because market-locked items
  // are storable and trade-protected ones are not.
  minWear: z.number().min(0).max(1).optional(), maxWear: z.number().min(0).max(1).optional(),
  paintSeed: z.number().int().min(0).max(1000).optional(),
  lock: z.enum(['market','trade']).optional(),
  wearBands: z.array(wearBand).max(64).readonly().optional(),
  // Select all asks for `excludeDisplayOnly`; the caller turns it into the catalogue's
  // never-marketable keys and the engine's own `cannot trade`, then strips it, as it does a name
  // into `matchKeys`.
  excludeDisplayOnly: z.boolean().optional(),
  excludeMatchKeys: z.array(z.string().max(64)).max(20000).readonly().optional(),
  excludeCannotTrade: z.boolean().optional(),
  chips: z.array(filterChip).max(32).optional() }).strict();
/**
 * What the cross-venue listings page narrows by: the inventory's filter bar, less the questions a
 * listed item has no answer to — where it is, which unit holds it, which lock it is under.
 *
 * `search` is the one name here that does *not* travel through the catalogue, and that is
 * deliberate rather than an oversight: both listing tables hold the venue's own
 * `market_hash_name` for the row, so the engine can answer a typed name — or a listing number —
 * out of observed evidence. Every other name is a chip, and the caller resolves it into
 * `matchKeys` and `wearBands` exactly as it does for inventory, then strips it. A typed name is
 * never a chip here for that reason, so `name` is not a kind this schema admits.
 */
const listingChip = filterChip.extend({ kind: z.enum(['item','category','rarity','collection','norm']) }).strict();
export const listingFilterSchema = z.object({
  venue: z.enum(['STEAM','CSFLOAT']).optional(),
  state: z.string().max(64).optional(),
  search: z.array(z.string().max(200)).max(32).optional(),
  matchKeys: z.array(z.string().max(64)).max(20000).readonly().optional(),
  minWear: z.number().min(0).max(1).optional(), maxWear: z.number().min(0).max(1).optional(),
  paintSeed: z.number().int().min(0).max(1000).optional(),
  wearBands: z.array(wearBand).max(64).readonly().optional(),
  chips: z.array(listingChip).max(32).optional()
}).strict();
/**
 * What the Buy orders page narrows by: the Listings bar's chips, less the normalised float, which
 * needs an item's own float range and an order has only a name.
 *
 * It never reaches the engine. A buy order names a market name, not an item this app holds, so a
 * caller with a catalogue resolves the chips and matches each order by what it would buy, then
 * strips the filter before forwarding. The runtime ignores it.
 */
export const buyOrderFilterSchema = z.object({
  search: z.array(z.string().max(200)).max(32).optional(),
  minWear: z.number().min(0).max(1).optional(), maxWear: z.number().min(0).max(1).optional(),
  paintSeed: z.number().int().min(0).max(1000).optional(),
  chips: z.array(filterChip.extend({ kind: z.enum(['item','category','rarity','collection']) }).strict()).max(32).optional()
}).strict();
/** A CSFloat buy order's whole filter set, in the edit route's terms: `null` for none. Stickers and charms by definition id. */
const accessoryList = z.array(z.object({ sId: z.number().int().min(0) }).strict()).max(100).nullable();
const buyOrderConstraints = z.object({
  minFloat: z.number().min(0).max(1).nullable(), maxFloat: z.number().min(0).max(1).nullable(),
  paintSeeds: z.array(z.number().int().min(0).max(1000)).max(100).nullable(),
  minKeychainPattern: z.number().int().min(0).nullable(), maxKeychainPattern: z.number().int().min(0).nullable(),
  appliedStickers: accessoryList, appliedKeychains: accessoryList
}).strict();
const recordFilter = z.object({ search: z.string().max(200).optional(), state: z.string().optional(), eventType: z.number().int().optional() }).strict();

/**
 * Every command the runtime's dispatch table answers. A caller that adds commands of its own
 * spreads `runtimeCommandSchema.options` into its own discriminated union, so the two never
 * drift: a command the runtime does not know is refused by name, never answered with nothing.
 */
export const runtimeCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('csfloat.page'), accountId: z.string().min(1), book: z.enum(['inventory','listings','sales','operations']), cursor }).strict(),
  z.object({ type: z.literal('csfloat.overview'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('csfloat.refresh'), accountId: z.string().min(1), eligibility: z.boolean() }).strict(),
  z.object({ type: z.literal('csfloat.protection'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('csfloat.list'), commandId: z.string().uuid(), members: z.array(
    z.object({ accountId: z.string().min(1), localId: z.string().min(1).max(128), priceCents: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER) }).strict()
  ).min(1).max(100) }).strict(),
  z.object({ type: z.literal('csfloat.reprice'), commandId: z.string().uuid(), accountId: z.string().min(1), listingId: z.string().min(1).max(64), priceCents: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ type: z.literal('csfloat.cancel'), commandId: z.string().uuid(), accountId: z.string().min(1), listingId: z.string().min(1).max(64) }).strict(),
  // A change to, or a cancel of, one of the account's own CSFloat buy orders. The price is the
  // buyer's limit per item in USD cents. `constraints`, when sent, is the order's whole new filter
  // set, as the site's edit dialog sends it; when absent the engine carries the order's own through
  // (kernel/csfloat-buy-orders). Either way the engine checks it and is the gate.
  z.object({ type: z.literal('csfloat.buyOrderEdit'), commandId: z.string().uuid(), accountId: z.string().min(1), orderId: z.string().min(1).max(64),
    maxPriceCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), quantity: z.number().int().min(1).max(100_000),
    constraints: buyOrderConstraints.optional() }).strict(),
  z.object({ type: z.literal('csfloat.buyOrderCancel'), commandId: z.string().uuid(), accountId: z.string().min(1), orderId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('csfloat.deliver'), commandId: z.string().uuid(), accountId: z.string().min(1), tradeId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('csfloat.deliveryRefresh'), accountId: z.string().min(1), operationId: z.string().max(128) }).strict(),
  z.object({ type: z.literal('csfloat.cannotDeliver'), accountId: z.string().min(1), operationId: z.string().min(1).max(128) }).strict(),
  // The in-game store. A purchase names sheet entries and quantities; the caller resolves each
  // entry's def index before forwarding (`defIndex` is what a catalogue adds, never what a window
  // sends), and nothing in these commands can carry a checkout URL or a cookie.
  z.object({ type: z.literal('store.sheet'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('store.refresh'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('store.purchases'), accountId: z.string().min(1), cursor: z.string().min(1).optional() }).strict(),
  z.object({
    type: z.literal('store.buy'),
    commandId: z.string().uuid(),
    accountId: z.string().min(1),
    lines: z.array(z.object({
      entryKey: z.string().min(1).max(128),
      quantity: z.number().int().min(1).max(100),
      unitPriceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      defIndex: z.number().int().min(0).optional()
    }).strict()).min(1).max(50)
  }).strict(),
  z.object({ type: z.literal('store.cancel'), accountId: z.string().min(1), purchaseId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('store.continue'), accountId: z.string().min(1), purchaseId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('storage.contentsPage'), accountIds: accountScope, pageSize, cursor, casketId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('inventory.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('orders.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  // A person's exit from an unexplained order: closed as cancelled or sold, on their word, recorded as a correction beside what was observed.
  z.object({ type: z.literal('orders.close'), accountId: z.string().min(1), orderId: z.string().min(1), as: z.enum(['cancelled', 'sold']) }).strict(),
  z.object({ type: z.literal('history.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('trades.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('ledger.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('activity.detail'), accountId: z.string().min(1), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('command.membersPage'), accountIds: accountScope, pageSize, cursor, commandId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('selection.matching'), accountIds: accountScope, filter: inventoryFilterSchema }).strict(),
  z.object({ type: z.literal('auth.beginQr') }).strict(),
  z.object({ type: z.literal('auth.pollQr'), sessionHandle: z.string().uuid() }).strict(),
  z.object({ type: z.literal('auth.credentials'), username: z.string().min(1), password: z.string().min(1) }).strict(),
  z.object({ type: z.literal('auth.guard'), sessionHandle: z.string().uuid(), code: z.string().min(4).max(10) }).strict(),
  z.object({ type: z.literal('auth.cancel'), sessionHandle: z.string().uuid() }).strict(),
  z.object({ type: z.literal('auth.refresh'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('accounts.list') }).strict(),
  // An account the runtime should hold a row for before anything signs it in: what a host whose
  // sessions are minted elsewhere does instead of a QR login. An existing account with the same
  // name or SteamID64 is updated, never duplicated. The reply is the id the record uses.
  z.object({ type: z.literal('accounts.add'), accountId: z.string().min(1).max(64), steamId64: z.string().regex(/^7656119\d{10}$/), accountName: z.string().min(1).max(64) }).strict(),
  // Why one account cannot be removed or reset right now, or null. Reads only; the erasing itself
  // is the caller's, because it restarts the runtime with the account's rows deleted before anything else runs.
  z.object({ type: z.literal('accounts.clearable'), accountId: z.string().min(1) }).strict(),
  // Marketplace credentials. `apiKey` is write-only: there is deliberately no command that reads
  // one back, and the bound is a bound rather than a format, because a venue may change what a
  // key looks like and this layer must not become the thing that decides a valid key is invalid.
  z.object({ type: z.literal('marketplace.connect'), accountId: z.string().min(1), venue: z.literal('csfloat'),
    apiKey: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal('marketplace.disconnect'), accountId: z.string().min(1), venue: z.literal('csfloat'),
    mode: z.enum(['disconnect', 'forget']) }).strict(),
  z.object({ type: z.literal('marketplace.status'), accountId: z.string().min(1), venue: z.literal('csfloat') }).strict(),
  z.object({ type: z.literal('marketplace.refresh'), accountId: z.string().min(1), venue: z.literal('csfloat') }).strict(),
  // The stall's two settings, changed at the venue. The reply is `/me` read back, never the request.
  z.object({ type: z.literal('marketplace.stall'), accountId: z.string().min(1), venue: z.literal('csfloat'),
    away: z.boolean().optional(), stallPublic: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('inventory.sync'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('inventory.read'), accountId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('inventory.page'),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    // `name` is a window's word and a catalogue's to resolve: it becomes `keys` with a `keyOrder`
    // of identity keys, exactly as a name filter becomes `matchKeys`, and never reaches the engine.
    sort: z.enum(['localId', 'defIndex', 'keys', 'float', 'seen', 'name']).optional(),
    keyOrder: z.array(z.string().max(64)).max(20000).readonly().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    cursor: z.string().min(1).optional(),
    filter: inventoryFilterSchema.optional()
  }).strict(),
  z.object({
    type: z.literal('inventory.groups'),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional(),
    filter: inventoryFilterSchema.optional()
  }).strict(),
  // What a scope holds by market kind, one row per account, identity key and wear band, with no
  // name. Unpaged: a valuation needs the whole set or none of it.
  z.object({ type: z.literal('inventory.positions'), accountIds: accountScope, filter: inventoryFilterSchema.optional() }).strict(),
  // Everything in flight for a scope. Read-only, account-scoped like every other read (rule 8).
  z.object({ type: z.literal('work.open'), accountIds: accountScope }).strict(),
  // What is waiting on the person rather than on the app: listings and sent offers Steam is
  // holding for a phone tap this product may never make (rule 2). A scope and nothing else —
  // there is no `seen` or `dismissed` to send, because an obligation is discharged by the tap
  // and removed by the walk that observes it, never by a window deciding it has been read.
  z.object({ type: z.literal('waiting.open'), accountIds: accountScope }).strict(),
  z.object({ type: z.literal('csfloat.eligibility'), accountId: z.string().min(1), localIds: z.array(z.string().min(1).max(128)).max(100) }).strict(),
  z.object({
    type: z.literal('history.page'),
    filter: recordFilter.optional(),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('activity.page'),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('storage.page'),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('orders.page'),
    filter: recordFilter.optional(),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('trades.page'),
    filter: recordFilter.optional(),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('ledger.page'),
    filter: recordFilter.optional(),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    pageSize: z.number().int().positive().max(250).optional(),
    cursor: z.string().min(1).optional()
  }).strict(),
  // Every open advertisement across the named accounts and both venues. Two commands rather than
  // one envelope: the page turns as the user scrolls, and the summary above it does not.
  z.object({
    type: z.literal('listings.page'),
    accountIds: accountScope,
    pageSize,
    cursor,
    sort: z.enum(['name','price','float','seen']).optional(),
    direction: z.enum(['asc','desc']).optional(),
    filter: listingFilterSchema.optional()
  }).strict(),
  z.object({ type: z.literal('listings.summary'), accountIds: accountScope, filter: listingFilterSchema.optional() }).strict(),
  z.object({ type: z.literal('trades.sync'), accountId: z.string().min(1) }).strict(),
  // The trades page. An entry is an offer, or a trade seen only in history, named by a key the engine
  // issued. The list is every trade, newest first, narrowed by stage, kind and which way the items went.
  z.object({ type: z.literal('trades.list'), accountIds: accountScope,
    stage: z.enum(['to-be-confirmed','reversal-period','finalized','reversed','ended']).optional(),
    origin: z.enum(['marketplace','transfers','other']).optional(), flow: z.enum(['out','in']).optional(), pageSize, cursor }).strict(),
  z.object({ type: z.literal('trades.summary'), accountIds: accountScope }).strict(),
  z.object({ type: z.literal('trades.entry'), accountId: z.string().min(1), entryKey: tradeEntryKey }).strict(),
  z.object({ type: z.literal('trades.items'), accountId: z.string().min(1), entryKey: tradeEntryKey, side: z.enum(['GIVE','RECEIVE']),
    groupKey: z.string().min(1).max(600).optional(), pageSize, cursor }).strict(),
  ...(['transfer.plan','transfer.submit'] as const).map(type => z.object({
    type: z.literal(type), commandId: z.string().uuid(), destinationAccountId: z.string().min(1),
    members: z.array(z.object({ accountId: z.string().min(1),localId:z.string().uuid(),
      quantity:z.number().int().positive().max(1000).optional(),casketId:z.string().nullable().optional() }).strict()).min(1).max(6200).optional(),
    manifestToken:z.string().uuid().optional(),manifestRevision:z.number().int().positive().optional()
  }).strict().refine(value => Boolean(value.members?.length) !== Boolean(value.manifestToken), {message:'Name a selection or its frozen manifest'})),
  z.object({type:z.literal('transfer.refresh'),destinationAccountId:z.string().min(1),accountIds:accountScope}).strict(),
  z.object({type:z.literal('transfer.cancel'),commandId:z.string().uuid(),accountId:z.string().min(1)}).strict(),
  z.object({type:z.literal('transfers.page'),accountIds:accountScope,pageSize:z.number().int().positive().max(250).optional(),cursor:z.string().min(1).optional()}).strict(),
  z.object({
    type: z.literal('selection.capture'),
    accountIds: z.array(z.string().min(1)).min(1).max(32),
    members: z.array(z.object({
      accountId: z.string().min(1),
      localId: z.string().uuid(),
      location: z.enum(['MAIN','CASKET','MISSING']).optional(),
      casketId: z.string().nullable().optional(),
      quantity: z.number().int().positive().optional()
    }).strict()).min(1).max(1000)
  }).strict(),
  z.object({ type: z.literal('selection.read'), token: z.string().uuid() }).strict(),
  // Drops members from a frozen selection, the way the store pre-check leaves them out (bulk storage plan D13).
  z.object({
    type: z.literal('selection.exclude'),
    token: z.string().uuid(),
    revision: z.number().int().positive(),
    members: z.array(z.object({ accountId: z.string().min(1), localId: z.string().uuid() }).strict()).min(1).max(1000)
  }).strict(),
  // What a store would meet, read from the record alone (bulk storage plan §5.1).
  z.object({
    type: z.literal('store.precheck'),
    members: z.array(z.object({ accountId: z.string().min(1), localId: z.string().uuid() }).strict()).max(1000).optional(),
    manifestToken: z.string().uuid().optional(),
    destinations: z.record(z.string(), z.string())
  }).strict().refine((command) => Boolean((command.members && command.members.length > 0) || command.manifestToken), {
    message: 'store.precheck needs members or a manifest token'
  }),
  z.object({ type: z.literal('command.read'), commandId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('command.stop'), commandId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('storage.sync'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('storage.read'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('storage.store'), accountId: z.string().min(1), localIds: z.array(z.string().uuid()).max(1000), casketId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('storage.retrieve'), accountId: z.string().min(1), localIds: z.array(z.string().uuid()).max(1000), casketId: z.string().min(1) }).strict(),
  // The schema bound is the first refusal; `policy/casket-name.ts` in the engine is the one that decides.
  z.object({ type: z.literal('storage.rename'), accountId: z.string().min(1), casketId: z.string().min(1), name: z.string().min(1).max(20) }).strict(),
  z.object({ type: z.literal('market.sync'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('market.read'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('plan.read'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('goals.preview'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('conflicts.read'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('conflicts.resolve'), accountId: z.string().min(1), desiredId: z.string().uuid(), resolution: z.enum(['resume', 'adopt']) }).strict(),
  z.object({ type: z.literal('market.history'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('orders.read'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('wallet.sync'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('listing.create'), accountId: z.string().min(1), localId: z.string().uuid(), priceReceiveCents: z.number().int().positive() }).strict(),
  z.object({
    type: z.literal('command.submit'),
    commandId: z.string().uuid(),
    kind: z.enum(['STORE', 'RETRIEVE', 'LIST', 'TRANSFER', 'REPRICE', 'DELIST_TO_STORE']),
    members: z.array(z.object({
      accountId: z.string().min(1),
      localId: z.string().uuid(),
      quantity: z.number().int().positive().optional(),
      sourceCasketId: z.string().min(1).optional(),
      destinationCasketId: z.string().min(1).optional(),
      priceReceiveCents: z.number().int().positive().optional()
    }).strict()).max(1000).optional(),
    manifestToken: z.string().uuid().optional(),
    manifestRevision: z.number().int().positive().optional(),
    destinations: z.record(z.string(), z.string()).optional(),
    priceReceiveCents: z.number().int().positive().optional(),
    // What the person agreed to store despite, when the pre-check named it (bulk storage plan D9).
    consent: z.array(z.enum(['csfloat-listed', 'csfloat-owed', 'trade-pledged'])).max(3).optional()
  }).strict().refine((command) => Boolean((command.members && command.members.length > 0) || command.manifestToken), {
    message: 'command.submit needs members or a manifest token'
  }),
  z.object({ type: z.literal('listing.remove'), accountId: z.string().min(1), listingId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('buyOrder.create'),
    accountId: z.string().min(1),
    marketHashName: z.string().min(1),
    priceTotalCents: z.number().int().positive(),
    quantity: z.number().int().positive(),
    currency: z.number().int().positive(),
    billingState: z.string().min(1)
  }).strict(),
  z.object({ type: z.literal('buyOrder.cancel'), accountId: z.string().min(1), buyOrderId: z.string().min(1) }).strict(),
  // Every buy order Steam shows open across the named accounts, whole: `mylistings` returns an
  // account's orders on one page, so the book is small and bounded rather than paged.
  z.object({ type: z.literal('buyOrders.read'), accountIds: accountScope, filter: buyOrderFilterSchema.optional() }).strict(),
  // The page's refresh: the chosen venue's book read again now for the accounts in view, or both
  // venues' when none is chosen. Through the read budget, never past it.
  z.object({ type: z.literal('buyOrders.refresh'), accountIds: accountScope, venue: z.enum(['STEAM', 'CSFLOAT']).nullable() }).strict(),
  // The one cross-account read. It takes the ids rather than defaulting to "everything"
  // because nothing in the runtime has a current account to fall back on (rule 8) — the caller
  // showing two signed-in accounts is the only thing that knows which two.
  z.object({ type: z.literal('portfolio.read'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  // Connection state per account, for an indicator. Named accounts for the same reason
  // `portfolio.read` names them: there is no current account to fall back on.
  z.object({ type: z.literal('session.status'), accountIds: z.array(z.string().min(1)).min(1).max(32) }).strict(),
  // Bringing one account online from what is already stored, and the reverse. Both are single
  // account (rule 8 again): a caller drives every saved account through `session.connect` one at
  // a time, so that one blocked account is reported as blocked rather than failing a batch, and
  // so that Steam sees the logons spaced out rather than all at once.
  // `cs2: false` signs in to Steam and stops there: the answer for an account whose CS2 session
  // is meant to stay free for a game on another computer. Absent means both.
  z.object({ type: z.literal('session.connect'), accountId: z.string().min(1), cs2: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('session.signOut'), accountId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('refresh.now'), accountIds: accountScope }).strict(),
  // A machine woke up. Sent with no accounts named: the runtime refreshes the accounts it is
  // already keeping current, and never signs in one that was left signed out.
  z.object({ type: z.literal('refresh.resume') }).strict(),
  z.object({ type: z.literal('refresh.status'), accountIds: accountScope }).strict(),
  z.object({ type: z.literal('refresh.scope'), accountId: z.string().min(1).nullable() }).strict()
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

/** The command names the runtime answers, for a caller that routes by name before validating. */
export const RUNTIME_COMMAND_TYPES: ReadonlySet<string> = new Set(
  runtimeCommandSchema.options.map((option) => {
    const shape = (option as unknown as { shape?: { type?: { value?: unknown } }; def?: { in?: { shape?: { type?: { value?: unknown } } } } });
    const value = shape.shape?.type?.value ?? shape.def?.in?.shape?.type?.value;
    if (typeof value !== 'string') throw new Error('every runtime command is an object with a literal type');
    return value;
  })
);

/**
 * What the Engine Runtime tells its caller, unprompted.
 *
 * **It carries no rows.** The payload names the account and the surfaces whose observations
 * changed, and the caller re-reads through the read commands it already has. That keeps the
 * read models the only path data travels, keeps this schema the narrow waist it is, and makes a
 * dropped or duplicated notification cost one stale second rather than a wrong screen — which
 * matters, because nothing here is delivered reliably and nothing acknowledges it.
 */
export const changeNotificationSchema = z.object({
  kind: z.literal('changed'),
  accountId: z.string().min(1),
  surfaces: z.array(z.string().min(1)).max(16),
  at: z.string().min(1)
}).strict();

export type ChangeNotification = z.infer<typeof changeNotificationSchema>;
