import type { EnginePorts, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, EngineDatabase } from '../db/database.js';
import type { AccountEndpointGovernors } from './governor.js';
import { EngineSignals } from './signals.js';
import type { AccountLock } from './support.js';
import { classifyAmbiguity } from './outcome.js';
import { errorMessage } from './support.js';
import { marketplaceBlock, type MarketplaceConsent } from './marketplace-commitments.js';
import { TradeStore } from '../db/trades.js';

/**
 * What a composing host lets standing Steam buy orders do with one account's wallet (requirements
 * BUY-11; `policy/wallet-admission.ts` admits by it). Here, in the kernel, so the admission policy
 * and the portfolio read compute the same figures.
 *
 * - `multiple` × (`balance` − `reserveCents`) × `safety` is the most every standing order together
 *   may commit. Steam lets standing orders total more than the wallet holds; how far to lean on
 *   that is the host's belief, never the engine's.
 * - `reserveCents` is wallet money something else will spend, kept out of every figure here.
 * - `maxOpenOrders` is how many orders may stand at once, the account's own and anyone else's.
 */
export type BuyOrderAdmissionPolicy = { multiple: number; safety: number; reserveCents: number; maxOpenOrders: number };
/** One composing host's policy for each account, answered synchronously (a host answers from a cache). */
export type BuyOrderAdmission = (accountId: string) => BuyOrderAdmissionPolicy;
/** The desktop's rule, and the default: what the wallet holds, nothing set aside, no count. Today's arithmetic to the cent. */
export const DEFAULT_BUY_ORDER_ADMISSION: BuyOrderAdmissionPolicy = { multiple: 1, safety: 1, reserveCents: 0, maxOpenOrders: Number.POSITIVE_INFINITY };

/** The checked policy a host gave, or the default. A policy that would let orders commit less than the spendable balance at 1x, or nothing at all, is refused. */
export function admissionPolicy(admission: BuyOrderAdmission | undefined, accountId: string): BuyOrderAdmissionPolicy {
  const policy = admission?.(accountId) ?? DEFAULT_BUY_ORDER_ADMISSION;
  if (!(policy.multiple >= 1) || !(policy.safety > 0) || !(policy.safety <= 1) || !(policy.reserveCents >= 0) || !(policy.maxOpenOrders >= 0)) {
    throw new Error('A buy-order admission policy needs a multiple of at least 1, a safety in (0, 1], and a reserve and a count of at least 0');
  }
  return policy;
}

/** What standing orders may commit under a policy: `floor(multiple × max(0, balance − reserve) × safety)`. */
export function commitmentCapCents(balanceCents: number, policy: BuyOrderAdmissionPolicy): number {
  return Math.floor(policy.multiple * Math.max(0, balanceCents - policy.reserveCents) * policy.safety);
}

/**
 * Everything a service needs. Passed once at construction so services stay small.
 *
 * No read coalescer here any more: the read broker (`orchestrate/reads.ts`) runs one walk per scope
 * at a time and answers every need it can from it, which is what `SingleFlight` on the surfaces
 * used to approximate from below (read broker plan D2, D3).
 */
export type EngineContext = {
  readonly database: EngineDatabase;
  readonly ports: EnginePorts;
  readonly governors: AccountEndpointGovernors;
  readonly locks: AccountLock;
  /** Hints that a read is worth doing. Never evidence — see `kernel/signals.ts`. */
  readonly signals: EngineSignals;
  /** The composing host's buy-order limits, per account; absent, one times the wallet and no count. */
  readonly buyOrderAdmission?: BuyOrderAdmission | undefined;
  now(): string;
};

export function createContext(
  database: EngineDatabase,
  ports: EnginePorts,
  governors: AccountEndpointGovernors,
  locks: AccountLock,
  signals: EngineSignals = new EngineSignals(),
  buyOrderAdmission?: BuyOrderAdmission
): EngineContext {
  return {
    database,
    ports,
    governors,
    locks,
    signals,
    buyOrderAdmission,
    now: () => ports.clock.now().toISOString()
  };
}

/** A mutation that has gone out, and the answer it is still waiting for. */
export type SentMutation = { answer: Promise<MutationOutcome> };

/**
 * The single path through which every external mutation runs.
 *
 * Records an attempt, applies the rate budget and circuit breaker, and converts any thrown
 * error into `AMBIGUOUS`. It never decides that an effect landed — only a later complete
 * observation may do that, so this returns `MutationOutcome`, which excludes `OBSERVED_*`
 * at the type level.
 */
export async function executeMutation(
  context: EngineContext,
  action: ActionRow,
  call: () => Promise<MutationOutcome>,
  validate?: () => void,
  answered?: AnswerRecorder,
  breakerFailure?: BreakerVerdict
): Promise<MutationOutcome> {
  return (await sendMutation(context, action, call, validate, answered, breakerFailure)).answer;
}

