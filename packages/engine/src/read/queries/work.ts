import { SELECTION_KIND, type EngineDatabase } from '../../db/database.js';
import { MEMBER_HOP_JOINS, MEMBER_REASON_SQL, MEMBER_STATE_SQL, STEP_ACTION_SQL, STEP_REASON_SQL, STEP_STATE_SQL } from '../../db/member-state.js';
import { OPEN_STEP_STATES_SQL } from '../../db/work.js';
import type { CommandAuthority } from '../../db/alphabets.js';
import { attemptLimit, RETRY_POLICY, retryPlan } from '../../kernel/retry-policy.js';
import { assertAccountScope, bounded, queryPage, type ScopedPageRequest } from './paging.js';

/**
 * One member of an open command, joined to the item or stack it names and the action
 * currently carrying it.
 *
 * `memberState` is observation-honest: `COMPLETE` only when the member's hop is `DONE`, which
 * only an observation writes. A mutation receipt is `AWAITING_OBSERVATION`, never `COMPLETE` —
 * rule 1. Which hop a member is on, and the words, are `db/member-state.ts`. `reason` is why it
 * is `BLOCKED` or `FAILED`, when it is.
 *
 * `hashName` is set on work about a buy order, which names a market name and no item this app
 * holds: main names the row by it, and its identity fields are empty. `null` on item work, which
 * main names by identity.
 *
 * `retryAt`, `attempt` and `attemptLimit` are the retry facts, from the arithmetic the resender
 * uses (`kernel/retry-policy.ts`): on a `RETRYING` member, when the next send is due and which number
 * it will be; on a member sent more than once, which send it is waiting on. `null` on work with
 * no retry in its policy, so the panel says nothing about attempts for work that gets one.
 *
 * `authority` is whose the command is: a person's, or a strategy's acting for one (strategy
 * authority plan D5). The panel labels a strategy's work; a person's needs no label.
 */
export type WorkRow = {
  accountId: string; commandId: string; commandKind: string; commandState: string; authority: CommandAuthority;
  submittedAt: string; memberId: string; memberState: string; quantity: number;
  localId: string | null; stackKey: string | null;
  defIndex: number; paintIndex: number | null; quality: number; paintWear: number | null;
  destinationCasketId: string | null; priceReceiveCents: number | null;
  actionKind: string | null; actionState: string | null; updatedAt: string;
  reason: string | null;
  matchKey: string;
  hashName: string | null;
  retryAt: string | null; attempt: number | null; attemptLimit: number | null;
};
export type WorkPage = { rows: WorkRow[] };

/** A source's row before the retry facts are added: what the carrying action's row says, when there is one. */
type RawWorkRow = Omit<WorkRow, 'retryAt' | 'attempt' | 'attemptLimit'> & { actionResolution?: string | null; attempts?: number | null; retryAfter?: string | null };

/** The columns a source joins from `action` and its attempts for `describeRetry`; `a` is the carrying action. */
const RETRY_COLUMNS = `a.resolution AS actionResolution, (SELECT COUNT(*) FROM attempt t WHERE t.action_id=a.id) AS attempts,
    (SELECT t.retry_after FROM attempt t WHERE t.action_id=a.id ORDER BY t.rowid DESC LIMIT 1) AS retryAfter`;

/**
 * Adds the retry facts to a row, from the same arithmetic the resender uses, so the panel's
 * countdown and the send it announces cannot disagree. A `READY` action a walk proved not
 * applied is waiting for `retryAt`; an action the venue refused for the moment is waiting for the
 * instant the venue named, with no cap of ours (delivery retries plan D1); any other action sent
 * more than once reports which send it is on. Work whose policy allows one send says nothing.
 */
function describeRetry(row: RawWorkRow): WorkRow {
  const { actionResolution, attempts, retryAfter, ...rest } = row;
  const policy = row.actionKind ? RETRY_POLICY[row.actionKind] : undefined;
  const made = attempts ?? 0;
  if (row.actionState === 'FAILED' && retryAfter) return { ...rest, retryAt: retryAfter, attempt: made + 1, attemptLimit: null };
  if (!policy || made === 0 || attemptLimit(policy) < 2) return { ...rest, retryAt: null, attempt: null, attemptLimit: null };
  if (row.actionState === 'READY' && actionResolution === 'OBSERVED_NOT_APPLIED') {
    const plan = retryPlan(policy, made, row.updatedAt);
    return { ...rest, retryAt: plan.kind === 'again' ? plan.retryAt : null, attempt: plan.attempt, attemptLimit: plan.limit };
  }
  return { ...rest, retryAt: null, attempt: made, attemptLimit: attemptLimit(policy) };
}

