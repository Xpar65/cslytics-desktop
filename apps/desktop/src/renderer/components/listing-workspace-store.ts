import { quoteFromBuyer, quoteFromReceive, type FeeTerms } from '@cslytics/ports';
import type { IconName } from './Icon.js';
import type { NamedAccessory } from '../../shared/accessories.js';
import { formatCountdown, parseMoney } from '../lib/labels.js';

/**
 * The listing workspace's state and every change to it, as a pure reducer.
 *
 * The workspace used to keep three copies of one thing in step by effects: the owner's list of
 * entries, the component's own rows with the prices typed into them, and a folded-or-open flag —
 * steered from outside by a `reveal` counter and a remount key, with a callback back for every
 * row that left. One copy of a dropped row that the owner was not told about came back on the
 * next staging. This is the one copy. The shell holds it (`useListingWorkspace`), the component
 * renders it, and its unit test walks the sequences
 * that used to need an effect to get right.
 */

export type Venue = 'steam' | 'csfloat';

/** Which of the two money fields a figure was typed into. The other follows from the venue's fees. */
export type PriceBasis = 'receive' | 'buyer';

/** A step a row implies, as a chip: a word or two on screen, the sentence in its tip. */
export type RowCaption = { icon: IconName; short: string; text: string };

/**
 * One thing the workspace prices: an item about to be listed, or a standing listing about to be
 * repriced. It carries what a row prints and nothing about how it is sent — that is the intent's.
 */
export type StagedEntry = {
  /** Stable for as long as the thing is staged. Staging the same key twice is one row. */
  key: string;
  accountId: string;
  name: string;
  /** The Steam market name its order book is read under; `null` when the catalogue has none. */
  marketHashName?: string | null | undefined;
  imageUrl: string | null;
  paintWear: number | null;
  /** What is applied to it — stickers, patches, a charm — drawn small beside the float, as on its tile. */
  accessories?: readonly NamedAccessory[] | undefined;
  /** The handle a tile's busy state keys on, so the item reads as busy while its send is out. */
  localId?: string | null | undefined;
  /** Where it is, or what it is listed at: the fact the price is being decided against. */
  place: { icon: IconName; label: string };
  /** A step that sending implies before the listing itself, said before it is sent. */
  caption?: RowCaption | undefined;
  /**
   * The same, for one marketplace, when it differs there. Staged before the marketplace is chosen,
   * so the row prints the one for whichever is selected now.
   */
  venueCaption?: Partial<Record<Venue, RowCaption>> | undefined;
  /** The venues this entry can go to, the default first. One venue is a fixed venue. */
  venues: readonly Venue[];
  /**
   * Venues shown in the marketplace control but not choosable, each with why, worded to follow the
   * venue's name: "does not support this item". A venue in neither list is not shown at all.
   */
  unavailable?: Partial<Record<Venue, string>> | undefined;
  /** The figure the row opens with. Absent, it opens with the workspace's own. */
  seed?: { price: string; basis: PriceBasis } | undefined;
  /**
   * What it is listed at now, in the figure its venue's call takes. A row still at this figure
   * has nothing to send: it would ask the venue to change a price to the one it already has.
   */
  currentListCents?: number | undefined;
  /**
   * When its venue will take this row's send, in milliseconds since the epoch, when that is not
   * yet: a Steam listing inside its price-change cooldown. The row can still be sent. The engine
   * holds it until then, and the row says so with a countdown (`sendsInLabel`) whose tip is `why`,
   * while its press would send a price (`heldSendOf`). Read when the row is staged, and read again
   * when it is staged again.
   */
  heldUntil?: { at: number; why: string } | undefined;
};

/** A row with a price its venue would take, as an intent is handed it. */
export type PricedEntry<E extends StagedEntry> = { entry: E; venue: Venue; cents: number };

