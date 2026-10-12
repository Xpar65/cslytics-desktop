import { createHash, randomUUID } from 'node:crypto';
import type { EngineDatabase } from '../../db/database.js';

/**
 * What every paged read shares: the bounds, the account scope, the revision a cursor is bound to,
 * and `queryPage`, the one keyset pager. The domains live beside it — `inventory.ts`, `work.ts`,
 * `records.ts`, `listings.ts` — and none of them hand-rolls a cursor.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 250;
export const MAX_RESPONSE_BYTES = 1_048_576;
export type ScopedPageRequest = { accountIds: readonly string[]; pageSize?: number; cursor?: string; filter?: { search?: string | undefined; state?: string | undefined; eventType?: number | undefined } };
export type PageTotals = { handles: number; groups: number; quantity: number; rows?: number };
export type PageEnvelope<T> = { kind: 'page'; requestId: string; revision: string; rows: T[]; nextCursor: string | null; hasNext: boolean; total: PageTotals }
  | { kind: 'stale-page'; reason: string };
export type Param = string | number | null;
type Cursor = { binding: string; revision: string; after: Param[] };

export function boundPageSize(size = DEFAULT_PAGE_SIZE): number {
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw new Error(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  return size;
}
export function assertAccountScope(database: EngineDatabase, ids: readonly string[]): string[] {
  const accounts = [...new Set(ids)].sort();
  if (!accounts.length || accounts.length > 32 || accounts.length !== ids.length) throw new Error('accountIds must name 1–32 distinct accounts');
  if (database.knownAccountIds(accounts).length !== accounts.length) throw new Error('Unknown account in scope');
  return accounts;
}
export function readRevision(database: EngineDatabase, accounts: readonly string[]): string {
  return accounts.map(id => `${id}:${database.publication(id, 'gc-inventory', '')?.published_generation ?? 0}`).join('|');
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function decode(cursor: string): Cursor {
  if (cursor.length > 4096) throw new Error('cursor is too large');
  let parsed: Cursor;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor; }
  catch { throw new Error('cursor is malformed'); }
  if (!parsed || typeof parsed.binding !== 'string' || typeof parsed.revision !== 'string' || !Array.isArray(parsed.after)
    || parsed.after.length > 5 || parsed.after.some(v => typeof v !== 'string' && typeof v !== 'number')) throw new Error('cursor is malformed');
  return parsed;
}
export function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Response exceeds 1 MiB');
  return value;
}

/**
 * Anything a domain can page: a scope, a size, a cursor, an opaque filter and an optional sort.
 *
 * Deliberately wider than any one domain's request, because each has its own sort vocabulary
 * (`inventory.ts`, `listings.ts`) and the binding hash below only needs to see *a* sort to keep a
 * cursor from surviving a change of one.
 */
type PageableRequest = {
  accountIds: readonly string[]; pageSize?: number | undefined; cursor?: string | undefined; filter?: unknown; sort?: string | undefined;
  /**
   * Which way every key runs. One direction for all of them, never a mix: the cursor is a single
   * row-value comparison, and `(a, b) < (?, ?)` only means "after" when `a` and `b` both descend.
   */
  direction?: 'asc' | 'desc' | undefined;
};

/** Shared by every paged read: cursor, revision and bounds. */
export function queryPage<T>(database: EngineDatabase, request: PageableRequest, domain: string,
  sql: string, params: Param[], keys: string[], totals?: PageTotals): PageEnvelope<T> {
  const accounts = assertAccountScope(database, request.accountIds);
  const size = boundPageSize(request.pageSize);
  const descending = request.direction === 'desc';
  // A cursor read going one way is not a cursor into the other, so the direction is bound too. It
  // joins the hash only when it descends, which keeps every ascending cursor already issued valid.
  const binding = hash({ domain, accounts, filter: request.filter ?? {}, sort: 'sort' in request ? request.sort ?? 'localId' : '', ...(descending ? { direction: 'desc' } : {}) });
  const marks = database.raw().prepare(`SELECT account_id, surface, revision FROM read_revision WHERE account_id IN (${accounts.map(() => '?')}) ORDER BY account_id,surface`).all(...accounts);
  const revision = hash([marks, readRevision(database, accounts)]);
  const cursor = request.cursor ? decode(request.cursor) : undefined;
  if (cursor && (cursor.binding !== binding || cursor.revision !== revision || cursor.after.length !== keys.length)) return { kind: 'stale-page', reason: 'cursor does not match surface, scope, filter, sort or revision' };
  const count = totals ?? (() => {
    const row = database.raw().prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number };
    return { handles: row.n, quantity: row.n, groups: row.n, rows: row.n };
  })();
  const rows = database.raw().prepare(`SELECT * FROM (${sql}) ${cursor ? `WHERE (${keys.join(',')})${descending ? '<' : '>'}(${keys.map(() => '?').join(',')})` : ''} ORDER BY ${keys.map((key) => (descending ? `${key} DESC` : key)).join(',')} LIMIT ?`)
    .all(...params, ...(cursor?.after ?? []), size + 1) as Array<T & Record<string, Param>>;
  const hasNext = rows.length > size;
  if (hasNext) rows.pop();
  const last = rows.at(-1);
  return bounded({ kind: 'page', requestId: randomUUID(), revision, rows,
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ binding, revision, after: keys.map(k => last[k]) })).toString('base64url') : null,
    hasNext, total: count });
}
