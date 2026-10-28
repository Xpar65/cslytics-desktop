import type { CommandAuthority } from '../db/alphabets.js';
import { AuthorityStore } from '../db/authority.js';
import type { EngineDatabase } from '../db/database.js';

/** A command's members as authority asks about them: the holding each names, or a group it does not. */
export type AuthorityMember = { accountId: string; localId?: string | undefined; stackKey?: string | undefined };

export const STRATEGY_NAMES_EACH_ITEM = 'A strategy names each item it acts on, never a group';
export const ONLY_A_PERSON_FORCES = 'Only a person may change a price inside the interval';

/** The refusal for a holding a person holds, naming what said so. */
export function heldByPerson(localId: string, commandId: string | null): string {
  return `A person ${commandId ? `acted on item ${localId} (command ${commandId})` : `kept item ${localId}`}; a strategy may act on it once they hand it over`;
}

/**
 * Why a strategy may not send this command, or `null` (strategy authority and confirmations plan
 * D3). A person's command is never refused here: what a person says about a holding always stands.
 *
 * A strategy names each holding, because the say is a holding's and a group member is units
 * nobody has chosen yet; it may never force a price change, because forcing is a person's
 * decision about the cadence (`kernel/price-cadence.ts`); and it may not act on a holding whose
 * say is a person's. Asked once per command, one statement set per account, however many members.
 */
export function strategyRefusal(database: EngineDatabase, request: { authority?: CommandAuthority | undefined; force?: boolean | undefined; members: readonly AuthorityMember[] }): string | null {
  if (request.authority !== 'STRATEGY') return null;
  if (request.force) return ONLY_A_PERSON_FORCES;
  if (request.members.some((member) => !member.localId)) return STRATEGY_NAMES_EACH_ITEM;
  const store = new AuthorityStore(database);
  const byAccount = new Map<string, string[]>();
  for (const member of request.members) byAccount.set(member.accountId, [...(byAccount.get(member.accountId) ?? []), member.localId!]);
  for (const [accountId, localIds] of byAccount) {
    const held = store.say(accountId, localIds).find((say) => say.authority === 'HUMAN');
    if (held) return heldByPerson(held.localId, held.commandId);
  }
  return null;
}

/**
 * After a person's command is admitted: the holdings it names that the person had handed to a
 * strategy are theirs again (D4). A strategy's command changes nothing here.
 */
export function claimForPerson(database: EngineDatabase, authority: CommandAuthority | undefined, commandId: string, members: readonly AuthorityMember[], now: string): void {
  if ((authority ?? 'HUMAN') !== 'HUMAN') return;
  const store = new AuthorityStore(database);
  const byAccount = new Map<string, string[]>();
  for (const member of members) if (member.localId) byAccount.set(member.accountId, [...(byAccount.get(member.accountId) ?? []), member.localId]);
  for (const [accountId, localIds] of byAccount) store.takeBack(accountId, localIds, commandId, now);
}
