import type { IconName } from './Icon.js';
import { parseMoney } from '../lib/labels.js';

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
   * has nothing to send: on Steam a reprice is a delist and a relist, and the relist costs a
   * phone confirmation, so sending one that changes nothing is not harmless.
   */
  currentListCents?: number | undefined;
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
};

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

/** The marketplace the controls for every row are on: the one chosen, else the first the rows reach. */
export function bulkVenueOf(state: WorkspaceState<StagedEntry>): Venue {
  return state.bulk.venue ?? (state.rows.some((row) => row.venues.includes('steam')) ? 'steam' : 'csfloat');
}

export function reduce<E extends StagedEntry>(state: WorkspaceState<E>, action: WorkspaceAction<E>): WorkspaceState<E> {
  switch (action.type) {
    case 'stage': {
      const fresh = action.entries.filter((entry) => !state.rows.some((row) => row.key === entry.key));
      // An emptied workspace starts its bulk controls over; one with rows keeps them.
      const bulk = state.rows.length === 0 ? BULK_EMPTY : state.bulk;
      return { rows: fresh.length === 0 ? state.rows : [...state.rows, ...fresh.map(seed)], open: true, bulk };
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
    case 'apply': {
      // An empty price field writes no price, so Apply after a strategy press routes the rows
      // without wiping what the strategy priced them at.
      const priced = parseMoney(state.bulk.price) !== null;
      const venue = bulkVenueOf(state);
      return {
        ...state,
        rows: state.rows.map((row) => (
          row.state === 'handed'
            ? row
            : {
              ...row,
              ...(priced ? { price: state.bulk.price, basis: state.bulk.basis, ownPrice: false } : {}),
              ownVenue: false,
              ...(row.venues.includes(venue) ? { venue } : {})
            }
        ))
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

/** Cents as a money field holds them: no currency mark, always two places. */
export function dollars(cents: number): string {
  return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
}
