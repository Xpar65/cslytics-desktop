import type { EngineDatabase } from './database.js';

/**
 * How long an observation nothing cites is kept (consolidation plan D22, §12 Q6): longer than any
 * reversal period, hold or escrow Steam imposes, and short enough that a record of two accounts
 * stays under a few megabytes of evidence.
 */
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export type SweepResult = { accountId: string; cutoff: string; deleted: number };

/** The sweep would have left a row pointing at a deleted observation; nothing was deleted. */
export class RetentionError extends Error {
  constructor(readonly dangling: readonly string[]) {
    super(`The sweep would leave rows pointing at a deleted observation: ${dangling.join(', ')}`);
    this.name = 'RetentionError';
  }
}

type ForeignKeyViolation = { table: string; rowid: number | bigint; parent: string; fkid: number };

/**
 * The record's one bound (consolidation plan §4.9). A **record** row is the trading record and is
 * never deleted by age. An **evidence** row is an `observation`, and its value is what cites it: a
 * holding's sighting, a step's resolving observation, a lineage's proof, a coverage checkpoint. An
 * observation that nothing cites is proof of nothing, and after `RETENTION_DAYS` it goes. Three
 * kinds survive at any age: the latest per account, surface and scope, because coverage reads it;
 * the one `surface_state` cites; and anything cited.
 *
 * In the purge's shape: foreign keys off for the transaction, one statement, `PRAGMA
 * foreign_key_check` before commit, and a rollback if anything was left pointing at a deleted row.
 * The citing columns are not a list anyone keeps: they are read from `PRAGMA foreign_key_list` over
 * every table, as the purge finds its tables by their account column, so a pointer a later plan
 * adds is covered the day it exists. No `VACUUM`: freed pages are reused, and a rebuild stays the
 * purge's. The refresh loop runs it once a day after a pass, never inside a walk.
 */
export class RetentionStore {
  constructor(readonly db: EngineDatabase) {}

  /** Every column of the record that cites an observation, as the record itself declares them. */
  citations(): Array<{ table: string; column: string }> {
    const sqlite = this.db.raw();
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const cited: Array<{ table: string; column: string }> = [];
    for (const table of tables) {
      for (const key of sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string }>) {
        if (key.table === 'observation') cited.push({ table, column: key.from });
      }
    }
    return cited;
  }

  /**
   * Deletes the account's observations older than the window that nothing cites and no scope
   * needs as its latest, and says how many went. Recorded as a `retention-swept` event only when
   * the count is not zero.
   */
  sweep(accountId: string, now: string, retentionDays = RETENTION_DAYS): SweepResult {
    const sqlite = this.db.raw();
    // `foreign_keys` cannot change inside a transaction; silently keeping it on would refuse the
    // delete row by row instead of proving the whole statement harmless once.
    if (sqlite.isTransaction) throw new Error('A retention sweep cannot run inside another transaction');
    const cutoff = new Date(Date.parse(now) - retentionDays * DAY_MS).toISOString();
    const cited = this.citations().map(({ table, column }) => `SELECT "${column}" AS id FROM "${table}" WHERE "${column}" IS NOT NULL`).join(' UNION ');
    const before = new Set(this.violations().map(violationKey));
    let deleted = 0;
    sqlite.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        deleted = Number(sqlite.prepare(`DELETE FROM observation WHERE account_id=? AND started_at<?
          AND id NOT IN (SELECT MAX(id) FROM observation WHERE account_id=? GROUP BY surface, scope_kind, scope_id)
          AND id NOT IN (${cited})`).run(accountId, cutoff, accountId).changes);
        const dangling = this.violations().filter((violation) => !before.has(violationKey(violation)));
        if (dangling.length > 0) throw new RetentionError([...new Set(dangling.map((row) => `${row.table} → ${row.parent}`))]);
        if (deleted > 0) this.db.addEvent(accountId, 'retention-swept', { deleted, cutoff, retentionDays }, now);
      });
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON');
    }
    return { accountId, cutoff, deleted };
  }

  private violations(): ForeignKeyViolation[] {
    return this.db.raw().prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolation[];
  }
}

function violationKey(violation: ForeignKeyViolation): string {
  return `${violation.table}:${String(violation.rowid)}:${violation.parent}:${String(violation.fkid)}`;
}
