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
  now(): string;
};

export function createContext(
  database: EngineDatabase,
  ports: EnginePorts,
  governors: AccountEndpointGovernors,
  locks: AccountLock,
  signals: EngineSignals = new EngineSignals()
): EngineContext {
  return {
    database,
    ports,
    governors,
    locks,
    signals,
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
  validate?: () => void
): Promise<MutationOutcome> {
  return (await sendMutation(context, action, call, validate)).answer;
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
  validate?: () => void
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

    if (outcome.kind === 'AMBIGUOUS') governor.breaker.failure();
    else governor.breaker.success();

    context.database.finishAttempt(
      action.id,
      attemptId,
      outcome.kind,
      outcome.raw,
      context.now(),
      outcome.kind === 'DEFINITIVELY_REJECTED' ? outcome.reason : undefined
    );
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
