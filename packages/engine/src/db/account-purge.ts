import type { EngineDatabase } from './database.js';
import { SELECTION_KIND } from './database.js';

/** `remove` takes the account out of the record; `reset` keeps it and empties it. */
export type PurgeMode = 'remove' | 'reset';

/** What a purge deleted, table by table. */
export type PurgeResult = { accountId: string; mode: PurgeMode; deleted: Record<string, number> };

/**
 * The tables with no `account_id` column, and why each is still covered. Every other table is
 * found by that column and emptied of the account, so a table added later is purged without
 * anyone remembering to; one added *here* needs a reason, and the coverage test
 * (`tests/unit/account-purge.test.ts`) fails on a new table that is in neither group.
 */
export const ACCOUNTLESS_TABLES = {
  account: 'the account itself: deleted by remove, kept by reset',
  attempt: 'hangs off action, and goes with the account\'s actions',
  command: 'spans accounts through command_member; deleted once no member and no transfer is left, and a selection draft naming this account is deleted whole',
  schema_migration: 'the record\'s own history'
} as const;

/** What reset keeps beside the account row: its CSFloat connection and the reference to its key. */
const RESET_KEEPS: ReadonlySet<string> = new Set(['credential_ref', 'venue_connection']);

/** Columns that tie a row to an account. A transfer names two, and belongs to both. */
const ACCOUNT_COLUMNS: ReadonlySet<string> = new Set(['account_id', 'destination_account_id']);

/** Deletes with one statement and counts what went. */
export type PurgeRun = (table: string, sql: string, ...params: string[]) => void;

/**
 * The account cannot be cleared yet: a transfer it shares with another account is still waiting
 * on that account's side. Nothing was changed, and the reason is the sentence the window shows.
 */
export class AccountPurgeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AccountPurgeRefused';
  }
}

/** The purge would have left another row pointing at one it deleted. Nothing was changed. */
export class AccountPurgeError extends Error {
  constructor(readonly dangling: readonly string[]) {
    super(`Deleting the account would leave rows pointing at deleted ones (${dangling.join(', ')}). Nothing was deleted.`);
    this.name = 'AccountPurgeError';
  }
}

type ForeignKeyViolation = { table: string; rowid: number | bigint | null; parent: string; fkid: number | bigint };

/**
 * Deletes this computer's record of one account (steam/auth.md, "Removing or resetting an
 * account"). One transaction: it all happens or none of it does.
 *
 * Foreign keys are switched off for it and the deletes are explicit, table by table. A cascade
 * from `account` would do the same thing slowly: each deleted observation makes SQLite look for
 * the rows that reference it in some thirty columns, most of them unindexed, and a record with
 * ten thousand observations would scan every child table ten thousand times. Instead the end of
 * the transaction runs `PRAGMA foreign_key_check` once, and any row the purge left pointing at a
 * deleted one — a table this code does not know about — rolls the whole thing back.
 *
 * Rows of *other* accounts that point into this one go too, because they cannot be kept honest
 * without it: a transfer between the two in either direction, and lineage another account's
 * holding draws from this one's (rule 3). That account's own rows are otherwise untouched.
 *
 * Then the file is rebuilt (`VACUUM`) and the write-ahead log folded in and truncated. Deleting a
 * row only frees its space: its bytes stay in the page, and so do older copies of it that SQLite
 * left behind whenever it rebalanced a page, in pages still holding another account's rows. A
 * rebuild copies only live rows, so afterwards none of the account's data is anywhere in the
 * file (`tests/unit/account-purge.test.ts` looks for it byte by byte).
 *
 * Only the runtime calls this, before any loop has started: a running loop would write the
 * account's rows straight back.
 */
