/**
 * Sends this window has made and the engine has not answered yet.
 *
 * Pressing *List* used to hold the listing workspace until the request came back, and the request
 * is not quick: a Steam list first reads the account's CSFloat books if they have aged, and a
 * CSFloat list connects the Game Coordinator, posts the listing and reads the stall again before
 * it replies. For that whole time the row sat in the workspace with a spinner and every other row
 * was locked. The press is now the whole gesture: the rows are handed here at once and leave the
 * workspace, and the work panel reports them from this moment on.
 *
 * This is the window's record of what it did, not the trading record. Nothing here reaches the
 * engine but the send itself, and no state here is an observation: *Submitting* means the request
 * is out, never that anything was listed. Once a send is accepted the engine's own rows (`work.open`)
 * say everything that follows — queued, sending, sent, waiting for a phone — and this lets go.
 *
 * Sends go one at a time, in the order they were pressed. That was already true of the workspace
 * (it locked while a batch was out), and it keeps two batches of one account from racing through
 * the same admission reads.
 */

/** One item of a send, as the work panel prints it and as busy-state keys it. */
export type OutboxItem = {
  /** The workspace row's key: unique within a send. */
  key: string;
  accountId: string;
  name: string;
  imageUrl: string | null;
  localId: string | null;
  /** What the seller receives, when the row priced it. */
  receiveCents: number | null;
};

/**
 * Where a send is, as far as this window knows. Never an observation.
 *
 * `UNSUBMITTED`: waiting behind an earlier send. `SUBMITTING`: the request is out, and stays so
 * until the engine's rows for it have been read. `REFUSED`: the engine turned it down and nothing
 * on screen took it back.
 */
export type OutboxState = 'UNSUBMITTED' | 'SUBMITTING' | 'REFUSED';

export type OutboxSend = {
  id: string;
  /** What kind of work it is, as `DESTINATION` names it: `LIST`, `CSFLOAT_LIST`, `REPRICE`, … */
  kind: string;
  items: readonly OutboxItem[];
  state: OutboxState;
  queuedAt: string;
  /** The engine's words, verbatim, when it refused. */
  reason: string | null;
};

export type OutboxOutcome = { accepted: true } | { accepted: false; reason: string };

export type OutboxRequest = {
  kind: string;
  items: readonly OutboxItem[];
  /** The request. It resolves when the engine has accepted it and throws what the engine refused with. */
  send: () => Promise<unknown>;
  /**
   * Told how the send ended. Returning `true` on a refusal says the caller has taken the items
   * back — a workspace still on screen shows the refusal on its own rows, where it can be fixed —
   * so the outbox forgets it. Otherwise the refusal stays here until it is dismissed, because a
   * refusal nobody was shown is the same as none.
   */
  onSettled?: ((outcome: OutboxOutcome) => boolean | undefined) | undefined;
};

export class Outbox {
  private sends: readonly OutboxSend[] = [];
  private readonly waiting: Array<{ id: string; request: OutboxRequest }> = [];
  private running = false;
  private readonly listeners = new Set<() => void>();

  /**
   * `handOver` re-reads open work. An accepted send is dropped only after it resolves, so there is
   * no moment in which an item is neither here nor in the engine's rows.
   */
  constructor(private readonly handOver: () => Promise<void>, private readonly now: () => string = () => new Date().toISOString()) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly snapshot = (): readonly OutboxSend[] => this.sends;

  enqueue(request: OutboxRequest): string {
    const id = crypto.randomUUID();
    this.sends = [...this.sends, { id, kind: request.kind, items: request.items, state: 'UNSUBMITTED', queuedAt: this.now(), reason: null }];
    this.waiting.push({ id, request });
    this.emit();
    void this.pump();
    return id;
  }

  /** Let go of a refusal once it has been read. Anything still on its way is not the person's to drop. */
  dismiss(id: string): void {
    if (!this.sends.some((send) => send.id === id && send.state === 'REFUSED')) return;
    this.remove(id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.running = true;
    this.patch(next.id, { state: 'SUBMITTING' });
    let outcome: OutboxOutcome;
    try {
      await next.request.send();
      outcome = { accepted: true };
    } catch (error) {
      outcome = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const taken = settle(next.request, outcome) === true;
    if (!outcome.accepted) {
      if (taken) this.remove(next.id);
      else this.patch(next.id, { state: 'REFUSED', reason: outcome.reason });
    }
    this.running = false;
    void this.pump();
    if (!outcome.accepted) return;
    await this.handOver().catch(() => undefined);
    this.remove(next.id);
  }

  private patch(id: string, change: Partial<OutboxSend>): void {
    this.sends = this.sends.map((send) => (send.id === id ? { ...send, ...change } : send));
    this.emit();
  }

  private remove(id: string): void {
    this.sends = this.sends.filter((send) => send.id !== id);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A caller's handler that throws must not stop the sends queued behind it. */
function settle(request: OutboxRequest, outcome: OutboxOutcome): boolean | undefined {
  try { return request.onSettled?.(outcome); } catch { return undefined; }
}
