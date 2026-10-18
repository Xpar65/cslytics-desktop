import { KIT_ATTRIBUTES_BY_ITEM, KIT_ATTRIBUTES_BY_QUALITY } from '@cslytics/ports';
import { TransferStore } from '../../db/transfers.js';
import type { EngineDatabase } from '../../db/database.js';
import { surfaceCoverage, type SurfaceCoverage } from './coverage.js';
import { assertAccountScope, bounded, queryPage, type PageEnvelope, type Param } from './paging.js';
import { matchSql } from './waiting.js';

/**
 * The trades page: every account's trades, one entry per trade, newest first.
 *
 * The rows are the offers and executed trades the two trade walks wrote (`surfaces/trades.ts`).
 * Nothing here is stored for the page: what a trade *was for* — a CSFloat purchase, a transfer this
 * app made, a swap between the person's own accounts — is joined at read time from rows other walks
 * already keep, and graded by the evidence that joined it (AGENTS.md: "before adding a table, ask
 * whether the fact is already there under another name").
 *
 * Four judgements are made here, and each refuses a plausible lie:
 *
 *  - **An accepted offer is not a past trade.** Steam accepting an offer is a receipt; the items
 *    moved only when an executed trade says `COMPLETE` (rule 1, TRD-04). Until then the entry stays
 *    under Current, and so does an own transfer whose batch has not seen both inventories agree.
 *  - **An offer leaves Current only on evidence.** A complete offers walk is a claim about the whole
 *    set, so an active-looking offer it no longer lists has ended, outcome unobserved. A walk that
 *    did not finish proves nothing about absence (rule 5).
 *  - **"Not a CSFloat purchase" needs a CSFloat read that could have seen it.** An account whose
 *    CSFloat trades were never read completely, or not since the trade began, is `other` with that
 *    reason — never `unmatched`, which is a claim this read could not back.
 *  - **An item is named by observed identity only.** A line is the holding a walk saw, the owned
 *    counterparty's holding, CSFloat's listing tuple, or Steam's market name, in that order; one with
 *    none of those has no identity at all rather than a `Def 0` (ITEM-05).
 *
 * Identity keys travel, names do not (SYS-05): the host names every row on the way out.
 */

export type TradePhase = 'current' | 'past';
export type TradeSide = 'GIVE' | 'RECEIVE';
export type TradeOriginKind = 'own-transfer' | 'own-accounts' | 'csfloat-purchase' | 'csfloat-sale' | 'csfloat-mixed' | 'other';
/**
 * Why a trade with no matched origin is `other`. Only `unmatched` says CSFloat was checked: a
 * complete read of its trades, begun after this trade began, named nothing that moved in it.
 */
export type CsfloatCheck = 'unmatched' | 'not-connected' | 'incomplete' | 'not-yet-covered';
export type TradeIdentitySource = 'holding' | 'peer-holding' | 'csfloat-listing' | 'market-name' | 'none';
/**
 * Where a trade stands, as observed. Current is the first two; Past the rest.
 *
 *  - `to-be-confirmed`: nothing has moved yet, or nothing Steam has said proves it did — an open
 *    offer, one waiting on a phone, an accepted offer whose trade the history has not shown, a
 *    pending or escrowed trade, an own transfer the inventories have not settled.
 *  - `reversal-period`: the trade happened and Steam can still reverse it. Its settlement date — the
 *    offer's `settlement_date` or the trade's `time_settlement`, seven days on — is still ahead.
 *  - `finalized`: complete, and past any settlement date Steam named.
 *  - `reversed`: Steam rolled it back, by support or within the reversal period.
 *  - `ended`: it never happened — declined, cancelled, expired, invalid, failed, or no longer listed.
 */
export type TradeStage = 'to-be-confirmed' | 'reversal-period' | 'finalized' | 'reversed' | 'ended';
/** The filter's coarse version of `TradeOriginKind`, computed in SQL so a filtered page is a full page. */
export type TradeOriginClass = 'marketplace' | 'transfers' | 'other';
export const TRADE_STAGES: readonly TradeStage[] = ['to-be-confirmed', 'reversal-period', 'finalized', 'reversed', 'ended'];
export const TRADE_ORIGIN_CLASSES: readonly TradeOriginClass[] = ['marketplace', 'transfers', 'other'];
/**
 * Which way a trade's items moved, from the account's side: `out` when it only gave, `in` when it
 * only received, `both` for a swap, `none` when no line was recorded. Read from the items, not from
 * who proposed the offer, so a trade seen only in Steam's history — which never says who sent it —
 * has one too, and a sent offer asking for items reads as what it would bring in.
 */
export type TradeFlow = 'out' | 'in' | 'both' | 'none';
/** The list's Sent and Received. A swap is both. */
export type TradeFlowFilter = 'out' | 'in';
export const TRADE_FLOWS: readonly TradeFlow[] = ['out', 'in', 'both', 'none'];

export type TradeListRequest = {
  accountIds: readonly string[];
  /** Only what is still moving, or only what has finished; every trade when absent. */
  phase?: TradePhase | undefined;
  stage?: TradeStage | undefined;
  origin?: TradeOriginClass | undefined;
  /** Trades that gave items (`out`) or brought them in (`in`). A swap matches both. */
  flow?: TradeFlowFilter | undefined;
  pageSize?: number | undefined;
  cursor?: string | undefined;
};

export type TradeSummaryRequest = { accountIds: readonly string[] };
/** How many entries each stage, origin and flow holds in a scope, for the filters' counts. */
export type TradeSummary = { counts: Array<{ phase: TradePhase; stage: TradeStage; origin: TradeOriginClass; flow: TradeFlow; count: number }> };

/** An item as a list row previews it: its side and identity keys, named by the host like the row's first item. */
export type TradePreview = Pick<TradeItemRow, 'side' | 'identitySource' | 'matchKey' | 'defIndex' | 'paintIndex' | 'quality' | 'paintWear' | 'hashName'>;