/**
 * Whether an answer counts against its kind's circuit breaker: a failure when it does, a success
 * when it does not. Every `AMBIGUOUS` answer counts, unless the surface that sends the kind passes
 * its own verdict; only a Steam discard does (`MarketService.discardTripsBreaker`), because an
 * answer Steam gave to one can be ambiguous and still say the route answers.
 */
export type BreakerVerdict = (outcome: MutationOutcome) => boolean;

/** The verdict every kind but one is held to: an ambiguous answer is a failure. */
export const AMBIGUOUS_IS_FAILURE: BreakerVerdict = (outcome) => outcome.kind === 'AMBIGUOUS';

/**
 * What a surface records from an answer, in the one transaction that finishes the attempt, so no
 * settle, wake or restart ever finds the attempt's outcome without it: the venue's own wait, or the
 * one kind of answer that states its effect (a listing's price named back by the call that changed
 * it). `at` is when the answer was recorded. It writes the record and nothing else. Should it throw,
 * the attempt is still finished, alone, with the venue's answer stored on it, and the surface
 * re-derives what it would have written from that stored answer the next time it looks at the
 * action (`MarketService.repairPriceAnswer`); the failure is recorded as `answer-record-error`.
 */
export type AnswerRecorder = (outcome: MutationOutcome, at: string) => void;

/**
 * One venue call that carries several actions of one kind on one account (CSFloat's bulk accept).
 *
 * Each action is checked and gets its own attempt row exactly as `sendMutation` does it; the call is made once,
 * under one token of the kind's budget and one verdict of its breaker, and each action is settled by its own entry
 * of the answer, AMBIGUOUS where the answer names none. An action whose checks refuse it is left out of the call and
 * answered with the error, and nothing is sent when every action is left out.
 */
