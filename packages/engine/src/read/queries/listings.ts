import type { EngineDatabase } from '../../db/database.js';
import type { WearBand } from '../../db/inventory-query.js';
import { MarketplaceStore } from '../../db/marketplace.js';
import { assertAccountScope, queryPage, type PageEnvelope } from './paging.js';

/**
 * Every advertisement an account has standing, on every venue, in one list.
 *
 * The per-venue screens answer "what is on Steam for this account" and "what is on CSFloat for
 * this account". Neither answers the question a seller with three accounts and two venues
 * actually asks, which is "what have I got listed" — and answering it by reading two screens per
 * account is how a listing is forgotten.
 *
 * Three things this read refuses to do, each because the alternative is a plausible lie:
 *
 *  - **It never converts.** Steam prices in the seller's wallet currency and CSFloat in US
 *    dollars. There is no FX source in this app (`cslytics-app-docs/steam/wallet.md`: the engine
 *    never values an item), so `summariseListings` groups money by venue *and* currency and the
 *    caller shows the groups. A single headline figure would be a number nobody can act on.
 *  - **It never guesses a currency.** A Steam listing is priced in the wallet currency of the
 *    account that holds it, so it is read from that account's last wallet snapshot; an account
 *    whose wallet has never been observed gets `null`, which renders as an amount without a
 *    symbol rather than as dollars.
 *  - **It never claims proceeds it was not told.** `receiveCents` is Steam's seller-receives
 *    figure. CSFloat reports the buyer price and keeps fees to itself, so its rows carry `null`
 *    — not the buyer price again, and not zero.
 *
 * Names are the venues' own (`hash_name`), which is observed evidence about the listing and is
 * already in both tables — the same standing `trade_line.market_hash_name` has in DATA-INDEX.
 * Identity keys travel beside them so the host can attach a picture; the engine attaches none.
 */
export type ListingVenue = 'STEAM' | 'CSFLOAT';
/** `seen` is `firstSeenAt`: the one date both venues' rows carry, and never a stand-in for `createdAt`. */
export type ListingSort = 'name' | 'price' | 'float' | 'seen';
export type ListingSortDirection = 'asc' | 'desc';
/**
 * What the Listings page narrows by: the inventory's filter, less what only an item in hand has.
 *
 * Two kinds of name, kept apart for the same reason `InventoryFilter` keeps them apart. `search`
 * is the venue's own `hash_name`, or a listing number — observed evidence already on both listing
 * tables, so the engine answers it. `matchKeys` and `wearBands` are the catalogue's answer to an
 * item, collection, rarity, quality or normalised-float chip, resolved by the host into identity
 * keys and ranges before the command arrives. The empty-versus-absent rule is `InventoryFilter`'s:
 * `matchKeys: []` is "a name filter matched nothing", never "no filter".
 *
 * Location, storage unit, lock and tradability are absent on purpose. A listed item is at the
 * venue by definition, and none of those questions has an answer for it.
 */
export type ListingFilter = {
  venue?: ListingVenue | undefined;
  state?: string | undefined;
  /** Substrings of the venue's name for the item, or listing numbers. Any one term qualifies a row. */
  search?: readonly string[] | undefined;
  matchKeys?: readonly string[] | undefined;
  minWear?: number | undefined;
  maxWear?: number | undefined;
  paintSeed?: number | undefined;
  wearBands?: readonly WearBand[] | undefined;
};
export type ListingPageRequest = {
  accountIds: readonly string[];
  pageSize?: number | undefined;
  cursor?: string | undefined;
  sort?: ListingSort | undefined;
  direction?: ListingSortDirection | undefined;
  filter?: ListingFilter | undefined;
};

export type ListingPageRow = {
  accountId: string;
  venue: ListingVenue;
  listingId: string;
  /** What the venue itself calls the item. Never a catalogue name; the engine holds none. */
  hashName: string;
  /** The venue's own state word, unmapped. `labels.ts` in the host turns it into English. */
  state: string;
  /** What a buyer pays. The one money figure both venues report, so the only comparable one. */
  buyerPriceCents: number;
  /** What the seller receives. Steam names it; CSFloat does not, and `null` says exactly that. */
  receiveCents: number | null;
  /** Steam `ECurrencyCode`. `null` is a wallet this app has not observed, never a default. */
  currency: number | null;
  localId: string | null;
  assetId: string;
  matchKey: string;
  defIndex: number | null;
  paintIndex: number | null;
  quality: number | null;
  paintWear: number | null;
  paintSeed: number | null;
  holdUntil: string | null;
  /** 0/1 as SQLite stores it: a Steam listing waiting on a phone tap this app never makes. */
  awaitingConfirmation: number;
  /** When the venue says it was listed. CSFloat names it; Steam's walk does not, and `null` says so. */
  createdAt: string | null;
  /**
   * When the walk that first saw this row finished: the earliest this app can vouch for the
   * listing. Never a stand-in for `createdAt` — a listing made elsewhere is older than this.
   */
  firstSeenAt: string | null;
  /** When the walk that last saw this row finished, and whether that walk completed (rule 5). */
  observedAt: string | null;
  observationComplete: number;
};