/** One trade as the list shows it. `entryKey` is `offer:<id>` or, for a trade seen only in history, `trade:<id>`. */
export type TradeListRow = {
  accountId: string;
  entryKey: string;
  offerId: string | null;
  tradeId: string | null;
  /** Null for a trade seen only in history, which says nothing about who proposed it. */
  direction: 'SENT' | 'RECEIVED' | null;
  offerStatus: string | null;
  tradeStatus: string | null;
  /** Always a SteamID64 string; the offer's 32-bit `accountid_other` is converted in SQL, never through a Number. */
  counterpartySteamId64: string | null;
  /** The owned account on the other side, when the other party is one. */
  peerAccountId: string | null;
  phase: TradePhase;
  stage: TradeStage;
  originClass: TradeOriginClass;
  flow: TradeFlow;
  /** 0 when the newest complete offers walk no longer lists this offer. */
  listed: number;
  sortAt: string;
  createdAt: string;
  /** When the offer was accepted or the trade began, once it was. */
  acceptedAt: string | null;
  /** When Steam settles the trade: for a trade-protected trade, the end of its reversal period. */
  settlesAt: string | null;
  transferState: string | null;
  giveQuantity: number;
  receiveQuantity: number;
  origin: TradeOriginKind;
  csfloatCheck: CsfloatCheck | null;
  csfloatTrades: number;
  /** CSFloat's buyer price summed over the matched trades, in USD cents; null unless every one named a price. */
  csfloatPriceCents: number | null;
  transferCommandId: string | null;
  /** The first item — a received one when there is any — by identity keys only. */
  identitySource: TradeIdentitySource | null;
  matchKey: string;
  defIndex: number | null;
  paintIndex: number | null;
  quality: number | null;
  paintWear: number | null;
  hashName: string | null;
  /**
   * A second item to show beside the first: of another kind when the trade holds one, the first thing
   * that went out for a swap, else the next line. Null for a trade of one line — a stack of one kind is
   * one line, and its quantity says how many.
   */
  second: TradePreview | null;
};

export type TradeItemRow = {
  accountId: string;
  lineKey: string;
  side: TradeSide;
  quantity: number;
  /** The asset id on the giving side, which is the only id a give line has before the trade. */
  assetId: string;
  /** The asset id the item carries after the trade, when Steam's history named it. */
  newAssetId: string | null;
  classId: string;
  instanceId: string;
  /** 1 when Steam said the item was no longer in the giver's inventory. */
  missing: number;
  identitySource: TradeIdentitySource;
  localId: string | null;
  holderAccountId: string | null;
  location: string | null;
  casketId: string | null;
  endReason: string | null;
  tradeProtectedUntil: string | null;
  tradableAfter: string | null;
  /** Empty when no identity was observed: the host then names the row by `hashName`, or not at all. */
  matchKey: string;
  defIndex: number | null;
  paintIndex: number | null;
  quality: number | null;
  paintWear: number | null;
  paintSeed: number | null;
  hashName: string | null;
  csfloatTradeId: string | null;
  csfloatPriceCents: number | null;
  /** `key:<matchKey>`, else `name:<hashName>`, else `line:<lineKey>` — what the grouped view folds by. */
  groupKey: string;
};

export type TradeItemGroup = {
  accountId: string;
  side: TradeSide;
  groupKey: string;
  /** Units, not lines: a line of twelve cases is twelve. */
  quantity: number;
  lines: number;
  minWear: number | null;
  maxWear: number | null;
  missing: number;
  identitySource: TradeIdentitySource;
  matchKey: string;
  defIndex: number | null;
  paintIndex: number | null;
  quality: number | null;
  hashName: string | null;
};

export type TradeTransferLink = {
  commandId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  state: string;
  reason: string | null;
  /** `offer-id`: the batch names this offer. `message`: not yet correlated, but the offer carries the command's message. */
  evidence: 'offer-id' | 'message';
};

export type TradeCsfloatLink = {
  tradeId: string;
  listingId: string;
  role: 'purchase' | 'sale';
  state: string;
  priceCents: number | null;
  hashName: string | null;
  floatValue: number | null;
  paintSeed: number | null;
  assetId: string;
  /**
   * `offer-id`: CSFloat's own record names this Steam offer. `own-delivery`: this app sent the offer
   * for that CSFloat sale. `asset`: the asset CSFloat sold moved in this trade, with the party CSFloat
   * names on the other side — the evidence a trade seen only in history can carry.
   */
  evidence: 'offer-id' | 'own-delivery' | 'asset';
};

export type TradeTimelineRow = { at: string; source: 'offer' | 'trade'; raw: number; status: string };

export type TradeEntry = TradeListRow & {
  /** The key this entry answers under now. A `trade:` entry that has since met its offer answers as the offer. */
  canonicalKey: string;
  message: string | null;
  rawOfferState: number | null;
  rawTradeStatus: number | null;
  confirmationMethod: number | null;
  expiresAt: string | null;
  escrowUntil: string | null;
  offerUpdatedAt: string | null;
  initiatedAt: string | null;
  tradeUpdatedAt: string | null;
  settledAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Which lines the items come from: Steam's history once it has any, the offer's otherwise. */
  lineSource: 'trade' | 'offer' | null;
  /** The latest trade protection on a received holding, when a walk has seen one. */
  tradeProtectedUntil: string | null;
  transfer: TradeTransferLink | null;
  csfloat: TradeCsfloatLink[];
  coverage: SurfaceCoverage[];
  timeline: TradeTimelineRow[];
  groups: TradeItemGroup[];
  groupsTruncated: boolean;
};

export type TradeEntryRequest = { accountId: string; entryKey: string };
export type TradeItemsRequest = {
  accountId: string;
  entryKey: string;
  side: TradeSide;
  groupKey?: string | undefined;
  pageSize?: number | undefined;
  cursor?: string | undefined;
};

export const TRADE_LIST_PAGE_SIZE = 100;
/** Groups one entry read returns per trade. A trade wider than this says so rather than truncating silently. */
export const TRADE_GROUP_LIMIT = 500;
const TIMELINE_LIMIT = 100;
const COVERAGE_SURFACES = ['steam-trade-offers', 'steam-trade-history', 'csfloat-trades'] as const;
/** Batch states after which an own transfer has nothing left to observe. */
const SETTLED_TRANSFER_STATES = "'DONE','FAILED','STOPPED'";
/**
 * Item families whose catalogue key needs a kit CSFloat's listing tuple does not carry: stickers,
 * patches, graffiti, music kits and charms by def index, and star items (StatTrak™ is attribute 81
 * at quality 3). Their CSFloat tuple names them by market name only, never by a key that would
 * resolve to the wrong entry.
 */
const KIT_ITEM_DEFS = [...KIT_ATTRIBUTES_BY_ITEM.keys()].join(',');
const KIT_QUALITIES = [...KIT_ATTRIBUTES_BY_QUALITY.keys()].join(',');