export async function executeBatchMutation(
  context: EngineContext,
  items: ReadonlyArray<{ action: ActionRow; validate?: () => void }>,
  call: (actions: readonly ActionRow[]) => Promise<ReadonlyMap<string, MutationOutcome>>
): Promise<Map<string, MutationOutcome | Error>> {
  const answers = new Map<string, MutationOutcome | Error>();
  const first = items[0]?.action;
  if (!first) return answers;
  if (items.some(({ action }) => action.account_id !== first.account_id || action.kind !== first.kind)) throw new Error('A batch is one account and one action kind');
  const governor = context.governors.forMutation(first.account_id, first.kind);
  if (!governor.breaker.canAttempt()) throw new Error(`Circuit open for ${first.kind} on ${first.account_id}`);
  await governor.bucket.take();

  const sent: ActionRow[] = [];
  for (const { action, validate } of items) {
    try {
      const current = context.database.action(action.id);
      if (!current || current.state !== 'READY' || !context.database.currentDesired(current)) throw new Error('Action is no longer current and READY');
      validate?.();
      sent.push(current);
    } catch (error) {
      answers.set(action.id, error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }
  if (!sent.length) return answers;
  const attempts = new Map(sent.map((action) => [action.id, context.database.startAttempt(action.id, context.now())]));
  let outcomes: ReadonlyMap<string, MutationOutcome>;
  try {
    outcomes = await call(sent);
  } catch (error) {
    const lost: MutationOutcome = { kind: 'AMBIGUOUS', cause: classifyAmbiguity(error), raw: errorMessage(error) };
    outcomes = new Map(sent.map((action) => [action.id, lost]));
  }
  const unnamed: MutationOutcome = { kind: 'AMBIGUOUS', cause: 'unclassified', raw: 'the batch answer named no outcome for this action' };
  if (sent.some((action) => (outcomes.get(action.id) ?? unnamed).kind === 'AMBIGUOUS')) governor.breaker.failure();
  else governor.breaker.success();
  for (const action of sent) {
    const outcome = outcomes.get(action.id) ?? unnamed, now = context.now();
    context.database.finishAttempt(action.id, attempts.get(action.id)!, outcome.kind, outcome.raw, now,
      outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : undefined, venueRetryAt(outcome, now));
    context.signals.emit({ kind: 'mutation-settled', accountId: action.account_id, actionKind: action.kind, outcome: outcome.kind, targetId: action.target_id });
    answers.set(action.id, outcome);
  }
  return answers;
}

/**
 * When a venue that refused the request says it may be made again, as an instant on the engine's
 * clock (rule 9: `now` is a parameter); `null` for every other answer. Kept on the attempt, so the
 * hold survives a restart and the work panel counts down to the same instant the resend waits for.
 */
export function venueRetryAt(outcome: MutationOutcome, now: string): string | null {
  return outcome.kind === 'DEFINITIVELY_REJECTED' && outcome.retryAfterMs !== undefined
    ? new Date(Date.parse(now) + outcome.retryAfterMs).toISOString() : null;
}

/**
 * `executeMutation`, returning once the call has gone out rather than once it is answered.
 *
 * Everything before the call is the same: the budget, the breaker, the checks, the attempt row.
 * Then the call is made and this returns at once, so a caller may send its next mutation while
 * this one waits for its answer (bulk storage plan D1). The answer still records the attempt's
 * outcome and the breaker's verdict, exactly as `executeMutation` does. A refusal before the call
 * is thrown from here, with nothing sent.
 */
export async function sendMutation(
  context: EngineContext,
  action: ActionRow,
  call: () => Promise<MutationOutcome>,
  validate?: () => void,
  answered?: AnswerRecorder,
  breakerFailure: BreakerVerdict = AMBIGUOUS_IS_FAILURE
): Promise<SentMutation> {
  if (action.state !== 'READY') throw new Error(`Action ${action.id} is not READY`);
  const governor = context.governors.forMutation(action.account_id, action.kind);
  if (!governor.breaker.canAttempt()) throw new Error(`Circuit open for ${action.kind} on ${action.account_id}`);
  await governor.bucket.take();

  const current = context.database.action(action.id);
  if (!current || current.state !== 'READY' || !context.database.currentDesired(current)) throw new Error('Action is no longer current and READY');
  // A hop of a command has no goal to be suspended or to expire: its step carries it (D3).
  const goal = current.desired_id ? context.database.desiredState(current.desired_id) : undefined;
  if (goal?.suspended_reason) throw new Error(`Goal suspended: ${goal.suspended_reason}`);
  if (goal?.expires_at && goal.expires_at <= context.now()) throw new Error('Goal expired; review before resuming');
  validate?.();

  // The claims the person chose to store this item despite, frozen on the move (bulk storage plan D9).
  const consent = current.kind === 'STORE_IN_CASKET' ? ((context.database.actionParams(current) as { consent?: readonly MarketplaceConsent[] } | null)?.consent ?? []) : [];
  if (['STORE_IN_CASKET','CREATE_SELL_LISTING'].includes(current.kind)) {
    const reason = marketplaceBlock(context.database,current.account_id,current.target_id,current.kind === 'STORE_IN_CASKET' ? 'storage' : 'steam-list',context.now(),'',consent);
    if (reason) throw new Error(reason);
  }

  if (['STORE_IN_CASKET','RETRIEVE_FROM_CASKET','CREATE_SELL_LISTING'].includes(current.kind)) {
    const asset = context.database.itemByLocalId(current.account_id,current.target_id)?.asset_id;
    const pledged = new TradeStore(context.database).committedTradeAssets(current.account_id,['ACTIVE','PENDING_CONFIRMATION','ESCROW','ACCEPTED','COUNTERED','UNKNOWN']);
    // A transfer pledges its assets from admission, before Steam names an offer, and one that
    // retrieves a crated item first is pledging the very asset its own hop moves. That hop is a
    // step of the command that pledged, and is the one mutation the pledge does not refuse; every
    // other command's is.
    const hop = current.step_id ? context.database.raw().prepare('SELECT command_id FROM work_step WHERE id=?').get(current.step_id) as { command_id: string } | undefined : undefined;
    const own = hop ? `command:${hop.command_id}` : null;
    if (asset && !consent.includes('trade-pledged') && pledged.some(line => line.asset_id === asset && line.offer_id !== own)) throw new Error('Item is committed to a trade');
  }

  const attemptId = context.database.startAttempt(action.id, context.now());
  // The call is made before the first await below, so the request is on its way when this returns.
  const answer = (async (): Promise<MutationOutcome> => {
    let outcome: MutationOutcome;
    try {
      outcome = await call();
    } catch (error) {
      outcome = { kind: 'AMBIGUOUS', cause: classifyAmbiguity(error), raw: errorMessage(error) };
    }

    if (breakerFailure(outcome)) governor.breaker.failure();
    else governor.breaker.success();

    const now = context.now();
    const finish = (): void => context.database.finishAttempt(
      action.id,
      attemptId,
      outcome.kind,
      outcome.raw,
      now,
      outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : undefined,
      venueRetryAt(outcome, now)
    );
    if (answered) {
      // One transaction: an attempt finished without what its answer said would read, to every
      // later pass and after a restart, as an answer that said something else.
      try {
        context.database.transaction(() => { finish(); answered(outcome, now); });
      } catch (error) {
        finish();
        context.database.addEvent(action.account_id, 'answer-record-error', { actionId: action.id, actionKind: action.kind, message: errorMessage(error) }, now);
      }
    } else {
      finish();
    }
    // A settled attempt is the strongest available hint that the surfaces which could *prove* its
    // effect are now worth re-reading. It is emphatically not a hint to try again: this signal
    // reaches a scheduler whose only verbs are the `sync*` methods (rule 1).
    context.signals.emit({
      kind: 'mutation-settled',
      accountId: action.account_id,
      actionKind: action.kind,
      outcome: outcome.kind,
      targetId: action.target_id
    });
    return outcome;
  })();
  // Whoever sent it awaits the answer; this only keeps a rejection nobody has awaited yet — the
  // runtime closing SQLite under a shutdown — from surfacing as an unhandled one.
  answer.catch(() => undefined);
  return { answer };
}
