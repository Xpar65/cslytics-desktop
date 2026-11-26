import type { EngineDatabase } from '../db/database.js';
import type { Surface } from './evidence.js';

/**
 * A venue's daily allowance of reads of one surface, per account, counted from the record.
 *
 * CSFloat allows 120 calls to `GET /me/inventory` in 24 hours (`csfloat.me.inventory`). On
 * 2026-11-10 a trading account spent them in ten hours — a read before every listing and five
 * after every retrieve — and then made about fifty refused calls an hour while every listing was
 * refused for want of a read (CSF-58). So the broker counts every walk of the surface begun in the
 * last 24 hours, complete or not, since a venue counts calls rather than answers, and starts none
 * past the budget:
 *
 * - `dailyCap`: no walk past this, whoever asks. Ten under the venue's own, because whether a call
 *   the venue refused counts against it is unknown.
 * - `automationCap`: a walk no person asked for stops here, leaving the rest for a person's Refresh.
 * - `spacingMs`: a walk no person asked for begins at least this long after the last one began.
 *
 * The count lives in the record, so a restart cannot reset it, and a walk that never started costs
 * nothing. Only a surface named here has a budget.
 */
export type ReadBudget = { dailyCap: number; automationCap: number; spacingMs: number };

export const READ_BUDGETS: Readonly<Partial<Record<Surface, ReadBudget>>> = {
  'csfloat-inventory': { dailyCap: 110, automationCap: 96, spacingMs: 15 * 60_000 }
};

/** The window a venue's daily allowance is counted over. */
export const READ_BUDGET_WINDOW_MS = 24 * 60 * 60_000;

/** What a read refused for the whole budget is told, and what the window shows while it lasts. */
export const READ_BUDGET_SPENT_REASON = 'daily read limit spent';
/** What a read no person asked for is told once the automatic share is spent. */
export const AUTOMATION_BUDGET_SPENT_REASON = 'automatic share of the daily read limit spent';

export type BudgetVerdict =
  | { kind: 'open' }
  /** Nobody reads before `untilMs`, a person included. */
  | { kind: 'spent'; untilMs: number; reason: string }
  /** Only a person reads before `untilMs`; `reason` is null when this is only the spacing between reads. */
  | { kind: 'person-only'; untilMs: number; reason: string | null };

const OPEN: BudgetVerdict = { kind: 'open' };

/**
 * Whether a walk of `surface` may begin at `nowMs`, and if not, until when and for whom. The
 * moment a spent budget frees is when the oldest walk in the window leaves it.
 */
export function readBudget(db: EngineDatabase, accountId: string, surface: Surface, nowMs: number): BudgetVerdict {
  const budget = READ_BUDGETS[surface];
  if (!budget) return OPEN;
  const { count, first } = db.observationsSince(accountId, surface, new Date(nowMs - READ_BUDGET_WINDOW_MS).toISOString());
  const freesAt = first === null ? nowMs : Date.parse(first) + READ_BUDGET_WINDOW_MS;
  if (count >= budget.dailyCap) return { kind: 'spent', untilMs: freesAt, reason: READ_BUDGET_SPENT_REASON };
  if (count >= budget.automationCap) return { kind: 'person-only', untilMs: freesAt, reason: AUTOMATION_BUDGET_SPENT_REASON };
  const last = db.latestObservation(accountId, surface);
  const nextAt = last ? Date.parse(last.started_at) + budget.spacingMs : nowMs;
  return nextAt > nowMs ? { kind: 'person-only', untilMs: nextAt, reason: null } : OPEN;
}

/**
 * When reads of `surface` are paused for the whole budget, or null: what the work panel says
 * beside a listing that waits on CSFloat (`read/queries/work.ts`). The spacing between reads is
 * the ordinary pace, not a pause, and is not reported.
 */
export function readsPausedUntil(db: EngineDatabase, accountId: string, surface: Surface, nowMs: number): string | null {
  const verdict = readBudget(db, accountId, surface, nowMs);
  return verdict.kind === 'spent' || (verdict.kind === 'person-only' && verdict.reason !== null) ? new Date(verdict.untilMs).toISOString() : null;
}