/** One row of the entry query: what a trade is, before anything is joined to describe it. */
type EntryBase = {
  accountId: string; entryKey: string; offerId: string | null; tradeId: string | null;
  direction: 'SENT' | 'RECEIVED' | null; offerStatus: string | null; tradeStatus: string | null;
  counterpartySteamId64: string | null; peerAccountId: string | null; phase: TradePhase; stage: TradeStage;
  originClass: TradeOriginClass; flow: TradeFlow; listed: number; sortAt: string; createdAt: string; acceptedAt: string | null;
  settlesAt: string | null; transferState: string | null;
};

type LineScope = { accountId: string; source: 'trade' | 'offer'; id: string; peerAccountId: string | null };

type EntryFilter = {
  phase?: TradePhase | undefined; stage?: TradeStage | undefined; origin?: TradeOriginClass | undefined; flow?: TradeFlowFilter | undefined;
  entry?: { accountId: string; entryKey: string } | undefined; collapse?: boolean | undefined;
};

/**
 * Every trade in a scope, as entries.
 *
 * An offer and the executed trade it became are one entry, joined only on `trade_offer.trade_id`:
 * the offers walk records the trade id once Steam names it and keeps it (`db/trades.ts`), while
 * `executed_trade.offer_id` is filled only when history happened to be read after that. A trade
 * that no recorded offer carries is an entry of its own.
 *
 * A trade between two owned accounts is one trade with two sides, each recorded on its own account
 * (N-TRD-07). With both in scope it is listed once, from the side that sent it — or, for a pair seen
 * only in history, the lower account id — whatever stage either side is in. The collapse is behind a
 * CASE so it costs nothing for a trade with someone else.
 *
 * The stage and the origin class are worked out here, in SQL, because the filters page on them: a
 * filter applied to a page after it was cut would hand back short pages and wrong counts. The stage
 * reads Steam's own settlement date — the offer's `settlement_date`, else the trade's
 * `time_settlement` — against `asOf`: a complete or accepted trade before it is still in its reversal
 * period, and only after it is it finalized. The origin class follows `originOf`'s precedence — a
 * transfer this app sent, then CSFloat's evidence, then an owned counterparty — on the same evidence.
 * The flow is which sides have lines, in either line set: an offer and the trade it became move the
 * same items, so the existence of a side does not depend on which set `lineScope` would choose.
 */
