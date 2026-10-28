import type { EngineDatabase } from '../../db/database.js';
import { TradeStore } from '../../db/trades.js';

/**
 * What one answer rests on: the latest walk of a surface, when it finished, and whether it did.
 *
 * Rule 5 carried into a read model. A read that reports rows without saying whether the walk that
 * wrote them finished invites the caller to read a floor as a total, so every read that answers
 * "these are all of them" names its walks. `observedAt: null` is "never walked", which is not the
 * same as "walked and found nothing".
 */
export type SurfaceCoverage = {
  accountId: string;
  surface: string;
  observedAt: string | null;
  complete: number;
  error: string | null;
};

export function surfaceCoverage(database: EngineDatabase, accountId: string, surface: string): SurfaceCoverage {
  const observation = database.latestObservation(accountId, surface);
  return {
    accountId,
    surface,
    observedAt: observation?.finished_at ?? null,
    complete: observation?.complete === 1 ? 1 : 0,
    error: observation?.error ?? null
  };
}

export const HISTORY_SURFACES = ['steam-market-history', 'steam-trade-history'] as const;
export type HistorySurface = (typeof HISTORY_SURFACES)[number];

/**
 * How much of an account's history the record holds: one row per history, from the coverage its
 * walk committed (`surface_state`) and the walk that last moved it.
 *
 * A history is read from the newest event down, a few pages a walk, so for a while the record holds
 * one contiguous segment from the top and owes the rest (history backfill plan D1, D2). `covered`
 * is that segment's size, `total` the venue's own count when it named one, and `remaining` what lay
 * below the boundary at the last walk, null while the venue has named no total and the end has not
 * been reached. The figures are the venue's and move as new events land. `stopped` says why a
 * backfill gave up short of the end; a backfill that is merely paused by a hold is the broker's to
 * report (`refresh.status`), not this read's.
 */
export type HistoryCoverageRow = SurfaceCoverage & {
  surface: HistorySurface;
  covered: number;
  total: number | null;
  remaining: number | null;
  stopped: string | null;
};

export function historyCoverage(database: EngineDatabase, accountId: string): HistoryCoverageRow[] {
  return HISTORY_SURFACES.map((surface) => {
    const base = surfaceCoverage(database, accountId, surface);
    if (surface === 'steam-trade-history') {
      const coverage = new TradeStore(database).historyCoverage(accountId);
      if (!coverage) return { ...base, surface, covered: 0, total: null, remaining: null, stopped: null };
      const remaining = coverage.reachedEnd ? 0 : coverage.total === null ? null : Math.max(0, coverage.total - coverage.coveredCount);
      return { ...base, surface, covered: coverage.coveredCount, total: coverage.total, remaining, stopped: coverage.stopped ?? null };
    }
    const row = database.checkpoint(accountId, surface);
    const cursor = row ? JSON.parse(row.cursor_json) as { coveredCount?: unknown; remaining?: unknown; stopped?: unknown } : undefined;
    if (!cursor || !Number.isSafeInteger(cursor.coveredCount) || !Number.isSafeInteger(cursor.remaining)) {
      return { ...base, surface, covered: 0, total: null, remaining: null, stopped: null };
    }
    const covered = cursor.coveredCount as number;
    const remaining = cursor.remaining as number;
    return { ...base, surface, covered, total: covered + remaining, remaining, stopped: typeof cursor.stopped === 'string' ? cursor.stopped : null };
  });
}
