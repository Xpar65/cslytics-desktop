import type { EngineDatabase } from '../../db/database.js';
import { assertAccountScope } from './paging.js';

/**
 * The `event` rows that are a fact a person is told of (notifications plan §7.2): written once by
 * the walk that observed it, never by a window, and read by the desktop through a watermark it
 * keeps in a file of its own. The trading record keeps what happened; the desktop keeps what it
 * told you. Only these kinds are facts for the bell; the rest of the log is the engine's own.
 */
export const FACT_KINDS = ['trade-reversed', 'BUY_ORDER_FILL'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
/** Where a reader is up to: the last fact it took, by its instant and, within an instant, its id. */
export type FactCursor = { at: string; id: string };
export type FactRow = { id: string; kind: FactKind; at: string; payload: Record<string, unknown> };
export type FactsPage = { accountId: string; rows: FactRow[]; cursor: FactCursor | null; more: boolean };
export type FactsRequest = { accountId: string; after: FactCursor | null; limit?: number | undefined };

export const FACTS_PAGE_LIMIT = 100;

/**
 * The facts of one account after a cursor, oldest first and bounded, with the cursor to continue
 * from: the last row's, or the one asked with when nothing is newer. `more` says another page
 * waits. Served by `event_page` (account, at, id); the cursor orders the same way.
 */
export function factsSince(database: EngineDatabase, request: FactsRequest): FactsPage {
  const [accountId] = assertAccountScope(database, [request.accountId]) as [string];
  const limit = Math.max(1, Math.min(request.limit ?? FACTS_PAGE_LIMIT, FACTS_PAGE_LIMIT));
  const after = request.after ?? { at: '', id: '' };
  const rows = database.raw().prepare(`SELECT id, kind, payload_json, at FROM event
      WHERE account_id=? AND kind IN (${FACT_KINDS.map(() => '?').join(',')}) AND (at > ? OR (at = ? AND id > ?))
      ORDER BY at, id LIMIT ?`)
    .all(accountId, ...FACT_KINDS, after.at, after.at, after.id, limit + 1) as Array<{ id: string; kind: FactKind; payload_json: string; at: string }>;
  const page = rows.slice(0, limit).map((row) => ({ id: row.id, kind: row.kind, at: row.at, payload: parsePayload(row.payload_json) }));
  const last = page.at(-1);
  return { accountId, rows: page, cursor: last ? { at: last.at, id: last.id } : request.after, more: rows.length > limit };
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
