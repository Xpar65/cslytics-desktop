import type { EnginePorts, MutationOutcome } from '@cslytics/ports';
import type { ActionRow, EngineDatabase } from '../db/database.js';
import type { AccountEndpointGovernors } from './governor.js';
import { EngineSignals } from './signals.js';
import type { AccountLock } from './support.js';
import { classifyAmbiguity } from './outcome.js';
import { errorMessage, SingleFlight } from './support.js';
import { marketplaceBlock } from './marketplace-commitments.js';
import { TradeStore } from '../db/trades.js';

/** Everything a service needs. Passed once at construction so services stay small. */
export type EngineContext = {
  readonly database: EngineDatabase;
  readonly ports: EnginePorts;
  readonly governors: AccountEndpointGovernors;
  readonly locks: AccountLock;
  /** Hints that a read is worth doing. Never evidence — see `kernel/signals.ts`. */
  readonly signals: EngineSignals;
  /** Coalesces concurrent reads of one account's surface into one walk (INV-06). */
  readonly reads: SingleFlight;
  now(): string;
};

export function createContext(
  database: EngineDatabase,
  ports: EnginePorts,
  governors: AccountEndpointGovernors,
  locks: AccountLock,
  signals: EngineSignals = new EngineSignals(),
  reads: SingleFlight = new SingleFlight()
): EngineContext {
  return {
    database,
    ports,
    governors,
    locks,
    signals,
    reads,
    now: () => ports.clock.now().toISOString()
  };
}

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
  if (action.state !== 'READY') throw new Error(`Action ${action.id} is not READY`);
  const governor = context.governors.for(action.account_id, action.kind);
  if (!governor.breaker.canAttempt()) throw new Error(`Circuit open for ${action.kind} on ${action.account_id}`);
  await governor.bucket.take();

  const current = context.database.action(action.id);
  if (!current || current.state !== 'READY' || !context.database.currentDesired(current)) throw new Error('Action is no longer current and READY');
  const goal = context.database.desiredState(current.desired_id);
  if (goal?.suspended_reason) throw new Error(`Goal suspended: ${goal.suspended_reason}`);
  if (goal?.expires_at && goal.expires_at <= context.now()) throw new Error('Goal expired; review before resuming');
  validate?.();

  if (['STORE_IN_CASKET','CREATE_SELL_LISTING'].includes(current.kind)) {
    const reason = marketplaceBlock(context.database,current.account_id,current.target_id,current.kind === 'STORE_IN_CASKET' ? 'storage' : 'steam-list',context.now());
    if (reason) throw new Error(reason);
  }

  if (['STORE_IN_CASKET','RETRIEVE_FROM_CASKET','CREATE_SELL_LISTING'].includes(current.kind)) {
    const asset = context.database.itemByLocalId(current.account_id,current.target_id)?.current_asset_id;
    const pledged = new TradeStore(context.database).committedTradeAssets(current.account_id,['ACTIVE','PENDING_CONFIRMATION','ESCROW','ACCEPTED','COUNTERED','UNKNOWN']);
    // A transfer batch pledges its assets from admission, before Steam names an offer, and a
    // batch that retrieves a crated item first is pledging the very asset its own hop moves. That
    // hop is queued under the basis `transfer:<commandId>` and is the one mutation the pledge
    // does not refuse; every other command's is.
    const own = goal?.basis.startsWith('transfer:') ? `command:${goal.basis.slice('transfer:'.length)}` : null;
    if (asset && pledged.some(line => line.asset_id === asset && line.offer_id !== own)) throw new Error('Item is committed to a trade');
  }

  const attemptId = context.database.startAttempt(action.id, context.now());
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
    outcome: outcome.kind
  });
  return outcome;
}