/**
 * What the workspace is being used to do.
 *
 * Listing and repricing are the same work — a figure per row, read through a venue's fees, sent
 * and then waited on — and differ only in words and in the call at the end. So the dock is one
 * component and this is the difference. Listing's is `list-intent.ts`; repricing's is
 * `listing-actions.ts`.
 */
export type WorkspaceIntent<E extends StagedEntry> = {
  /** "List", "Reprice": the button on a row, and the start of the footer's. */
  verb: string;
  /** What a row is: "item", "listing". */
  noun: string;
  /** The pill's and the header's mark, so two workspaces side by side in the strip read apart. */
  icon: IconName;
  /** What a venue turned down, for the notice that carries its words: "the listing". */
  refused: string;
  /**
   * The sends these rows need, one per thing a venue accepts or refuses as a whole. A send that
   * throws marks exactly its own rows refused, with the engine's words. `kind` is the work it
   * becomes, as the work panel names it (`DESTINATION`), so the panel can say what it is before
   * the engine has it.
   */
  batches: (rows: ReadonlyArray<PricedEntry<E>>) => Array<{ venue: Venue; kind: string; keys: readonly string[]; send: () => Promise<unknown> }>;
};

/** `handed`: in the window's outbox. Off screen, and back as `refused` if the engine turns it down. */
export type RowState = 'ready' | 'handed' | 'refused';

export type StagedRow<E extends StagedEntry> = {
  key: string;
  entry: E;
  /** The venues this row's own verdict allows. Never widened by a bulk control. */
  venues: readonly Venue[];
  venue: Venue;
  /** The figure as typed, into the field `basis` names. */
  price: string;
  basis: PriceBasis;
  /** This row's price was typed here, so a change to the price for every row leaves it alone. */
  ownPrice: boolean;
  /** Likewise for its marketplace. */
  ownVenue: boolean;
  /**
   * The listing strategy chosen on this row (`ListingStrategyOption`): an id, `null` for none (it is
   * listed at the price typed, and nothing reprices it after), or unset while it follows what the
   * row is under now. A desktop that offers no listing strategies never sets it.
   */
  listingStrategy?: string | null | undefined;
  /** Likewise for its listing strategy. */
  ownListingStrategy?: boolean | undefined;
  state: RowState;
  /** The engine's words, verbatim, when it refused this row's batch. */
  detail?: string | undefined;
};

/** The ways *Price all rows* prices every row from the market, each a press. */
export type StrategyId = 'instant' | 'bid' | 'undercut' | 'float';

/** What the last strategy press did, for the line under the strip and the folded summary. */
export type Applied = { id: StrategyId; priced: number; total: number; skipped: ReadonlyArray<readonly [string, number]> };

/**
 * The controls for every row. `venue` is `null` until chosen, and reads as the first venue the
 * rows can reach, so a workspace of CSFloat-only rows does not open on Steam's fees.
 */
export type BulkState = {
  price: string;
  basis: PriceBasis;
  venue: Venue | null;
  /** Folded until asked for: most stagings are priced a row at a time. */
  open: boolean;
  /** What the last press under Price all rows did; a typed price for every row takes its place. */
  applied: Applied | null;
  /**
   * The listing strategy for every row, with the venues it lists on (`null`: any, as none does).
   * Unset, each row keeps its own; `id: null` is none.
   */
  listingStrategy?: BulkListingStrategy | undefined;
};

export type BulkListingStrategy = { id: string | null; venues: readonly Venue[] | null };

export type WorkspaceState<E extends StagedEntry> = {
  rows: readonly StagedRow<E>[];
  /** The panel is on screen, under its pill. Folded, the pill alone reports the staging. */
  open: boolean;
  bulk: BulkState;
};