function entriesSql(accounts: readonly string[], asOf: string, where: EntryFilter): { sql: string; params: Param[] } {
  const marks = accounts.map(() => '?').join(',');
  const params: Param[] = [...accounts, ...accounts, asOf];
  const conditions: string[] = [];
  if (where.phase) { conditions.push('phase=?'); params.push(where.phase); }
  if (where.stage) { conditions.push('stage=?'); params.push(where.stage); }
  if (where.origin) { conditions.push('originClass=?'); params.push(where.origin); }
  if (where.flow) { conditions.push("flow IN (?, 'both')"); params.push(where.flow); }
  if (where.entry) { conditions.push('accountId=? AND entryKey=?'); params.push(where.entry.accountId, where.entry.entryKey); }
  if (where.collapse) {
    conditions.push(`(CASE WHEN peerAccountId IS NULL OR peerAccountId NOT IN (${marks}) THEN 1
      WHEN EXISTS (SELECT 1 FROM z other WHERE other.accountId=z.peerAccountId
        AND ((z.offerId IS NOT NULL AND other.offerId=z.offerId) OR (z.tradeId IS NOT NULL AND other.tradeId=z.tradeId))
        AND (other.canon<z.canon OR (other.canon=z.canon AND other.accountId<z.accountId))) THEN 0 ELSE 1 END)=1`);
    params.push(...accounts);
  }
  const sql = `WITH walk AS (
      SELECT a.id AS account_id,
        (SELECT MAX(w.id) FROM observation w WHERE w.account_id=a.id AND w.surface='steam-trade-offers'
          AND w.complete=1 AND w.error IS NULL) AS obs
      FROM account a WHERE a.id IN (${marks})
    ),
    e AS (
      SELECT o.account_id AS accountId, 'offer:' || o.offer_id AS entryKey, o.offer_id AS offerId,
        COALESCE(o.trade_id, t.trade_id) AS tradeId, o.direction AS direction, o.status AS offerStatus, t.status AS tradeStatus,
        COALESCE(t.counterparty_steam_id64, o.counterparty_steam_id64) AS counterpartySteamId64,
        CASE WHEN w.obs IS NOT NULL AND o.last_seen_obs < w.obs THEN 0 ELSE 1 END AS listed,
        MAX(o.updated_at, IFNULL(t.initiated_at, ''), IFNULL(t.updated_at, '')) AS sortAt,
        o.created_at AS createdAt,
        COALESCE(t.initiated_at, CASE WHEN o.status='ACCEPTED' THEN o.updated_at END) AS acceptedAt,
        COALESCE(o.settlement_date, t.settled_at) AS settlesAt,
        o.message AS message
      FROM trade_offer o JOIN walk w ON w.account_id=o.account_id
      LEFT JOIN executed_trade t ON t.account_id=o.account_id AND t.trade_id=o.trade_id
      UNION ALL
      SELECT t.account_id, 'trade:' || t.trade_id, NULL, t.trade_id, NULL, NULL, t.status, t.counterparty_steam_id64, 1,
        MAX(t.initiated_at, IFNULL(t.updated_at, '')), t.initiated_at, t.initiated_at, t.settled_at, NULL
      FROM executed_trade t
      WHERE t.account_id IN (${marks})
        AND NOT EXISTS (SELECT 1 FROM trade_offer o WHERE o.account_id=t.account_id AND o.trade_id=t.trade_id)
    ),
    x AS (
      SELECT e.*, p.id AS peerAccountId,
        CASE WHEN e.offerId IS NULL THEN NULL ELSE COALESCE(
          (SELECT s.state FROM work_step s WHERE s.account_id=e.accountId AND s.kind='SEND' AND s.offer_id=e.offerId),
          (SELECT s.state FROM work_step s JOIN transfer_detail d ON d.step_id=s.id WHERE d.destination_account_id=e.accountId AND s.offer_id=e.offerId LIMIT 1)) END AS transferState,
        CASE WHEN e.offerId IS NOT NULL AND (
            EXISTS (SELECT 1 FROM work_step s JOIN transfer_detail d ON d.step_id=s.id WHERE s.offer_id=e.offerId AND e.accountId IN (s.account_id, d.destination_account_id))
            OR (e.message LIKE 'CSlytics transfer %' AND EXISTS (SELECT 1 FROM work_step s JOIN transfer_detail d ON d.step_id=s.id WHERE s.command_id=substr(e.message, 19)
              AND s.offer_id IS NULL AND e.accountId IN (s.account_id, d.destination_account_id)))) THEN 1 ELSE 0 END AS transferBatch,
        CASE WHEN (e.offerId IS NOT NULL AND (
            EXISTS (SELECT 1 FROM csfloat_trade c WHERE c.account_id=e.accountId AND c.offer_id=e.offerId)
            OR EXISTS (SELECT 1 FROM work_step s JOIN csfloat_trade c ON c.account_id=s.account_id AND c.trade_id=s.target_id
              WHERE s.account_id=e.accountId AND s.kind='CSFLOAT_SEND' AND s.offer_id=e.offerId)))
          OR (e.counterpartySteamId64 IS NOT NULL AND EXISTS (
            SELECT 1 FROM trade_line l JOIN csfloat_trade c ON c.account_id=l.account_id AND c.asset_id=l.asset_id
              JOIN account a ON a.id=l.account_id
            WHERE l.account_id=e.accountId
              AND ((e.tradeId IS NOT NULL AND l.trade_id=e.tradeId) OR (e.offerId IS NOT NULL AND l.offer_id=e.offerId AND l.trade_id IS NULL))
              AND ((c.seller_steam_id=a.steam_id64 AND l.side='GIVE' AND json_extract(c.data_json,'$.buyerSteamId')=e.counterpartySteamId64)
                OR (c.seller_steam_id<>a.steam_id64 AND l.side='RECEIVE' AND c.seller_steam_id=e.counterpartySteamId64))))
          THEN 1 ELSE 0 END AS marketplace,
        CASE WHEN e.direction='SENT' THEN 0 WHEN e.offerId IS NOT NULL THEN 1 ELSE 2 END AS canon,
        CASE WHEN (e.tradeId IS NOT NULL AND EXISTS (SELECT 1 FROM trade_line l WHERE l.account_id=e.accountId AND l.trade_id=e.tradeId AND l.side='GIVE'))
          OR (e.offerId IS NOT NULL AND EXISTS (SELECT 1 FROM trade_line l WHERE l.account_id=e.accountId AND l.offer_id=e.offerId AND l.side='GIVE' AND l.trade_id IS NULL))
          THEN 1 ELSE 0 END AS gives,
        CASE WHEN (e.tradeId IS NOT NULL AND EXISTS (SELECT 1 FROM trade_line l WHERE l.account_id=e.accountId AND l.trade_id=e.tradeId AND l.side='RECEIVE'))
          OR (e.offerId IS NOT NULL AND EXISTS (SELECT 1 FROM trade_line l WHERE l.account_id=e.accountId AND l.offer_id=e.offerId AND l.side='RECEIVE' AND l.trade_id IS NULL))
          THEN 1 ELSE 0 END AS receives
      FROM e LEFT JOIN account p ON p.steam_id64=e.counterpartySteamId64 AND p.id<>e.accountId
    ),
    y AS (
      SELECT x.*,
        CASE WHEN transferBatch=1 THEN 'transfers' WHEN marketplace=1 THEN 'marketplace'
          WHEN peerAccountId IS NOT NULL THEN 'transfers' ELSE 'other' END AS originClass,
          CASE WHEN gives=1 AND receives=1 THEN 'both' WHEN gives=1 THEN 'out' WHEN receives=1 THEN 'in' ELSE 'none' END AS flow,
        CASE
          WHEN tradeStatus IN ('ROLLED_BACK','REVERSED') THEN 'reversed'
          WHEN (tradeStatus='COMPLETE' OR offerStatus='ACCEPTED') AND settlesAt IS NOT NULL AND settlesAt > ? THEN 'reversal-period'
          WHEN transferState IS NOT NULL AND transferState NOT IN (${SETTLED_TRANSFER_STATES}) THEN 'to-be-confirmed'
          WHEN tradeStatus='COMPLETE' THEN 'finalized'
          WHEN tradeStatus='FAILED' THEN 'ended'
          WHEN tradeStatus IS NOT NULL THEN 'to-be-confirmed'
          WHEN offerStatus='ACCEPTED' THEN 'to-be-confirmed'
          WHEN offerStatus IN ('ACTIVE','PENDING_CONFIRMATION','ESCROW','UNKNOWN') AND listed=1 THEN 'to-be-confirmed'
          ELSE 'ended' END AS stage
      FROM x
    ),
    z AS (
      SELECT y.*, CASE WHEN stage IN ('to-be-confirmed','reversal-period') THEN 'current' ELSE 'past' END AS phase FROM y
    )
    SELECT accountId, entryKey, offerId, tradeId, direction, offerStatus, tradeStatus, counterpartySteamId64, peerAccountId,
      phase, stage, originClass, flow, listed, sortAt, createdAt, acceptedAt, settlesAt, transferState
    FROM z${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`;
  return { sql, params };
}

/** Steam's history lines once it has any for this trade; the offer's lines otherwise. Never both. */
function lineScope(database: EngineDatabase, base: Pick<EntryBase, 'accountId' | 'offerId' | 'tradeId' | 'peerAccountId'>): LineScope | null {
  if (base.tradeId) {
    const recorded = database.raw().prepare('SELECT 1 AS found FROM trade_line WHERE account_id=? AND trade_id=? LIMIT 1').get(base.accountId, base.tradeId);
    if (recorded) return { accountId: base.accountId, source: 'trade', id: base.tradeId, peerAccountId: base.peerAccountId };
  }
  if (base.offerId) return { accountId: base.accountId, source: 'offer', id: base.offerId, peerAccountId: base.peerAccountId };
  if (base.tradeId) return { accountId: base.accountId, source: 'trade', id: base.tradeId, peerAccountId: base.peerAccountId };
  return null;
}

function lineWhere(scope: LineScope, alias = 'l'): { sql: string; params: Param[] } {
  return scope.source === 'trade'
    ? { sql: `${alias}.account_id=? AND ${alias}.trade_id=?`, params: [scope.accountId, scope.id] }
    : { sql: `${alias}.account_id=? AND ${alias}.offer_id=? AND ${alias}.trade_id IS NULL`, params: [scope.accountId, scope.id] };
}