export class AccountPurgeStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * Why the account cannot be cleared now, or null.
   *
   * A transfer between two owned accounts belongs to both, and the purge deletes it. While the
   * *other* account's part of it — its send, its accept, its cancel — is unresolved, deleting the
   * batch would leave that action waiting for an observation nothing would ever look for again
   * (rule 1), in the other account's work panel for good. So the purge waits for it. The account's
   * own unresolved work is another matter: it goes with the account, and the confirmation says so.
   */
  refusal(accountId: string): string | null {
    const waiting = this.db.raw().prepare(`
      SELECT COALESCE(mine.account_name, ?) AS mine, COALESCE(theirs.account_name, action.account_id) AS theirs
      FROM work_step send JOIN transfer_detail detail ON detail.step_id=send.id
      JOIN work_step hop ON hop.command_id=send.command_id AND hop.account_id IN (send.account_id, detail.destination_account_id)
      JOIN action ON action.id=hop.action_id
      LEFT JOIN account mine ON mine.id=?
      LEFT JOIN account theirs ON theirs.id=action.account_id
      WHERE send.kind='SEND' AND (send.account_id=? OR detail.destination_account_id=?) AND action.account_id<>?
        AND action.state IN ('READY','RUNNING','AWAITING_OBSERVATION')
      LIMIT 1`).get(accountId, accountId, accountId, accountId, accountId) as { mine: string; theirs: string } | undefined;
    if (!waiting) return null;
    return `A transfer between ${waiting.mine} and ${waiting.theirs} is still in progress. Let it finish, or cancel it, then try again.`;
  }

  purge(accountId: string, mode: PurgeMode): PurgeResult {
    const sqlite = this.db.raw();
    // `foreign_keys` cannot change inside a transaction; silently keeping it on would cascade.
    if (sqlite.isTransaction) throw new Error('An account purge cannot run inside another transaction');
    const deleted: Record<string, number> = {};
    const run: PurgeRun = (table, sql, ...params) => {
      const changes = Number(sqlite.prepare(sql).run(...params).changes);
      if (changes > 0) deleted[table] = (deleted[table] ?? 0) + changes;
    };
    const keyed = this.accountKeyedTables();
    const before = new Set(this.violations().map(violationKey));
    sqlite.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        const refused = this.refusal(accountId);
        if (refused) throw new AccountPurgeRefused(refused);
        // Found through the account's own rows, so before those go.
        this.deleteLineageFrom(run, accountId);
        run('attempt', 'DELETE FROM attempt WHERE action_id IN (SELECT id FROM action WHERE account_id=?)', accountId);
        const commands = (sqlite.prepare('SELECT DISTINCT command_id FROM command_member WHERE account_id=?').all(accountId) as Array<{ command_id: string }>)
          .map((row) => row.command_id);
        // A selection draft is one frozen set: with this account gone it is a different selection,
        // so a draft naming the account goes whole rather than shrinking under the window's token.
        const drafts = (sqlite.prepare(`SELECT c.id FROM command c WHERE c.kind=? AND EXISTS (SELECT 1 FROM command_member m WHERE m.command_id=c.id AND m.account_id=?)`)
          .all(SELECTION_KIND, accountId) as Array<{ id: string }>).map((row) => row.id);
        for (const token of drafts) {
          run('command_member', 'DELETE FROM command_member WHERE command_id=?', token);
          run('command', 'DELETE FROM command WHERE id=?', token);
        }
        for (const { table, columns } of keyed) {
          if (mode === 'reset' && this.resetKeeps().has(table)) continue;
          run(table, `DELETE FROM "${table}" WHERE ${columns.map((column) => `${column}=?`).join(' OR ')}`, ...columns.map(() => accountId));
        }
        for (const commandId of commands) {
          run('command', `DELETE FROM command WHERE id=?
            AND NOT EXISTS (SELECT 1 FROM command_member WHERE command_id=?)
            AND NOT EXISTS (SELECT 1 FROM work_step WHERE command_id=?)`, commandId, commandId, commandId);
        }
        if (mode === 'remove') run('account', 'DELETE FROM account WHERE id=?', accountId);
        // The name and the picture are observed too; the next persona read writes them again.
        else sqlite.prepare('UPDATE account SET persona_name=NULL, avatar_hash=NULL, persona_obs=NULL, trade_token=NULL, trade_token_obs=NULL WHERE id=?').run(accountId);
        const dangling = this.violations().filter((violation) => !before.has(violationKey(violation)));
        if (dangling.length > 0) throw new AccountPurgeError([...new Set(dangling.map((row) => `${row.table} → ${row.parent}`))]);
      });
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON');
    }
    sqlite.exec('VACUUM');
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { accountId, mode, deleted };
  }

  /** Every table with a column naming an account, and those columns. */
  accountKeyedTables(): Array<{ table: string; columns: string[] }> {
    const sqlite = this.db.raw();
    const accountColumns = this.accountColumns();
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
    return tables.flatMap(({ name }) => {
      const columns = (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((column) => accountColumns.has(column));
      return columns.length > 0 ? [{ table: name, columns }] : [];
    });
  }

  /** The columns that tie a row to an account. Its own method so a saboteur can forget one. */
  protected accountColumns(): ReadonlySet<string> {
    return ACCOUNT_COLUMNS;
  }

  /**
   * Lineage that draws from this account's holdings, whichever account it sits under. A trade
   * receipt files the link under the receiver, citing the giver's holding and, when the giver's
   * trade history found it, the giver's observation (rule 3; `HoldingsStore.linkTradeLine`).
   */
  protected deleteLineageFrom(run: PurgeRun, accountId: string): void {
    run('item_lineage', `DELETE FROM item_lineage
      WHERE observation_id IN (SELECT id FROM observation WHERE account_id=?)
         OR from_local_id IN (SELECT local_id FROM item WHERE account_id=?)`, accountId, accountId);
  }

  /** What reset leaves in place beside the account row. */
  protected resetKeeps(): ReadonlySet<string> {
    return RESET_KEEPS;
  }

  private violations(): ForeignKeyViolation[] {
    return this.db.raw().prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolation[];
  }
}

function violationKey(violation: ForeignKeyViolation): string {
  return `${violation.table}:${String(violation.rowid)}:${violation.parent}:${String(violation.fkid)}`;
}
