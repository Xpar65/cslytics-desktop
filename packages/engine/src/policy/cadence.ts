import type { EngineDatabase, ObservationRow } from '../db/database.js';
import { FRESHNESS, freshness, type Surface, type SurfaceRef } from '../kernel/evidence.js';

/**
 * When a surface is next worth reading.
 *
 * Pure: given the latest observation for a scope and the account's tier, it returns a due time. It
 * reaches no port, opens no transaction and reads no clock of its own.
 *
 * The base intervals extend `FRESHNESS` rather than restating it. `FRESHNESS` already answers
 * "how long is one complete observation worth trusting?", and "refresh before it stops being
 * trustworthy" is the same number — a second, independently maintained table would drift, and
 * the drift would show up as evidence going `STALE` in the middle of a planner tick.
 *
 * The numbers are the ones settled in
 * `cslytics-app-docs/plans/completed/continuous-freshness-plan.md` §4.2 and §9. They are engineering
 * choices, not measured Steam limits. Whether several accounts behind one IP share Steam's
 * budget or are counted independently is **unmeasured** (plan §9.2), so the runtime keeps both a
 * per-account and a process-wide budget and this table stays deliberately unhurried.
 */
export type Tier = 'ACTIVE' | 'BACKGROUND';

export type CadenceRule = {
  /** How often to read when the account is the one on screen. */
  activeMs: number;
  /** How often to read when the account is signed in but not being looked at. */
  backgroundMs: number;
  /**
   * True when a timer alone should never schedule this surface.
   *
   * Casket contents are the case. While this app holds the CS2 session — which is exclusive per
   * account — nothing else can move an item into or out of a unit, so a periodic walk of every
   * casket would spend the GC budget proving that nothing changed. They refresh on the events
   * that imply a change, and on the post-reconnect sweep that covers the one window in which a
   * change could have gone unseen.
   */
  eventDrivenOnly?: boolean;
};