/**
 * One trade's lines with the identity each resolves to.
 *
 * A give line's holding is the row that carried its asset id — kept on a `MISSING` row after the
 * item left, so a past trade still names what went. A receive line's is the row carrying its new
 * asset id, which Steam's history names. For an owned counterparty the same two lookups run on its
 * account, the other way round. Then CSFloat's listing tuple, for the asset a CSFloat trade on this
 * account sold; then the market name Steam or CSFloat gave the line. Nothing else names an item.
 */
function resolvedLinesSql(scope: LineScope): { sql: string; params: Param[] } {
  const cf = (path: string): string => `json_extract(c.data_json,'$.${path}')`;
  const lines = lineWhere(scope);
  const peer = scope.peerAccountId
    ? `(SELECT p.local_id FROM item p WHERE p.account_id=? AND p.asset_id = CASE l.side WHEN 'RECEIVE' THEN l.asset_id ELSE l.new_asset_id END)`
    : 'NULL';
  const sql = `SELECT *, CASE WHEN matchKey<>'' THEN 'key:' || matchKey WHEN hashName IS NOT NULL THEN 'name:' || hashName ELSE 'line:' || lineKey END AS groupKey
    FROM (
      SELECT accountId, lineKey, side, assetId, newAssetId, classId, instanceId, quantity, missing,
        CASE WHEN hLocal IS NOT NULL THEN (CASE WHEN ownId IS NOT NULL THEN 'holding' ELSE 'peer-holding' END)
             WHEN cfUsable=1 THEN 'csfloat-listing'
             WHEN hashName IS NOT NULL THEN 'market-name'
             ELSE 'none' END AS identitySource,
        hLocal AS localId, holderAccountId, location, casketId, endReason, tradeProtectedUntil, tradableAfter,
        COALESCE(hMatch, CASE WHEN cfUsable=1 THEN cfDef || ':' || cfPaint || ':' || cfQuality || ':' END, '') AS matchKey,
        CASE WHEN hLocal IS NOT NULL THEN hDef WHEN cfUsable=1 THEN cfDef END AS defIndex,
        CASE WHEN hLocal IS NOT NULL THEN hPaint WHEN cfUsable=1 THEN cfPaint END AS paintIndex,
        CASE WHEN hLocal IS NOT NULL THEN hQuality WHEN cfUsable=1 THEN cfQuality END AS quality,
        COALESCE(hWear, cfFloat) AS paintWear, COALESCE(hSeed, cfSeed) AS paintSeed,
        hashName, csfloatTradeId, csfloatPriceCents
      FROM (
        SELECT q.*,
          h.local_id AS hLocal, h.account_id AS holderAccountId, h.location AS location, h.casket_id AS casketId,
          h.end_reason AS endReason, h.trade_protected_until AS tradeProtectedUntil, h.tradable_after AS tradableAfter,
          h.def_index AS hDef, h.paint_index AS hPaint, h.quality AS hQuality, h.paint_wear AS hWear, h.paint_seed AS hSeed,
          CASE WHEN h.local_id IS NULL THEN NULL ELSE ${matchSql('h')} END AS hMatch,
          c.trade_id AS csfloatTradeId, ${cf('listing.priceCents')} AS csfloatPriceCents,
          ${cf('listing.item.defIndex')} AS cfDef, ${cf('listing.item.paintIndex')} AS cfPaint, ${cf('listing.item.quality')} AS cfQuality,
          ${cf('listing.item.floatValue')} AS cfFloat, ${cf('listing.item.paintSeed')} AS cfSeed,
          CASE WHEN ${cf('listing.item.defIndex')} IS NOT NULL AND ${cf('listing.item.paintIndex')} IS NOT NULL
            AND ${cf('listing.item.quality')} IS NOT NULL AND ${cf('listing.item.quality')} NOT IN (${KIT_QUALITIES})
            AND ${cf('listing.item.defIndex')} NOT IN (${KIT_ITEM_DEFS}) THEN 1 ELSE 0 END AS cfUsable,
          COALESCE(q.lineHashName, ${cf('listing.item.marketHashName')}) AS hashName
        FROM (
          SELECT l.account_id AS accountId, l.line_key AS lineKey, l.side AS side, l.asset_id AS assetId, l.new_asset_id AS newAssetId,
            l.class_id AS classId, l.instance_id AS instanceId, l.quantity AS quantity, l.market_hash_name AS lineHashName,
            CASE WHEN json_extract(l.attributes_json,'$.missing') THEN 1 ELSE 0 END AS missing,
            COALESCE(
              (SELECT i.local_id FROM item i WHERE i.local_id=l.local_id AND i.account_id=l.account_id),
              (SELECT i.local_id FROM item i WHERE i.account_id=l.account_id
                 AND i.asset_id = CASE l.side WHEN 'GIVE' THEN l.asset_id ELSE l.new_asset_id END)) AS ownId,
            ${peer} AS peerId,
            (SELECT t.trade_id FROM csfloat_trade t WHERE t.account_id=l.account_id AND t.asset_id=l.asset_id ORDER BY t.trade_id LIMIT 1) AS cfId
          FROM trade_line l WHERE ${lines.sql}
        ) q
        LEFT JOIN item h ON h.local_id=COALESCE(q.ownId, q.peerId)
        LEFT JOIN csfloat_trade c ON c.account_id=q.accountId AND c.trade_id=q.cfId
      )
    )`;
  return { sql, params: [...(scope.peerAccountId ? [scope.peerAccountId] : []), ...lines.params] };
}

type OriginResult = {
  origin: TradeOriginKind;
  csfloatCheck: CsfloatCheck | null;
  transfer: TradeTransferLink | null;
  csfloat: TradeCsfloatLink[];
};

type CsfloatTradeRecord = { trade_id: string; listing_id: string; asset_id: string; state: string; seller_steam_id: string; data_json: string };

/**
 * What the trade was for, strongest evidence first: a transfer this app made, then a CSFloat trade,
 * then a trade between owned accounts this app did not make, then nothing it could verify.
 */
function originOf(database: EngineDatabase, base: EntryBase, scope: LineScope | null): OriginResult {
  const transfer = transferOf(database, base);
  if (transfer) return { origin: 'own-transfer', csfloatCheck: null, transfer, csfloat: [] };
  const csfloat = csfloatLinksOf(database, base, scope);
  if (csfloat.length > 0) {
    const roles = new Set(csfloat.map((link) => link.role));
    const origin = roles.size > 1 ? 'csfloat-mixed' : roles.has('sale') ? 'csfloat-sale' : 'csfloat-purchase';
    return { origin, csfloatCheck: null, transfer: null, csfloat };
  }
  if (base.peerAccountId) return { origin: 'own-accounts', csfloatCheck: null, transfer: null, csfloat: [] };
  return { origin: 'other', csfloatCheck: csfloatCheckOf(database, base.accountId, base.createdAt), transfer: null, csfloat: [] };
}