const OPEN_WORK_LIMIT = 1_000;

/**
 * How many settled commands stay in the answer.
 *
 * Something must be said about a command that just finished, or the last thing the user did
 * vanishes between two polls and the indicator can never show its outcome. Recency by wall clock
 * would be wrong — the engine's clock is injected and a test's is not the machine's — so this is
 * by *rank*: the most recently touched commands keep their settled members, and older ones fall
 * off as new work arrives. The renderer decides what to show; the engine only states the facts.
 */
const SETTLED_COMMAND_LIMIT = 25;

/**
 * The commands of a scope whose settled work is still reported (D25): the most recently touched,
 * by their latest hop, else by their admission. Bound in SQL so the read never carries every
 * settled member of every command the record holds.
 */
function recentCommandsSql(marks: string): string {
  return `(SELECT r.id FROM command r
      WHERE r.kind <> '${SELECTION_KIND}'
        AND (EXISTS (SELECT 1 FROM command_member rm WHERE rm.command_id=r.id AND rm.account_id IN (${marks}))
          OR EXISTS (SELECT 1 FROM work_step rs WHERE rs.command_id=r.id AND rs.account_id IN (${marks})))
      ORDER BY COALESCE((SELECT MAX(w.updated_at) FROM work_step w WHERE w.command_id=r.id), r.created_at) DESC
      LIMIT ${SETTLED_COMMAND_LIMIT})`;
}

/**
 * Work asked for as a command with members: a Steam store, retrieve, listing, transfer, reprice or
 * delist-to-storage, and an account transfer. One row per member, carrying the member's current
 * hop (`db/member-state.ts`): its earliest open hop, else its latest failed one, else its last
 * settled one. A member whose hops are not written yet reads `QUEUED`; one refused, stopped or
 * sold reads its own word, which no hop can say for it. A transfer's send hop is about every
 * member of its source, so it is read once per member; the destination's accept hop is that
 * account's own action and names no item, and is not a row.
 *
 * `localId` is the holding the member names; a group member not yet expanded into units names
 * none, and its identity comes from the group. Settled work is bounded in SQL to the most
 * recently touched commands (D25).
 *
 * Stopped is a word about a member, never about its command. Stop halts what was never sent and
 * leaves the rest to be settled by observation, so a member Stop could not stop stays here until
 * one does (N-WORK-09). This read used to drop every member of a stopped command, and a transfer
 * whose offer was already waiting on the phone vanished from the panel while Steam still held it.
 */
function memberOpenWork(database: EngineDatabase, accounts: readonly string[]): RawWorkRow[] {
  const marks = accounts.map(() => '?').join(',');
  return database.raw().prepare(`
    SELECT m.account_id AS accountId, c.id AS commandId, c.kind AS commandKind, c.state AS commandState, c.authority AS authority,
      c.created_at AS submittedAt, m.local_id AS memberId,
      ${MEMBER_STATE_SQL} AS memberState, ${RETRY_COLUMNS},
      m.quantity AS quantity,
      CASE WHEN i.local_id IS NOT NULL THEN m.local_id END AS localId,
      m.stack_key AS stackKey,
      COALESCE(i.def_index, g.def_index, 0) AS defIndex,
      i.paint_index AS paintIndex,
      COALESCE(i.quality, g.quality, 0) AS quality,
      i.paint_wear AS paintWear,
      m.destination AS destinationCasketId,
      m.price_receive_cents AS priceReceiveCents,
      a.kind AS actionKind, a.state AS actionState,
      COALESCE(s.updated_at, c.created_at) AS updatedAt,
      ${MEMBER_REASON_SQL} AS reason,
      CASE
        WHEN i.local_id IS NOT NULL THEN i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,'')
        WHEN g.def_index IS NOT NULL THEN g.def_index || '::' || g.quality || ':' || IFNULL(g.kit,'')
        ELSE ''
      END AS matchKey,
      NULL AS hashName
    FROM command c
    JOIN command_member m ON m.command_id=c.id
    ${MEMBER_HOP_JOINS}
    LEFT JOIN item i ON i.account_id=m.account_id AND i.local_id=m.local_id
    LEFT JOIN (
      SELECT account_id, group_key AS stack_key, MAX(def_index) AS def_index, MAX(quality) AS quality, MAX(kit) AS kit
      FROM item WHERE unit_kind='fungible' GROUP BY account_id, group_key
    ) g ON g.account_id=m.account_id AND g.stack_key=m.stack_key AND i.local_id IS NULL
    WHERE m.account_id IN (${marks})
      AND c.kind <> '${SELECTION_KIND}'
      AND m.state <> 'STOPPED'
      AND ((m.state IN ('PREPARED','QUEUED') AND (s.id IS NULL OR s.state IN ${OPEN_STEP_STATES_SQL}))
        OR c.id IN ${recentCommandsSql(marks)})
  `).all(...accounts, ...accounts, ...accounts) as RawWorkRow[];
}