/** Money for one venue in one currency. Two currencies are two rows, never one sum (BUY-09). */
export type ListingMoneyBucket = {
  venue: ListingVenue;
  currency: number | null;
  listings: number;
  buyerPriceCents: number;
  receiveCents: number | null;
};
/** The states actually present in the scope, so the caller can offer no dead filter option. */
export type ListingStateBucket = { venue: ListingVenue; state: string; listings: number };
/**
 * What the figures rest on, per account and venue.
 *
 * A listings page built on a walk that did not finish is a floor, not a book, and the only way
 * for the caller to say so is to be told. `observedAt: null` is "never walked", which is not the
 * same claim as "walked and empty" — rule 5 in the read model, the way `SurfaceEvidence` carries
 * it for the portfolio.
 */
export type ListingCoverageRow = { accountId: string; venue: ListingVenue; observedAt: string | null; complete: number };
export type ListingsSummary = {
  accountIds: string[];
  money: ListingMoneyBucket[];
  states: ListingStateBucket[];
  coverage: ListingCoverageRow[];
};

/**
 * CSFloat prices in US dollars (`DATA-INDEX.md`: `csfloat_listing.price_cents` is the buyer price
 * in USD cents). Expressed as Steam's `ECurrencyCode` so one currency vocabulary covers both
 * venues and the host needs one formatter rather than one per venue.
 */
export const CSFLOAT_CURRENCY = 1;

const STEAM_SURFACE = 'steam-market';
const CSFLOAT_SURFACE = 'csfloat-stall';

/**
 * Steam's identity expression, spelled for an aliased `item`.
 *
 * It must stay identical to `INDIVIDUAL_MATCH_SQL` in `db/inventory-query.ts` — the catalogue
 * resolves a key or it does not, and two spellings of the same key resolve differently.
 */
const ITEM_MATCH_SQL = "i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,'')";

type Param = string | number | null;
type Branch = { sql: string; params: Param[] };

/**
 * Open listings for a scope, newest walk's view of them, across both venues.
 *
 * `ABSENT` Steam rows are excluded: that status is written only by a *complete* walk that no
 * longer saw the listing, so leaving them in would fill a page called Listings with things that
 * are not listed. What happened to them is the Orders and History books, which keep the record.
 */
export function pageListings(database: EngineDatabase, request: ListingPageRequest): PageEnvelope<ListingPageRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const sort: ListingSort = request.sort ?? 'name';
  const direction: ListingSortDirection = request.direction ?? 'asc';
  const { sql, params } = union(accounts, request.filter ?? {});
  const page = queryPage<ListingPageRow & { sortValue?: unknown }>(
    database,
    { ...request, sort, direction },
    'listings',
    `SELECT *, ${sortValue(sort, direction)} AS sortValue FROM (${sql})`,
    params,
    ['sortValue', 'accountId', 'venue', 'listingId']
  );
  // The sort column is the cursor's business, not the row's.
  if (page.kind === 'page') for (const row of page.rows) delete row.sortValue;
  return page;
}

/**
 * The value a page is ordered by, never null.
 *
 * A keyset cursor compares row values, and a comparison with NULL is neither before nor after, so
 * a null in the first key strands every row behind it. A listing with no float (a case, a sticker)
 * or a row whose first sighting is unknown is given a stand-in that sorts it **last** whichever
 * way the page runs, rather than first on the way up and last on the way down.
 */
function sortValue(sort: ListingSort, direction: ListingSortDirection): string {
  const descending = direction === 'desc';
  if (sort === 'price') return 'buyerPriceCents';
  if (sort === 'float') return `IFNULL(paintWear, ${descending ? -1 : 2})`;
  if (sort === 'seen') return `IFNULL(firstSeenAt, '${descending ? '' : '~'}')`;
  return 'hashName';
}

/**
 * The figures above the list, and the evidence under them.
 *
 * `states` deliberately ignores both `venue` and `state`: it is the set of options the caller
 * offers, and an option list narrowed by the option already chosen leaves exactly one of itself.
 * It honours every item filter — names, identity, float, pattern — because those are what the
 * user is looking *through*. `money` honours the whole filter, so the figures describe the rows on
 * screen rather than a different set.
 */