function transferOf(database: EngineDatabase, base: EntryBase): TradeTransferLink | null {
  if (!base.offerId) return null;
  const raw = database.raw();
  // The send hop that put the offer up, seen from either side; its transfer's words come from the
  // hops (`TransferStore.batch`).
  type SendRow = { command_id: string; account_id: string };
  const named = raw.prepare(`SELECT s.command_id, s.account_id FROM work_step s JOIN transfer_detail d ON d.step_id=s.id
    WHERE s.kind='SEND' AND s.offer_id=? AND (s.account_id=? OR d.destination_account_id=?) LIMIT 1`).get(base.offerId, base.accountId, base.accountId) as SendRow | undefined;
  if (named) return linkOf(database, named, 'offer-id');
  // A send whose response was lost is correlated later, by the message it carried (`orchestrate/transfer.ts`).
  // Until then the offer is still this app's transfer, and saying "other" would be the wrong answer.
  const offer = raw.prepare('SELECT message FROM trade_offer WHERE account_id=? AND offer_id=?').get(base.accountId, base.offerId) as { message: string | null } | undefined;
  const commandId = /^CSlytics transfer (\S+)$/.exec(offer?.message ?? '')?.[1];
  if (!commandId) return null;
  const pending = raw.prepare(`SELECT s.command_id, s.account_id FROM work_step s JOIN transfer_detail d ON d.step_id=s.id
    WHERE s.kind='SEND' AND s.command_id=? AND s.offer_id IS NULL AND (s.account_id=? OR d.destination_account_id=?) LIMIT 1`).get(commandId, base.accountId, base.accountId) as SendRow | undefined;
  return pending ? linkOf(database, pending, 'message') : null;
}

function linkOf(database: EngineDatabase, row: { command_id: string; account_id: string }, evidence: TradeTransferLink['evidence']): TradeTransferLink | null {
  const batch = new TransferStore(database).batch(row.command_id, row.account_id);
  if (!batch) return null;
  return { commandId: batch.command_id, sourceAccountId: batch.account_id, destinationAccountId: batch.destination_account_id,
    state: batch.state, reason: batch.reason, evidence };
}

/**
 * The CSFloat trades this Steam trade carried. One offer may carry several, and CSFloat's own
 * `offerId` can be null, so a trade is matched on any of three pieces of evidence — never on the
 * item's name, which two unrelated trades of the same skin share.
 */
function csfloatLinksOf(database: EngineDatabase, base: EntryBase, scope: LineScope | null): TradeCsfloatLink[] {
  const raw = database.raw();
  const ownSteamId = database.account(base.accountId)?.steam_id64 ?? null;
  const found = new Map<string, TradeCsfloatLink>();
  const add = (row: CsfloatTradeRecord, evidence: TradeCsfloatLink['evidence']): void => {
    if (!found.has(row.trade_id)) found.set(row.trade_id, csfloatLink(row, ownSteamId, evidence));
  };
  if (base.offerId) {
    // `csfloat_trade_offer` serves the lookup by the offer the venue named.
    for (const row of raw.prepare(`SELECT trade_id, listing_id, asset_id, state_word AS state, seller_steam_id, data_json FROM csfloat_trade
      WHERE account_id=? AND offer_id=? ORDER BY trade_id`).all(base.accountId, base.offerId) as CsfloatTradeRecord[]) add(row, 'offer-id');
    for (const row of raw.prepare(`SELECT c.trade_id, c.listing_id, c.asset_id, c.state_word AS state, c.seller_steam_id, c.data_json
      FROM work_step s JOIN csfloat_trade c ON c.account_id=s.account_id AND c.trade_id=s.target_id
      WHERE s.account_id=? AND s.kind='CSFLOAT_SEND' AND s.offer_id=? ORDER BY c.trade_id`).all(base.accountId, base.offerId) as CsfloatTradeRecord[]) add(row, 'own-delivery');
  }
  if (scope && base.counterpartySteamId64) {
    const lines = lineWhere(scope);
    const rows = raw.prepare(`SELECT c.trade_id, c.listing_id, c.asset_id, c.state_word AS state, c.seller_steam_id, c.data_json, l.side AS side
      FROM trade_line l JOIN csfloat_trade c ON c.account_id=l.account_id AND c.asset_id=l.asset_id
      WHERE ${lines.sql} ORDER BY c.trade_id`).all(...lines.params) as Array<CsfloatTradeRecord & { side: TradeSide }>;
    for (const row of rows) {
      const sale = row.seller_steam_id === ownSteamId;
      const data = parseTrade(row.data_json);
      const otherParty = sale ? data.buyerSteamId : row.seller_steam_id;
      if (row.side === (sale ? 'GIVE' : 'RECEIVE') && otherParty === base.counterpartySteamId64) add(row, 'asset');
    }
  }
  return [...found.values()];
}

type StoredTrade = {
  buyerSteamId?: string;
  listing?: { priceCents?: number; item?: { marketHashName?: string; floatValue?: number; paintSeed?: number } };
};

function parseTrade(json: string): StoredTrade {
  try { return JSON.parse(json) as StoredTrade; } catch { return {}; }
}

function csfloatLink(row: CsfloatTradeRecord, ownSteamId: string | null, evidence: TradeCsfloatLink['evidence']): TradeCsfloatLink {
  const data = parseTrade(row.data_json);
  const item = data.listing?.item;
  return {
    tradeId: row.trade_id,
    listingId: row.listing_id,
    role: row.seller_steam_id === ownSteamId ? 'sale' : 'purchase',
    state: row.state,
    priceCents: typeof data.listing?.priceCents === 'number' ? data.listing.priceCents : null,
    hashName: typeof item?.marketHashName === 'string' ? item.marketHashName : null,
    floatValue: typeof item?.floatValue === 'number' ? item.floatValue : null,
    paintSeed: typeof item?.paintSeed === 'number' ? item.paintSeed : null,
    assetId: row.asset_id,
    evidence
  };
}

/**
 * Why nothing matched. The CSFloat trades walk publishes all or nothing (`surfaces/csfloat-trades.ts`)
 * and reads every state, so a complete walk that *started* after this trade began would have held
 * its CSFloat trade if there was one. Anything less is not a check.
 */