/**
 * Work recorded as steps with no member rows (consolidation plan D2): every kind of CSFloat work,
 * listings from a unit and deliveries included, a store purchase, and the work of one hop asked
 * for by hand (a delist, a buy order placed or cancelled; `WorkStore.lone`). One row per command
 * and holding (or, for work about no holding, per command), carrying its current hop: the earliest
 * unsettled step; else the latest hop that failed, because the hops after it were never reached
 * and the failure is what there is to say; else the last settled one. The hop's action, or the
 * last action an earlier hop had, names what the glyph travels toward: a wait for CSFloat has no
 * action of its own, and is drawn on the retrieve it followed. Settled work is bounded in SQL to
 * the most recently touched commands (D25). A delivery whose sale the venue ended is the venue's
 * doing, not an outcome of anything asked for here, and leaves the list the way a stopped command
 * does (N-WORK-02).
 *
 * A hand delist is confirmed only when a complete walk no longer shows the listing *and* an
 * inventory walk after it still holds the item — gone from the market alone may have been a sale
 * (N-WORK-07). A buy order names a market name, not an item: `hashName` is the order's, or for a
 * create the name it asked for, and no identity key travels (N-WORK-08).
 */
function stepOpenWork(database: EngineDatabase, accounts: readonly string[]): RawWorkRow[] {
  const marks = accounts.map(() => '?').join(',');
  return database.raw().prepare(`
    SELECT * FROM (
      SELECT s.account_id AS accountId, s.command_id AS commandId, c.kind AS commandKind, c.state AS commandState, c.authority AS authority,
        c.created_at AS submittedAt, COALESCE(s.local_id, s.id) AS memberId,
        ${STEP_STATE_SQL} AS memberState, ${RETRY_COLUMNS},
        1 AS quantity,
        s.local_id AS localId, NULL AS stackKey,
        COALESCE(i.def_index, 0) AS defIndex, i.paint_index AS paintIndex, COALESCE(i.quality, 0) AS quality, i.paint_wear AS paintWear,
        NULL AS destinationCasketId,
        COALESCE(json_extract(s.params_json,'$.priceCents'), json_extract(s.params_json,'$.maxPriceCents')) AS priceReceiveCents,
        a.kind AS actionKind, a.state AS actionState, s.updated_at AS updatedAt,
        ${STEP_REASON_SQL} AS reason,
        IFNULL(i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,''), '') AS matchKey,
        CASE WHEN s.local_id IS NULL THEN COALESCE(json_extract(s.params_json,'$.hashName'), b.hash_name, sb.hash_name) END AS hashName,
        ROW_NUMBER() OVER (
          PARTITION BY s.command_id, s.account_id, COALESCE(s.local_id, s.target_id, s.id)
          ORDER BY CASE WHEN s.state IN ${OPEN_STEP_STATES_SQL} THEN 0 WHEN s.state='FAILED' THEN 1 ELSE 2 END,
                   CASE WHEN s.state IN ${OPEN_STEP_STATES_SQL} THEN s.ordinal ELSE -s.ordinal END) AS hop
      FROM work_step s
      JOIN command c ON c.id=s.command_id
      LEFT JOIN action own ON own.id=s.action_id
      LEFT JOIN action a ON a.id=${STEP_ACTION_SQL}
      LEFT JOIN item i ON i.account_id=s.account_id AND i.local_id=s.local_id
      LEFT JOIN venue_order b ON b.account_id=s.account_id AND b.venue='csfloat' AND b.side='BUY' AND b.venue_order_id=s.target_id AND s.kind IN ('CSFLOAT_BUY_ORDER_EDIT','CSFLOAT_BUY_ORDER_CANCEL')
      LEFT JOIN venue_order sb ON sb.account_id=s.account_id AND sb.venue='steam' AND sb.side='BUY' AND sb.venue_order_id=s.target_id AND s.kind='BUY_ORDER_CANCEL'
      WHERE s.account_id IN (${marks}) AND c.state <> 'STOPPED'
        AND NOT EXISTS (SELECT 1 FROM command_member m WHERE m.command_id=s.command_id)
        AND NOT (c.kind='CSFLOAT_DELIVER' AND EXISTS (
          SELECT 1 FROM csfloat_trade t WHERE t.account_id=s.account_id AND t.trade_id=s.target_id AND t.state_word IN ('failed','cancelled')))
        AND (s.state IN ${OPEN_STEP_STATES_SQL} OR s.command_id IN ${recentCommandsSql(marks)})
    ) WHERE hop=1
  `).all(...accounts, ...accounts, ...accounts) as RawWorkRow[];
}

