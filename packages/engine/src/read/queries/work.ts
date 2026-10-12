import type { EngineDatabase } from '../../db/database.js';
import { COMMAND_BASIS, MEMBER_CARRIER_JOINS, MEMBER_REASON_SQL, MEMBER_STATE_SQL } from '../../db/member-state.js';
import { csfloatOpenOperations } from './csfloat.js';
import { attemptLimit, RETRY_POLICY, retryPlan } from '../../kernel/retry-policy.js';
import { assertAccountScope, bounded, queryPage, type ScopedPageRequest } from './paging.js';

/**
 * One member of an open command, joined to the item or stack it names and the action
 * currently carrying it.
 *
 * `memberState` is observation-honest: `COMPLETE` only when the carrying action is `DONE`.
 * A mutation receipt is `SUBMITTED`, never `COMPLETE` — rule 1. Which action carries a member,
 * and the words, are `db/member-state.ts`: a listing member follows its goal, because nothing
 * else it points at ever changes. `reason` is why it is `BLOCKED` or `FAILED`, when it is.
 *
 * `hashName` is set on work about a buy order, which names a market name and no item this app
 * holds: main names the row by it, and its identity fields are empty. `null` on item work, which
 * main names by identity.
 *
 * `retryAt`, `attempt` and `attemptLimit` are the retry facts, from the arithmetic the resender
 * uses (`kernel/retry-policy.ts`): on a `RETRYING` member, when the next send is due and which number
 * it will be; on a member sent more than once, which send it is waiting on. `null` on work with
 * no retry in its policy, so the panel says nothing about attempts for work that gets one.
 */
