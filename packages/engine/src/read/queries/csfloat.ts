import type { EngineDatabase } from '../../db/database.js';
import { CsfloatStore, type CsfloatOperation, type StoredCsfloatTrade } from '../../db/csfloat.js';
import { HoldingsStore } from '../../db/holdings.js';
import type { CsfloatListingItem } from '@cslytics/ports';

export type CsfloatBook = 'inventory' | 'listings' | 'sales' | 'operations';
export type CsfloatPageRow = { id: string; name: string; localId: string | null; state: string; priceCents: number | null;
  observedAt: string | null; deadlineAt: string | null; offerId: string | null; tradable: boolean; reason: string | null };
export type CsfloatPage = { accountId: string; book: CsfloatBook; rows: CsfloatPageRow[]; nextCursor: string | null; stalePage: boolean };

/** Bounded, account-scoped projections. Trade tokens and raw venue bodies never cross IPC. */
export function pageCsfloat(db: EngineDatabase, accountId: string, book: CsfloatBook, cursor?: string): CsfloatPage {
  const snapshot = (db.raw().prepare('SELECT COALESCE(MAX(id),0) AS id FROM observation WHERE account_id=?').get(accountId) as { id: number }).id;
  let after = '';
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as { accountId: string; book: string; snapshot: number; after: string };
      if (decoded.accountId !== accountId || decoded.book !== book || decoded.snapshot !== snapshot || typeof decoded.after !== 'string') throw new Error('stale');
      after = decoded.after;
    } catch { return { accountId,book,rows: [],nextCursor: null,stalePage: true }; }
  }
  const sources = { inventory: ['csfloat_inventory','asset_id'],listings: ['csfloat_contract','listing_id'],sales: ['csfloat_trade','trade_id'],operations: ['csfloat_operation','id'] } as const;
  const [table,key] = sources[book];
  const raw = db.raw().prepare(`SELECT * FROM ${table} WHERE account_id=? AND ${key}>? ORDER BY ${key} LIMIT 101`).all(accountId,after) as Record<string,unknown>[];
  const store = new CsfloatStore(db);
  const rows = raw.slice(0,100).map(row => {
    const observationId = typeof row['observation_id'] === 'number' ? row['observation_id'] : null;
    const observedAt = db.observation(accountId,observationId)?.finished_at ?? null;
    if (book === 'operations') {
      const op = row as unknown as CsfloatOperation;
      return { id: op.id,name: op.kind.toLowerCase(),localId: op.local_id,state: op.state,priceCents: op.price_cents,
        observedAt: op.updated_at,deadlineAt: null,offerId: op.offer_id,tradable: false,reason: op.error };
    }
    if (book === 'sales') {
      const trade = JSON.parse(row['data_json'] as string) as StoredCsfloatTrade;
      return { id: trade.tradeId,name: trade.listing.item.marketHashName,localId: row['local_id'] as string | null,state: trade.state,
        priceCents: trade.listing.priceCents,observedAt,deadlineAt: trade.deadlineAt,offerId: trade.offerId,tradable: false,
        reason: trade.sellerSteamId === db.account(accountId)?.steam_id64 ? null : 'Purchase' };
    }
    const item = JSON.parse(row['item_json'] as string) as CsfloatListingItem;
    const localId = store.associate(accountId,item);
    return { id: row[key] as string,name: item.marketHashName,localId,state: book === 'inventory' ? 'inventory' : row['state'] as string,
      priceCents: typeof row['price_cents'] === 'number' ? row['price_cents'] : null,observedAt,deadlineAt: null,offerId: null,
      tradable: item.tradable === 1 && localId !== null,reason: localId === null ? 'Item identity unresolved' : null };
  });
  return { accountId,book,rows,stalePage: false,nextCursor: raw.length > 100 ? Buffer.from(JSON.stringify({accountId,book,snapshot,after:raw[99]![key]})).toString('base64url') : null };
}

export function csfloatOverview(db: EngineDatabase, accountId: string) {
  const store = new CsfloatStore(db);
  const observations = ['csfloat-stall','csfloat-trades','csfloat-inventory','csfloat-buy-orders'].map(surface => {
    const obs = db.latestObservation(accountId,surface);
    return { surface,observedAt: obs?.finished_at ?? null,complete: obs?.complete === 1,reason: obs?.error ?? null };
  });
  const conflicts = db.raw().prepare('SELECT reason,observed_at AS observedAt FROM marketplace_conflict WHERE account_id=? AND resolved_at IS NULL ORDER BY observed_at LIMIT 100').all(accountId) as Array<{reason:string;observedAt:string}>;
  return { accountId,policy: store.policy(),observations,conflicts };
}