/**
 * Whether a row has stopped moving.
 *
 * `COMPLETE` here means an observation proved the effect, not that a mutation returned: the
 * member's hop reached `DONE`. `FAILED` and `REJECTED` are settled too, but they are settled
 * *badly*, and the indicator keeps showing them until a person has looked — which is why they are
 * reported rather than filtered away at the source.
 *
 * The query used to contradict this comment: it excluded `c.state='REJECTED'` outright, so a
 * refused command was invisible in the one place built to show refusals. A store refused for a
 * stale CSFloat observation left the window claiming success and the panel showing nothing. The
 * CSFloat source had the same contradiction until CSF-30: it dropped `FAILED` operations in SQL,
 * so a create the venue refused vanished from the panel on the next poll.
 *
 * Judged on `memberState`, not on the action: a listing member whose retrieve is `DONE` still
 * has its listing hop to come, and a `BLOCKED` one has stopped moving without any action saying so.
 */
const SETTLED: ReadonlySet<string> = new Set(['COMPLETE', 'FAILED', 'REJECTED', 'BLOCKED', 'STOPPED', 'SOLD']);
function isSettled(row: WorkRow): boolean {
  return SETTLED.has(row.memberState);
}

/**
 * Open work for a scope, newest first, at most 1,000 rows: what the work panel and the indicator
 * show, and nothing else feeds them.
 *
 * **Every piece of work the engine queues or sends reaches a person through this read**, from
 * admission until an observation settles it. It reads one table, the hops of every command
 * (`work_step`, consolidation plan D2), two ways:
 *
 *  - a command with members, on their hops (`memberOpenWork`): every Steam command and account
 *    transfer, one row per member;
 *  - any other command, by its hops (`stepOpenWork`): every kind of CSFloat work, listings from a
 *    unit and deliveries included, store purchases, and the work of one hop asked for by hand.
 *
 * Work recorded as a bare action outside a command is invisible, and nothing fails. That happened
 * twice — a hand delist (N-WORK-07) and buy-order cancels and edits (N-WORK-08) were each shown
 * only on their own page — which is why every enqueue site is a hop now, and
 * `tests/unit/work-coverage.test.ts` names the source of every action kind the engine enqueues.
 *
 * Command-state changes do not raise a `changed` notice. The renderer polls this while it
 * has open rows and re-reads on every observation notice.
 */
export function pageOpenWork(database: EngineDatabase, request: { accountIds: readonly string[] }): WorkPage {
  const accounts = assertAccountScope(database, request.accountIds);
  const all = [...memberOpenWork(database, accounts), ...stepOpenWork(database, accounts)]
    .map(describeRetry)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || right.commandId.localeCompare(left.commandId)
      || right.memberId.localeCompare(left.memberId));

  // Newest first, so the commands whose settled members are kept are the ones just acted on.
  const recent = new Set<string>();
  for (const row of all) {
    if (recent.size >= SETTLED_COMMAND_LIMIT) break;
    recent.add(row.commandId);
  }
  const rows = all.filter((row) => !isSettled(row) || recent.has(row.commandId)).slice(0, OPEN_WORK_LIMIT);
  return bounded({ rows });
}

export function pageCommandMembers(database: EngineDatabase, request: ScopedPageRequest & { commandId: string }) {
  const accounts = assertAccountScope(database, request.accountIds);
  return queryPage(database, request, `command:${request.commandId}`, `SELECT m.account_id AS accountId, m.local_id AS memberId, m.state AS state, m.quantity AS quantity,
    (SELECT s.action_id FROM work_step s WHERE s.command_id=m.command_id AND s.account_id=m.account_id AND s.local_id=m.local_id AND s.action_id IS NOT NULL ORDER BY s.ordinal DESC LIMIT 1) AS actionId
    FROM command_member m WHERE m.command_id=? AND m.account_id IN (${accounts.map(() => '?')})`, [request.commandId, ...accounts], ['accountId', 'memberId']);
}
