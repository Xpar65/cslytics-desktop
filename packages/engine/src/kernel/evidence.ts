import type { ActionRow, AttemptRow, EngineDatabase, ItemRow, ObservationRow, ScopeKind } from '../db/database.js';
import { marketplaceBlock, type MarketplaceConsent } from './marketplace-commitments.js';
import { committedSql } from '../db/commitment.js';
import { CsfloatStore } from '../db/csfloat.js';

export type Freshness = 'FRESH' | 'STALE' | 'INCOMPLETE' | 'NEVER';
export type Surface =
  | 'gc-inventory' | 'gc-casket' | 'gc-event' | 'gc-storage-units'
  | 'steam-market' | 'steam-market-history' | 'steam-wallet'
  | 'steam-trade-offers' | 'steam-trade-history' | 'steam-trade-inventory'
  | 'steam-persona'
  | 'csfloat-account-status' | 'csfloat-stall' | 'csfloat-inventory' | 'csfloat-trades' | 'csfloat-trade' | 'csfloat-listing' | 'csfloat-buy-orders'
  | 'gc-store-price-sheet';
export type ScopeRef = { kind: ScopeKind; id?: string };
export type SurfaceRef = { surface: Surface; scope: ScopeRef };
/**
 * What a waiting action needs before it can be settled (settling and read path plan D5): walks,
 * each of which must begin after a moment; a person, whom no walk hurries; or nothing.
 */
export type ProofNeed =
  | { kind: 'walks'; walks: ReadonlyArray<{ ref: SurfaceRef; startedAfter: string }> }
  | { kind: 'person'; reason: string }
  | { kind: 'none' };
export type Evidence<T> =
  | { grade: 'SATISFIED'; value: T; observationId: number; observedAt: string }
  | { grade: 'UNSATISFIED'; reason: string; observationId: number; blockedUntil?: string }
  | { grade: 'UNKNOWN'; want: SurfaceRef; freshness: Freshness };

/**
 * How long one complete observation of a surface is worth trusting.
 *
 * `gc-storage-units` and `steam-wallet` are written by `surfaces/storage` and `surfaces/market`
 * and were missing from this table, so `freshness` fell through its `!FRESHNESS[surface]` guard
 * and graded every one of them `INCOMPLETE` — including the wallet that
 * `surfaces/buy-orders` admits real money against (requirements N-BUY-06).
 */
export const FRESHNESS: Record<Surface, { maxAgeMs: number; scope: ScopeKind; proves: 'presence' | 'set' }> = {
  // CSFloat allows about 120 inventory reads a day: trusted for five minutes, a steady listing loop read it 288
  // times a day and spent the day by late morning (2026-10-25). Fifteen keeps it near 96 (CSF-51).
  'csfloat-inventory': { maxAgeMs: 15 * 60_000, scope: 'account', proves: 'presence' },
  'csfloat-trades': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  'csfloat-trade': { maxAgeMs: 5 * 60_000, scope: 'item', proves: 'presence' },
  'csfloat-listing': { maxAgeMs: 5 * 60_000, scope: 'item', proves: 'presence' },
  'steam-trade-inventory': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  'gc-inventory': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  'gc-casket': { maxAgeMs: 5 * 60_000, scope: 'casket', proves: 'set' },
  'gc-event': { maxAgeMs: 60_000, scope: 'item', proves: 'presence' },
  'gc-storage-units': { maxAgeMs: 15 * 60_000, scope: 'account', proves: 'set' },
  'steam-market': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  'steam-market-history': { maxAgeMs: 15 * 60_000, scope: 'account', proves: 'set' },
  'steam-wallet': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  // A complete offer walk is a set claim: these are all the offers. Executed history proves
  // presence only — Steam's log is append-only, so a walk of it can never establish that a
  // trade did *not* happen (rule 5, TRD-05).
  'steam-trade-offers': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  'steam-trade-history': { maxAgeMs: 15 * 60_000, scope: 'account', proves: 'presence' },
  // One account's current face. Presence, not a set: Steam says what this account looks like
  // now, and says nothing about any other SteamID. Twenty-four hours matches how rarely a
  // persona changes and keeps CM traffic off the critical path.
  'steam-persona': { maxAgeMs: 24 * 60 * 60_000, scope: 'account', proves: 'presence' },
  // `/me` is a presence claim about one account: it says what CSFloat currently reports, and
  // says nothing about any set of listings, orders or trades (plan CSF-21).
  'csfloat-account-status': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'presence' },
  // A complete stall walk is a set claim — these are all the account's listings — and it is the
  // claim cross-venue protection will rest on, so it expires quickly (plan XLIST-04).
  'csfloat-stall': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  // A complete walk of the account's own buy-order book is a set claim — these are all its open
  // orders — and it is what proves a cancel absent or an edit present (CSF-39, CSF-40).
  'csfloat-buy-orders': { maxAgeMs: 5 * 60_000, scope: 'account', proves: 'set' },
  // The GC's price sheet is a set claim — these are the entries this account may buy, at these
  // prices — and a purchase freezes a price out of it, so it must be recent (STORE-01).
  'gc-store-price-sheet': { maxAgeMs: 15 * 60_000, scope: 'account', proves: 'set' }
};