export function summariseListings(database: EngineDatabase, request: ListingPageRequest): ListingsSummary {
  const accounts = assertAccountScope(database, request.accountIds);
  const filter = request.filter ?? {};
  const raw = database.raw();

  const full = union(accounts, filter);
  const money = raw.prepare(`SELECT venue, currency, COUNT(*) AS listings,
      COALESCE(SUM(buyerPriceCents),0) AS buyerPriceCents, SUM(receiveCents) AS receiveCents
    FROM (${full.sql}) GROUP BY venue, currency ORDER BY venue, currency`).all(...full.params) as ListingMoneyBucket[];

  const options = union(accounts, { ...filter, venue: undefined, state: undefined });
  const states = raw.prepare(`SELECT venue, state, COUNT(*) AS listings
    FROM (${options.sql}) GROUP BY venue, state ORDER BY venue, state`).all(...options.params) as ListingStateBucket[];

  const marketplace = new MarketplaceStore(database);
  const coverage: ListingCoverageRow[] = [];
  for (const accountId of accounts) {
    // Steam is every account's venue, so an account with no walk still gets a row saying so.
    // CSFloat is an account's venue once a key has been attached *or* once the stall has been
    // walked — a key that was later removed does not make the book that was read stop mattering.
    // An account that has never done either gets no line, because reporting the coverage of a
    // venue it does not use would be answering a question nobody asked.
    coverage.push(evidence(database, accountId, 'STEAM', STEAM_SURFACE));
    const stall = database.latestObservation(accountId, CSFLOAT_SURFACE);
    if (stall || marketplace.connection(accountId, 'csfloat')) {
      coverage.push({
        accountId,
        venue: 'CSFLOAT',
        observedAt: stall?.finished_at ?? null,
        complete: stall?.complete === 1 ? 1 : 0
      });
    }
  }
  return { accountIds: accounts, money, states, coverage };
}

function evidence(database: EngineDatabase, accountId: string, venue: ListingVenue, surface: string): ListingCoverageRow {
  const observation = database.latestObservation(accountId, surface);
  return {
    accountId,
    venue,
    observedAt: observation?.finished_at ?? null,
    complete: observation?.complete === 1 ? 1 : 0
  };
}

function union(accounts: readonly string[], filter: ListingFilter): Branch {
  const branches: Branch[] = [];
  if (filter.venue !== 'CSFLOAT') branches.push(steamBranch(accounts, filter));
  if (filter.venue !== 'STEAM') branches.push(csfloatBranch(accounts, filter));
  // A venue filter naming neither venue cannot happen through the schema, but an empty union is
  // not valid SQL, so say "no rows" explicitly rather than building something that throws.
  if (branches.length === 0) return { sql: 'SELECT NULL AS accountId WHERE 0', params: [] };
  const inner = {
    sql: branches.map((branch) => branch.sql).join('\nUNION ALL\n'),
    params: branches.flatMap((branch) => branch.params)
  };
  const item = itemPredicate(filter);
  return item.sql ? { sql: `SELECT * FROM (${inner.sql}) WHERE ${item.sql}`, params: [...inner.params, ...item.params] } : inner;
}

/**
 * The questions about the *item* a listing advertises, asked once over both venues.
 *
 * They are asked of the projected columns rather than inside each branch, because by then a
 * CSFloat row's identity has already been taken from its associated local item where one exists
 * (`csfloatBranch`), and the two venues answer them identically. A listing whose identity is not
 * known — a Steam row with no local item — has an empty key and no float, so it fails an identity
 * or float question rather than passing it: nothing is concluded about an item nobody identified.
 *
 * Each predicate is `InventoryFilter`'s, spelled over these columns; `inventoryQuery` in
 * `db/inventory-query.ts` is the one to keep this in step with.
 */
function itemPredicate(filter: ListingFilter): Branch {
  const clauses: string[] = [];
  const params: Param[] = [];
  const terms = (filter.search ?? []).map((term) => term.trim()).filter(Boolean);
  if (terms.length) {
    clauses.push(`(${terms.map(() => `hashName LIKE ? ESCAPE '\\' OR listingId=?`).join(' OR ')})`);
    for (const term of terms) params.push(like(term), term);
  }
  if (filter.matchKeys) {
    if (filter.matchKeys.length === 0) clauses.push('0');
    else { clauses.push(`matchKey IN (${filter.matchKeys.map(() => '?').join(',')})`); params.push(...filter.matchKeys); }
  }
  if (filter.minWear !== undefined) { clauses.push('paintWear IS NOT NULL AND paintWear>=?'); params.push(filter.minWear); }
  if (filter.maxWear !== undefined) { clauses.push('paintWear IS NOT NULL AND paintWear<=?'); params.push(filter.maxWear); }
  if (filter.paintSeed !== undefined) { clauses.push('paintSeed=?'); params.push(filter.paintSeed); }
  if (filter.wearBands) {
    // Each band is its own key set with its own absolute bounds, exactly as in inventory: the same
    // normalised position is a different float in a 0–0.4 skin than in a 0–1 one.
    const bands = filter.wearBands.filter((band) => band.matchKeys.length > 0);
    if (bands.length === 0) clauses.push('0');
    else {
      clauses.push(`(${bands.map((band) => `(matchKey IN (${band.matchKeys.map(() => '?').join(',')}) AND paintWear IS NOT NULL AND paintWear BETWEEN ? AND ?)`).join(' OR ')})`);
      for (const band of bands) params.push(...band.matchKeys, band.minWear, band.maxWear);
    }
  }
  return { sql: clauses.join(' AND '), params };
}