export const CADENCE: Record<Surface, CadenceRule> = {
  'csfloat-inventory': { activeMs: 15 * 60_000, backgroundMs: 60 * 60_000, eventDrivenOnly: true },
  // Admission and dispatch both refuse an item whose sales book has lapsed rather than read an
  // unwalked book as an empty one (CSF-13), so this interval is the freshness window and not a
  // separately chosen number. At ninety minutes against a five-minute window the book was outside
  // it for all but the first five minutes of each cycle, and storing, listing or transferring any
  // item on a CSFloat-connected account was refused for the rest of it.
  'csfloat-trades': { activeMs: FRESHNESS['csfloat-trades'].maxAgeMs, backgroundMs: 20 * 60_000 },
  'csfloat-trade': { activeMs: 60_000, backgroundMs: 5 * 60_000, eventDrivenOnly: true },
  // One listing by id. The broker has a scope for one only while a delist or reprice waits on it
  // (`ReadBroker.scopes`), so a timer here reads nothing else; it is what keeps reading after
  // the proof bound, so a delist CSFloat could not be read for during an outage is still read
  // for once it answers, rather than waiting for someone to refresh (CSF-45).
  'csfloat-listing': { activeMs: 5 * 60_000, backgroundMs: 20 * 60_000 },
  'steam-trade-inventory': { activeMs: 5 * 60_000, backgroundMs: 20 * 60_000, eventDrivenOnly: true },
  'gc-inventory': { activeMs: FRESHNESS['gc-inventory'].maxAgeMs, backgroundMs: 20 * 60_000 },
  'gc-casket': { activeMs: 15 * 60_000, backgroundMs: 60 * 60_000, eventDrivenOnly: true },
  'gc-storage-units': { activeMs: 15 * 60_000, backgroundMs: 60 * 60_000 },
  'gc-event': { activeMs: Number.POSITIVE_INFINITY, backgroundMs: Number.POSITIVE_INFINITY, eventDrivenOnly: true },
  'steam-market': { activeMs: FRESHNESS['steam-market'].maxAgeMs, backgroundMs: 20 * 60_000 },
  'steam-market-history': { activeMs: FRESHNESS['steam-market-history'].maxAgeMs, backgroundMs: 60 * 60_000 },
  'steam-wallet': { activeMs: 10 * 60_000, backgroundMs: 60 * 60_000 },
  // Trades happen on someone else's schedule, so both surfaces are timer-driven. History is
  // read less often than offers because a checkpointed walk of an append-only log costs one
  // page when nothing happened, and an offer is the thing that blocks the user's own work.
  'steam-trade-offers': { activeMs: FRESHNESS['steam-trade-offers'].maxAgeMs, backgroundMs: 20 * 60_000 },
  'steam-trade-history': { activeMs: FRESHNESS['steam-trade-history'].maxAgeMs, backgroundMs: 60 * 60_000 },
  // A face changes rarely. Both tiers use the same 24h interval so a background account still
  // gets a fresh hash once a day without spending CM budget more often than an active one.
  'steam-persona': { activeMs: FRESHNESS['steam-persona'].maxAgeMs, backgroundMs: FRESHNESS['steam-persona'].maxAgeMs },
  // An account's own CSFloat status changes when the venue decides it does — a balance
  // settles, a restriction lands — so it is timer-driven, and cheap: one request, one row.
  'csfloat-account-status': { activeMs: FRESHNESS['csfloat-account-status'].maxAgeMs, backgroundMs: 30 * 60_000 },
  // Roughly 50,000 stall reads a day were remaining after one call (fixtures/csfloat/INDEX.md),
  // so the cadence is set by what the user needs to see rather than by the budget.
  'csfloat-stall': { activeMs: FRESHNESS['csfloat-stall'].maxAgeMs, backgroundMs: 20 * 60_000 },
  // The own buy-order book shares the stall's 50,000-a-day family (fixtures/csfloat/INDEX.md), so
  // its cadence too is set by what the Buy orders page needs to show rather than by the budget.
  'csfloat-buy-orders': { activeMs: FRESHNESS['csfloat-buy-orders'].maxAgeMs, backgroundMs: 20 * 60_000 },
  // Read when the Store screen asks or a purchase is admitted. Nothing in the background needs
  // to know what Valve is selling today.
  'gc-store-price-sheet': { activeMs: FRESHNESS['gc-store-price-sheet'].maxAgeMs, backgroundMs: 60 * 60_000, eventDrivenOnly: true }
};

/**
 * How long to leave the wallet alone when nothing could have moved it (plan §9.4).
 *
 * With no open listing, no live buy order and no recent sale, the only remaining cause of a
 * balance change is the user adding funds on the Steam website — and every *other* cause already
 * has a trigger that reads the wallet immediately. So the timer exists solely for the website
 * case, and six hours is plenty.
 */
export const WALLET_QUIET_MS = 6 * 60 * 60_000;

/** The order a pass reads surfaces in: cheapest and most explanatory first. */
export const SURFACE_ORDER: readonly Surface[] = [
  'steam-persona', 'gc-inventory', 'gc-storage-units', 'gc-casket', 'steam-market', 'steam-market-history', 'steam-wallet',
  'steam-trade-offers', 'steam-trade-history'
];

export type BackoffState = {
  consecutiveFailures: number;
  notBeforeMs: number;
  /** The venue refused the read for its pace. Nothing but time lifts this hold (`policy/backoff.ts`). */
  rateLimited?: boolean;
};

export type DueInput = {
  ref: SurfaceRef;
  tier: Tier;
  /** The latest observation for exactly this scope, or undefined when there has never been one. */
  observation: ObservationRow | undefined;
  now: Date;
  /** Only meaningful for `steam-wallet`: false lets the quiet interval apply. */
  hasOpenCommitment?: boolean;
  /** An owned transfer is waiting on offers, or on both inventories after acceptance. */
  transferIntervalMs?: number;
  /** When a waiting action's need makes this scope due (`policy/proof.ts`). */
  proofDueAtMs?: number | undefined;
  /** A history still has older pages to read (`OrderService.coverage`, `TradeService.coverage`): the backfill interval caps the tier's. */
  backfillPending?: boolean;
};

