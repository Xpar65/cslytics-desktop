import type { EngineDatabase } from '../../db/database.js';
import { assertAccountScope, bounded } from './paging.js';

/**
 * Everything a walk has observed to be waiting on the person rather than on this app.
 *
 * This is the other half of `pageOpenWork`, and the distinction is the whole reason it exists.
 * Open work is what the *engine* is doing: it drains by itself, and the person is a spectator.
 * These rows drain only when a human opens the Steam mobile app and taps. Rule 2 means this
 * product may never hold the Guard secret that signs a confirmation, so it can never make that
 * tap — a pending confirmation is a permanent hand-off, not a transient state the next tick
 * clears. (The secret is named nowhere in shipped source, including here: `check:secrets` scans
 * comments too, and that is the point of it.)
 *
 * Reported together because the obligation is one thing, not two. A seller who has listed six
 * items and sent one trade offer owes seven taps, and being told about the listings on the
 * listings screen and the offer on the trades screen is how one of the seven is forgotten. The
 * listing is then not listed and earns nothing, silently, for as long as nobody looks.
 *
 * Three refusals, each because the alternative is a plausible lie:
 *
 *  - **It observes; it never infers.** A row is here because a walk read the listing out of
 *    `listings_to_confirm`, or read the offer at `trade_offer_state = 9`. Nothing is derived
 *    from a `sellitem` response having returned `needs_mobile_confirmation` (rule 1). That is
 *    also why confirming on the phone does not empty this list: only the next complete walk does.
 *  - **It carries its own evidence.** `coverage` names the walk each half rests on and whether
 *    it finished. A count built on an unfinished walk is a floor, and the caller is given what
 *    it needs to say so rather than a bare number that reads as a total (rule 5).
 *  - **It holds no `seen`, `dismissed` or `notified`.** An obligation cannot be dismissed — it
 *    is discharged by a tap, and the walk after that tap removes the row. So there is no UI
 *    state to keep anywhere, in this database or beside it, and this read stays a read.
 *
 * Identity keys travel; names do not. `hashName` is the venue's own string for the item, which
 * is observed evidence, and the host attaches the catalogue name and picture on the way out
 * (SYS-05), exactly as it does for `work.open` and `listings.page`. A listing joins its item by
 * `local_id`. An offer joins the item the trades walk matched to its **first given line**
 * (`trade_line.local_id`, written only when exactly one local row carried that asset handle,
 * ITEM-05), and when it found one that item is the whole of its name. The offers walk reads
 * Steam's descriptions, so the line carries a market name too; it is passed on only for a line
 * that matched nothing, because the host names a row that carries one by that name rather than by
 * its identity, and a matched item's identity says more (its wear, its rarity). A line with neither
 * carries no identity at all rather than an invented one. `distinctItems` says whether the other lines
 * are copies of that first item or different skins, so the host never says "× 3" of three
 * different things (`TRD-EX-20`).
 */

/** Which kind of tap is owed. Two sources, one obligation; never merged into one vocabulary. */
export type WaitingKind = 'SELL_LISTING' | 'TRADE_OFFER';