export type WorkRow = {
  accountId: string; commandId: string; commandKind: string; commandState: string;
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
type RawWorkRow = Omit<WorkRow, 'retryAt' | 'attempt' | 'attemptLimit'> & { actionResolution?: string | null; attempts?: number | null };

/** The two columns a source joins from `action` for `describeRetry`; `a` is the carrying action. */
const RETRY_COLUMNS = `a.resolution AS actionResolution, (SELECT COUNT(*) FROM attempt t WHERE t.action_id=a.id) AS attempts`;

/**
 * Adds the retry facts to a row, from the same arithmetic the resender uses, so the panel's
 * countdown and the send it announces cannot disagree. A `READY` action a walk proved not
 * applied is waiting for `retryAt`; any other action sent more than once reports which send it
 * is on. Work whose policy allows one send says nothing.
 */
function describeRetry(row: RawWorkRow): WorkRow {
  const { actionResolution, attempts, ...rest } = row;
  const policy = row.actionKind ? RETRY_POLICY[row.actionKind] : undefined;
  const made = attempts ?? 0;
  if (!policy || made === 0 || attemptLimit(policy) < 2) return { ...rest, retryAt: null, attempt: null, attemptLimit: null };
  if (row.actionState === 'READY' && actionResolution === 'OBSERVED_NOT_APPLIED') {
    const plan = retryPlan(policy, made, row.updatedAt);
    return { ...rest, retryAt: plan.kind === 'again' ? plan.retryAt : null, attempt: plan.attempt, attemptLimit: plan.limit };
  }
  return { ...rest, retryAt: null, attempt: made, attemptLimit: attemptLimit(policy) };
}

const OPEN_WORK_LIMIT = 1_000;

function commandOpenWork(database: EngineDatabase, accounts: readonly string[]): RawWorkRow[] {
  const marks = accounts.map(() => '?').join(',');
  return database.raw().prepare(`
    SELECT m.account_id AS accountId, c.id AS commandId, c.kind AS commandKind, c.state AS commandState,
      c.created_at AS submittedAt, m.member_id AS memberId,
      ${MEMBER_STATE_SQL} AS memberState, ${RETRY_COLUMNS},
      m.quantity AS quantity,
      CASE WHEN m.stack_key IS NULL THEN m.member_id END AS localId,
      m.stack_key AS stackKey,
      COALESCE(i.def_index, s.def_index, 0) AS defIndex,
      i.paint_index AS paintIndex,
      COALESCE(i.quality, s.quality, 0) AS quality,
      i.paint_wear AS paintWear,
      m.destination AS destinationCasketId,
      m.price_receive_cents AS priceReceiveCents,
      a.kind AS actionKind, a.state AS actionState,
      COALESCE(a.updated_at, c.created_at) AS updatedAt,
      ${MEMBER_REASON_SQL} AS reason,
      CASE
        WHEN m.stack_key IS NULL THEN i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,'')
        ELSE s.def_index || '::' || s.quality || ':' || IFNULL(s.kit,'')
      END AS matchKey,
      NULL AS hashName
    FROM command c
    JOIN command_member m ON m.command_id=c.id
    LEFT JOIN item i ON i.account_id=m.account_id AND i.local_id=m.member_id AND m.stack_key IS NULL
    LEFT JOIN (
      SELECT account_id, group_key AS stack_key, MAX(def_index) AS def_index, MAX(quality) AS quality, MAX(kit) AS kit
      FROM item WHERE unit_kind='fungible' GROUP BY account_id, group_key
    ) s ON s.account_id=m.account_id AND s.stack_key=m.stack_key
    ${MEMBER_CARRIER_JOINS}
    WHERE m.account_id IN (${marks})
      AND c.state NOT IN ('STOPPED')
      AND m.state NOT IN ('STOPPED')
  `).all(...accounts) as RawWorkRow[];
}

/**
 * Delists asked for by hand, in the shape `work.open` speaks.
 *
 * `listing.remove` queues a `REMOVE_SELL_LISTING` action with no command behind it, so nothing in
 * `command_member` names it and the panel built to say what is in flight never heard of a delist.
 * The fact was already recorded — an action row whose state only the market walk may advance —
 * and this is the read over it, folded in the way CSFloat's operations are. `commandKind` is
 * synthesised (`DELIST`) and the action's id stands in for the command's, because there is none.
 *
 * A reprice or a delist-to-storage cancels a listing too, as its first hop. That removal is
 * already reported through its member, and the member is re-pointed at the second hop once the
 * first is proved, so it is told apart by who asked: a chain's delist carries `COMMAND_BASIS`.
 *
 * `memberState` is observation-honest (rule 1): `COMPLETE` only for a `DONE` action, which the
 * reconciler writes only when a complete walk no longer shows the listing *and* the item is
 * observed back in main inventory — gone from the market alone may have been a sale. `RETRYING`
 * is a `READY` action a walk proved not applied, waiting for its next send (`kernel/retry-policy.ts`).
 */
function delistOpenWork(database: EngineDatabase, accounts: readonly string[]): RawWorkRow[] {
  const marks = accounts.map(() => '?').join(',');
  return database.raw().prepare(`
    SELECT a.account_id AS accountId, a.id AS commandId, 'DELIST' AS commandKind, a.state AS commandState,
      a.created_at AS submittedAt, a.id AS memberId,
      CASE a.state WHEN 'DONE' THEN 'COMPLETE'
        WHEN 'READY' THEN CASE WHEN a.resolution='OBSERVED_NOT_APPLIED' THEN 'RETRYING' ELSE 'QUEUED' END
        ELSE a.state END AS memberState,
      ${RETRY_COLUMNS},
      1 AS quantity,
      l.local_id AS localId, NULL AS stackKey,
      COALESCE(i.def_index, 0) AS defIndex, i.paint_index AS paintIndex,
      COALESCE(i.quality, 0) AS quality, i.paint_wear AS paintWear,
      NULL AS destinationCasketId, NULL AS priceReceiveCents,
      a.kind AS actionKind, a.state AS actionState, a.updated_at AS updatedAt,
      CASE WHEN a.state='FAILED' THEN a.error END AS reason,
      IFNULL(i.def_index || ':' || IFNULL(i.paint_index,'') || ':' || i.quality || ':' || IFNULL(i.kit,''), '') AS matchKey,
      NULL AS hashName
    FROM action a
    JOIN desired_state d ON d.id=a.desired_id
    LEFT JOIN market_listing l ON l.account_id=a.account_id AND l.listing_id=json_extract(d.params_json,'$.listingId')
    LEFT JOIN item i ON i.account_id=l.account_id AND i.local_id=l.local_id
    WHERE a.account_id IN (${marks}) AND a.kind='REMOVE_SELL_LISTING' AND d.basis<>?
  `).all(...accounts, COMMAND_BASIS) as RawWorkRow[];
}

/**
 * Steam buy-order work, in the shape `work.open` speaks.
 *
 * A cancel is a bare `CANCEL_BUY_ORDER` action, as a hand delist is a bare `REMOVE_SELL_LISTING`:
 * no command names it, and until this read the work panel never heard of one (N-WORK-08). A
 * create is the same shape. `commandKind` is the action's kind and its id stands in for the
 * command's.
 *
 * A never-sent `READY` is left out. The request queues the action and sends it in the same call,
 * so one is a send that never started, and nothing would ever advance it; the buy-order book does
 * not count it either. A `READY` a walk proved not applied is different: `RetryService` sends it
 * again when its turn comes, and it reads `RETRYING` until then. `COMPLETE` only for a `DONE`
 * action, which the reconciler writes only when a complete market walk shows the effect (rule 1).
 *
 * A buy order names a market name, not an item: `hashName` is the order's, or for a create the
 * name it asked for, and no identity key travels.
 */
function steamBuyOrderOpenWork(database: EngineDatabase, accounts: readonly string[]): RawWorkRow[] {
  const marks = accounts.map(() => '?').join(',');
  return database.raw().prepare(`
    SELECT a.account_id AS accountId, a.id AS commandId, a.kind AS commandKind, a.state AS commandState,
      a.created_at AS submittedAt, a.id AS memberId,
      CASE a.state WHEN 'DONE' THEN 'COMPLETE' WHEN 'READY' THEN 'RETRYING' ELSE a.state END AS memberState,
      ${RETRY_COLUMNS},
      1 AS quantity, NULL AS localId, NULL AS stackKey,
      0 AS defIndex, NULL AS paintIndex, 0 AS quality, NULL AS paintWear,
      NULL AS destinationCasketId, NULL AS priceReceiveCents,
      a.kind AS actionKind, a.state AS actionState, a.updated_at AS updatedAt,
      CASE WHEN a.state='FAILED' THEN a.error END AS reason,
      '' AS matchKey,
      IFNULL(CASE a.kind WHEN 'CREATE_BUY_ORDER' THEN a.target_id ELSE b.hash_name END, '') AS hashName
    FROM action a
    LEFT JOIN buy_order b ON a.kind='CANCEL_BUY_ORDER' AND b.account_id=a.account_id AND b.buy_order_id=a.target_id
    WHERE a.account_id IN (${marks}) AND a.kind IN ('CREATE_BUY_ORDER','CANCEL_BUY_ORDER')
      AND (a.state<>'READY' OR a.resolution='OBSERVED_NOT_APPLIED')
  `).all(...accounts) as RawWorkRow[];
}

/**
 * Whether a row has stopped moving.
 *
 * `COMPLETE` here means an observation proved the effect, not that a mutation returned: the
 * member's action reached `DONE`. `FAILED` and `REJECTED` are settled too, but they are settled
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
const SETTLED: ReadonlySet<string> = new Set(['COMPLETE', 'FAILED', 'REJECTED', 'BLOCKED', 'STOPPED']);
function isSettled(row: WorkRow): boolean {
  return SETTLED.has(row.memberState);
}

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
 * Open work for a scope, newest first, at most 1,000 rows: what the work panel and the indicator
 * show, and nothing else feeds them.
 *
 * **Every piece of work the engine queues or sends reaches a person through this read**, from
 * admission until an observation settles it. It is a union of sources, and a source is opt-in:
 * work recorded anywhere else is invisible, and nothing fails. That has happened twice — a hand
 * delist (N-WORK-07) and buy-order cancels and edits (N-WORK-08) were each shown only on their own
 * page. So a new kind of work joins a source here, or is a new one, in the `WorkRow` shape:
 *
 *  - command members (`commandOpenWork`);
 *  - bare Steam actions no command names: hand delists (`delistOpenWork`) and buy orders
 *    (`steamBuyOrderOpenWork`);
 *  - CSFloat operations of every kind (`csfloatOpenOperations`).
 *
 * `tests/unit/work-coverage.test.ts` names the source of every action kind the engine enqueues.
 *
 * Command-state changes do not raise a `changed` notice. The renderer polls this while it
 * has open rows and re-reads on every observation notice.
 */
export function pageOpenWork(database: EngineDatabase, request: { accountIds: readonly string[] }): WorkPage {
  const accounts = assertAccountScope(database, request.accountIds);
  const all = [...commandOpenWork(database, accounts), ...delistOpenWork(database, accounts),
    ...steamBuyOrderOpenWork(database, accounts), ...csfloatOpenOperations(database, accounts)]
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
  return queryPage(database, request, `command:${request.commandId}`, `SELECT account_id AS accountId,member_id AS memberId,state,quantity,action_id AS actionId FROM command_member
    WHERE command_id=? AND account_id IN (${accounts.map(() => '?')})`, [request.commandId, ...accounts], ['accountId', 'memberId']);
}