/**
 * How soon a history is read again while older pages remain. A walk reads the top of the log and
 * at most a few pages (`HISTORY_PAGES_PER_WALK` for the market history, `TRADE_HISTORY_PAGES_PER_WALK`
 * for executed trades), so an account whose log is deep is covered over several walks rather than
 * one; two minutes apart keeps the per-endpoint budget untouched and finishes a log of fifty pages
 * inside half an hour. The interval is the same in both tiers: a log is finished whether or not
 * anyone is looking at the account.
 */
export const HISTORY_BACKFILL_EVERY_MS = 2 * 60_000;

export type DueVerdict =
  | { due: true; because: 'never-observed' | 'proof' | 'stale' | 'incomplete' }
  | { due: false; because: 'fresh' | 'event-driven-only'; nextDueAtMs: number };

export function baseIntervalMs(surface: Surface, tier: Tier, hasOpenCommitment = true): number {
  const rule = CADENCE[surface];
  if (surface === 'steam-wallet' && !hasOpenCommitment) return WALLET_QUIET_MS;
  return tier === 'ACTIVE' ? rule.activeMs : rule.backgroundMs;
}

/**
 * Whether this surface is worth reading now, from its evidence alone: the cadence source of the
 * read broker (read broker plan D10).
 *
 * Note what is *not* here. Nothing about actions, attempts or mutations: this decides when to
 * look, never whether to act, and re-sending a mutation is repository rule 1's business. And
 * nothing about holds or requests: a scope held after a failure, and a read somebody asked for,
 * are the broker's own state. It raises a need for a due scope and keeps it through a hold, so a
 * verdict here is never past a hold and never consumed by one.
 */
export function isDue(input: DueInput): DueVerdict {
  const nowMs = input.now.getTime();
  const surface = input.ref.surface;
  const rule = CADENCE[surface];

  const proofAtMs = input.proofDueAtMs ?? Number.POSITIVE_INFINITY;
  if (proofAtMs <= nowMs) return { due: true, because: 'proof' };
  if (rule.eventDrivenOnly) {
    return { due: false, because: 'event-driven-only', nextDueAtMs: proofAtMs };
  }
  if (!input.observation) return { due: true, because: 'never-observed' };

  const grade = freshness(input.observation, surface, input.now);
  // An incomplete walk proves nothing (rule 5), so it does not reset the clock: the scope is due
  // again as soon as the hold its failure earned lifts, which the broker waits out.
  if (grade === 'INCOMPLETE') return { due: true, because: 'incomplete' };

  const interval = Math.min(baseIntervalMs(surface, input.tier, input.hasOpenCommitment ?? true), input.transferIntervalMs ?? Infinity,
    input.backfillPending ? HISTORY_BACKFILL_EVERY_MS : Infinity);
  const startedMs = Date.parse(input.observation.started_at);
  if (!Number.isFinite(startedMs)) return { due: true, because: 'incomplete' };
  const staleAtMs = startedMs + interval;
  return nowMs >= staleAtMs ? { due: true, because: 'stale' } : { due: false, because: 'fresh', nextDueAtMs: Math.min(staleAtMs, proofAtMs) };
}

/**
 * True when this account holds something that could move its wallet without the user acting.
 *
 * Read from the one order table: a listing or a buy order on any venue that no observation has
 * closed out, which includes a request of ours no walk has yet shown.
 */
export function hasOpenCommitment(database: EngineDatabase, accountId: string): boolean {
  const row = database.raw().prepare(`
    SELECT COUNT(*) AS open_orders FROM venue_order WHERE account_id=? AND state NOT LIKE 'ENDED_%'
  `).get(accountId) as { open_orders: number };
  return row.open_orders > 0;
}

/** The latest observation for one scope, in the shape `isDue` wants. */
export function latestFor(database: EngineDatabase, accountId: string, ref: SurfaceRef): ObservationRow | undefined {
  return database.latestObservationForScope(
    accountId,
    FRESHNESS[ref.surface].scope,
    ref.scope.id ?? null,
    ref.surface
  );
}