/**
 * Operations that stopped without an outcome to report.
 *
 * `DONE` and `FAILED` are outcomes and stay in the answer: `pageOpenWork` keeps a settled row while
 * its command is among the most recently touched, exactly as it keeps a Steam member's, so the
 * panel can say *Confirmed* or *Failed* and why. A cancelled delivery is the venue ending a sale,
 * not a result of anything asked for here, and leaves the list the way a stopped command does
 * (N-WORK-02).
 */
const CSFLOAT_SILENT_OPERATIONS = ['CANCELLED'];

/**
 * CSFloat operations, in the shape `work.open` speaks.
 *
 * A user who sent a row to CSFloat from the listing workspace expects to see it in the same work panel
 * as everything else, so these are folded into the same row shape rather than given a surface of
 * their own. `commandKind` is synthesised (`CSFLOAT_LIST`) because an operation has no command
 * row of its own to name.
 *
 * `memberState` stays observation-honest: an operation is `COMPLETE` only when its action is
 * `DONE`. A venue accepting a request is a receipt, not proof — rule 1, in a second marketplace.
 * While the action is `RUNNING` the row says so, in the same word a Steam member uses: the send
 * is engine-driven now, so *Queued* and *Sending* are states a person actually sees.
 *
 * Every kind is here, a buy-order edit or cancel too (N-WORK-08). One of those was once filtered
 * out, on the argument that it is about an order rather than an item and its Buy orders row
 * already said *Changing*; the work panel then never showed it. An order names no item, so its
 * row carries `hashName` — frozen into the action at admission, because a settled cancel's order
 * has left the book — and no identity key.
 *
 * A refusal stays. This query used to drop `FAILED` at the source, so a create CSFloat rejected
 * after admission — a price above what it lets the account list, a suspension the window had not
 * read yet — vanished from the panel on the next poll, while the Steam source kept its refused
 * members for the same panel. The reason the venue gave is `o.error`, and the row carries it
 * (CSF-30).
 *
 * A listing from a storage unit has no create action until CSFloat has seen the item, so until
 * then the row reports the retrieve it carries instead: `RETRIEVE_FROM_CASKET` while the item
 * leaves the unit, and the operation's own `AWAITING_VENUE` while CSFloat catches up. A `DONE`
 * retrieve is the first hop, never the listing (CSF-37).
 */
export function csfloatOpenOperations(db: EngineDatabase, accounts: readonly string[]): CsfloatWorkRow[] {
  if (accounts.length === 0) return [];
  const marks = accounts.map(() => '?').join(',');
  const rows = db.raw().prepare(`
    SELECT o.account_id AS accountId, o.command_id AS commandId, o.kind AS kind, o.state AS state,
      o.created_at AS submittedAt, o.id AS memberId, o.local_id AS localId, o.price_cents AS priceReceiveCents,
      o.updated_at AS updatedAt, a.kind AS actionKind, a.state AS actionState, o.error AS reason,
      CASE WHEN o.action_id IS NULL THEN 0 ELSE 1 END AS carriesCreate,
      i.def_index AS defIndex, i.paint_index AS paintIndex, i.quality AS quality, i.paint_wear AS paintWear,
      i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,'') AS matchKey,
      CASE WHEN o.order_id IS NOT NULL THEN COALESCE(json_extract(a.params_json,'$.hashName'), b.hash_name, '') END AS hashName
    FROM csfloat_operation o
    LEFT JOIN action a ON a.id=COALESCE(o.action_id,o.retrieve_action_id)
    LEFT JOIN item i ON i.account_id=o.account_id AND i.local_id=o.local_id
    LEFT JOIN csfloat_buy_order b ON b.account_id=o.account_id AND b.order_id=o.order_id
    WHERE o.account_id IN (${marks})
      AND o.state NOT IN (${CSFLOAT_SILENT_OPERATIONS.map(() => '?').join(',')})
  `).all(...accounts, ...CSFLOAT_SILENT_OPERATIONS) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    accountId: String(row['accountId']),
    commandId: String(row['commandId']),
    commandKind: `CSFLOAT_${String(row['kind']).toUpperCase()}`,
    commandState: String(row['state']),
    submittedAt: String(row['submittedAt']),
    memberId: String(row['memberId']),
    memberState: memberStateOf(String(row['state']), row['carriesCreate'] === 1 ? (row['actionState'] as string | null) ?? null : null),
    quantity: 1,
    localId: (row['localId'] as string | null) ?? null,
    stackKey: null,
    defIndex: typeof row['defIndex'] === 'number' ? row['defIndex'] : 0,
    paintIndex: typeof row['paintIndex'] === 'number' ? row['paintIndex'] : null,
    quality: typeof row['quality'] === 'number' ? row['quality'] : 0,
    paintWear: typeof row['paintWear'] === 'number' ? row['paintWear'] : null,
    destinationCasketId: null,
    priceReceiveCents: typeof row['priceReceiveCents'] === 'number' ? row['priceReceiveCents'] : null,
    actionKind: (row['actionKind'] as string | null) ?? null,
    actionState: (row['actionState'] as string | null) ?? null,
    updatedAt: String(row['updatedAt']),
    reason: (row['reason'] as string | null) ?? null,
    matchKey: typeof row['matchKey'] === 'string' ? row['matchKey'] : '',
    hashName: typeof row['hashName'] === 'string' ? row['hashName'] : null
  }));
}

