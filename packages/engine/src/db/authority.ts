import { sqlList, type CommandAuthority } from './alphabets.js';
import { CSFLOAT_DELIVER } from './csfloat.js';
import type { EngineDatabase } from './database.js';

/** The goal a person's hand-over is (strategy authority and confirmations plan D4): one per holding. */
export const HOLDING_TARGET = 'holding';

/** At most this many holdings per question or hand-over: a page of inventory, or of listings, is far below it. */
export const AUTHORITY_LIMIT = 1_000;

/**
 * The command kinds whose work on a holding is an obligation, never a say over it (D2): a delivery
 * the venue holds the seller to, and the confirmation that completes a hop already admitted.
 */
export const OBLIGATION_KINDS: readonly string[] = [CSFLOAT_DELIVER, 'CONFIRM'];

/**
 * Who may act on a holding, and since when.
 *
 * `HUMAN` is a person's: a strategy's command on it is refused (D3). `STRATEGY` is a holding a
 * strategy has acted on, or one a person handed over. `null` is a holding nobody has said anything
 * about, which a strategy may act on too.
 */
export type HoldingSay = {
  localId: string;
  authority: CommandAuthority | null;
  /** When it was said: the hand-over goal's time, else the latest command of that authority. */
  since: string | null;
  /** The command that said it, when one did; a hand-over by `authority.set` names none. */
  commandId: string | null;
};

type Touch = { localId: string; commandId: string; authority: CommandAuthority; createdAt: string };
type Goal = { localId: string; intent: string; createdAt: string; commandId: string | null };

/**
 * The say over a holding (D2), derived from what the record already holds and never stored per
 * command: a person's hand-over goal when one is current, else the commands that acted on the holding.
 *
 * A command acted on a holding when one of its members names it, or one of its hops does: a Steam
 * command is admitted as members and expanded into hops at dispatch, and a CSFloat command is hops
 * alone, so asking only one of the two would miss a person's command in the moment between its
 * admission and its first hop. A rejected command and a captured selection said nothing.
 *
 * Every statement takes the holdings as one JSON value, so a thousand members are three statements
 * and never a thousand, and never a list of bound variables SQLite would refuse.
 */
export class AuthorityStore {
  constructor(readonly db: EngineDatabase) {}

  say(accountId: string, localIds: readonly string[]): HoldingSay[] {
    const ids = [...new Set(localIds)];
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    const touches = [
      ...this.db.raw().prepare(`SELECT m.local_id AS localId, c.id AS commandId, c.authority AS authority, c.created_at AS createdAt
        FROM json_each(?) j JOIN command_member m INDEXED BY command_member_account_local ON m.account_id=? AND m.local_id=j.value
        JOIN command c ON c.id=m.command_id
        WHERE c.state NOT IN ('REJECTED','DRAFT')`).all(list, accountId) as Touch[],
      ...this.db.raw().prepare(`SELECT s.local_id AS localId, c.id AS commandId, c.authority AS authority, c.created_at AS createdAt
        FROM json_each(?) j JOIN work_step s INDEXED BY work_step_account_local ON s.account_id=? AND s.local_id=j.value
        JOIN command c ON c.id=s.command_id
        WHERE c.state NOT IN ('REJECTED','DRAFT') AND c.kind NOT IN (${sqlList(OBLIGATION_KINDS)})`).all(list, accountId) as Touch[]
    ];
    const goals = new Map((this.db.raw().prepare(`SELECT g.target_id AS localId, g.intent AS intent, g.created_at AS createdAt, g.command_id AS commandId
      FROM json_each(?) j JOIN desired_state g INDEXED BY desired_current
        ON g.account_id=? AND g.target_kind='${HOLDING_TARGET}' AND g.target_id=j.value AND g.superseded_by IS NULL`).all(list, accountId) as Goal[])
      .map((goal) => [goal.localId, goal]));
    return ids.map((localId) => {
      // A current goal is the person's latest word: every person's command on a holding handed to a
      // strategy supersedes it (`takeBack`), and a strategy's command is never admitted on one a
      // person holds, so nothing newer than the goal can disagree with it.
      const goal = goals.get(localId);
      if (goal) return { localId, authority: goal.intent === 'STRATEGY' ? 'STRATEGY' : 'HUMAN', since: goal.createdAt, commandId: goal.commandId };
      const mine = touches.filter((touch) => touch.localId === localId);
      for (const authority of ['HUMAN', 'STRATEGY'] as const) {
        const latest = mine.filter((touch) => touch.authority === authority)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.commandId.localeCompare(left.commandId))[0];
        if (latest) return { localId, authority, since: latest.createdAt, commandId: latest.commandId };
      }
      return { localId, authority: null, since: null, commandId: null };
    });
  }

  /**
   * A person's word on who may act on these holdings (D4): `STRATEGY` hands them over, `HUMAN`
   * keeps them. Written as the holding's goal, so the next word supersedes it and the record keeps
   * every earlier one. `commandId` names the command whose admission said it, when one did.
   */
  set(accountId: string, localIds: readonly string[], authority: CommandAuthority, now: string, commandId: string | null = null): void {
    this.db.transaction(() => {
      for (const localId of new Set(localIds)) {
        this.db.upsertDesired({ accountId, targetKind: HOLDING_TARGET, targetId: localId, intent: authority, params: {}, commandId, now });
      }
    });
  }

  /**
   * A person's command takes back the holdings they had handed to a strategy (D4): the hand-over is
   * superseded by a goal that keeps them, naming the command. A holding never handed over has no
   * goal to supersede, and its say is the person's already, from the command itself.
   */
  takeBack(accountId: string, localIds: readonly string[], commandId: string, now: string): void {
    const ids = [...new Set(localIds)];
    if (!ids.length) return;
    const handed = this.db.raw().prepare(`SELECT g.target_id AS localId FROM json_each(?) j JOIN desired_state g INDEXED BY desired_current
      ON g.account_id=? AND g.target_kind='${HOLDING_TARGET}' AND g.target_id=j.value AND g.superseded_by IS NULL
      WHERE g.intent='STRATEGY'`).all(JSON.stringify(ids), accountId) as Array<{ localId: string }>;
    if (handed.length) this.set(accountId, handed.map((row) => row.localId), 'HUMAN', now, commandId);
  }
}
