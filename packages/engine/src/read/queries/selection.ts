import type { EngineDatabase } from '../../db/database.js';

/**
 * A frozen selection as the host needs it to build a request from a token: its members in key
 * order, and the accounts it touches. The renderer never receives a member list; main reads it
 * here, bounded, rather than reaching into `selection_member` itself.
 */
export type SelectionMemberView = { accountId: string; memberId: string; stackKey: string | null; quantity: number; casketId: string | null };

/** At most `limit` members of one revision of a selection, ordered by account and member. */
export function selectionMembers(db: EngineDatabase, token: string, revision: number, limit: number): SelectionMemberView[] {
  return db.raw().prepare(`
    SELECT account_id AS accountId, member_id AS memberId, stack_key AS stackKey, quantity, casket_id AS casketId
    FROM selection_member WHERE token=? AND revision=? ORDER BY account_id, member_id LIMIT ?
  `).all(token, revision, limit) as SelectionMemberView[];
}

/** Every account a selection touches, in any revision. */
export function selectionAccounts(db: EngineDatabase, token: string): string[] {
  return (db.raw().prepare('SELECT DISTINCT account_id FROM selection_member WHERE token=? ORDER BY account_id')
    .all(token) as Array<{ account_id: string }>).map((row) => row.account_id);
}