function steamBranch(accounts: readonly string[], filter: ListingFilter): Branch {
  const params: Param[] = [];
  let where = `m.account_id IN (${accounts.map(() => '?').join(',')}) AND m.status<>'ABSENT'`;
  params.push(...accounts);
  if (filter.state) { where += ' AND m.status=?'; params.push(filter.state); }
  return {
    sql: `SELECT m.account_id AS accountId, 'STEAM' AS venue, m.listing_id AS listingId,
        m.hash_name AS hashName, m.status AS state,
        m.buyer_price_cents AS buyerPriceCents, m.price_receive_cents AS receiveCents,
        (SELECT w.currency FROM wallet_snapshot w WHERE w.account_id=m.account_id ORDER BY w.id DESC LIMIT 1) AS currency,
        m.local_id AS localId, m.asset_id AS assetId,
        IFNULL(${ITEM_MATCH_SQL}, '') AS matchKey,
        i.def_index AS defIndex, i.paint_index AS paintIndex, i.quality AS quality,
        i.paint_wear AS paintWear, i.paint_seed AS paintSeed,
        m.hold_until AS holdUntil, m.awaiting_confirmation AS awaitingConfirmation,
        NULL AS createdAt, f.finished_at AS firstSeenAt,
        o.finished_at AS observedAt, IFNULL(o.complete,0) AS observationComplete
      FROM market_listing m
      LEFT JOIN item i ON i.local_id=m.local_id AND i.account_id=m.account_id
      LEFT JOIN observation f ON f.id=m.first_seen_obs
      LEFT JOIN observation o ON o.id=m.last_seen_obs
      WHERE ${where}`,
    params
  };
}

/**
 * CSFloat's book, with identity taken from the local item where the association exists.
 *
 * `csfloat_listing` carries the venue's own tuple but no `kit`, and a key spelled with an empty
 * kit is a different key from one spelled with the item's. So the contract row — which is where
 * `CsfloatStore.associate` recorded the identity association, by float tuple and never by asset
 * id alone (rule 3) — is joined through to the local item, and the venue's tuple is only the
 * fallback for a listing this app has not managed to associate.
 */
function csfloatBranch(accounts: readonly string[], filter: ListingFilter): Branch {
  const params: Param[] = [];
  let where = `c.account_id IN (${accounts.map(() => '?').join(',')})`;
  params.push(...accounts);
  if (filter.state) { where += ' AND c.state=?'; params.push(filter.state); }
  return {
    sql: `SELECT c.account_id AS accountId, 'CSFLOAT' AS venue, c.listing_id AS listingId,
        c.hash_name AS hashName, c.state AS state,
        c.price_cents AS buyerPriceCents, NULL AS receiveCents,
        ${CSFLOAT_CURRENCY} AS currency,
        k.local_id AS localId, c.asset_id AS assetId,
        IFNULL(${ITEM_MATCH_SQL},
          c.def_index || ':' || IFNULL(c.paint_index,'') || ':' || IFNULL(c.quality,'') || ':') AS matchKey,
        c.def_index AS defIndex, c.paint_index AS paintIndex, c.quality AS quality,
        c.paint_wear AS paintWear, c.paint_seed AS paintSeed,
        NULL AS holdUntil, 0 AS awaitingConfirmation,
        c.created_at AS createdAt, f.finished_at AS firstSeenAt,
        o.finished_at AS observedAt, IFNULL(o.complete,0) AS observationComplete
      FROM csfloat_listing c
      LEFT JOIN csfloat_contract k ON k.account_id=c.account_id AND k.listing_id=c.listing_id
      LEFT JOIN item i ON i.local_id=k.local_id AND i.account_id=c.account_id
      LEFT JOIN observation f ON f.id=c.first_seen_obs
      LEFT JOIN observation o ON o.id=c.last_seen_obs
      WHERE ${where}`,
    params
  };
}

/**
 * A substring search over the venue's own name for the item.
 *
 * `%` and `_` are wildcards and `\` is the escape this query declares, so a user typing any of
 * them must get a literal. Without this, searching for `_` matches every listing, which looks
 * like the filter being ignored.
 */
function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