export const ACCOUNT_INVENTORY: SurfaceRef = { surface: 'gc-inventory', scope: { kind: 'account' } };
export const ACCOUNT_MARKET: SurfaceRef = { surface: 'steam-market', scope: { kind: 'account' } };
export const ACCOUNT_WALLET: SurfaceRef = { surface: 'steam-wallet', scope: { kind: 'account' } };
export const ACCOUNT_HISTORY: SurfaceRef = { surface: 'steam-market-history', scope: { kind: 'account' } };
export const ACCOUNT_STORAGE_UNITS: SurfaceRef = { surface: 'gc-storage-units', scope: { kind: 'account' } };
/**
 * The name a request or a message gives a scope, and the key the read broker, its breakers and its
 * backoff hold the scope under. Never an observation's `surface`: a casket's observation is surface
 * `gc-casket` with the casket in `scope_id` (consolidation plan D14).
 *
 * Every scope that is not the account's carries its id. Until 2026-10-19 only `gc-casket` did, so
 * every `csfloat-listing` need joined the one broker entry the first listing had made: a second
 * delist waiting beside it was never read, and the first was read every five seconds for good
 * (adversarial testing plan §0.1). `G-INV-13` holds this injective.
 */
export function surfaceName(ref: SurfaceRef): string {
  return ref.scope.kind === 'account' ? ref.surface : `${ref.surface}:${ref.scope.id ?? ''}`;
}
export function surfaceOf(obs: ObservationRow): Surface {
  return obs.surface as Surface;
}
export function freshness(obs: ObservationRow | undefined, surface: Surface, now: Date): Freshness {
  if (!obs) return 'NEVER';
  if (!obs.complete || obs.error || !FRESHNESS[surface]) return 'INCOMPLETE';
  const age = now.getTime() - Date.parse(obs.started_at);
  return !Number.isFinite(age) || age < 0 || age > FRESHNESS[surface].maxAgeMs ? 'STALE' : 'FRESH';
}
export function satisfied<T>(value: T, obs: ObservationRow): Evidence<T> {
  return { grade: 'SATISFIED', value, observationId: obs.id, observedAt: obs.finished_at };
}

/** A walk must start after the attempt finished. A point sighting can arrive during a call;
 * its persisted observation watermark breaks ties at the clock's millisecond precision. */
export function postAttempt(database: EngineDatabase, action: ActionRow, obs: ObservationRow, absence: boolean): boolean {
  const attempt = database.latestAttempt(action.id);
  if (!attempt || obs.account_id !== action.account_id) return false;
  if (obs.id <= attemptWatermark(attempt)) return false;
  if (absence) return Boolean(attempt.finished_at && obs.started_at > attempt.finished_at);
  return obs.started_at >= attempt.started_at;
}

/** The newest observation the record held when the attempt began (`startAttempt`): nothing at or below it can have seen its effect. */
export function attemptWatermark(attempt: AttemptRow): number {
  return attempt.request_ref ? (JSON.parse(attempt.request_ref) as { observationWatermark?: number }).observationWatermark ?? 0 : 0;
}

