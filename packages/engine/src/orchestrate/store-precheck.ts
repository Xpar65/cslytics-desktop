import type { AccountId } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { csfloatClaim, type MarketplaceConsent } from '../kernel/marketplace-commitments.js';
import { storedCannotTrade } from '../kernel/attributes.js';
import { OrderStore } from '../db/orders.js';
import { MarketplaceStore } from '../db/marketplace.js';
import { OPEN_STEP_STATES_SQL } from '../db/work.js';
import { CASKET_CAPACITY } from '../surfaces/storage.js';
import type { TradeService } from '../surfaces/trades.js';

/** What a store pre-check is asked about: the items, or a frozen selection, and the unit each account's items go to. */
export type StorePrecheckRequest = {
  members?: ReadonlyArray<{ accountId: AccountId; localId: string }>;
  manifestToken?: string;
  destinations: Readonly<Record<string, string>>;
};

/** One item the pre-check names, and why, in words a person reads. */
export type PrecheckLine = { accountId: string; localId: string; reason: string };

export type StorePrecheck = {
  /** How many items were asked about. */
  asked: number;
  /** Left out whatever the person chooses: what cannot be stored at all, and what a Steam listing holds (bulk storage plan D10, D13). */
  leaveOut: PrecheckLine[];
  /** Stored only if the person agrees: the claim each one would be stored despite (D9). */
  decide: Array<PrecheckLine & { claim: MarketplaceConsent }>;
  /** The reads the answer rests on and when each finished; `null` is a read never made (D8). */
  asOf: Array<{ accountId: string; surface: PrecheckSurface; finishedAt: string | null }>;
  /** Each destination's room: the observed count and the stores already on their way, against a thousand (D12). */
  room: Array<{ accountId: string; casketId: string; label: string | null; room: number }>;
  /** Accounts whose CS2 session is not up: nothing can be stored there now (D4). */
  gcDown: string[];
};

export type PrecheckSurface = 'steam-market' | 'steam-trade-offers' | 'csfloat-stall' | 'csfloat-trades';

const STORAGE_UNIT_DEF_INDEX = 1201;

/**
 * What a store of these items would meet, read from the record and nothing else (bulk storage plan
 * D8): no venue is asked anything, so it answers at once, and it says how old each read it rests on
 * is rather than claiming a venue holds nothing. It is advice under warn-and-allow (D9), not a gate:
 * the gate is the same claim functions asked again at the send, which is why this asks them too —
 * once with no consent, and once with each consent, so a claim is named by exactly the consent that
 * lets it through. The two can therefore never disagree about what blocks a store.
 */
export function storePrecheck(context: EngineContext, trades: TradeService, request: StorePrecheckRequest): StorePrecheck {
  const db = context.database;
  const now = context.now();
  const members = request.manifestToken
    ? db.draftMembers(request.manifestToken).map((row) => ({ accountId: row.accountId, localId: row.localId ?? row.memberId }))
    : [...(request.members ?? [])];
  const pledges = new Map<string, ReturnType<TradeService['committedAssets']>>();
  const pledgedFor = (accountId: string): ReturnType<TradeService['committedAssets']> => {
    const found = pledges.get(accountId) ?? trades.committedAssets(accountId);
    pledges.set(accountId, found);
    return found;
  };
  const orders = new OrderStore(db);
  const leaveOut: PrecheckLine[] = [];
  const decide: StorePrecheck['decide'] = [];

  for (const { accountId, localId } of members) {
    const item = db.itemByLocalId(accountId, localId);
    const out = (reason: string): void => { leaveOut.push({ accountId, localId, reason }); };
    if (!item) { out('not in this account\'s record'); continue; }
    if (item.def_index === STORAGE_UNIT_DEF_INDEX) { out('a storage unit'); continue; }
    if (item.location === 'CASKET') { out('already in storage'); continue; }
    if (item.location !== 'MAIN' || !item.asset_id) { out('not in inventory'); continue; }
    if (item.trade_protected_until && item.trade_protected_until > now) { out('trade-protected'); continue; }
    if (storedCannotTrade(item)) { out('marked untradable by Steam'); continue; }
    const steam = orders.commitment(accountId, localId, item.asset_id, 'steam');
    if (steam?.venue === 'steam') { out('listed on the Steam market'); continue; }

    const claims: Array<{ claim: MarketplaceConsent; reason: string }> = [];
    const pledge = pledgedFor(accountId).get(item.asset_id);
    if (pledge) claims.push({ claim: 'trade-pledged', reason: `in trade offer ${pledge.offerId}` });
    const blocked = csfloatClaim(db, accountId, localId, 'storage');
    if (blocked) {
      if (!csfloatClaim(db, accountId, localId, 'storage', '', ['csfloat-listed'])) claims.push({ claim: 'csfloat-listed', reason: 'listed on CSFloat' });
      else if (!csfloatClaim(db, accountId, localId, 'storage', '', ['csfloat-owed'])) claims.push({ claim: 'csfloat-owed', reason: 'sold on CSFloat and owed to the buyer' });
      else if (!csfloatClaim(db, accountId, localId, 'storage', '', ['csfloat-listed', 'csfloat-owed'])) {
        claims.push({ claim: 'csfloat-listed', reason: 'listed on CSFloat' }, { claim: 'csfloat-owed', reason: 'sold on CSFloat and owed to the buyer' });
      } else {
        // A claim no consent answers is not the person's to override.
        out(blocked);
        continue;
      }
    }
    for (const { claim, reason } of claims) decide.push({ accountId, localId, reason, claim });
  }

  const accounts = [...new Set(members.map((member) => member.accountId))].sort();
  const latest = (accountId: string, surface: PrecheckSurface): string | null => (db.raw().prepare(`SELECT finished_at FROM observation
    WHERE account_id=? AND surface=? AND complete=1 ORDER BY id DESC LIMIT 1`).get(accountId, surface) as { finished_at: string } | undefined)?.finished_at ?? null;
  const asOf: StorePrecheck['asOf'] = [];
  const marketplaces = new MarketplaceStore(db);
  for (const accountId of accounts) {
    const surfaces: PrecheckSurface[] = ['steam-market', 'steam-trade-offers'];
    if (marketplaces.connection(accountId, 'csfloat')) surfaces.push('csfloat-stall', 'csfloat-trades');
    for (const surface of surfaces) asOf.push({ accountId, surface, finishedAt: latest(accountId, surface) });
  }

  const room: StorePrecheck['room'] = [];
  for (const accountId of accounts) {
    const casketId = request.destinations[accountId];
    if (!casketId) continue;
    const unit = db.storageUnit(accountId, casketId);
    if (!unit) continue;
    const onTheWay = (db.raw().prepare(`SELECT COUNT(*) AS n FROM work_step WHERE account_id=? AND kind='STORE' AND state IN ${OPEN_STEP_STATES_SQL}
      AND json_extract(params_json,'$.casketId')=?`).get(accountId, casketId) as { n: number }).n;
    room.push({ accountId, casketId, label: unit.label, room: Math.max(0, CASKET_CAPACITY - unit.contains_count - onTheWay) });
  }

  const gcDown = accounts.filter((accountId) => context.ports.gc.connectionStatus(accountId).state !== 'CONNECTED');
  return { asked: members.length, leaveOut, decide, asOf, room, gcDown };
}
