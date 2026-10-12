import type { MarketplaceStatus } from '@cslytics/engine';

/**
 * The marketplaces this desktop trades on, in the order every page shows them.
 *
 * One row per venue, and the window reads venues from here rather than spelling them out: a
 * page's venue control and the plus beside it, the order a notice names venues in, and the venue's
 * page in Settings. A new marketplace starts as a row here, and the pages that read this offer it
 * — as a filter where an account has it, as a plus where none does — with no page edited.
 *
 * `code` is the venue as the trading record names it (`ListingVenue`, `BuyOrderVenue`); `id` is the
 * venue as the window names it — its mark, its work, its page in Settings. `connection` is what
 * setting it up means for one account: Steam's is the account itself, since every account here is
 * a Steam sign-in, so every account has it; a `key` venue is set up once a key is saved for the
 * account, whatever the venue last said about that key. A rejected or throttled key is still a
 * venue the person chose, and its page in Settings is where that is put right.
 */
export const MARKETPLACES = [
  { code: 'STEAM', id: 'steam', label: 'Steam', connection: 'account' },
  { code: 'CSFLOAT', id: 'csfloat', label: 'CSFloat', connection: 'key' }
] as const satisfies ReadonlyArray<{ code: string; id: string; label: string; connection: 'account' | 'key' }>;

export type Marketplace = (typeof MARKETPLACES)[number];
/** A venue as the trading record names it. */
export type VenueCode = Marketplace['code'];
/** A venue as the window names it. */
export type VenueId = Marketplace['id'];
/** The venues an account sets up by saving a key, each of which has a status to read per account. */
export type KeyedVenueId = Extract<Marketplace, { connection: 'key' }>['id'];

const byCode = <T>(pick: (market: Marketplace, index: number) => T): Readonly<Record<VenueCode, T>> =>
  Object.fromEntries(MARKETPLACES.map((market, index) => [market.code, pick(market, index)])) as Record<VenueCode, T>;

/** A venue's name, by its code in the trading record. */
export const VENUE_LABEL = byCode((market) => market.label);
/** A venue as the rest of the window spells it — `VenueMark`, the fee schedule, the work panel — by its code. */
export const VENUE_ID = byCode((market) => market.id);
/** Where a venue sorts: the order of `MARKETPLACES`, never the alphabetical one SQL groups in. */
export const VENUE_ORDER = byCode((_, index) => index);

export const byVenue = <T extends { venue: VenueCode }>(left: T, right: T): number =>
  VENUE_ORDER[left.venue] - VENUE_ORDER[right.venue];

/** Each keyed venue's status for each account, as the window has read it; absent until read. */
export type KeyedStatuses = Readonly<Record<KeyedVenueId, Readonly<Record<string, MarketplaceStatus | undefined>>>>;

/**
 * Which venues each account has set up.
 *
 * An account is left out until every keyed venue has answered for it. Unknown is not "not set up":
 * a page that took it for that would offer a plus for a venue that turns out, a moment later, to
 * be connected.
 */
export function setUpByAccount(accountIds: readonly string[], statuses: KeyedStatuses): Record<string, ReadonlySet<VenueId>> {
  const answer: Record<string, ReadonlySet<VenueId>> = {};
  for (const accountId of accountIds) {
    const venues = new Set<VenueId>();
    let known = true;
    for (const market of MARKETPLACES) {
      if (market.connection === 'account') { venues.add(market.id); continue; }
      const status = statuses[market.id][accountId];
      if (status === undefined) { known = false; break; }
      if (status.status !== 'NOT_CONNECTED') venues.add(market.id);
    }
    if (known) answer[accountId] = venues;
  }
  return answer;
}

/** What a page's venue control offers: venues to filter by, and venues to add. */
export type VenueOffer = {
  /** The venues offered as a filter, in `MARKETPLACES` order. */
  shown: readonly Marketplace[];
  /** The venues offered as a plus, each with the account whose page in Settings it opens. */
  addable: ReadonlyArray<{ market: Marketplace; accountId: string }>;
};

/**
 * Which venues a page with these accounts in view offers, and which it offers to add.
 *
 * A venue is shown when any account in view has it set up, and also when the page's book holds
 * rows there: a key forgotten after a walk leaves what that walk read, and a filter that could not
 * select rows on the screen would hide them behind *All venues*. A venue no account in view has set
 * up, and with nothing in the book, is offered as a plus instead — once every account's status is
 * known, so the control does not offer one and then take it back. The plus opens the first account
 * in view, which on a single account is that account, and on several is the first of them, since
 * none has it.
 */
export function venueOffer({ accountIds, setUp, counts }: {
  accountIds: readonly string[];
  setUp: Readonly<Record<string, ReadonlySet<VenueId>>>;
  /** What the page's book holds at each venue. */
  counts: ReadonlyMap<VenueCode, number>;
}): VenueOffer {
  const known = accountIds.length > 0 && accountIds.every((accountId) => setUp[accountId] !== undefined);
  const shown: Marketplace[] = [];
  const addable: Array<{ market: Marketplace; accountId: string }> = [];
  for (const market of MARKETPLACES) {
    const held = (counts.get(market.code) ?? 0) > 0;
    if (market.connection === 'account' || held || accountIds.some((accountId) => setUp[accountId]?.has(market.id))) shown.push(market);
    else if (known) addable.push({ market, accountId: accountIds[0]! });
  }
  return { shown, addable };
}
