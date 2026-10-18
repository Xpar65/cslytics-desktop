import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { MIGRATIONS } from './migrations.js';

export { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
export { MIGRATIONS, type Migration } from './migrations.js';

/** What `applySchema` removed to bring a record to the declared shape, for a test or a log. */
export type SchemaReconciliation = { dropped: string[] };

/**
 * Brings a database to the declared current shape, whether it is empty or years old.
 *
 * Three steps, in this order:
 *
 *  1. `SCHEMA_SQL`'s tables. Every statement is `IF NOT EXISTS`, so running it against an existing
 *     database adds the tables that are new and touches nothing else.
 *  2. `MIGRATIONS` — the column additions that step 1 cannot express, applied in order, each in its
 *     own transaction, each stamped so it runs once.
 *  3. The indexes and triggers, after the record has been **reconciled** to them: an index or
 *     trigger the record holds that the declared shape does not name is dropped, and one whose
 *     stored text differs from the declaration is dropped so the declaration recreates it. `CREATE
 *     … IF NOT EXISTS` skips an object that exists, whatever its body, so without this step a
 *     renamed index lived on in the field for ever and a changed trigger reached fresh records only
 *     (consolidation plan D24). A table is never reconciled this way: a changed table is a
 *     migration.
 *
 * The version is stamped only after all three succeed. A crash mid-way leaves the stamp behind,
 * so the next open retries exactly the work that did not finish — which is why every migration has
 * to be idempotent. `now` is the engine's clock; the stamp never asks SQLite for the time (D23).
 *
 * A database a **newer** build has stamped is refused before a single statement runs. Every step
 * above assumes the record is at or behind this build: the declared shape would recreate a table a
 * later migration dropped (migration 25 drops five), and this build would then write into a shape
 * it does not understand. Only the older build can refuse, so the refusal has to ship before any
 * newer schema does (desktop release plan D8).
 */
export function applySchema(sqlite: DatabaseSync, now: string = new Date().toISOString()): SchemaReconciliation {
  const found = existingVersion(sqlite);
  if (found !== null && found > SCHEMA_VERSION) throw new SchemaNewerThanAppError(found, SCHEMA_VERSION);
  const { tables, objects } = statements();
  // Tables first. `CREATE TABLE IF NOT EXISTS` is a no-op for one that already exists, so this
  // creates what is new and leaves the rest alone.
  for (const statement of tables) sqlite.exec(statement);

  // Then the column catch-up, because an index in the declared shape may reference a column that
  // only a migration can add to an existing table. Running the indexes before this point fails on
  // an old database with `no such column`.
  const applied = stampedVersion(sqlite);
  let upgraded = false;
  for (const migration of MIGRATIONS) {
    if (applied >= migration.version) continue;
    upgraded = true;
    // A rebuild runs with foreign keys off (Migration.foreignKeysOff). The pragma cannot change
    // inside a transaction, and a record may already hold a dangling row from before any of this,
    // so only a row the migration itself left dangling fails it.
    const enforcing = (sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    const relax = Boolean(migration.foreignKeysOff) && enforcing;
    const before = relax ? new Set(violations(sqlite)) : new Set<string>();
    if (relax) sqlite.exec('PRAGMA foreign_keys = OFF');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      migration.up(sqlite);
      if (relax) {
        const left = violations(sqlite).filter((violation) => !before.has(violation));
        if (left.length) throw new Error(`${left.length} row(s) left pointing at a missing parent: ${left.slice(0, 5).join('; ')}`);
      }
      stamp(sqlite, migration.version, now);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
    } finally {
      if (relax) sqlite.exec('PRAGMA foreign_keys = ON');
    }
  }

  const dropped = reconcile(sqlite, objects);
  for (const object of objects) sqlite.exec(object.sql);
  if (stampedVersion(sqlite) < SCHEMA_VERSION) stamp(sqlite, SCHEMA_VERSION, now);
  // A rebuild copies a table and drops the old one, and the pages it held stay in the file as
  // free space until something returns them. Once, after the migrations that freed them, and
  // never on an ordinary open: records we measured shrank by a third at migration 29.
  if (upgraded) sqlite.exec('VACUUM');
  return { dropped };
}

type DeclaredObject = { kind: 'index' | 'trigger'; name: string; sql: string; stored: string };

/**
 * Splits the declared shape into tables and the objects that are reconciled.
 *
 * `schema.ts` stays one readable declaration; the ordering requirement above is satisfied here
 * rather than by asking a reader to keep two constants in step. Anything that is neither a table,
 * an index nor a trigger throws, so a new kind of statement cannot be silently dropped.
 */
function statements(): { tables: readonly string[]; objects: readonly DeclaredObject[] } {
  const tables: string[] = [];
  const objects: DeclaredObject[] = [];
  for (const raw of SCHEMA_SQL.replace(/^[ \t]*--[^\n]*\n/gm, '').trim().match(/\s*CREATE TRIGGER[\s\S]*?END;|\s*[^;]+;/gi) ?? []) {
    // `schema.ts` explains a table above its definition. Those comments belong to the statement
    // that follows, and SQLite is happy to receive them, but the classification below is not.
    const statement = raw.replace(/^[ \t]*--[^\n]*\n/gm, '').trim();
    if (statement === '') continue;
    if (/^CREATE TABLE/i.test(statement)) tables.push(statement);
    else if (/^CREATE (UNIQUE )?INDEX/i.test(statement)) objects.push(declared('index', statement));
    else if (/^CREATE TRIGGER/i.test(statement)) objects.push(declared('trigger', statement));
    else throw new Error(`schema.ts: unclassified statement: ${statement.slice(0, 60)}`);
  }
  return { tables, objects };
}

function declared(kind: DeclaredObject['kind'], sql: string): DeclaredObject {
  const name = /^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) IF NOT EXISTS (\w+)/i.exec(sql)?.[1];
  if (!name) throw new Error(`schema.ts: every index and trigger is declared IF NOT EXISTS with a plain name: ${sql.slice(0, 60)}`);
  return { kind, name, sql, stored: storedForm(sql) };
}

/**
 * The form SQLite keeps in `sqlite_master`: the statement without `IF NOT EXISTS`, without its
 * terminator, one space between tokens. Both sides of a comparison go through this, so whether
 * SQLite strips the clause itself or not makes no difference.
 */
function storedForm(sql: string): string {
  return sql.replace(/\bIF NOT EXISTS\s+/i, '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Drops every index and trigger the record holds that the declaration does not name or does not
 * match. An automatic index (a PRIMARY KEY or UNIQUE constraint) has no SQL and is a table's own.
 */
function reconcile(sqlite: DatabaseSync, objects: readonly DeclaredObject[]): string[] {
  const declaredByName = new Map(objects.map((object) => [object.name, object]));
  const existing = sqlite
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
  const dropped: string[] = [];
  for (const object of existing) {
    const declaration = declaredByName.get(object.name);
    if (declaration && declaration.kind === object.type && storedForm(object.sql) === declaration.stored) continue;
    sqlite.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
    dropped.push(object.name);
  }
  return dropped.sort();
}

/** Every foreign-key violation in the record, as `table:rowid:parent` keys. */
function violations(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | bigint | null; parent: string }>)
    .map((row) => `${row.table}:${String(row.rowid)}:${row.parent}`);
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

function stamp(sqlite: DatabaseSync, version: number, now: string): void {
  sqlite
    .prepare('INSERT OR IGNORE INTO schema_migration(version, applied_at) VALUES (?, ?)')
    .run(version, now);
}