export type WaitingRow = {
  accountId: string;
  kind: WaitingKind;
  /** The listing id, or the trade offer id. Identifiers never reach the screen; the host shortens. */
  id: string;
  /**
   * What the venue calls the item. A listing always has one. An offer has one only when its first
   * given line matched no item, because then Steam's description is the only name it has; a
   * matched line is named by the identity below.
   */
  hashName: string | null;
  /** The listing's item, or the item matched to the offer's first given line. Null when unmatched. */
  localId: string | null;
  /** Empty when no item is joined: the host then names nothing rather than a made-up identity. */
  matchKey: string;
  defIndex: number | null;
  paintIndex: number | null;
  quality: number | null;
  paintWear: number | null;
  paintSeed: number | null;
  /** Listings only. An offer moves items, not money, and carries no price this app was told. */
  buyerPriceCents: number | null;
  receiveCents: number | null;
  currency: number | null;
  /** Offers only: who it was sent to. */
  counterparty: string | null;
  /** How many items the tap releases: one for a listing, the given lines for an offer. */
  items: number;
  /**
   * How many different items those are, by the identity of the joined `item` row, with an
   * unmatched line counting as its own. `1` for a listing, and for an offer of three copies of
   * one skin; `3` for an offer of three different skins. What lets a host say "× 3" only when it
   * is true and "and 2 more" otherwise.
   */
  distinctItems: number;
  /**
   * When the walk that *first* saw this row finished — not when the mutation was sent.
   *
   * The distance between the two is the part worth showing: an item that has been waiting since
   * this morning is not earning, and that is the fact that makes a person go and tap.
   */
  waitingSince: string | null;
  /** Offers expire. A listing does not, which is why this is `null` for half these rows. */
  expiresAt: string | null;
  /** The walk that last saw it, and whether that walk finished (rule 5). */
  observedAt: string | null;
  observationComplete: number;
};

/** What each half of the answer rests on, per account. `observedAt: null` is "never walked". */
export type WaitingCoverageRow = {
  accountId: string;
  surface: 'steam-market' | 'steam-trade-offers';
  observedAt: string | null;
  complete: number;
};

export type WaitingPage = { kind: 'page'; rows: WaitingRow[]; coverage: WaitingCoverageRow[] };

const MARKET_SURFACE = 'steam-market';
const OFFERS_SURFACE = 'steam-trade-offers';
/**
 * A bound, like every read here. Nothing sane produces 500 simultaneous confirmations, and a
 * person who somehow has more is not helped by row 501 — they are helped by the count, which is
 * `rows.length` only because this cap is far above any real book.
 */
const WAITING_LIMIT = 500;

/** The catalogue's match key for an `item` row under `alias`; NULL when the join found no row. */
export const matchSql = (alias: string): string =>
  `${alias}.def_index || ':' || IFNULL(${alias}.paint_index,'') || ':' || ${alias}.quality || ':' || IFNULL(${alias}.kit,'')`;
const ITEM_MATCH_SQL = matchSql('i');

/**
 * Every observed obligation for a scope, oldest first.
 *
 * Oldest first because this is a to-do list and the thing that has been waiting longest is the
 * thing most likely to have been forgotten — the opposite order from `pageOpenWork`, where the
 * newest row is the one the person just caused and is watching for.
 */
