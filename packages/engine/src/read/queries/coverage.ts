import type { EngineDatabase } from '../../db/database.js';

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