export type WorkspaceAction<E extends StagedEntry> =
  /** Entries join the rows already here, which keep what was typed; one already here only opens it. */
  | { type: 'stage'; entries: readonly E[] }
  /** Taken off by hand. It stays selected, so the next staging brings it back. */
  | { type: 'drop'; key: string }
  /** Handed to the outbox: off screen until the engine answers. */
  | { type: 'hand'; keys: readonly string[] }
  /** The engine took the batch: its rows are gone for good. */
  | { type: 'accept'; keys: readonly string[] }
  /** The engine refused the batch: its rows come back with its words, and the panel opens on them. */
  | { type: 'refuse'; keys: readonly string[]; reason: string }
  | { type: 'price'; key: string; price: string; basis: PriceBasis }
  | { type: 'venue'; key: string; venue: Venue }
  /** The price for every row: written where no row has spoken for itself. */
  | { type: 'spread'; price: string; basis: PriceBasis }
  /** The marketplace for every row: likewise, and only where the row can reach it. */
  | { type: 'route'; venue: Venue }
  /** One row's listing strategy: an id, `null` for none, or `undefined` to follow what it is under now. */
  | { type: 'listingStrategy'; key: string; strategy: string | null | undefined }
  /**
   * The listing strategy for every row: written where no row has chosen its own, and only on rows
   * whose venue it lists on. `undefined` puts those rows back on what they are under now.
   */
  | { type: 'listingStrategyAll'; strategy: BulkListingStrategy | undefined }
  /** Apply to all: every ready row takes the bulk venue, and the bulk price when there is one. */
  | { type: 'apply' }
  /** A strategy's figures, as what the buyer pays, into every row it priced. */
  | { type: 'priced'; applied: Applied; cents: ReadonlyMap<string, number> }
  | { type: 'bulkOpen'; open: boolean }
  | { type: 'fold' }
  | { type: 'reveal' }
  /** Closing is the destructive gesture: nothing staged survives it. */
  | { type: 'close' };

const BULK_EMPTY: BulkState = { price: '', basis: 'receive', venue: null, open: false, applied: null };

export const EMPTY: WorkspaceState<never> = { rows: [], open: false, bulk: BULK_EMPTY };

/** A row as an entry seeds it: at the entry's own figure (a standing listing's price) or unpriced. */
export function seed<E extends StagedEntry>(entry: E): StagedRow<E> {
  return {
    key: entry.key,
    entry,
    venues: entry.venues,
    venue: entry.venues.includes('steam') ? 'steam' : entry.venues[0] ?? 'steam',
    // A default figure on every row is a listing nobody meant, one press away.
    price: entry.seed?.price ?? '',
    basis: entry.seed?.basis ?? 'receive',
    ownPrice: false,
    ownVenue: false,
    state: 'ready'
  };
}

/**
 * A staged row given its entry as it is now. What was typed, chosen and answered on the row is the
 * person's and stays; the venues it may go to are the entry's verdict and follow it, and a row whose
 * marketplace the entry no longer allows goes back to the one it would have opened on.
 */
function restage<E extends StagedEntry>(row: StagedRow<E>, entry: E): StagedRow<E> {
  const venues = entry.venues;
  return venues.includes(row.venue) ? { ...row, entry, venues } : { ...row, entry, venues, venue: seed(entry).venue, ownVenue: false };
}

/** The marketplace the controls for every row are on: the one chosen, else the first the rows reach. */
export function bulkVenueOf(state: WorkspaceState<StagedEntry>): Venue {
  return state.bulk.venue ?? (state.rows.some((row) => row.venues.includes('steam')) ? 'steam' : 'csfloat');
}