export function pageWaiting(database: EngineDatabase, request: { accountIds: readonly string[] }): WaitingPage {
  const accounts = assertAccountScope(database, request.accountIds);
  const marks = accounts.map(() => '?').join(',');

  const listings = database.raw().prepare(`
    SELECT m.account_id AS accountId, 'SELL_LISTING' AS kind, m.listing_id AS id,
      m.hash_name AS hashName, m.local_id AS localId,
      IFNULL(${ITEM_MATCH_SQL}, '') AS matchKey,
      i.def_index AS defIndex, i.paint_index AS paintIndex, i.quality AS quality,
      i.paint_wear AS paintWear, i.paint_seed AS paintSeed,
      m.buyer_price_cents AS buyerPriceCents, m.price_receive_cents AS receiveCents,
      (SELECT w.currency FROM wallet_snapshot w WHERE w.account_id=m.account_id ORDER BY w.id DESC LIMIT 1) AS currency,
      NULL AS counterparty, 1 AS items, 1 AS distinctItems,
      first.finished_at AS waitingSince, NULL AS expiresAt,
      last.finished_at AS observedAt, IFNULL(last.complete, 0) AS observationComplete
    FROM market_listing m
    LEFT JOIN item i ON i.account_id=m.account_id AND i.local_id=m.local_id
    LEFT JOIN observation last ON last.id=m.last_seen_obs
    LEFT JOIN observation first ON first.id=m.first_seen_obs
    WHERE m.account_id IN (${marks}) AND m.status='PENDING_CONFIRMATION'
  `).all(...accounts) as WaitingRow[];

  /*
   * `direction='SENT'` is load-bearing. A *received* offer also waits on the person, but it waits
   * on a decision — accept, decline, ignore — and this app has no opinion about whether it should
   * be accepted. Putting it here would turn a list of "things you already decided to do, that
   * cannot finish without you" into a list that mixes in somebody else's proposal, and the two
   * need different words and a different answer. Received offers stay in Trades (TRD-05).
   */
  // `g` is the offer's first given line and `i` the item the walk matched it to. Both are LEFT
  // joins: an offer with no lines, or a line no single local row carried, is still owed — it is
  // just owed without a name, and the host says so instead of inventing one.
  const offers = database.raw().prepare(`
    SELECT t.account_id AS accountId, 'TRADE_OFFER' AS kind, t.offer_id AS id,
      CASE WHEN i.local_id IS NULL THEN g.market_hash_name END AS hashName, i.local_id AS localId,
      IFNULL(${ITEM_MATCH_SQL}, '') AS matchKey,
      i.def_index AS defIndex, i.paint_index AS paintIndex, i.quality AS quality,
      i.paint_wear AS paintWear, i.paint_seed AS paintSeed,
      NULL AS buyerPriceCents, NULL AS receiveCents, NULL AS currency,
      t.counterparty_id AS counterparty,
      (SELECT COUNT(*) FROM trade_line l
        WHERE l.account_id=t.account_id AND l.offer_id=t.offer_id AND l.side='GIVE') AS items,
      (SELECT COUNT(DISTINCT IFNULL(${matchSql('li')}, 'asset:' || l.asset_id))
        FROM trade_line l LEFT JOIN item li ON li.account_id=l.account_id AND li.local_id=l.local_id
        WHERE l.account_id=t.account_id AND l.offer_id=t.offer_id AND l.side='GIVE') AS distinctItems,
      first.finished_at AS waitingSince, t.expires_at AS expiresAt,
      last.finished_at AS observedAt, IFNULL(last.complete, 0) AS observationComplete
    FROM trade_offer t
    LEFT JOIN trade_line g ON g.account_id=t.account_id AND g.offer_id=t.offer_id AND g.side='GIVE'
      AND g.line_key=(SELECT MIN(l.line_key) FROM trade_line l
        WHERE l.account_id=t.account_id AND l.offer_id=t.offer_id AND l.side='GIVE')
    LEFT JOIN item i ON i.account_id=g.account_id AND i.local_id=g.local_id
    LEFT JOIN observation last ON last.id=t.last_seen_obs
    LEFT JOIN observation first ON first.id=t.first_seen_obs
    WHERE t.account_id IN (${marks}) AND t.direction='SENT' AND t.status='PENDING_CONFIRMATION'
  `).all(...accounts) as WaitingRow[];

  // A row whose first walk has no finished time sorts last rather than first: "unknown" is not
  // "longest waiting", and guessing the urgent end of the list is the one place it would matter.
  const rows = [...listings, ...offers]
    .sort((left, right) => order(left.waitingSince).localeCompare(order(right.waitingSince))
      || left.accountId.localeCompare(right.accountId)
      || left.id.localeCompare(right.id))
    .slice(0, WAITING_LIMIT);

  const coverage: WaitingCoverageRow[] = [];
  for (const accountId of accounts) {
    coverage.push(evidence(database, accountId, MARKET_SURFACE));
    coverage.push(evidence(database, accountId, OFFERS_SURFACE));
  }
  return bounded({ kind: 'page' as const, rows, coverage });
}

function order(at: string | null): string {
  return at ?? '￿';
}

function evidence(database: EngineDatabase, accountId: string, surface: WaitingCoverageRow['surface']): WaitingCoverageRow {
  const observation = database.latestObservation(accountId, surface);
  return {
    accountId,
    surface,
    observedAt: observation?.finished_at ?? null,
    complete: observation?.complete === 1 ? 1 : 0
  };
}
