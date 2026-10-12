import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Beside the record, so the copy travels with it whether it lives in a profile or on a server. */
export const BACKUP_DIRECTORY = 'backups';

/**
 * How many pre-upgrade copies are kept. Each is a whole record, so this is a disk bound; three
 * covers a bad release and the one after it that was meant to fix it.
 */
export const BACKUPS_KEPT = 3;

const BACKUP_NAME = /^trading-v(\d+)-(.+)\.sqlite$/;

/** The copy could not be made, so the upgrade it was meant to protect did not run. */
export class SchemaBackupError extends Error {
  constructor(readonly target: string, cause: unknown) {
    super(
      `Could not back up the trading record before upgrading it (${cause instanceof Error ? cause.message : String(cause)}). `
      + `The record was not changed. Free some disk space, or check that ${dirname(target)} can be written, then restart.`
    );
    this.name = 'SchemaBackupError';
  }
}

/**
 * Copies a record before this build migrates it, and keeps the newest `BACKUPS_KEPT`.
 *
 * `VACUUM INTO` rather than a file copy: it reads one consistent snapshot through the WAL, so a
 * copy cannot catch the main file and the `-wal` at different moments, and the result is a single
 * compact file with nothing beside it. A migration is forward-only and runs on a record nobody but
 * its owner will ever see — migration 25 drops five tables — so this copy is the only way back
 * from a defect in one (desktop release plan D9).
 *
 * Returns the path written. Throws `SchemaBackupError` without touching the record if the copy
 * fails; a failed prune is ignored, because a surplus backup costs disk and nothing else.
 */
export function backupBeforeUpgrade(sqlite: DatabaseSync, recordPath: string, fromVersion: number, now: Date): string {
  const directory = join(dirname(recordPath), BACKUP_DIRECTORY);
  const target = join(directory, `trading-v${fromVersion}-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
  try {
    mkdirSync(directory, { recursive: true });
    sqlite.prepare('VACUUM INTO ?').run(target);
  } catch (error) {
    throw new SchemaBackupError(target, error);
  }
  pruneBackups(directory);
  return target;
}

/** Removes all but the newest `BACKUPS_KEPT` backups, newest by the time in the name. */
export function pruneBackups(directory: string): void {
  try {
    const backups = readdirSync(directory)
      .map((name) => ({ name, match: BACKUP_NAME.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => right.match[2]!.localeCompare(left.match[2]!));
    for (const stale of backups.slice(BACKUPS_KEPT)) rmSync(join(directory, stale.name), { force: true });
  } catch {
    // A backup left behind is disk, not a defect.
  }
}
