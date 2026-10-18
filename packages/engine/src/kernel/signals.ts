import type { AccountId, GcConnectionState, MutationOutcome } from '@cslytics/ports';
import type { Surface } from './evidence.js';

/**
 * The engine's in-process signal bus.
 *
 * A signal is a **hint that a read is worth doing**. It is never a fact, and nothing downstream
 * may treat one as evidence: every fact still arrives through an `observation` row written by a
 * surface. That distinction is what keeps repository rule 1 intact once a scheduler is the thing
 * driving work — a bus that carried facts would let "Steam accepted the sell" become "the item
 * is listed" without anybody walking the book.
 *
 * It replaces `InventoryService.onObservation`, which was the same idea with exactly one
 * publisher and one subscriber. Emission points are the ones that already existed: an
 * observation being written, a GC event being applied, a mutation settling, a session changing
 * state. Nothing new is recorded, and nothing here is persisted — a signal missed because the
 * process died costs one cadence interval, because the next pass re-derives due-ness from the
 * `observation` table rather than from anything held in memory.
 *
 * **Delivery is synchronous, on the emitter's stack, and that is load-bearing.** Settling is not:
 * it runs a turn later, once per burst (`orchestrate/settle.ts`). What must be true when a
 * publisher returns is that the settler has *marked* the account owed, so that
 * `TradingEngine.settled` awaited right after `applyGcEvent` waits for the settle rather than
 * answering at once — `GC-EVT-01` does exactly that. Deferring delivery to a microtask would
 * make that await a no-op.
 *
 * The cost of synchronous delivery is the rule a listener has to keep: **it runs wherever the
 * publisher was, so it may not open a transaction or write.** Every `observed` signal is emitted
 * after its transaction commits, so a listener that reads the database may subscribe to those;
 * `order-changed` can be emitted from inside a walk's transaction and is consumed only by
 * in-memory scheduling bookkeeping. A listener also may not take the emitter down with it — a
 * scheduler bug must never abort an inventory snapshot — so a throw is reported, not propagated.
 *
 * Re-entrancy is queued rather than recursed: a listener that emits gets its signal delivered
 * after the current one finishes, in order, so a burst stays in the order Steam sent it and a
 * mutually-triggering pair cannot blow the stack.
 */
export type EngineSignal =
  /** A surface was walked. `complete` is the walk's own verdict, not a freshness judgement. */
  | { kind: 'observed'; accountId: AccountId; surface: Surface; scopeId?: string; complete: boolean; observationId: number }
  /** One GC item event was applied. */
  | { kind: 'gc-item'; accountId: AccountId; change: 'added' | 'updated' | 'removed'; casketId?: string }
  /** The CS2 Game Coordinator session changed state for this account. */
  | { kind: 'gc-session'; accountId: AccountId; state: GcConnectionState; detail?: string }
  /** One external mutation returned. The outcome is about the *attempt*, never the effect. `targetId` is the action's target. */
  | { kind: 'mutation-settled'; accountId: AccountId; actionKind: string; outcome: MutationOutcome['kind']; targetId?: string }
  /** An order's observed lifecycle state moved — a sale, a fill, a cancellation, a hold. */
  | { kind: 'order-changed'; accountId: AccountId; side: 'SELL' | 'BUY'; state: string };

export type SignalListener = (signal: EngineSignal) => void;

export class EngineSignals {
  private readonly listeners = new Set<SignalListener>();
  private readonly queued: EngineSignal[] = [];
  private flushing = false;
  /** Reported rather than thrown: see the class comment on why a listener may not break a walk. */
  onListenerError: ((error: unknown, signal: EngineSignal) => void) | undefined;

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(signal: EngineSignal): void {
    this.queued.push(signal);
    if (this.flushing) return;
    this.flushing = true;
    this.flush();
  }

  /** Delivers everything queued, in emission order, including anything a listener adds. */
  private flush(): void {
    try {
      while (this.queued.length > 0) {
        const signal = this.queued.shift()!;
        // Copied first: a listener that unsubscribes itself while being notified must not skip
        // the listener after it, which is what mutating a live Set during iteration does.
        for (const listener of [...this.listeners]) {
          try {
            listener(signal);
          } catch (error) {
            this.onListenerError?.(error, signal);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  clear(): void {
    this.listeners.clear();
    this.queued.length = 0;
  }
}