/**
 * The operation's own state wins once it has settled: `DONE` is written only beside a resolved
 * action after a complete walk, and `FAILED` beside the venue's refusal or the walk that showed the
 * listing elsewhere. Before that, the action says whether the send is running. `actionState` is
 * the create's only: a retrieve's `DONE` is where the wait for CSFloat starts, not where it ends.
 */
function memberStateOf(state: string, actionState: string | null): string {
  if (state === 'DONE') return 'COMPLETE';
  if (state === 'FAILED') return 'FAILED';
  if (actionState === 'DONE') return 'COMPLETE';
  if (actionState === 'RUNNING') return 'RUNNING';
  return state;
}

/** The row shape `pageOpenWork` unions. Declared here so `work.ts` need not import a CSFloat type. */
export type CsfloatWorkRow = {
  accountId: string; commandId: string; commandKind: string; commandState: string;
  submittedAt: string; memberId: string; memberState: string; quantity: number;
  localId: string | null; stackKey: string | null;
  defIndex: number; paintIndex: number | null; quality: number; paintWear: number | null;
  destinationCasketId: string | null; priceReceiveCents: number | null;
  actionKind: string | null; actionState: string | null; updatedAt: string; reason: string | null; matchKey: string;
  /** A buy-order operation's market name; `null` on listing and delivery work, which is named by identity. */
  hashName: string | null;
};

export type CsfloatEligibilityState = 'eligible' | 'ineligible' | 'absent' | 'unknown';
export type CsfloatEligibility = { localId: string; state: CsfloatEligibilityState; reason: string | null };
/** A group of interchangeable units, answered as a whole: `units` is how many of it CSFloat would take now. */
export type CsfloatGroupEligibility = { stackKey: string; state: CsfloatEligibilityState; reason: string | null; units: number };
/** The inspector's multi-selection ceiling for venue actions. */
export const CSFLOAT_ELIGIBILITY_LIMIT = 100;

const ABSENT_REASON = 'CSFloat does not hold this item in its inventory read';
const UNTRADABLE_REASON = 'CSFloat reports the item as not tradable';

/**
 * Can these specific items be listed on CSFloat?
 *
 * `csfloat.page` answers this per account, paged and keyed by asset. The inspector needs the
 * opposite direction — "this item I am looking at, yes or no" — and the join is `store.associate`,
 * the same identity association the rest of the CSFloat surface uses.
 *
 * Four answers, and two of them are about what is known rather than what is so. `unknown` means no
 * complete CSFloat inventory observation exists for the account: it is not a refusal. Absence of an
 * observation is not evidence of absence, so the inspector says the item is not checked yet rather
 * than hiding the action as though the venue had refused it. `absent` is the other half: a
 * complete read that does not hold the item at all (rule 5). CSFloat leaves out of that read what
 * it will not trade — the storage test account's read of 2026-09-22 held the sticker, patch, pin and agent
 * of one delivery and not the viewer pass, key, gift, graffiti, name tag or swap tool beside them —
 * and it lags a retrieve by about two minutes, so what `absent` means is the window's to word.
 * `ineligible` is held but not tradable, or held under an identity that does not resolve.
 */