/** When an action's last attempt returned: the moment the walks that prove it must begin after. */
export function attemptReturned(database: EngineDatabase, action: ActionRow): string {
  const attempt = database.latestAttempt(action.id);
  return attempt?.finished_at ?? attempt?.started_at ?? action.updated_at;
}

export function surfaceEvidence(database: EngineDatabase, accountId: string, ref: SurfaceRef, now: Date, absence = false, action?: ActionRow): Evidence<ObservationRow> {
  const obs = database.latestObservationForScope(accountId, ref.scope.kind, ref.scope.id ?? null, ref.surface);
  const state = freshness(obs, ref.surface, now);
  if (!obs || state !== 'FRESH' || (absence && FRESHNESS[ref.surface].proves !== 'set') || (action && !postAttempt(database, action, obs, absence))) {
    return { grade: 'UNKNOWN', want: ref, freshness: state === 'FRESH' ? 'INCOMPLETE' : state };
  }
  return satisfied(obs, obs);
}

/** The walk that proves where an item is: its unit's, or the inventory's. A listing never moves it. */
export function locationSurface(item: ItemRow | undefined): SurfaceRef {
  if (item?.casket_id && item.location === 'CASKET') return { surface: 'gc-casket', scope: { kind: 'casket', id: item.casket_id } };
  return ACCOUNT_INVENTORY;
}

export function locationEvidence(database: EngineDatabase, accountId: string, localId: string, location: ItemRow['location'], now: Date, action?: ActionRow): Evidence<ItemRow> {
  const item = database.itemByLocalId(accountId, localId);
  const want = locationSurface(item);
  let obs = database.observation(accountId, item?.location_obs ?? null);
  if (obs && !obs.complete) {
    obs = database.latestCompleteObservationForScope(accountId, obs.scope_kind ?? 'account', obs.scope_id, obs.surface) ?? obs;
  }
  const surface = obs ? surfaceOf(obs) : want.surface;
  const state = freshness(obs, surface, now);
  const newest = obs && database.latestCompleteObservationForScope(accountId, obs.scope_kind ?? 'account', obs.scope_id, obs.surface);
  if (!item || !obs || state !== 'FRESH' || (newest && newest.id > obs.id && freshness(newest, surface, now) !== 'FRESH')) {
    return { grade: 'UNKNOWN', want, freshness: state };
  }
  const absence = item.location === 'MISSING';
  if ((absence && FRESHNESS[surface].proves !== 'set') || (action && !postAttempt(database, action, obs, absence))) {
    return { grade: 'UNKNOWN', want, freshness: 'INCOMPLETE' };
  }
  return item.location === location ? satisfied(item, obs)
    : { grade: 'UNSATISFIED', reason: `Item is ${item.location}; requires ${location}`, observationId: obs.id };
}

export type ActionKind = 'CREATE_SELL_LISTING' | 'RETRIEVE_FROM_CASKET' | 'STORE_IN_CASKET' | 'RENAME_CASKET';
export type Precondition = 'main' | 'casket' | 'asset' | 'trade-protection' | 'market-lock' | 'no-open-order' | 'main-room' | 'casket-room' | 'casket-owned';
export const PRECONDITIONS: Record<ActionKind, readonly Precondition[]> = {
  CREATE_SELL_LISTING: ['main', 'asset', 'trade-protection', 'market-lock', 'no-open-order'],
  RETRIEVE_FROM_CASKET: ['casket', 'asset', 'trade-protection', 'main-room'],
  STORE_IN_CASKET: ['main', 'asset', 'trade-protection', 'casket-room'],
  // A unit is never listed, never inside another unit and never trade-locked, so the only
  // thing a rename has to know is that a fresh unit walk still lists it for this account.
  RENAME_CASKET: ['casket-owned']
};