export function reduce<E extends StagedEntry>(state: WorkspaceState<E>, action: WorkspaceAction<E>): WorkspaceState<E> {
  switch (action.type) {
    case 'stage': {
      const fresh = action.entries.filter((entry) => !state.rows.some((row) => row.key === entry.key));
      // A row staged again keeps everything typed or chosen on it and takes the entry as it is now:
      // what it describes moves meanwhile (a listing's cooldown is a time read when it was staged).
      const again = new Map(action.entries.map((entry) => [entry.key, entry]));
      const rows = state.rows.some((row) => row.state !== 'handed' && again.has(row.key))
        ? state.rows.map((row) => (row.state === 'handed' || !again.has(row.key) ? row : restage(row, again.get(row.key)!)))
        : state.rows;
      // An emptied workspace starts its bulk controls over; one with rows keeps them.
      const bulk = state.rows.length === 0 ? BULK_EMPTY : state.bulk;
      return { rows: fresh.length === 0 ? rows : [...rows, ...fresh.map(seed)], open: true, bulk };
    }
    case 'drop':
      return { ...state, rows: state.rows.filter((row) => row.key !== action.key) };
    case 'hand':
      return { ...state, rows: state.rows.map((row) => (action.keys.includes(row.key) ? { ...row, state: 'handed', detail: undefined } : row)) };
    case 'accept':
      return { ...state, rows: state.rows.filter((row) => !action.keys.includes(row.key)) };
    case 'refuse':
      return {
        ...state,
        open: true,
        rows: state.rows.map((row) => (action.keys.includes(row.key) ? { ...row, state: 'refused', detail: action.reason } : row))
      };
    case 'price':
      return { ...state, rows: state.rows.map((row) => (row.key === action.key ? { ...row, price: action.price, basis: action.basis, ownPrice: true } : row)) };
    case 'venue':
      return { ...state, rows: state.rows.map((row) => (row.key === action.key ? { ...row, venue: action.venue, ownVenue: true } : row)) };
    case 'spread':
      // The figure and which field it was typed into, not a converted amount: each row works the
      // other figure out through its own venue's fees.
      return {
        ...state,
        bulk: { ...state.bulk, price: action.price, basis: action.basis, applied: null },
        rows: state.rows.map((row) => (row.ownPrice || row.state === 'handed' ? row : { ...row, price: action.price, basis: action.basis }))
      };
    case 'route':
      return {
        ...state,
        bulk: { ...state.bulk, venue: action.venue },
        rows: state.rows.map((row) => (row.ownVenue || row.state === 'handed' || !row.venues.includes(action.venue) ? row : { ...row, venue: action.venue }))
      };
    case 'listingStrategy':
      return { ...state, rows: state.rows.map((row) => (row.key === action.key ? { ...row, listingStrategy: action.strategy, ownListingStrategy: action.strategy !== undefined } : row)) };
    case 'listingStrategyAll': {
      const chosen = action.strategy;
      return {
        ...state,
        bulk: { ...state.bulk, listingStrategy: chosen },
        rows: state.rows.map((row) => {
          if (row.ownListingStrategy || row.state === 'handed') return row;
          if (chosen === undefined) return { ...row, listingStrategy: undefined };
          return listsOn(chosen, row.venue) ? { ...row, listingStrategy: chosen.id } : row;
        })
      };
    }
    case 'apply': {
      // An empty price field writes no price, so Apply after a strategy press routes the rows
      // without wiping what the strategy priced them at.
      const priced = parseMoney(state.bulk.price) !== null;
      const venue = bulkVenueOf(state);
      const strategy = state.bulk.listingStrategy;
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (row.state === 'handed') return row;
          const routed = row.venues.includes(venue) ? venue : row.venue;
          return {
            ...row,
            ...(priced ? { price: state.bulk.price, basis: state.bulk.basis, ownPrice: false } : {}),
            ownVenue: false,
            venue: routed,
            ...(strategy !== undefined && listsOn(strategy, routed) ? { listingStrategy: strategy.id, ownListingStrategy: false } : {})
          };
        })
      };
    }
    case 'priced':
      // Every row priced takes its figure as a bulk price would, so a price typed for every row
      // afterwards still writes over it. The bulk field no longer describes the rows, and clears.
      return {
        ...state,
        bulk: { ...state.bulk, price: '', applied: action.applied },
        rows: state.rows.map((row) => {
          const cents = action.cents.get(row.key);
          return cents !== undefined && row.state !== 'handed' ? { ...row, price: dollars(cents), basis: 'buyer', ownPrice: false } : row;
        })
      };
    case 'bulkOpen':
      return { ...state, bulk: { ...state.bulk, open: action.open } };
    case 'fold':
      return state.open ? { ...state, open: false } : state;
    case 'reveal':
      return state.open ? state : { ...state, open: true };
    case 'close':
      return { rows: [], open: false, bulk: BULK_EMPTY };
  }
}