export function csfloatEligibility(db: EngineDatabase, accountId: string, localIds: readonly string[]): CsfloatEligibility[] {
  const wanted = [...new Set(localIds)].slice(0, CSFLOAT_ELIGIBILITY_LIMIT);
  if (wanted.length === 0) return [];
  const verdict = venueVerdicts(db, accountId);
  return wanted.map((localId) => ({ localId, ...(verdict ? verdict(localId) : { state: 'unknown' as const, reason: null }) }));
}

/**
 * The same question for a group, which the inventory shows as one row: how many of its units in
 * main inventory CSFloat would take now. Any one is enough to offer the group; how many is what a
 * listing of it can ask for. A group CSFloat holds none of is `absent` only when it holds none of
 * any unit, and `ineligible` when it holds some that it will not trade.
 */
export function csfloatGroupEligibility(db: EngineDatabase, accountId: string, stackKeys: readonly string[]): CsfloatGroupEligibility[] {
  const wanted = [...new Set(stackKeys)].slice(0, CSFLOAT_ELIGIBILITY_LIMIT);
  if (wanted.length === 0) return [];
  const verdict = venueVerdicts(db, accountId);
  const holdings = new HoldingsStore(db);
  return wanted.map((stackKey) => {
    if (!verdict) return { stackKey, state: 'unknown' as const, reason: null, units: 0 };
    const loose = holdings.units(accountId, stackKey).filter((unit) => unit.location === 'MAIN' && unit.current_asset_id);
    if (loose.length === 0) return { stackKey, state: 'ineligible' as const, reason: 'No unit of this group is in main inventory', units: 0 };
    const states = loose.map((unit) => verdict(unit.local_id));
    const units = states.filter((entry) => entry.state === 'eligible').length;
    if (units > 0) return { stackKey, state: 'eligible' as const, reason: null, units };
    if (states.every((entry) => entry.state === 'absent')) return { stackKey, state: 'absent' as const, reason: ABSENT_REASON, units: 0 };
    return { stackKey, state: 'ineligible' as const, reason: states.find((entry) => entry.state === 'ineligible')?.reason ?? UNTRADABLE_REASON, units: 0 };
  });
}

/** One pass over the latest complete CSFloat read, answering per unit; null when there is none. */
function venueVerdicts(db: EngineDatabase, accountId: string): ((localId: string) => { state: CsfloatEligibilityState; reason: string | null }) | null {
  const observed = db.latestObservation(accountId, 'csfloat-inventory');
  if (!observed || observed.complete !== 1 || observed.error !== null) return null;
  const store = new CsfloatStore(db);
  const eligible = new Map<string, boolean>();
  const held = new Set<string>();
  const rows = db.raw().prepare('SELECT asset_id,item_json FROM csfloat_inventory WHERE account_id=?').all(accountId) as Array<{ asset_id: string; item_json: string }>;
  for (const row of rows) {
    held.add(row.asset_id);
    const item = JSON.parse(row.item_json) as CsfloatListingItem;
    const localId = store.associate(accountId, item);
    if (localId === null) continue;
    // A tradable row wins over an untradable duplicate: one listable copy is enough to list one.
    eligible.set(localId, (eligible.get(localId) ?? false) || item.tradable === 1);
  }
  return (localId) => {
    if (eligible.get(localId)) return { state: 'eligible', reason: null };
    if (eligible.has(localId)) return { state: 'ineligible', reason: UNTRADABLE_REASON };
    const asset = db.itemByLocalId(accountId, localId)?.current_asset_id;
    // Held under this asset id but not resolved to this row: CSFloat has it, the identity disagrees.
    if (asset && held.has(asset)) return { state: 'ineligible', reason: 'CSFloat holds this asset under an identity that does not match the item' };
    return { state: 'absent', reason: ABSENT_REASON };
  };
}

/** The account a CSFloat operation belongs to, so the host can refuse one addressed to another account. */
export function csfloatOperationAccount(db: EngineDatabase, operationId: string): string | null {
  return new CsfloatStore(db).operation(operationId)?.account_id ?? null;
}