function csfloatCheckOf(database: EngineDatabase, accountId: string, since: string): CsfloatCheck {
  const raw = database.raw();
  const checked = raw.prepare(`SELECT started_at FROM observation WHERE account_id=? AND surface='csfloat-trades'
    AND complete=1 AND error IS NULL ORDER BY id DESC LIMIT 1`).get(accountId) as { started_at: string } | undefined;
  if (checked && checked.started_at >= since) return 'unmatched';
  const connection = raw.prepare(`SELECT status, credential_ref FROM venue_connection WHERE account_id=? AND venue='csfloat'`)
    .get(accountId) as { status: string; credential_ref: string | null } | undefined;
  if (!connection?.credential_ref || connection.status === 'DISCONNECTED') return 'not-connected';
  const last = database.latestObservation(accountId, 'csfloat-trades');
  if (last && (last.complete !== 1 || last.error !== null)) return 'incomplete';
  return 'not-yet-covered';
}

type Decorated = { row: TradeListRow; scope: LineScope | null; origin: OriginResult };

/** Everything the list shows about one entry beyond what the entry query itself knows. */
function decorate(database: EngineDatabase, base: EntryBase): Decorated {
  const scope = lineScope(database, base);
  let giveQuantity = 0;
  let receiveQuantity = 0;
  let first: TradeItemRow | undefined;
  let second: TradeItemRow | undefined;
  if (scope) {
    const lines = lineWhere(scope);
    for (const side of database.raw().prepare(`SELECT side, SUM(quantity) AS quantity FROM trade_line l WHERE ${lines.sql} GROUP BY side`)
      .all(...lines.params) as Array<{ side: TradeSide; quantity: number }>) {
      if (side.side === 'GIVE') giveQuantity = side.quantity; else receiveQuantity = side.quantity;
    }
    // What the trade was about: what came in when anything did, otherwise what went out. Beside it,
    // the first that went out for a swap, else the first of another kind, else the next line: two
    // pictures say "more than one" best when they are not the same picture twice.
    const resolved = resolvedLinesSql(scope);
    [first, second] = database.raw().prepare(`SELECT * FROM (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY side ORDER BY lineKey) AS inSide,
          ROW_NUMBER() OVER (PARTITION BY side, groupKey ORDER BY lineKey) AS inGroup
        FROM (${resolved.sql}) r)
      ORDER BY CASE WHEN inSide=1 THEN 0 WHEN inGroup=1 THEN 1 ELSE 2 END, CASE side WHEN 'RECEIVE' THEN 0 ELSE 1 END, lineKey
      LIMIT 2`).all(...resolved.params) as TradeItemRow[];
  }
  const origin = originOf(database, base, scope);
  const priced = origin.csfloat.map((link) => link.priceCents);
  return {
    scope,
    origin,
    row: {
      ...base,
      giveQuantity,
      receiveQuantity,
      origin: origin.origin,
      csfloatCheck: origin.csfloatCheck,
      csfloatTrades: origin.csfloat.length,
      csfloatPriceCents: priced.length > 0 && priced.every((cents): cents is number => cents !== null)
        ? priced.reduce((sum, cents) => sum + cents, 0)
        : null,
      transferCommandId: origin.transfer?.commandId ?? null,
      identitySource: first?.identitySource ?? null,
      matchKey: first?.matchKey ?? '',
      defIndex: first?.defIndex ?? null,
      paintIndex: first?.paintIndex ?? null,
      quality: first?.quality ?? null,
      paintWear: first?.paintWear ?? null,
      hashName: first?.hashName ?? null,
      second: second ? { side: second.side, identitySource: second.identitySource, matchKey: second.matchKey, defIndex: second.defIndex,
        paintIndex: second.paintIndex, quality: second.quality, paintWear: second.paintWear, hashName: second.hashName } : null
    }
  };
}

/**
 * One page of the trade list, newest first.
 *
 * Paged in two passes. `queryPage` pages the lean entry query, and only the page's own rows are then
 * decorated — quantities, the first item, the origin — so a long history costs one sort, not one
 * origin lookup per trade ever made. The phase, stage, origin and flow are the filter, which the cursor
 * is bound to: a cursor from one filter cannot walk another, nor an unfiltered one a filtered list.
 *
 * `asOf` is the engine's clock, the instant a reversal period is judged against. Every read here
 * takes it rather than the wall clock, so a stage is the one the engine that wrote the row would give.
 */
export function pageTradeEntries(database: EngineDatabase, request: TradeListRequest, asOf: string): PageEnvelope<TradeListRow> {
  const accounts = assertAccountScope(database, request.accountIds);
  const { sql, params } = entriesSql(accounts, asOf, { phase: request.phase, stage: request.stage, origin: request.origin, flow: request.flow, collapse: true });
  const page = queryPage<EntryBase>(database, {
    accountIds: accounts,
    pageSize: request.pageSize ?? TRADE_LIST_PAGE_SIZE,
    cursor: request.cursor,
    filter: { phase: request.phase ?? null, stage: request.stage ?? null, origin: request.origin ?? null, flow: request.flow ?? null },
    direction: 'desc'
  }, 'trades-list', sql, params, ['sortAt', 'accountId', 'entryKey']);
  if (page.kind !== 'page') return page;
  return bounded({ ...page, rows: page.rows.map((base) => decorate(database, base).row) });
}

/**
 * How many trades each stage, origin and flow holds in a scope: the filters' counts. One pass over
 * the same entries the list pages, so a count and the list it filters cannot disagree.
 */
export function summariseTrades(database: EngineDatabase, request: TradeSummaryRequest, asOf: string): TradeSummary {
  const accounts = assertAccountScope(database, request.accountIds);
  const { sql, params } = entriesSql(accounts, asOf, { collapse: true });
  const counts = database.raw().prepare(`SELECT phase, stage, originClass AS origin, flow, COUNT(*) AS count FROM (${sql})
    GROUP BY phase, stage, originClass, flow ORDER BY phase, stage, originClass, flow`).all(...params) as TradeSummary['counts'];
  return bounded({ counts });
}

