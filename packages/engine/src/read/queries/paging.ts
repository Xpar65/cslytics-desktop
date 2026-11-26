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
/** The inventory each account's cursors were cut over: the last complete walk of it. */
export function readRevision(database: EngineDatabase, accounts: readonly string[]): string {
  return accounts.map(id => `${id}:${database.latestCompleteObservationForScope(id, 'account', null, 'gc-inventory')?.id ?? 0}`).join('|');
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function decode(cursor: string): Cursor {
  if (cursor.length > 4096) throw new Error('cursor is too large');
  let parsed: Cursor;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor; }
  catch { throw new Error('cursor is malformed'); }
  // Five keys at most, each carried as two values by `queryPage` (`afterOf`).
  if (!parsed || typeof parsed.binding !== 'string' || typeof parsed.revision !== 'string' || !Array.isArray(parsed.after)
    || parsed.after.length > 10 || parsed.after.some(v => typeof v !== 'string' && typeof v !== 'number')) throw new Error('cursor is malformed');
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

/**
 * One walk of a paged read past its first page: every row of the read, in page order, as the
 * statement answered it once, with the position after each row's keys. A read whose statement
 * costs more than a page (a joined or derived entry list, a sort no index serves) used to run it
 * twice a page, a count and a sort, so walking a long list cost pages × the whole list (a trading
 * host's 9,500-entry trade history: 38 pages, 0.2 s of SQL each, on every pass). Keyed by the
 * cursor's own binding and revision and the statement, so a walk is served from it exactly while
 * its cursors are good: anything that would make a cursor stale makes a new key.
 */
type Walk = { rows: Array<Record<string, Param>>; after: Map<string, number>; total: PageTotals };
const walks = new WeakMap<EngineDatabase, Map<string, Walk>>();
/** Walks kept per database, least recently read dropped first: a few readers walking at once, not a history. */
export const WALKS_KEPT = 8;

/**
 * A row's place in a keyset, as a cursor carries it: per key, whether it has a value (0 or 1) and the value (0 for
 * none), never a null. A null cannot be compared (`(a, b) > (?, ?)` with a null is neither true nor false, which
 * strands every row behind it) and `decode` refuses one, so a page that ended on a row with a missing key used to
 * answer `cursor is malformed` for the next (seen 2026-11-11 on `listings.page` sorted by name, every few
 * minutes). `keyColumns` is the same pair in SQL, so the order is SQLite's own: a null first on the way up, last on
 * the way down. A value no cursor can carry (a blob, an infinity) is named here rather than left for `decode`.
 */
function afterOf(row: Record<string, unknown>, keys: readonly string[], domain: string): Param[] {
  return keys.flatMap((key): Param[] => {
    const value = row[key];
    if (value === null || value === undefined) return [0, 0];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return [1, value];
    throw new Error(`${domain}: the sort key ${key} holds a ${typeof value} no cursor can carry`);
  });
}

/** `afterOf` in SQL: the expressions a page is ordered and compared by, two per key. */
function keyColumns(keys: readonly string[]): string[] {
  return keys.flatMap((key) => [`(${key} IS NOT NULL)`, `IFNULL(${key}, 0)`]);
}

function keysOf(row: Record<string, Param>, keys: readonly string[], domain: string): string {
  return JSON.stringify(afterOf(row, keys, domain));
}

function walkFor(database: EngineDatabase, id: string, read: () => Walk): Walk {
  let kept = walks.get(database);
  if (!kept) { kept = new Map(); walks.set(database, kept); }
  let walk = kept.get(id);
  if (walk) kept.delete(id);
  else walk = read();
  kept.set(id, walk);
  while (kept.size > WALKS_KEPT) kept.delete(kept.keys().next().value!);
  return walk;
}

/**
 * Shared by every paged read: cursor, revision and bounds.
 *
 * A first page asks for itself alone (a count and one page), so a reader that wants one page pays
 * for one. A later page is served from the walk (`Walk`): the first cursor page reads the whole list
 * once, ordered as the pages are, and every page after it is a slice. Its rows are what the
 * statement answered when that page was read: a walk is a snapshot of the read from its second
 * page on, never pages cut at different instants. A cursor the walk cannot place falls back to the
 * row-value comparison.
 */
export function queryPage<T>(database: EngineDatabase, request: PageableRequest, domain: string,
  sql: string, params: Param[], keys: string[], totals?: PageTotals): PageEnvelope<T> {
  const accounts = assertAccountScope(database, request.accountIds);
  const size = boundPageSize(request.pageSize);
  const descending = request.direction === 'desc';
  // A cursor read going one way is not a cursor into the other, so the direction is bound too. It
  // joins the hash only when it descends, which keeps every ascending cursor already issued valid.
  const binding = hash({ domain, accounts, filter: request.filter ?? {}, sort: 'sort' in request ? request.sort ?? 'localId' : '', ...(descending ? { direction: 'desc' } : {}) });
  const marks = database.revisionMarks(accounts);
  const revision = hash([marks, readRevision(database, accounts)]);
  const cursor = request.cursor ? decode(request.cursor) : undefined;
  if (cursor && (cursor.binding !== binding || cursor.revision !== revision || cursor.after.length !== keys.length * 2)) return { kind: 'stale-page', reason: 'cursor does not match surface, scope, filter, sort or revision' };
  const columns = keyColumns(keys);
  const order = columns.map((column) => (descending ? `${column} DESC` : column)).join(',');
  const counted = (n: number): PageTotals => totals ?? { handles: n, quantity: n, groups: n, rows: n };
  let rows: Array<T & Record<string, Param>> | undefined;
  let count: PageTotals | undefined;
  if (cursor) {
    // Not the parameters: a read judged at the engine's clock (`asOf`) passes a new instant every page.
    const walk = walkFor(database, `${binding}|${revision}|${hash(sql)}`, () => {
      const all = database.raw().prepare(`SELECT * FROM (${sql}) ORDER BY ${order}`).all(...params) as Array<Record<string, Param>>;
      return { rows: all, after: new Map(all.map((row, index) => [keysOf(row, keys, domain), index + 1])), total: counted(all.length) };
    });
    const from = walk.after.get(JSON.stringify(cursor.after));
    if (from !== undefined) {
      rows = walk.rows.slice(from, from + size + 1) as Array<T & Record<string, Param>>;
      count = walk.total;
    }
  }
  if (!rows || !count) {
    count = totals ?? (() => {
      const row = database.raw().prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number };
      return counted(row.n);
    })();
    rows = database.raw().prepare(`SELECT * FROM (${sql}) ${cursor ? `WHERE (${columns.join(',')})${descending ? '<' : '>'}(${columns.map(() => '?').join(',')})` : ''} ORDER BY ${order} LIMIT ?`)
      .all(...params, ...(cursor?.after ?? []), size + 1) as Array<T & Record<string, Param>>;
  }
  const hasNext = rows.length > size;
  if (hasNext) rows = rows.slice(0, size);
  const last = rows.at(-1);
  return bounded({ kind: 'page', requestId: randomUUID(), revision, rows,
    nextCursor: hasNext && last ? Buffer.from(JSON.stringify({ binding, revision, after: afterOf(last, keys, domain) })).toString('base64url') : null,
    hasNext, total: count });
}
