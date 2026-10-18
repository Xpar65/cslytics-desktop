import type { EngineDatabase } from '../../db/database.js';
import { CsfloatStore, type StoredCsfloatTrade } from '../../db/csfloat.js';
import { HoldingsStore } from '../../db/holdings.js';
import { AssetEvidenceStore } from '../../db/asset-evidence.js';
import type { WorkStepRow } from '../../db/work.js';
import type { CsfloatListingItem } from '@cslytics/ports';

export type CsfloatBook = 'inventory' | 'listings' | 'sales' | 'operations';
export type CsfloatPageRow = { id: string; name: string; localId: string | null; state: string; priceCents: number | null;
  observedAt: string | null; deadlineAt: string | null; offerId: string | null; tradable: boolean; reason: string | null };
export type CsfloatPage = { accountId: string; book: CsfloatBook; rows: CsfloatPageRow[]; nextCursor: string | null; stalePage: boolean };

/**
 * Bounded, account-scoped projections. Trade tokens and raw venue bodies never cross IPC.
 *
 * The `operations` book is the account's CSFloat work as the record keeps it: one row per hop of
 * every CSFloat command (consolidation plan D2), named by the hop's kind, in the one work
 * alphabet, with the terms the hop was admitted with.
 */
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
  const sources = { inventory: ['asset_evidence','asset_id'],listings: ['venue_order','listing_id'],sales: ['csfloat_trade','trade_id'] } as const;
  const [table,key] = book === 'operations' ? ['work_step','id'] as const : sources[book];
  const raw = book === 'operations'
    ? db.raw().prepare(`SELECT s.* FROM work_step s JOIN command c ON c.id=s.command_id WHERE s.account_id=? AND c.kind LIKE 'CSFLOAT_%' AND s.id>? ORDER BY s.id LIMIT 101`)
      .all(accountId,after) as Record<string,unknown>[]
    : book === 'listings'
      // Every advertisement the record holds, in any state: the listings book is the venue's word for each.
      ? db.raw().prepare(`SELECT v.venue_order_id AS listing_id, v.local_id, v.asset_id, v.price_cents, x.state_word AS state, x.item_json, x.type, x.observation_id
          FROM venue_order v JOIN csfloat_order x ON x.account_id=v.account_id AND x.order_id=v.order_id
          WHERE v.account_id=? AND v.venue='csfloat' AND v.side='SELL' AND v.venue_order_id>? ORDER BY v.venue_order_id LIMIT 101`).all(accountId,after) as Record<string,unknown>[]
      : book === 'inventory'
        // The venue's word on every asset it holds for this account, from its last complete read (D11).
        ? db.raw().prepare(`SELECT asset_id, detail_json AS item_json, last_seen_obs AS observation_id FROM asset_evidence WHERE account_id=? AND source='csfloat' AND asset_id>? ORDER BY asset_id LIMIT 101`).all(accountId,after) as Record<string,unknown>[]
        : db.raw().prepare(`SELECT * FROM ${table} WHERE account_id=? AND ${key}>? ORDER BY ${key} LIMIT 101`).all(accountId,after) as Record<string,unknown>[];
  const store = new CsfloatStore(db);
  const rows = raw.slice(0,100).map(row => {
    const observationId = typeof row['observation_id'] === 'number' ? row['observation_id'] : null;
    const observedAt = db.observation(accountId,observationId)?.finished_at ?? null;
    if (book === 'operations') {
      const step = row as unknown as WorkStepRow;
      const params = JSON.parse(step.params_json ?? '{}') as { priceCents?: number | null; maxPriceCents?: number | null };
      return { id: step.id,name: step.kind.toLowerCase(),localId: step.local_id,state: step.state,priceCents: params.priceCents ?? params.maxPriceCents ?? null,
        observedAt: step.updated_at,deadlineAt: step.deadline_at,offerId: step.offer_id,tradable: false,reason: step.reason };
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
  const conflicts = db.raw().prepare('SELECT reason,observed_at AS observedAt FROM venue_conflict WHERE account_id=? AND resolved_at IS NULL ORDER BY observed_at LIMIT 100').all(accountId) as Array<{reason:string;observedAt:string}>;
  return { accountId,policy: store.policy(),observations,conflicts };
}

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
    const loose = holdings.units(accountId, stackKey).filter((unit) => unit.location === 'MAIN' && unit.asset_id);
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
  for (const row of new AssetEvidenceStore(db).csfloatHeld(accountId)) {
    held.add(row.asset_id);
    const localId = store.associate(accountId, row.item);
    if (localId === null) continue;
    // A tradable row wins over an untradable duplicate: one listable copy is enough to list one.
    eligible.set(localId, (eligible.get(localId) ?? false) || row.eligible === 1);
  }
  return (localId) => {
    if (eligible.get(localId)) return { state: 'eligible', reason: null };
    if (eligible.has(localId)) return { state: 'ineligible', reason: UNTRADABLE_REASON };
    const asset = db.itemByLocalId(accountId, localId)?.asset_id;
    // Held under this asset id but not resolved to this row: CSFloat has it, the identity disagrees.
    if (asset && held.has(asset)) return { state: 'ineligible', reason: 'CSFloat holds this asset under an identity that does not match the item' };
    return { state: 'absent', reason: ABSENT_REASON };
  };
}

/**
 * The account a piece of CSFloat work belongs to, by its command id or the id of one of its hops,
 * so the host can refuse one addressed to another account.
 */
export function csfloatOperationAccount(db: EngineDatabase, operationId: string): string | null {
  const row = db.raw().prepare(`SELECT s.account_id AS accountId FROM work_step s JOIN command c ON c.id=s.command_id
    WHERE (s.command_id=? OR s.id=?) AND c.kind LIKE 'CSFLOAT_%' LIMIT 1`).get(operationId, operationId) as { accountId: string } | undefined;
  return row?.accountId ?? null;
}