/** The entry a key names now: a `trade:` key whose offer has since been recorded answers as the offer. */
function entryBase(database: EngineDatabase, accountId: string, entryKey: string, asOf: string): EntryBase | undefined {
  let key = entryKey;
  if (key.startsWith('trade:')) {
    const offer = database.raw().prepare('SELECT offer_id FROM trade_offer WHERE account_id=? AND trade_id=? ORDER BY offer_id LIMIT 1')
      .get(accountId, key.slice('trade:'.length)) as { offer_id: string } | undefined;
    if (offer) key = `offer:${offer.offer_id}`;
  }
  const { sql, params } = entriesSql([accountId], asOf, { entry: { accountId, entryKey: key } });
  return database.raw().prepare(sql).get(...params) as EntryBase | undefined;
}

/** One trade with everything the page shows beside its items: origin, coverage, timeline and groups. */
export function readTradeEntry(database: EngineDatabase, request: TradeEntryRequest, asOf: string): TradeEntry | null {
  const [accountId] = assertAccountScope(database, [request.accountId]) as [string];
  const base = entryBase(database, accountId, request.entryKey, asOf);
  if (!base) return null;
  const raw = database.raw();
  const { row, scope, origin } = decorate(database, base);
  type OfferRow = { message: string | null; state_code: number; confirmation_method: number | null; expires_at: string | null;
    escrow_until: string | null; updated_at: string; first_seen_obs: number; last_seen_obs: number };
  type TradeRow = { status_code: number; initiated_at: string; updated_at: string | null; settled_at: string | null; first_seen_obs: number; last_seen_obs: number };
  const offer = base.offerId
    ? raw.prepare('SELECT * FROM trade_offer WHERE account_id=? AND offer_id=?').get(accountId, base.offerId) as OfferRow | undefined
    : undefined;
  const trade = base.tradeId
    ? raw.prepare('SELECT * FROM executed_trade WHERE account_id=? AND trade_id=?').get(accountId, base.tradeId) as TradeRow | undefined
    : undefined;
  const seen = (id: number | undefined): string | null => (id === undefined ? null : database.observation(accountId, id)?.finished_at ?? null);

  let groups: TradeItemGroup[] = [];
  let tradeProtectedUntil: string | null = null;
  if (scope) {
    const resolved = resolvedLinesSql(scope);
    groups = raw.prepare(`SELECT accountId, side, groupKey, SUM(quantity) AS quantity, COUNT(*) AS lines,
        MIN(paintWear) AS minWear, MAX(paintWear) AS maxWear, MAX(missing) AS missing, MIN(identitySource) AS identitySource,
        MAX(matchKey) AS matchKey, MAX(defIndex) AS defIndex, MAX(paintIndex) AS paintIndex, MAX(quality) AS quality,
        MAX(hashName) AS hashName
      FROM (${resolved.sql}) GROUP BY side, groupKey ORDER BY side, groupKey LIMIT ?`).all(...resolved.params, TRADE_GROUP_LIMIT + 1) as TradeItemGroup[];
    tradeProtectedUntil = (raw.prepare(`SELECT MAX(tradeProtectedUntil) AS until FROM (${resolved.sql}) WHERE side='RECEIVE'`)
      .get(...resolved.params) as { until: string | null }).until;
  }
  // One lookup per id, each on its own index (`trade_status_event_offer`, `trade_status_event_trade`);
  // a row that carries both ids is one row of the union.
  const timeline = raw.prepare(`SELECT at, source, raw, status FROM (
      SELECT occurred_at AS at, CASE WHEN event_key LIKE 'offer:%' THEN 'offer' ELSE 'trade' END AS source, state_code AS raw, status, event_key
      FROM trade_status_event WHERE account_id=? AND offer_id=?
      UNION SELECT occurred_at, CASE WHEN event_key LIKE 'offer:%' THEN 'offer' ELSE 'trade' END, state_code, status, event_key
      FROM trade_status_event WHERE account_id=? AND trade_id=?)
    ORDER BY at, event_key LIMIT ?`).all(accountId, base.offerId, accountId, base.tradeId, TIMELINE_LIMIT) as TradeTimelineRow[];

  return bounded({
    ...row,
    canonicalKey: base.entryKey,
    message: offer?.message ?? null,
    rawOfferState: offer?.state_code ?? null,
    rawTradeStatus: trade?.status_code ?? null,
    confirmationMethod: offer?.confirmation_method ?? null,
    expiresAt: offer?.expires_at ?? null,
    escrowUntil: offer?.escrow_until ?? null,
    offerUpdatedAt: offer?.updated_at ?? null,
    initiatedAt: trade?.initiated_at ?? null,
    tradeUpdatedAt: trade?.updated_at ?? null,
    settledAt: trade?.settled_at ?? null,
    firstSeenAt: seen(offer?.first_seen_obs ?? trade?.first_seen_obs),
    lastSeenAt: seen(Math.max(offer?.last_seen_obs ?? 0, trade?.last_seen_obs ?? 0) || undefined),
    lineSource: scope?.source ?? null,
    tradeProtectedUntil,
    transfer: origin.transfer,
    csfloat: origin.csfloat,
    coverage: COVERAGE_SURFACES.map((surface) => surfaceCoverage(database, accountId, surface)),
    timeline,
    groups: groups.slice(0, TRADE_GROUP_LIMIT),
    groupsTruncated: groups.length > TRADE_GROUP_LIMIT
  });
}

/** One side of one trade, a page at a time, optionally one group of it. */
export function pageTradeItems(database: EngineDatabase, request: TradeItemsRequest, asOf: string): PageEnvelope<TradeItemRow> {
  const [accountId] = assertAccountScope(database, [request.accountId]) as [string];
  const base = entryBase(database, accountId, request.entryKey, asOf);
  if (!base) throw new Error('That trade is no longer recorded');
  const scope = lineScope(database, base);
  const pageRequest = {
    accountIds: [accountId],
    pageSize: request.pageSize,
    cursor: request.cursor,
    filter: { entryKey: base.entryKey, side: request.side, groupKey: request.groupKey ?? null }
  };
  if (!scope) return queryPage<TradeItemRow>(database, pageRequest, 'trade-items', 'SELECT NULL AS lineKey WHERE 0', [], ['lineKey']);
  const resolved = resolvedLinesSql(scope);
  const where = ['side=?', ...(request.groupKey === undefined ? [] : ['groupKey=?'])];
  return queryPage<TradeItemRow>(database, pageRequest, 'trade-items',
    `SELECT * FROM (${resolved.sql}) WHERE ${where.join(' AND ')}`,
    [...resolved.params, request.side, ...(request.groupKey === undefined ? [] : [request.groupKey])], ['lineKey']);
}