function listsOn(strategy: BulkListingStrategy, venue: Venue): boolean {
  return strategy.venues === null || strategy.venues.includes(venue);
}

/**
 * A listing strategy a build offers in the workspace (`lib/extensions.ts`): something a row is
 * handed to instead of being listed by hand, which then lists it and keeps it listed. The desktop
 * offers none, and its rows are always listed at the price typed.
 */
export type ListingStrategyOption = {
  id: string;
  label: string;
  /** The sentence in its tip: what it lists at, and when it changes the price. */
  title: string;
  /** The marketplaces it lists on. */
  venues: readonly Venue[];
  /** It lists at the price typed on the row and keeps it there. Otherwise it prices the row itself. */
  takesPrice: boolean;
};

/**
 * What a row is under before anything is chosen here.
 *
 * `assigned` is a strategy the row was handed to, which choosing none lets go of. Otherwise it is
 * the default of whatever holds the row: another choice overrides it and nothing has to let it go.
 * `fallback` is that default for an assigned row, which it goes back to when its strategy lets go.
 */
export type CurrentListingStrategy = {
  id: string;
  label: string;
  title: string;
  assigned: boolean;
  /** The marketplace it lists the row on, when it names one. */
  venue: Venue | null;
  /** The buyer price it keeps the row at, for a strategy that takes a typed price. */
  buyerCents: number | null;
  fallback: { id: string; label: string; title: string } | null;
};

/** What one row's press sends, decided from its strategy, its price and what it is under now. */
export type RowPlan =
  /** The typed price, by the intent's own call. `release` first lets the row go from the strategy it was handed to. */
  | { kind: 'price'; release: boolean }
  /** Only lets the row go from its strategy: to none, at the price it is already listed at, or back to its fallback. */
  | { kind: 'release'; to: 'none' | 'fallback' }
  /** Hands the row to a strategy, which lists it from then on. */
  | { kind: 'assign'; strategy: string }
  /** Nothing to send, and why: the line the row says it in. */
  | { kind: 'unchanged'; why: string }
  | { kind: 'unpriced' }
  /** The choice cannot be sent from this row, and why. */
  | { kind: 'blocked'; why: string };

const VENUE_NAME: Readonly<Record<Venue, string>> = { steam: 'Steam', csfloat: 'CSFloat' };

/** The work panel's name (`DESTINATION`) for a hand-over to a listing strategy, and for one letting a row go. */
export const LISTING_STRATEGY_KIND = 'LISTING_STRATEGY';

/** The strategy a row is on: the one chosen on it, else what it is under now, else none. */
export function rowListingStrategy(chosen: string | null | undefined, current: CurrentListingStrategy | null | undefined): string | null {
  return chosen !== undefined ? chosen : current?.id ?? null;
}

/**
 * What a row's press sends.
 *
 * With no listing strategy it is what it always was: the typed price when it changes something,
 * else nothing. A row handed to a strategy that goes to none is let go first, so the strategy does
 * not reprice what a person just priced; one already at the price it is listed at is only let go.
 * A row put under a strategy is handed to it, and the price is that strategy's to set, unless it
 * takes the typed one. Choosing what the row is already under sends nothing.
 */
