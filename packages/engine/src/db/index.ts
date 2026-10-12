import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { MIGRATIONS } from './migrations.js';

export { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
export { MIGRATIONS, type Migration } from './migrations.js';

/**
 * Brings a database to the declared current shape, whether it is empty or years old.
 *
 * Two halves, in this order:
 *
 *  1. `SCHEMA_SQL` — the declared shape. Every statement is `IF NOT EXISTS`, so running it against
 *     an existing database adds the tables and indexes that are new and touches nothing else.
 *  2. `MIGRATIONS` — the column additions that step 1 cannot express, applied in order, each in its
 *     own transaction, each stamped so it runs once.
 *
 * The version is stamped only after both halves succeed. A crash mid-way leaves the stamp behind,
 * so the next open retries exactly the work that did not finish — which is why every migration has
 * to be idempotent.
 *
 * This replaces a `migrate()` that lived in the middle of the writer class and whose gate read
 * `if (version < 3)` while stamping versions 2 and 3 inside that branch, so a version-2 database was
 * an unreachable state. It also duplicated five table definitions that `schema.ts` already had.
 *
 * A database a **newer** build has stamped is refused before a single statement runs. Both halves
 * above assume the record is at or behind this build: the declared shape would recreate a table a
 * later migration dropped (migration 25 drops five), and this build would then write into a shape
 * it does not understand. Only the older build can refuse, so the refusal has to ship before any
 * newer schema does (desktop release plan D8).
 */
export function applySchema(sqlite: DatabaseSync): void {
  const found = existingVersion(sqlite);
  if (found !== null && found > SCHEMA_VERSION) throw new SchemaNewerThanAppError(found, SCHEMA_VERSION);
  const { drops, tables, indexes } = statements();
  // A dropped index is a correction to an earlier shape; it has to go before anything recreates it.
  for (const statement of drops) sqlite.exec(statement);
  // Tables first. `CREATE TABLE IF NOT EXISTS` is a no-op for one that already exists, so this
  // creates what is new and leaves the rest alone.
  for (const statement of tables) sqlite.exec(statement);

  // Then the column catch-up, because an index in the declared shape may reference a column that
  // only a migration can add to an existing table. Running the indexes before this point fails on
  // an old database with `no such column`.
  const applied = stampedVersion(sqlite);
  for (const migration of MIGRATIONS) {
    if (applied >= migration.version) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      migration.up(sqlite);
      stamp(sqlite, migration.version);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
    }
  }

  for (const statement of indexes) sqlite.exec(statement);
  if (stampedVersion(sqlite) < SCHEMA_VERSION) stamp(sqlite, SCHEMA_VERSION);
}

/**
 * Splits the declared shape into tables and indexes.
 *
 * `schema.ts` stays one readable declaration; the ordering requirement above is satisfied here
 * rather than by asking a reader to keep two constants in step. Anything that is neither a table nor
 * an index throws, so a new kind of statement cannot be silently dropped.
 */
function statements(): { drops: readonly string[]; tables: readonly string[]; indexes: readonly string[] } {
  const drops: string[] = [];
  const tables: string[] = [];
  const indexes: string[] = [];
  for (const raw of SCHEMA_SQL.replace(/^[ \t]*--[^\n]*\n/gm, '').trim().match(/\s*CREATE TRIGGER[\s\S]*?END;|\s*[^;]+;/gi) ?? []) {
    // `schema.ts` explains a table above its definition. Those comments belong to the statement
    // that follows, and SQLite is happy to receive them, but the classification below is not.
    const statement = raw.replace(/^[ \t]*--[^\n]*\n/gm, '').trim();
    if (statement === '') continue;
    if (/^DROP INDEX/i.test(statement)) drops.push(statement);
    else if (/^CREATE TABLE/i.test(statement)) tables.push(statement);
    else if (/^CREATE (UNIQUE )?INDEX/i.test(statement)) indexes.push(statement);
    else if (/^CREATE TRIGGER/i.test(statement)) indexes.push(statement);
    else throw new Error(`schema.ts: unclassified statement: ${statement.slice(0, 60)}`);
  }
  return { drops, tables, indexes };
}

/** A record written by a later build than this one. The message is the sentence a person sees. */
export class SchemaNewerThanAppError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(
      `This trading record was written by a newer version of CSlytics (record version ${found}; `
      + `this app understands up to ${supported}). Install the latest version to open it. `
      + 'Nothing in the record was changed.'
    );
    this.name = 'SchemaNewerThanAppError';
  }
}

/**
 * The stamp of a record that has one, or `null` for a database no build has initialised.
 *
 * Read without creating anything: `stampedVersion` needs `schema_migration` to exist, and creating
 * it here would be the first write to a record this build may be about to refuse.
 */
export function existingVersion(sqlite: DatabaseSync): number | null {
  const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'").get();
  return table ? stampedVersion(sqlite) : null;
}

export function stampedVersion(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as
    { version: number | null };
  return row.version ?? 0;
}

function stamp(sqlite: DatabaseSync, version: number): void {
  sqlite
    .prepare("INSERT OR IGNORE INTO schema_migration(version, applied_at) VALUES (?, datetime('now'))")
    .run(version);
}
