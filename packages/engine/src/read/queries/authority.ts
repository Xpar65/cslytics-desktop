import { AUTHORITY_LIMIT, AuthorityStore, type HoldingSay } from '../../db/authority.js';
import type { EngineDatabase } from '../../db/database.js';
import { assertAccountScope, bounded } from './paging.js';

export type AuthorityPage = { kind: 'page'; rows: HoldingSay[] };

/**
 * Who may act on each holding (strategy authority and confirmations plan D5): a person's, a
 * strategy's, or nobody's yet. It is how a strategy learns which holdings it may act on before it
 * asks, and the engine still refuses at admission whatever a strategy believed (D3).
 */
export function readAuthority(database: EngineDatabase, request: { accountId: string; localIds: readonly string[] }): AuthorityPage {
  const [accountId] = assertAccountScope(database, [request.accountId]);
  if (request.localIds.length > AUTHORITY_LIMIT) throw new Error(`Ask about at most ${AUTHORITY_LIMIT} items at once`);
  return bounded({ kind: 'page' as const, rows: new AuthorityStore(database).say(accountId!, request.localIds) });
}