export function planRow(input: {
  /** The row's own choice (`StagedRow.listingStrategy`). */
  chosen: string | null | undefined;
  current: CurrentListingStrategy | null;
  options: readonly ListingStrategyOption[];
  venue: Venue;
  /** The typed figure is a price this venue would take. */
  priced: boolean;
  /** Sending it would change something: it is not what the row is already listed at. */
  changed: boolean;
  /** What the buyer pays at the typed figure, when it is a price. */
  buyerCents: number | null;
}): RowPlan {
  const { current, venue } = input;
  const id = rowListingStrategy(input.chosen, current);
  if (id === null) {
    const release = current?.assigned === true;
    if (input.changed) return { kind: 'price', release };
    if (input.priced) return release ? { kind: 'release', to: 'none' } : { kind: 'unchanged', why: 'Already listed at this price.' };
    return { kind: 'unpriced' };
  }
  if (current && !current.assigned && id === current.id) return { kind: 'unchanged', why: `${current.label} lists it.` };
  if (current?.assigned && current.fallback && id === current.fallback.id) return { kind: 'release', to: 'fallback' };
  const option = input.options.find((candidate) => candidate.id === id);
  if (!option) {
    return current && id === current.id ? { kind: 'unchanged', why: `Under ${current.label}.` } : { kind: 'blocked', why: 'Not a listing strategy on offer.' };
  }
  if (!option.venues.includes(venue)) return { kind: 'blocked', why: `${option.label} does not list on ${VENUE_NAME[venue]}.` };
  if (option.takesPrice && (!input.priced || input.buyerCents === null)) return { kind: 'unpriced' };
  const same = current?.assigned === true && current.id === id && (current.venue === null || current.venue === venue)
    && (!option.takesPrice || current.buyerCents === input.buyerCents);
  return same ? { kind: 'unchanged', why: `Already under ${option.label}.` } : { kind: 'assign', strategy: id };
}

/**
 * When a row's press would be held by its venue, which is what its "Sends in" chip counts down
 * to: the entry's hold, and only while the row's plan is to send a price. A standing listing still
 * at the price it has sends nothing, and one handed to a listing strategy or let go by one sends
 * no price of its own, so neither says when "it" sends. `null` when there is nothing to count.
 */
export function heldSendOf(entry: Pick<StagedEntry, 'heldUntil'>, plan: RowPlan): StagedEntry['heldUntil'] | null {
  return plan.kind === 'price' ? entry.heldUntil ?? null : null;
}

/**
 * What a row held for its venue says while it waits: "Sends in 3:41", counted up to the second so
 * it never reads 0:00 while there is still a wait. `null` once the wait is over, when it says nothing.
 */
export function sendsInLabel(heldUntil: number, now: number): string | null {
  const leftMs = heldUntil - now;
  return leftMs > 0 ? `Sends in ${formatCountdown(leftMs)}` : null;
}

/** Cents as a money field holds them: no currency mark, always two places. */
export function dollars(cents: number): string {
  return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * What the buyer would pay for a row as typed, read through its venue's fees, or `null` when the
 * figure is not a price. A buyer price is what a listing shows, so it is the figure a row is
 * compared with on a float curve. `terms` is the row's wallet (`venueCurrency`) and the instant it
 * would list, because Steam's minimum fee is the wallet's at the time.
 */
export function buyerCentsOf(venue: Venue, price: string, basis: PriceBasis, terms: FeeTerms): number | null {
  const typed = parseMoney(price);
  if (typed === null) return null;
  return (basis === 'receive' ? quoteFromReceive(venue, typed, terms) : quoteFromBuyer(venue, typed, terms)).buyerCents;
}

/**
 * The currency a row's figures are in: USD on CSFloat everywhere, the account's wallet on Steam
 * (money and currency page §2). A typed price is in this currency and is sent as typed.
 */
export function venueCurrency(venue: Venue, wallet: number | null | undefined): number | null {
  return venue === 'csfloat' ? 1 : wallet ?? null;
}
