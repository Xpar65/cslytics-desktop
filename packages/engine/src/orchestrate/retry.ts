import type { AccountId, MutationOutcome } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { attemptsMade } from '../kernel/not-applied.js';
import { errorMessage } from '../kernel/support.js';
import { RETRY_POLICY, retryPlan } from '../kernel/retry-policy.js';
import { WorkStore } from '../db/work.js';

/** Sends one action again, through the same executor its first send used. */
export type RetrySender = (actionId: string) => Promise<MutationOutcome>;
/** One sender per kind whose `RETRY_POLICY` row says `retry-service`; wired in the composition root. */
export type RetrySenders = Readonly<Record<string, RetrySender>>;

type Waiting = { action: ActionRow; retryAtMs: number };
type LoopControl = { stop: boolean; wake?: (() => void) | undefined };

/** The longest a loop rests between looks: a floor under the wake path, not the cadence. */
export const IDLE_MS = 60_000;

/**
 * The one resender: sends again what a walk proved did not land, when its schedule says.
 *
 * Nothing else in the engine re-sends a bare action. Convergence re-sends a listing goal's
 * `READY` step because a goal is a standing instruction; `CommandService.resume` sends members
 * that were *never* sent; neither has a verb for "sent once, proved absent, send again", and a
 * hand delist whose request died in transport had nothing looking at it at all. This service
 * owns exactly the kinds whose `RETRY_POLICY` row names it, through `senders`, and
 * `tests/unit/retry-coverage.test.ts` fails when a row and a sender disagree.
 *
 * **It never decides.** What it sends is `READY` with `OBSERVED_NOT_APPLIED`, which only a
 * reconciler writes, from a complete walk begun after the attempt (`kernel/not-applied.ts`).
 * When it sends is `retryPlan` over the attempts the row already has — derived, not stored, so a
 * restart finds the same schedule in the same rows. After the send, proof demand and the settle
 * do the rest, and a further proof of absence comes back here or ends it (rule 1).
 *
 * **It costs nothing while idle.** `schedule` is called after every settle and on every session
 * start; it is one `SELECT`, and a loop runs only while an account has something waiting. The
 * loop sleeps on `ports.clock`, so a scenario advances to the retry and asserts the send, and a
 * settle wakes it rather than waiting the sleep out.
 */
export class RetryService {
  private readonly loops = new Map<AccountId, LoopControl>();
  private stopped = false;

  constructor(protected readonly context: EngineContext, readonly senders: RetrySenders) {}

  /** Looks once; starts the account's loop if something is waiting, or wakes the one running. */
  schedule(accountId: AccountId): void {
    if (this.stopped) return;
    const running = this.loops.get(accountId);
    if (running) { running.wake?.(); return; }
    if (this.waiting(accountId).length === 0) return;
    const control: LoopControl = { stop: false };
    this.loops.set(accountId, control);
    void this.loop(accountId, control)
      .catch((error: unknown) => {
        if (!this.stopped) this.context.database.addEvent(accountId, 'retry-loop-error', { message: errorMessage(error) }, this.context.now());
      })
      .finally(() => { if (this.loops.get(accountId) === control) this.loops.delete(accountId); });
  }

  stopAccount(accountId: AccountId): void {
    const control = this.loops.get(accountId);
    if (!control) return;
    control.stop = true;
    control.wake?.();
  }

  stop(): void {
    this.stopped = true;
    for (const accountId of [...this.loops.keys()]) this.stopAccount(accountId);
  }

  /**
   * The actions waiting their turn, with when: `READY` because a walk proved the last attempt did
   * not land, of a kind this service sends, each under the schedule its attempts have earned.
   */
  waiting(accountId: AccountId): Waiting[] {
    const kinds = Object.keys(this.senders);
    if (kinds.length === 0) return [];
    const { database } = this.context;
    const rows = database.raw().prepare(`SELECT * FROM action WHERE account_id=? AND state='READY' AND resolution='OBSERVED_NOT_APPLIED'
      AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY updated_at, id`).all(accountId, ...kinds) as ActionRow[];
    const waiting: Waiting[] = [];
    for (const action of rows) {
      const plan = retryPlan(RETRY_POLICY[action.kind]!, attemptsMade(database, action.id), action.updated_at);
      if (plan.kind === 'again') waiting.push({ action, retryAtMs: Date.parse(plan.retryAt) });
    }
    return waiting;
  }

  private async loop(accountId: AccountId, control: LoopControl): Promise<void> {
    while (!control.stop && !this.stopped) {
      const waiting = this.waiting(accountId);
      if (waiting.length === 0) return;
      const nowMs = this.context.ports.clock.now().getTime();
      const due = waiting.filter((entry) => entry.retryAtMs <= nowMs);
      for (const entry of due) {
        if (control.stop || this.stopped) return;
        await this.send(accountId, entry.action);
      }
      // A send changes the set; look again before resting.
      if (due.length > 0) continue;
      const earliest = Math.min(...waiting.map((entry) => entry.retryAtMs));
      await this.rest(control, Math.max(0, Math.min(earliest - nowMs, IDLE_MS)));
    }
  }

  private async rest(control: LoopControl, delayMs: number): Promise<void> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    control.wake = wake;
    try {
      await Promise.race([this.context.ports.clock.sleep(delayMs), woken]);
    } finally {
      control.wake = undefined;
    }
  }

  /** One resend, under the account's lock, of an action that is still the one the schedule named. */
  protected async send(accountId: AccountId, action: ActionRow): Promise<void> {
    const { database } = this.context;
    const sender = this.senders[action.kind]!;
    await this.context.locks.run(accountId, async () => {
      // Re-read under the lock: a person may have asked for something else meanwhile, and a
      // newer goal retires this action rather than racing it.
      const current = database.action(action.id);
      if (!current || current.state !== 'READY' || current.resolution !== 'OBSERVED_NOT_APPLIED') return;
      try {
        await sender(action.id);
      } catch (error) {
        // `executeMutation` refused before anything went out — a suspended or expired goal, an
        // open circuit. Nothing was sent, so nothing is owed an observation; the refusal is the
        // action's to show, and the item is free again (OP-08).
        const reason = errorMessage(error);
        if (database.action(action.id)?.state === 'READY') database.setActionState(action.id, 'FAILED', this.context.now(), reason);
        database.addEvent(accountId, 'retry-refused', { actionId: action.id, kind: action.kind, reason }, this.context.now());
      }
      // The hop the action carries, if any, follows the action: a resend went out, or was refused.
      new WorkStore(database).mirror(action.id, this.context.now());
    });
  }
}
