import type { EngineDatabase } from '../../db/database.js';

/**
 * A frozen selection as the host needs it to build a request from a token: its members in key
 * order, and the accounts it touches. A selection is a command in `DRAFT` whose members are the
 * frozen set (consolidation plan §4.4). The renderer never receives a member list; main reads it
 * here, bounded, rather than reaching into `command_member` itself.
 */
export type SelectionMemberView = { accountId: string; memberId: string; stackKey: string | null; quantity: number; casketId: string | null };

/** At most `limit` members of a draft, ordered by account and member. */
export function selectionMembers(db: EngineDatabase, token: string, limit: number): SelectionMemberView[] {
  return db.draftMembers(token, { after: ['', ''], limit })
    .map((row) => ({ accountId: row.accountId, memberId: row.memberId, stackKey: row.stackKey ?? null, quantity: row.quantity, casketId: row.casketId }));
}

/** Every account a draft touches. */
export function selectionAccounts(db: EngineDatabase, token: string): string[] {
  return (db.raw().prepare('SELECT DISTINCT account_id FROM command_member WHERE command_id=? ORDER BY account_id')
    .all(token) as Array<{ account_id: string }>).map((row) => row.account_id);
}