export function evaluatePreconditions(database: EngineDatabase, accountId: string, localId: string, checks: readonly Precondition[], now: Date, casketId?: string, consent: readonly MarketplaceConsent[] = []): Evidence<unknown>[] {
  const item = database.itemByLocalId(accountId, localId);
  return checks.map((check): Evidence<unknown> => {
    if (check === 'casket-owned') {
      const evidence = surfaceEvidence(database, accountId, ACCOUNT_STORAGE_UNITS, now, true);
      if (evidence.grade !== 'SATISFIED') return evidence;
      const unit = database.storageUnit(accountId, casketId ?? '');
      return unit ? satisfied(unit, evidence.value)
        : { grade: 'UNSATISFIED', reason: 'Storage unit is not owned by this account', observationId: evidence.observationId };
    }
    if (check === 'main') {
      const reason = marketplaceBlock(database,accountId,localId,checks.includes('no-open-order') ? 'steam-list' : 'storage',now.toISOString(),'',consent);
      if (reason) return { grade: 'UNSATISFIED', reason, observationId: 0 };
    }
    if (check === 'main' || check === 'casket') return locationEvidence(database, accountId, localId, check === 'main' ? 'MAIN' : 'CASKET', now);
    if (check === 'no-open-order') {
      const evidence = surfaceEvidence(database, accountId, ACCOUNT_MARKET, now, true);
      if (evidence.grade !== 'SATISFIED') return evidence;
      // One question, by the holding's row and by its asset id, which the book may know a unit by
      // before a walk bound the row (D5); Steam's own when cross-venue protection is off (XLIST-03).
      const everyVenue = new CsfloatStore(database).policy().preventDuplicates;
      const committed = database.raw().prepare(`SELECT 1 FROM item i WHERE i.account_id=? AND i.local_id=? AND ${committedSql('i', everyVenue ? undefined : 'steam')}`).get(accountId, localId);
      return committed ? { grade: 'UNSATISFIED', reason: 'Item already has an open or unexplained order', observationId: evidence.observationId } : satisfied(true, evidence.value);
    }
    if (check === 'main-room' || check === 'casket-room') {
      const ref: SurfaceRef = check === 'main-room' ? ACCOUNT_INVENTORY : { surface: 'gc-casket', scope: { kind: 'casket', id: casketId ?? '' } };
      const evidence = surfaceEvidence(database, accountId, ref, now, true);
      if (evidence.grade !== 'SATISFIED') return evidence;
      const count = check === 'main-room' ? database.countMainItems(accountId) : evidence.value.total_expected ?? 1000;
      return count < 1000 ? satisfied(1000 - count, evidence.value)
        : { grade: 'UNSATISFIED', reason: check === 'main-room' ? 'Main inventory hard cap reached' : 'Casket capacity reached', observationId: evidence.observationId };
    }
    const evidence = locationEvidence(database, accountId, localId, item?.location ?? 'MAIN', now);
    if (evidence.grade !== 'SATISFIED') return evidence;
    if (check === 'asset') return item?.asset_id ? evidence : { grade: 'UNSATISFIED', reason: 'Item has no current Steam asset id', observationId: evidence.observationId };
    const until = check === 'trade-protection' ? item?.trade_protected_until : item?.tradable_after;
    return until && Date.parse(until) > now.getTime()
      ? { grade: 'UNSATISFIED', reason: `${check} until ${until}`, observationId: evidence.observationId, blockedUntil: until }
      : evidence;
  });
}

/**
 * A precondition no complete, fresh walk can answer yet. It is not a refusal: an incomplete or
 * stale read proves nothing either way (rule 5), so a caller that can wait for the walk does.
 */
export class ObservationRequired extends Error {
  constructor(readonly want: SurfaceRef, readonly freshness: Freshness) {
    super(`Observation required: ${surfaceName(want)} (${freshness})`);
    this.name = 'ObservationRequired';
  }
}

/**
 * Throws the first refusal, and only when there is none, the first read still owed. A
 * precondition a walk has already refused is not worth waiting on another for.
 */
export function requirePreconditions(evidence: Evidence<unknown>[]): void {
  const refused = evidence.find((entry) => entry.grade === 'UNSATISFIED');
  if (refused?.grade === 'UNSATISFIED') throw new Error(refused.reason);
  const unknown = evidence.find((entry) => entry.grade === 'UNKNOWN');
  if (unknown?.grade === 'UNKNOWN') throw new ObservationRequired(unknown.want, unknown.freshness);
}
