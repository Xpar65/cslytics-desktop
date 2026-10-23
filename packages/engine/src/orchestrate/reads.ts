import type { AccountId, GcStatus } from '@cslytics/ports';
import type { ObservationRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { FRESHNESS, surfaceName, type Surface, type SurfaceRef } from '../kernel/evidence.js';
import type { EngineSignal } from '../kernel/signals.js';
import { errorMessage } from '../kernel/support.js';
import { laneOf, type Transport } from '../kernel/governor.js';
import { BackoffLedger, BLOCKED_ELSEWHERE_RETRY_MS } from '../policy/backoff.js';
import { baseIntervalMs, hasOpenCommitment, isDue, latestFor, SURFACE_ORDER, type DueVerdict, type Tier } from '../policy/cadence.js';
import { proofDueAtMs, type ProofDemand } from '../policy/proof.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { MarketService } from '../surfaces/market.js';
import type { StorageService } from '../surfaces/storage.js';
import type { TradeService } from '../surfaces/trades.js';
import type { SessionService } from '../surfaces/session.js';
import type { InGameStoreService } from '../surfaces/in-game-store.js';
import type { CsfloatAccountService } from '../surfaces/csfloat-account.js';
import type { CsfloatListingService } from '../surfaces/csfloat-listings.js';
import type { CsfloatInventoryService } from '../surfaces/csfloat-inventory.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { CsfloatBuyOrderService } from '../surfaces/csfloat-buy-orders.js';
import type { Settling } from './settle.js';

/** How often the retention sweep runs for an account. */
export const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** How long a worker sleeps when nothing is due. Short enough to notice a tier change. */
export const IDLE_TICK_MS = 30_000;
/**
 * How long a hint's read waits for the hints after it. A Game Coordinator item event is one of a
 * burst more often than not, and the burst arrives over as many turns as it has events: coalescing
 * alone turned twenty items into two snapshots, one begun at the first event and one after it.
 * Waiting the window out after the last hint makes them one (requirements INV-06). A need somebody
 * waits for never waits for a hint.
 */
export const HINT_WINDOW_MS = 2_000;

const EPOCH = '1970-01-01T00:00:00.000Z';

export type ReadServices = {
  inventory: InventoryService;
  storage: StorageService;
  market: MarketService;
  trades: TradeService;
  /** Owns steam-persona; present whenever the engine has a session surface. */
  session: SessionService;
  /** A need is answered once what its walk read is settled. */
  settle: Settling;
  /**
   * What the work waiting for proof needs walked, derived from the database whenever the broker asks
   * (`policy/proof.ts`), less the hops of the commands named. Absent, nothing is waiting.
   */
  demand?: (accountId: AccountId, provedByDispatch: readonly string[]) => readonly ProofDemand[];
  /**
   * The commands whose dispatch is running, each of which proves its own round
   * (`CommandService.proveStage`). Absent, no dispatch is running.
   */
  dispatching?: () => readonly string[];
  /** The retention sweep (`db/retention.ts`), run once a day. Absent, nothing is swept. */
  retention?: (accountId: AccountId) => unknown;
  /** The in-game store's price sheet. */
  inGameStore?: InGameStoreService;
  /** Absent on a Steam-only profile, which is a supported state rather than a degraded one. */
  csfloatAccount?: CsfloatAccountService;
  csfloatListings?: CsfloatListingService;
  csfloatInventory?: CsfloatInventoryService;
  csfloatTrades?: CsfloatTradeService;
  csfloatBuyOrders?: CsfloatBuyOrderService;
};

/**
 * Who is asking. A `person` need comes from the window and goes first; it also lifts a hold, as
 * *Refresh now* always did. A `work` need is a command's, a driver's or proof demand's: it reads
 * through a hold without lifting it, as the attended reads always did, and is told when its walk
 * fails. A `cadence` need is the timer's, and a hint's: the one kind a hold holds back, because a
 * hold exists to keep an unattended reader from asking a failing surface for ever.
 */
export type NeedPriority = 'person' | 'work' | 'cadence';
export const NEED_PRIORITIES: readonly NeedPriority[] = ['person', 'work', 'cadence'];

/**
 * The one sentence every read is (read broker plan D1): a complete observation of this scope that
 * began after this moment, for this asker.
 */
export type Need = { ref: SurfaceRef; startedAfter: string; priority: NeedPriority };

/**
 * Why a need was not answered with an observation. `breaker`: the scope's breaker is open.
 * `no-session`: a Game Coordinator scope while the account has no CS2 session. `no-venue`: a
 * CSFloat scope on an account with no CSFloat connection, or a scope nothing walks. `incomplete`:
 * the walk this need rode ended incomplete, and the scope is now held; `detail` is what the walk
 * said. `withdrawn`: the asker stopped, or the engine did. A refusal is answered at once: nothing
 * that waits for an answer is kept waiting, because every asker has a way back — a command's chain
 * continues from the settle that proves something, proof demand and the cadence ask again on their
 * schedules, a driver is woken by the next settle — and a person is told.
 */
export type RefusalReason = 'breaker' | 'no-session' | 'no-venue' | 'incomplete' | 'withdrawn';
export type ReadOutcome =
  | { kind: 'observed'; observation: ObservationRow }
  | { kind: 'refused'; reason: RefusalReason; detail?: string };

export type ScopeState = 'idle' | 'due' | 'walking' | 'held' | 'unreadable';
export const SCOPE_STATES: readonly ScopeState[] = ['idle', 'due', 'walking', 'held', 'unreadable'];
export type NeedState = 'queued' | 'in-flight' | 'observed' | 'refused';
export const NEED_STATES: readonly NeedState[] = ['queued', 'in-flight', 'observed', 'refused'];

/** One scope as the window may show it: its state, since when, and the hold's end and reason. */
export type ScopeStatus = { ref: SurfaceRef; state: ScopeState; since: string; until?: string; reason?: string; needs: number };

/** What an orchestrator may ask of the broker: handed over late-bound, as `Settling` is. */
export interface Reading {
  /** Waits for a complete observation of the scope begun after the moment, or a refusal. `signal` withdraws it. */
  need(accountId: AccountId, need: Need, signal?: AbortSignal): Promise<ReadOutcome>;
  /** Raises the need and does not wait: a hint, a nudge, a cadence. */
  want(accountId: AccountId, need: Need): void;
  /** Needs for every surface whose latest complete walk is older than its trust window, awaited together. */
  ensureFresh(accountId: AccountId, surfaces: readonly Surface[], priority?: NeedPriority): Promise<void>;
  status(accountId: AccountId): ScopeStatus[];
}

/** What the window is told after a walk. Surfaces only — never rows (continuous freshness plan §4.5). */
export type RefreshNotice = { accountId: AccountId; surfaces: readonly Surface[]; at: string };

/** Why an account is not currently refreshing, in the words the window shows, and every scope's state. */
export type RefreshStatus = {
  accountId: AccountId;
  tier: Tier;
  running: boolean;
  /** Set while reads are being held off, with the reason and when it lifts. */
  heldUntil?: string;
  reason?: string;
  /** The one surface a failed walk backed off, when the hold is one scope's and not the session's: the rest of the account reads on. */
  heldSurface?: Surface;
  scopes: ScopeStatus[];
};

/** What a walk of one scope costs before it is made (read broker plan D5). A unit read is charged to the wire after it, when the adapter says it went there. */
export const TRANSPORT_OF: Readonly<Record<Surface, Transport>> = {
  'gc-inventory': 'gc-cache',
  'gc-storage-units': 'gc-cache',
  'gc-casket': 'gc-cache',
  'gc-event': 'gc-cache',
  'gc-store-price-sheet': 'gc-wire',
  'steam-market': 'steam-web',
  'steam-market-history': 'steam-web',
  'steam-wallet': 'steam-web',
  'steam-trade-offers': 'steam-web',
  'steam-trade-history': 'steam-web',
  'steam-trade-inventory': 'steam-web',
  'steam-persona': 'steam-web',
  'csfloat-account-status': 'csfloat',
  'csfloat-stall': 'csfloat',
  'csfloat-inventory': 'csfloat',
  'csfloat-trades': 'csfloat',
  'csfloat-trade': 'csfloat',
  'csfloat-listing': 'csfloat',
  'csfloat-buy-orders': 'csfloat'
};

/** What one walk came back with. */
export type WalkResult =
  | { kind: 'walked'; complete: boolean; observationId: number | null; transport?: Transport; reason?: string }
  | { kind: 'no-venue' }
  | { kind: 'no-session' };

type NeedEntry = {
  need: Need;
  raisedAt: string;
  state: 'queued' | 'in-flight';
  /** Whether a walk has carried this entry: a want that came back queued from one has had its read-through. */
  walked?: boolean;
  resolve?: ((outcome: ReadOutcome) => void) | undefined;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
};
type Walk = { startedAt: string; needs: NeedEntry[] };
type ScopeEntry = { ref: SurfaceRef; name: string; transport: Transport; needs: NeedEntry[]; walk?: Walk | undefined; hintUntilMs: number; holdReason?: string | undefined; since: string };
type AccountEntry = {
  accountId: AccountId;
  kept: boolean;
  tier: Tier;
  scopes: Map<string, ScopeEntry>;
  lanes: Set<string>;
  loop?: Promise<void> | undefined;
  wake?: (() => void) | undefined;
  held?: { until: number; reason: string; surface?: Surface } | undefined;
  lastSweptMs: number;
};

const RANK: Record<NeedPriority, number> = { person: 0, work: 1, cadence: 2 };

function refused(reason: RefusalReason, detail?: string): ReadOutcome {
  return { kind: 'refused', reason, ...(detail ? { detail } : {}) };
}

/**
 * The one reader: every observation the engine makes is a need it answers (read broker plan).
 *
 * A need is a complete observation of a scope begun after a moment, with a priority. One walk per
 * scope is in flight at a time, and it answers every need it can: a need raised while a walk that
 * began after its moment is in flight joins that walk, one raised after queues for the next, and
 * one whose scope already has a complete observation begun after its moment is answered with no
 * read at all (D3). Needs are served oldest first within a scope and by priority across scopes;
 * the worker per account waits on one thing, the earliest of a hold lifting, a cadence coming
 * due, a transport token or a need arriving, and never polls (D4). What a read costs is its
 * transport, and the Game Coordinator's cache costs nothing (D5). Nothing here is written to the
 * record: every source of a need is durable already, so a restart re-derives all of it (D6).
 *
 * The broker's entire vocabulary is the surfaces' own `sync*` methods, called from `walk`. It has
 * **no verb for re-sending a mutation** — repository rule 1, the rule an unattended reader most
 * endangers. And an incomplete walk answers no need: the scope goes held and the needs stay
 * queued, which is rule 5 in one place.
 */
export class ReadBroker implements Reading {
  private readonly accounts = new Map<AccountId, AccountEntry>();
  private readonly backoff: BackoffLedger;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;

  /** Set by the composition root so a completed walk can reach the window. */
  onChanged: ((notice: RefreshNotice) => void) | undefined;

  constructor(
    protected readonly context: EngineContext,
    protected readonly services: ReadServices,
    backoff = new BackoffLedger()
  ) {
    this.backoff = backoff;
    this.unsubscribe = context.signals.subscribe((signal) => this.onSignal(signal));
  }

  // --- lifecycle -----------------------------------------------------------

  /** Begins keeping one account current: its cadence and proof demand raise needs from here on. */
  start(accountId: AccountId): void {
    if (this.stopped) return;
    const account = this.account(accountId);
    if (account.kept) return;
    account.kept = true;
    this.pump(account);
  }

  /** Stops keeping the account current and withdraws what was queued for it. A need raised later is served: it is an explicit ask. */
  stopAccount(accountId: AccountId): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.kept = false;
    account.held = undefined;
    this.backoff.forget(accountId);
    for (const scope of account.scopes.values()) {
      for (const entry of [...scope.needs]) if (entry.state === 'queued') this.withdraw(scope, entry);
    }
    this.wake(account);
  }

  stop(): void {
    this.stopped = true;
    for (const account of this.accounts.values()) {
      account.kept = false;
      for (const scope of account.scopes.values()) for (const entry of [...scope.needs]) this.withdraw(scope, entry);
      this.wake(account);
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Which account the window is looking at.
   *
   * `null` means the all-accounts scope, where every account is background: the portfolio reads
   * cached holdings, and promoting twenty accounts to the active cadence because a summary is on
   * screen is exactly the request storm LANE-06 forbids.
   */
  setActiveAccount(accountId: AccountId | null): void {
    for (const account of this.accounts.values()) account.tier = account.accountId === accountId ? 'ACTIVE' : 'BACKGROUND';
    if (accountId) { const account = this.accounts.get(accountId); if (account) this.wake(account); }
  }

  /** Drops every account to background — a hidden window, or a machine going to sleep. */
  setAllBackground(): void {
    for (const account of this.accounts.values()) account.tier = 'BACKGROUND';
  }

  tier(accountId: AccountId): Tier {
    return this.accounts.get(accountId)?.tier ?? 'BACKGROUND';
  }

  /**
   * The accounts this broker is keeping current: the ones a Steam session started. A machine
   * waking up refreshes these and no others, because reading an account is enough to sign it in
   * (`getWebSession` logs on whatever it is asked about), and an account its owner left signed out
   * must stay that way.
   */
  keptCurrent(): AccountId[] {
    return [...this.accounts.values()].filter((account) => account.kept).map((account) => account.accountId);
  }

  // --- asking --------------------------------------------------------------

  async need(accountId: AccountId, need: Need, signal?: AbortSignal): Promise<ReadOutcome> {
    if (this.stopped || signal?.aborted) return refused('withdrawn');
    const latest = latestFor(this.context.database, accountId, need.ref);
    if (latest?.complete === 1 && latest.started_at > need.startedAfter) {
      await this.services.settle.settled(accountId);
      return { kind: 'observed', observation: latest };
    }
    const account = this.account(accountId);
    const scope = this.scope(account, need.ref);
    const refusal = this.refusal(account, scope);
    if (refusal) return refused(refusal, this.refusalDetail(account, scope, refusal));
    if (this.lifts(need)) this.clearHold(account, scope);
    return new Promise<ReadOutcome>((resolve) => {
      const entry: NeedEntry = { need, raisedAt: this.context.now(), state: 'queued', resolve, signal };
      if (signal) {
        entry.onAbort = () => this.withdraw(scope, entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.enqueue(account, scope, entry);
    });
  }

  want(accountId: AccountId, need: Need): void {
    if (this.stopped) return;
    const account = this.account(accountId);
    const scope = this.scope(account, need.ref);
    if (this.refusal(account, scope)) return;
    if (this.lifts(need)) this.clearHold(account, scope);
    const latest = latestFor(this.context.database, accountId, need.ref);
    if (latest?.complete === 1 && latest.started_at > need.startedAfter) return;
    // At most one want is queued per scope: a later one only moves its moment or raises its priority.
    const existing = scope.needs.find((entry) => entry.state === 'queued' && !entry.resolve);
    if (existing) {
      existing.need = {
        ref: existing.need.ref,
        startedAfter: existing.need.startedAfter > need.startedAfter ? existing.need.startedAfter : need.startedAfter,
        priority: RANK[need.priority] < RANK[existing.need.priority] ? need.priority : existing.need.priority
      };
      this.wake(account);
      return;
    }
    this.enqueue(account, scope, { need, raisedAt: this.context.now(), state: 'queued' });
  }

  /**
   * One need per surface, each for a walk begun inside the surface's trust window (`FRESHNESS`,
   * never the cadence: a background account's interval is deliberately longer than the window the
   * evidence is trusted for, and a caller admitting work needs the window).
   */
  async ensureFresh(accountId: AccountId, surfaces: readonly Surface[], priority: NeedPriority = 'work'): Promise<void> {
    const nowMs = this.context.ports.clock.now().getTime();
    await Promise.all(surfaces.map((surface) => this.need(accountId, {
      ref: { surface, scope: { kind: 'account' } },
      startedAfter: new Date(nowMs - FRESHNESS[surface].maxAgeMs).toISOString(),
      priority
    })));
  }

  /**
   * *Refresh now*: a person need for every scope of the account, past every hold, awaited
   * together. Past the holds, never past the budget: pressing it for twenty accounts queues rather
   * than floods. The reconnect sweep raises the same needs, because "a session just came back" and
   * "the user asked" want the same thing — the one window in which the world could have changed
   * unobserved (continuous freshness plan §1).
   */
  async refreshNow(accountId: AccountId, options: { contents?: boolean } = {}): Promise<readonly Surface[]> {
    await this.awaitHandshake(accountId);
    const account = this.account(accountId);
    this.backoff.forget(accountId);
    account.held = undefined;
    for (const scope of account.scopes.values()) scope.holdReason = undefined;
    const refs = this.scopes(accountId, this.demand(accountId)).filter((ref) => options.contents !== false || ref.surface !== 'gc-casket');
    const startedAfter = this.context.now();
    const outcomes = await Promise.all(refs.map((ref) => this.need(accountId, { ref, startedAfter, priority: 'person' })));
    return [...new Set(refs.filter((_, index) => outcomes[index]!.kind === 'observed').map((ref) => ref.surface))];
  }

  /**
   * A sign-in or a Connect still bringing CS2 up. Reads made now would refuse every Game
   * Coordinator scope for want of a session, and the window then said "Refreshing now — done" six
   * seconds after a sign-in with neither CS2 nor the market read (2026-10-15). So Refresh now waits
   * for the handshake to be tried first; it is bounded by its own timeout.
   */
  protected async awaitHandshake(accountId: AccountId): Promise<void> {
    await this.services.session.handshake(accountId);
  }

  // --- what the window sees ------------------------------------------------

  status(accountId: AccountId): ScopeStatus[] {
    const account = this.accounts.get(accountId);
    if (!account) return [];
    const gc = this.context.ports.gc.connectionStatus(accountId);
    const nowMs = this.context.ports.clock.now().getTime();
    return [...account.scopes.values()].map((scope) => this.scopeStatus(account, scope, gc, nowMs));
  }

  refreshStatus(accountId: AccountId): RefreshStatus {
    const account = this.accounts.get(accountId);
    const nowMs = this.context.ports.clock.now().getTime();
    const base: RefreshStatus = { accountId, tier: this.tier(accountId), running: account?.kept ?? false, scopes: this.status(accountId) };
    const held = account?.held;
    if (!held || held.until <= nowMs) return base;
    return { ...base, heldUntil: new Date(held.until).toISOString(), reason: held.reason, ...(held.surface ? { heldSurface: held.surface } : {}) };
  }

  private scopeStatus(account: AccountEntry, scope: ScopeEntry, gc: GcStatus, nowMs: number): ScopeStatus {
    const base = { ref: scope.ref, since: scope.since, needs: scope.needs.length };
    if (!this.readable(scope.ref, gc)) {
      const reason = this.gcReason(account.accountId, gc);
      return { ...base, state: 'unreadable', ...(reason ? { reason } : {}) };
    }
    if (scope.walk) return { ...base, state: 'walking', since: scope.walk.startedAt };
    const hold = this.backoff.state(account.accountId, scope.name);
    if (hold && hold.notBeforeMs > nowMs) {
      return { ...base, state: 'held', until: new Date(hold.notBeforeMs).toISOString(), ...(scope.holdReason ? { reason: scope.holdReason } : {}) };
    }
    if (scope.needs.length) return { ...base, state: 'due' };
    return { ...base, state: 'idle' };
  }

  /**
   * Why the Game Coordinator scopes cannot be read, when there is a reason worth a hold. The GC
   * being held elsewhere is a fact about another computer, and asking faster cannot change it
   * (steam/gc-inventory.md). A session that never came up in this run — CS2 left off at launch,
   * or refused — is not held at all: nothing is reconnecting it, the Steam surfaces are still being
   * read, and "not refreshing" would be untrue (steam/auth.md, "Launch preferences").
   */
  private gcReason(accountId: AccountId, gc: GcStatus): string | undefined {
    if (gc.state === 'CONNECTED') return undefined;
    if (gc.state === 'BLOCKED_ELSEWHERE') return 'blocked-elsewhere';
    return this.services.session.supervises(accountId) ? 'gc-disconnected' : undefined;
  }

  // --- the worker ----------------------------------------------------------

  private account(accountId: AccountId): AccountEntry {
    let account = this.accounts.get(accountId);
    if (!account) {
      account = { accountId, kept: false, tier: 'BACKGROUND', scopes: new Map(), lanes: new Set(), lastSweptMs: Number.NEGATIVE_INFINITY };
      this.accounts.set(accountId, account);
    }
    return account;
  }

  /**
   * The key a scope is held under: its surface and, for anything narrower than the account, its
   * id. Isolated so a saboteur can key by surface alone, the mistake that left a second CSFloat
   * delist unread on 2026-10-19 (`CSF-47`).
   */
  protected scopeKey(ref: SurfaceRef): string {
    return surfaceName(ref);
  }

  private scope(account: AccountEntry, ref: SurfaceRef): ScopeEntry {
    const name = this.scopeKey(ref);
    let scope = account.scopes.get(name);
    if (!scope) {
      scope = { ref, name, transport: TRANSPORT_OF[ref.surface], needs: [], hintUntilMs: 0, since: this.context.now() };
      account.scopes.set(name, scope);
    }
    return scope;
  }

  private enqueue(account: AccountEntry, scope: ScopeEntry, entry: NeedEntry): void {
    scope.needs.push(entry);
    scope.since = entry.raisedAt;
    if (scope.walk && this.joins(scope.walk, entry.need)) {
      entry.state = 'in-flight';
      scope.walk.needs.push(entry);
    }
    this.pump(account);
  }

  /**
   * Whether a walk in flight answers a need raised while it runs: only one that began after the
   * need's moment. One that began before can have read the book before the change the need is
   * about (rule 1). Isolated so a saboteur can join whatever is in flight.
   */
  protected joins(walk: { startedAt: string }, need: Need): boolean {
    return walk.startedAt > need.startedAfter;
  }

  /** Whether a need lifts the hold on its scope: a person's does, as *Refresh now* always did. */
  protected lifts(need: Need): boolean {
    return need.priority === 'person';
  }

  /**
   * Whether a need reads through a hold: a person's and a command's or driver's do, as every
   * attended read always did; only the cadence's, and a hint's, waits it out. Isolated so a
   * saboteur can make everyone wait.
   */
  protected pressing(need: Need): boolean {
    return need.priority !== 'cadence';
  }

  /**
   * Whether a want that already rode a walk which ended incomplete presses through the hold again.
   * It never does: it has had its read-through, and the hold is the broker's judgement that asking
   * again now is pointless. Before this, the reconnect sweep's person want on a trade history Steam
   * was rate-limiting rode five walks in seven seconds, until the breaker opened (N-READ-13,
   * 2026-10-16). Only a person's need lifts a hold. Isolated so a saboteur can hammer.
   */
  protected pressesAgain(_need: Need): boolean {
    return false;
  }

  /**
   * Whether a Game Coordinator need waits for the session to come up rather than being refused.
   * It never does: one waited for would be raised again by its cadence and waited for again, and
   * *Refresh now* on a Steam-only account would never answer. Isolated so a saboteur can wait.
   */
  protected waitsForSession(_ref: SurfaceRef): boolean {
    return false;
  }

  /** Whether a queued entry reads through its scope's hold now: pressing, and not already carried by a walk that failed. */
  private presses(entry: NeedEntry): boolean {
    return entry.state === 'queued' && this.pressing(entry.need) && (!entry.walked || this.pressesAgain(entry.need));
  }

  private heldNow(account: AccountEntry, scope: ScopeEntry): boolean {
    const hold = this.backoff.state(account.accountId, scope.name);
    return hold !== undefined && hold.notBeforeMs > this.context.ports.clock.now().getTime();
  }

  /**
   * Runs the account's worker, or wakes the one running. A new worker begins a turn later, never
   * on the asker's stack: a burst of needs raised in one turn is then one walk, where a worker
   * that began at once would have walked for the first need before the second was raised.
   */
  private pump(account: AccountEntry): void {
    if (this.stopped) return;
    if (account.loop) { this.wake(account); return; }
    account.loop = Promise.resolve().then(() => this.loop(account))
      .catch((error: unknown) => {
        try { this.context.database.addEvent(account.accountId, 'read-loop-error', { message: errorMessage(error) }, this.context.now()); } catch { /* the record is gone */ }
      })
      .finally(() => {
        account.loop = undefined;
        // A need raised between the worker deciding it was idle and ending is served by the next one.
        if (!this.stopped && (account.kept || this.busy(account))) this.pump(account);
        else if (!account.kept && !this.busy(account)) this.accounts.delete(account.accountId);
      });
  }

  private wake(account: AccountEntry): void {
    account.wake?.();
  }

  private busy(account: AccountEntry): boolean {
    for (const scope of account.scopes.values()) if (scope.needs.length || scope.walk) return true;
    return false;
  }

  private async loop(account: AccountEntry): Promise<void> {
    while (!this.stopped) {
      const gc = this.context.ports.gc.connectionStatus(account.accountId);
      this.gcHold(account, gc);
      this.refuseUnreadable(account, gc);
      if (account.kept) this.raiseDue(account, gc);
      this.startWalks(account, gc);
      if (account.kept) this.sweepIfDue(account);
      if (!account.kept && !this.busy(account)) return;
      await this.rest(account, gc);
    }
  }

  /** Keeps the account's hold current with its CS2 session, for the window's *Not refreshing* text. */
  private gcHold(account: AccountEntry, gc: GcStatus): void {
    const reason = this.gcReason(account.accountId, gc);
    const nowMs = this.context.ports.clock.now().getTime();
    if (reason) account.held = { until: nowMs + BLOCKED_ELSEWHERE_RETRY_MS, reason };
    else if (account.held && (account.held.reason === 'blocked-elsewhere' || account.held.reason === 'gc-disconnected')) account.held = undefined;
  }

  /** A Game Coordinator scope cannot be read without a session, so nothing waits for one. */
  private refuseUnreadable(account: AccountEntry, gc: GcStatus): void {
    for (const scope of account.scopes.values()) {
      if (this.readable(scope.ref, gc) || this.waitsForSession(scope.ref)) continue;
      for (const entry of [...scope.needs]) if (entry.state === 'queued') this.answer(scope, entry, refused('no-session'));
    }
  }

  /**
   * Whether this scope can be read now. A Game Coordinator surface cannot be without a session;
   * one waited for would be refused, raised again by its cadence and refused again, for ever.
   * A session coming up asks for every surface itself (`onSignal`), which is when they are read.
   */
  protected readable(ref: SurfaceRef, gc: GcStatus): boolean {
    return !isGcSurface(ref.surface) || gc.state === 'CONNECTED';
  }

  /** The cadence and proof sources (plan D10): a want for every due scope that has nothing queued or in flight. */
  private raiseDue(account: AccountEntry, gc: GcStatus): void {
    const demand = this.demand(account.accountId);
    for (const ref of this.scopes(account.accountId, demand)) {
      const scope = this.scope(account, ref);
      if (!this.readable(ref, gc) || scope.needs.length || scope.walk) continue;
      // An open breaker refuses every need: nothing is raised until it lets one through.
      if (this.context.governors.breakerFor(account.accountId, scope.name).isOpen()) continue;
      const verdict = this.verdict(account, ref, demand);
      if (!verdict.due) continue;
      const latest = latestFor(this.context.database, account.accountId, ref);
      scope.needs.push({ need: { ref, startedAfter: latest?.started_at ?? EPOCH, priority: verdict.because === 'proof' ? 'work' : 'cadence' }, raisedAt: this.context.now(), state: 'queued' });
      scope.since = this.context.now();
    }
  }

  private startWalks(account: AccountEntry, gc: GcStatus): void {
    const nowMs = this.context.ports.clock.now().getTime();
    const candidates = [...account.scopes.values()].filter((scope) =>
      !scope.walk && scope.needs.some((entry) => entry.state === 'queued') && this.readable(scope.ref, gc) && scope.hintUntilMs <= nowMs);
    for (const scope of this.pick(candidates)) {
      const lane = laneOf(scope.transport);
      if (account.lanes.has(lane)) continue;
      const breaker = this.context.governors.breakerFor(account.accountId, scope.name);
      if (breaker.isOpen()) {
        for (const entry of [...scope.needs]) if (entry.state === 'queued') this.answer(scope, entry, refused('breaker', this.refusalDetail(account, scope, 'breaker')));
        continue;
      }
      // A held scope is walked only for a need that reads through the hold; the cadence waits.
      if (this.heldNow(account, scope) && !scope.needs.some((entry) => this.presses(entry))) continue;
      // The bucket is the endpoint's, not the scope's: a venue counts calls to a route, so a
      // hundred listings read one at a time share one route's budget.
      if (!this.context.governors.tryAdmitRead(account.accountId, scope.transport, scope.ref.surface)) continue;
      this.startWalk(account, scope, lane);
    }
  }

  /**
   * The order scopes are walked in: by the best priority among their queued needs, then by the
   * oldest need. Isolated so a saboteur can serve the newest first and starve the one that waited.
   */
  protected pick(candidates: readonly ScopeEntry[]): ScopeEntry[] {
    const rank = (scope: ScopeEntry): [number, string] => {
      const queued = scope.needs.filter((entry) => entry.state === 'queued');
      return [Math.min(...queued.map((entry) => RANK[entry.need.priority])), queued.map((entry) => entry.raisedAt).sort()[0] ?? ''];
    };
    return [...candidates].sort((left, right) => {
      const [priority, raised] = rank(left);
      const [otherPriority, otherRaised] = rank(right);
      return priority - otherPriority || raised.localeCompare(otherRaised) || left.name.localeCompare(right.name);
    });
  }

  private startWalk(account: AccountEntry, scope: ScopeEntry, lane: string): void {
    const startedAt = this.context.now();
    const captured = scope.needs.filter((entry) => entry.state === 'queued');
    for (const entry of captured) { entry.state = 'in-flight'; entry.walked = true; }
    const walk: Walk = { startedAt, needs: captured };
    scope.walk = walk;
    scope.since = startedAt;
    account.lanes.add(lane);
    void this.runWalk(account, scope, walk, lane).catch(() => undefined).finally(() => this.wake(account));
  }

  private async runWalk(account: AccountEntry, scope: ScopeEntry, walk: Walk, lane: string): Promise<void> {
    const accountId = account.accountId;
    let result: WalkResult;
    try {
      result = await this.walk(accountId, scope.ref);
    } catch (error) {
      result = { kind: 'walked', complete: false, observationId: null, reason: errorMessage(error) };
    }
    // The walk is over before anyone is answered, so a caller that asks again on its answer finds the scope free.
    if (scope.walk === walk) scope.walk = undefined;
    account.lanes.delete(lane);
    scope.since = this.context.now();
    if (result.kind === 'walked' && result.transport === 'gc-wire') this.context.governors.debitRead(accountId, 'gc-wire', scope.ref.surface);
    if (result.kind !== 'walked') {
      for (const entry of [...walk.needs]) this.answer(scope, entry, refused(result.kind));
      return;
    }
    const breaker = this.context.governors.breakerFor(accountId, scope.name);
    if (result.complete) {
      breaker.success();
      this.backoff.succeed(accountId, scope.name);
      scope.holdReason = undefined;
      if (account.held && account.held.reason !== 'blocked-elsewhere' && account.held.reason !== 'gc-disconnected') account.held = undefined;
      await this.services.settle.settled(accountId);
      const observation = (result.observationId !== null ? this.context.database.observation(accountId, result.observationId) : undefined)
        ?? latestFor(this.context.database, accountId, scope.ref);
      for (const entry of [...walk.needs]) this.answer(scope, entry, observation ? { kind: 'observed', observation } : refused('incomplete'));
      this.notify(accountId, [scope.ref.surface]);
      return;
    }
    breaker.failure();
    // The venue's own words when the walk recorded them, so a 429 or a stale session reads as itself.
    const recorded = result.observationId !== null ? this.context.database.observation(accountId, result.observationId) : undefined;
    const reason = result.reason ?? recorded?.error ?? 'incomplete-observation';
    this.decay(accountId, scope.ref, reason);
    // An incomplete walk answers no need (rule 5). Whoever waited is told; a want waits the hold out.
    for (const entry of [...walk.needs]) {
      if (entry.resolve) this.answer(scope, entry, refused('incomplete', reason));
      else entry.state = 'queued';
    }
  }

  private answer(scope: ScopeEntry, entry: NeedEntry, outcome: ReadOutcome): void {
    const at = scope.needs.indexOf(entry);
    if (at !== -1) scope.needs.splice(at, 1);
    if (scope.walk) {
      const inFlight = scope.walk.needs.indexOf(entry);
      if (inFlight !== -1) scope.walk.needs.splice(inFlight, 1);
    }
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
    const resolve = entry.resolve;
    entry.resolve = undefined;
    resolve?.(outcome);
  }

  private withdraw(scope: ScopeEntry, entry: NeedEntry): void {
    this.answer(scope, entry, refused('withdrawn'));
  }

  /**
   * What goes with a refusal a person will read. A resting scope says when it is asked again and
   * what it last answered, so "resting" never hides the venue's own words (a 429, a stale session).
   */
  private refusalDetail(account: AccountEntry, scope: ScopeEntry, reason: RefusalReason): string | undefined {
    if (reason !== 'breaker') return undefined;
    const resetsAt = this.context.governors.breakerFor(account.accountId, scope.name).resetsAtMs();
    const latest = latestFor(this.context.database, account.accountId, scope.ref);
    const parts = [
      resetsAt === null ? undefined : `until ${new Date(resetsAt).toISOString()}`,
      latest?.error ? `last: ${latest.error}` : undefined
    ].filter((part): part is string => part !== undefined);
    return parts.length ? parts.join('; ') : undefined;
  }

  /** Why a need on this scope is refused before anything is queued, or undefined. */
  private refusal(account: AccountEntry, scope: ScopeEntry): RefusalReason | undefined {
    const surface = scope.ref.surface;
    if (surface === 'gc-event') return 'no-venue';
    if (this.context.governors.breakerFor(account.accountId, scope.name).isOpen()) return 'breaker';
    if (isGcSurface(surface) && !this.waitsForSession(scope.ref) && this.context.ports.gc.connectionStatus(account.accountId).state !== 'CONNECTED') return 'no-session';
    if (surface.startsWith('csfloat-') && !this.venue(account.accountId)) return 'no-venue';
    return undefined;
  }

  /** Whether the account has a CSFloat connection a read can be made with. An unlinked venue is not an empty book. */
  private venue(accountId: AccountId): boolean {
    if (!this.services.csfloatAccount || !this.context.ports.csfloat) return false;
    const row = this.context.database.raw().prepare("SELECT status FROM venue_connection WHERE account_id=? AND venue='csfloat'").get(accountId) as { status: string } | undefined;
    return row !== undefined && row.status !== 'DISCONNECTED';
  }

  private clearHold(account: AccountEntry, scope: ScopeEntry): void {
    this.backoff.clear(account.accountId, scope.name);
    scope.holdReason = undefined;
    if (account.held && account.held.reason !== 'blocked-elsewhere' && account.held.reason !== 'gc-disconnected') account.held = undefined;
  }

  /**
   * Sleeps until the next thing is due: a hold lifting, a hint's window closing, a transport's
   * token, a cadence coming due or the idle tick; any need, signal or walk ending wakes it sooner.
   * A scope waiting only for a lane needs no time: the walk holding the lane wakes the worker when
   * it ends.
   */
  private async rest(account: AccountEntry, gc: GcStatus): Promise<void> {
    const nowMs = this.context.ports.clock.now().getTime();
    let earliest = nowMs + IDLE_TICK_MS;
    for (const scope of account.scopes.values()) {
      if (scope.walk || !this.readable(scope.ref, gc) || !scope.needs.some((entry) => entry.state === 'queued')) continue;
      const hold = this.backoff.state(account.accountId, scope.name);
      if (hold && hold.notBeforeMs > nowMs && !scope.needs.some((entry) => this.presses(entry))) { earliest = Math.min(earliest, hold.notBeforeMs); continue; }
      const resetsAtMs = this.context.governors.breakerFor(account.accountId, scope.name).resetsAtMs();
      if (resetsAtMs !== null) { earliest = Math.min(earliest, resetsAtMs); continue; }
      if (scope.hintUntilMs > nowMs) { earliest = Math.min(earliest, scope.hintUntilMs); continue; }
      earliest = Math.min(earliest, this.context.governors.readAdmittedAtMs(account.accountId, scope.transport, scope.ref.surface));
    }
    if (account.kept) {
      const demand = this.demand(account.accountId);
      for (const ref of this.scopes(account.accountId, demand)) {
        const scope = this.scope(account, ref);
        if (scope.walk || scope.needs.length || !this.readable(ref, gc)) continue;
        const resetsAtMs = this.context.governors.breakerFor(account.accountId, scope.name).resetsAtMs();
        if (resetsAtMs !== null) { earliest = Math.min(earliest, resetsAtMs); continue; }
        const verdict = this.verdict(account, ref, demand);
        if (verdict.due) { earliest = nowMs; break; }
        if (Number.isFinite(verdict.nextDueAtMs)) earliest = Math.min(earliest, verdict.nextDueAtMs);
      }
    }
    const delay = Math.max(0, Math.min(earliest - nowMs, IDLE_TICK_MS));
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    account.wake = wake;
    try {
      await Promise.race([this.context.ports.clock.sleep(delay), woken]);
    } finally {
      account.wake = undefined;
    }
  }

  /**
   * The retention sweep, once a day and never inside a walk (consolidation plan §4.9). A failure
   * is an event, not a reason to stop reading.
   */
  private sweepIfDue(account: AccountEntry): void {
    if (this.stopped || !this.services.retention) return;
    const nowMs = this.context.ports.clock.now().getTime();
    if (nowMs - account.lastSweptMs < SWEEP_EVERY_MS) return;
    account.lastSweptMs = nowMs;
    try {
      this.services.retention(account.accountId);
    } catch (error) {
      try { this.context.database.addEvent(account.accountId, 'retention-error', { reason: errorMessage(error) }, this.context.now()); } catch { /* the record is gone */ }
    }
  }

  // --- the executors -------------------------------------------------------

  /**
   * Dispatches to the surface that owns this scope. The only verbs the broker has, and the one
   * place in the orchestration a surface walks (`tests/unit/read-path.test.ts`). The surfaces
   * write their own observations — the *incomplete* one a failure produces included — so this
   * never interprets a result beyond whether the walk was complete.
   */
  protected async walk(accountId: AccountId, ref: SurfaceRef): Promise<WalkResult> {
    const { database } = this.context;
    const services = this.services;
    const walked = (observationId: number | null, complete = observationId !== null && database.observation(accountId, observationId)?.complete === 1, transport?: Transport): WalkResult =>
      ({ kind: 'walked', complete, observationId, ...(transport ? { transport } : {}) });
    switch (ref.surface) {
      case 'steam-persona': {
        const id = await services.session.syncPersona(accountId);
        return id === 0 ? { kind: 'no-session' } : walked(id);
      }
      case 'gc-inventory': return walked(await services.inventory.sync(accountId));
      case 'gc-storage-units': {
        // The unit list only. Contents follow their own needs — see `policy/cadence.ts`.
        const ids = await services.storage.syncUnits(accountId, false);
        return walked(ids[0] ?? null, ids.length > 0 && ids.every((id) => database.observation(accountId, id)?.complete === 1));
      }
      case 'gc-casket': {
        const read = await services.storage.syncCasket(accountId, ref.scope.id ?? '');
        return walked(read.observationId, undefined, read.transport === 'wire' ? 'gc-wire' : 'gc-cache');
      }
      case 'gc-event': return { kind: 'no-venue' };
      case 'gc-store-price-sheet': {
        if (!services.inGameStore) return { kind: 'no-venue' };
        return walked(await services.inGameStore.syncPriceSheet(accountId), undefined, 'gc-wire');
      }
      case 'steam-market': {
        // Settling is not this walk's business: the settler runs every reconciler after any
        // complete walk. When it was, this one settled listings and forgot buy orders (N-BUY-10).
        const result = await services.market.sync(accountId);
        return walked(result.observationId, result.complete);
      }
      case 'steam-market-history': return walked(await services.market.orders.syncHistory(accountId));
      case 'steam-wallet': return walked(await services.market.syncWallet(accountId));
      case 'steam-trade-inventory': return walked(await services.trades.syncEligibility(accountId));
      case 'steam-trade-offers': {
        const result = await services.trades.syncOffers(accountId);
        return walked(result.observationId, result.complete);
      }
      case 'steam-trade-history': {
        // Completeness here means contiguous coverage, not "the request returned": an incomplete
        // history walk leaves the checkpoint alone and holds the scope, so the next walk re-reads
        // the gap rather than stepping over it.
        const result = await services.trades.syncHistory(accountId);
        return walked(result.observationId, result.complete);
      }
      case 'csfloat-account-status': {
        if (!services.csfloatAccount) return { kind: 'no-venue' };
        const status = await services.csfloatAccount.refreshStatus(accountId);
        if (status.status === 'NOT_CONNECTED' || status.status === 'DISCONNECTED') return { kind: 'no-venue' };
        const latest = database.latestObservation(accountId, 'csfloat-account-status');
        return walked(latest?.id ?? null, status.status === 'CONNECTED' && latest?.complete === 1);
      }
      case 'csfloat-stall': {
        if (!services.csfloatListings) return { kind: 'no-venue' };
        const result = await services.csfloatListings.syncStall(accountId);
        return walked(result.observationId, result.complete);
      }
      case 'csfloat-listing': {
        if (!services.csfloatListings) return { kind: 'no-venue' };
        return walked(await services.csfloatListings.syncListing(accountId, ref.scope.id ?? ''));
      }
      case 'csfloat-buy-orders': {
        if (!services.csfloatBuyOrders) return { kind: 'no-venue' };
        const result = await services.csfloatBuyOrders.sync(accountId);
        return walked(result.observationId, result.complete);
      }
      case 'csfloat-trades': {
        if (!services.csfloatTrades) return { kind: 'no-venue' };
        return walked(await services.csfloatTrades.sync(accountId));
      }
      case 'csfloat-trade': {
        if (!services.csfloatTrades) return { kind: 'no-venue' };
        const trade = await services.csfloatTrades.syncTrade(accountId, ref.scope.id ?? '');
        const latest = latestFor(database, accountId, ref);
        return walked(latest?.id ?? null, trade !== null && latest?.complete === 1);
      }
      case 'csfloat-inventory': {
        if (!services.csfloatInventory) return { kind: 'no-venue' };
        return walked(await services.csfloatInventory.sync(accountId));
      }
    }
  }

  /**
   * Tells the window that something changed.
   *
   * Surfaces, never rows. The window re-reads through the read models it already uses, which is
   * what keeps `read/views.ts` the only path data travels and makes a dropped notice cost one
   * stale second rather than a wrong screen (continuous freshness plan §4.5).
   */
  protected notify(accountId: AccountId, surfaces: readonly Surface[]): void {
    this.onChanged?.({ accountId, surfaces, at: this.context.now() });
  }

  // --- scheduling state ----------------------------------------------------

  /** What the waiting work needs walked, read from the database each time (settling plan D5), less a command's own. */
  protected demand(accountId: AccountId): readonly ProofDemand[] {
    return this.services.demand?.(accountId, this.provedByDispatch()) ?? [];
  }

  /**
   * The commands whose hops the cadence leaves to their own dispatch. A hop of a command whose
   * dispatch is running is the dispatch's to prove: its round reads once after its last answer
   * (`CommandService.proveStage`). Demanded here as well, every answer made the inventory due the
   * moment a walk predated it, so a store of 974 walked a thousand items on every event batch (L-10,
   * 2026-10-16 evening, 29 walks in 30 s; `BULK-14`). They are left out in the query, not after it:
   * asked of each hop's owner and then dropped, the demand of a store of 968 cost a few queries per
   * waiting store at every answer (2026-10-18, D15). A hop a restart left waiting, with no dispatch
   * running (`N-DEMAND-03`), and a move of nobody's command keep their demand. Isolated so a
   * saboteur can demand proof for all.
   */
  protected provedByDispatch(): readonly string[] {
    return this.services.dispatching?.() ?? [];
  }

  private verdict(account: AccountEntry, ref: SurfaceRef, demand: readonly ProofDemand[]): DueVerdict {
    const accountId = account.accountId;
    const pending = this.context.database.raw().prepare(`SELECT EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code=3) AS accepted
      FROM work_step s JOIN transfer_detail d ON d.step_id=s.id
      WHERE s.kind='SEND' AND (s.account_id=? OR d.destination_account_id=?) AND s.state IN ('QUEUED','SENT','AWAITING_OBSERVATION','RETRYING')`).all(accountId, accountId) as Array<{ accepted: number }>;
    const delivery = pending.some((b) => b.accepted === 1);
    const transferIntervalMs = pending.length && ref.surface === 'steam-trade-offers' ? TRANSFER_INTERVALS_MS.offers
      : delivery && ref.surface === 'gc-inventory' ? TRANSFER_INTERVALS_MS.inventoryAfterAccept
        : delivery && ref.surface === 'steam-trade-history' ? TRANSFER_INTERVALS_MS.historyAfterAccept : Infinity;
    const observation = latestFor(this.context.database, accountId, ref);
    const now = this.context.ports.clock.now();
    return isDue({
      ref,
      tier: account.tier,
      observation,
      now,
      hasOpenCommitment: hasOpenCommitment(this.context.database, accountId),
      transferIntervalMs,
      proofDueAtMs: proofDueAtMs(ref, demand, observation?.started_at, now.getTime()),
      backfillPending: ref.surface === 'steam-market-history' && this.services.market.orders.backfillPending(accountId)
    });
  }

  /**
   * Every scope this account has on a cadence: the account-wide surfaces, one per known unit, and
   * one per CSFloat listing that waiting work needs read. A listing is never read on a timer for its
   * own sake: only while a delist or reprice waits on it (CSF-45), and then on its own cadence too.
   */
  protected scopes(accountId: AccountId, demand: readonly ProofDemand[]): SurfaceRef[] {
    const refs: SurfaceRef[] = SURFACE_ORDER
      .filter((surface) => surface !== 'gc-casket')
      .map((surface) => ({ surface, scope: { kind: 'account' as const } }));
    if (this.venue(accountId)) {
      for (const surface of CSFLOAT_PASS_SURFACES) refs.push({ surface, scope: { kind: 'account' } });
      const listings = new Set(demand.filter((need) => need.ref.surface === 'csfloat-listing' && need.ref.scope.id).map((need) => need.ref.scope.id!));
      for (const id of listings) refs.push({ surface: 'csfloat-listing', scope: { kind: 'item', id } });
    }
    const caskets = this.context.database.raw()
      .prepare(`SELECT casket_id FROM storage_unit WHERE account_id=?`)
      .all(accountId) as Array<{ casket_id: string }>;
    for (const unit of caskets) refs.push({ surface: 'gc-casket', scope: { kind: 'casket', id: unit.casket_id } });
    return refs;
  }

  /** Backs a scope off after a failed or incomplete walk, from its own interval, and says why in the window's words. */
  protected decay(accountId: AccountId, ref: SurfaceRef, reason: string): void {
    const name = this.scopeKey(ref);
    const nowMs = this.context.ports.clock.now().getTime();
    const account = this.account(accountId);
    const base = baseIntervalMs(ref.surface, account.tier);
    const state = this.backoff.fail(accountId, name, Number.isFinite(base) ? base : 60_000, nowMs);
    this.scope(account, ref).holdReason = reason;
    account.held = { until: state.notBeforeMs, reason, surface: ref.surface };
  }

  // --- signals -------------------------------------------------------------

  /** A hint: a cadence want with the hint window, so a burst of them is one walk. */
  protected hint(accountId: AccountId, refs: readonly SurfaceRef[]): void {
    const account = this.account(accountId);
    const nowMs = this.context.ports.clock.now().getTime();
    for (const ref of refs) {
      this.scope(account, ref).hintUntilMs = nowMs + HINT_WINDOW_MS;
      this.want(accountId, { ref, startedAfter: this.context.now(), priority: 'cadence' });
    }
  }

  /**
   * Turns a hint into a want. Every branch raises a *read*; none concludes anything.
   *
   * The interesting one is a `gc-item` removal. The Game Coordinator keeps a listed item in the
   * inventory until it sells (`db/commitment.ts`), so an item leaving it is the only notice this
   * app ever gets that a listing may have sold, because the Community Market pushes nothing. What
   * it earns is a market walk, then a history walk, then a wallet read — three observations that
   * can actually establish what happened, rather than an inference that it did.
   */
  protected onSignal(signal: EngineSignal): void {
    const { accountId } = signal;
    const account = this.accounts.get(accountId);
    if (!account?.kept) return;
    const atAccount = (surface: Surface): SurfaceRef => ({ surface, scope: { kind: 'account' } });
    if (signal.kind === 'gc-item') {
      const refs = SIGNAL_READS.gcItem.map(atAccount);
      if (signal.casketId) refs.push({ surface: 'gc-casket', scope: { kind: 'casket', id: signal.casketId } });
      if (signal.change === 'removed') refs.push(...SIGNAL_READS.gcItemRemoved.map(atAccount));
      this.hint(accountId, refs);
      return;
    }
    if (signal.kind === 'gc-session') {
      if (signal.state === 'CONNECTED') {
        // The reconnect sweep. The gap is the one window in which the world could have moved
        // with nobody watching (continuous freshness plan §1), so everything is suspect, contents
        // included: a person need for each, which lifts every hold as *Refresh now* does.
        this.backoff.forget(accountId);
        account.held = undefined;
        const startedAfter = this.context.now();
        for (const ref of this.scopes(accountId, this.demand(accountId))) this.want(accountId, { ref, startedAfter, priority: 'person' });
      }
      this.wake(account);
      return;
    }
    if (signal.kind === 'mutation-settled') {
      // The action this settled is in the database with its need, which the next scheduling
      // decision reads (settling plan D5): waking the worker is all a Steam action needs. Trade and
      // CSFloat sends still nudge, for the drivers that own them.
      const startedAfter = this.context.now();
      for (const surface of NUDGES[signal.actionKind] ?? []) this.want(accountId, { ref: atAccount(surface), startedAfter, priority: 'work' });
      if (signal.actionKind.startsWith('trade.')) {
        const batches = this.context.database.raw().prepare(`SELECT s.account_id AS account_id,d.destination_account_id AS destination_account_id
          FROM work_step s JOIN transfer_detail d ON d.step_id=s.id
          WHERE s.kind='SEND' AND (s.account_id=? OR d.destination_account_id=?) AND s.state IN ('QUEUED','SENT','AWAITING_OBSERVATION','RETRYING')`).all(accountId, accountId) as Array<{ account_id: string; destination_account_id: string }>;
        for (const batch of batches) for (const other of [batch.account_id, batch.destination_account_id]) {
          if (other !== accountId && this.accounts.get(other)?.kept) {
            for (const surface of NUDGES[signal.actionKind] ?? []) this.want(other, { ref: atAccount(surface), startedAfter, priority: 'work' });
          }
        }
      }
      this.wake(account);
      return;
    }
    if (signal.kind === 'order-changed') {
      const refs = SIGNAL_READS.orderChanged.map(atAccount);
      if (signal.side === 'BUY') refs.push(...SIGNAL_READS.buyOrderChanged.map(atAccount));
      this.hint(accountId, refs);
    }
  }
}

/**
 * The reads a trade or CSFloat send nudges, for the drivers that own those kinds.
 *
 * Steam actions are not here any more. Their proof is demand derived from the database
 * (`policy/proof.ts`), because this table was wrong for a buy order the book never showed —
 * history settles that, and the table asked for the market and the wallet — and because a
 * request made from it lived in memory, so a restart forgot it (settling and read path plan §1).
 * This is a *reading* list, never a retry list: nothing here touches an action's state.
 */
export const NUDGES: Readonly<Record<string, readonly Surface[]>> = {
  'trade.send': ['steam-trade-offers'],
  'trade.accept': ['steam-trade-offers','steam-trade-history','gc-inventory'],
  'trade.cancel': ['steam-trade-offers','gc-inventory'],
  // The stall is the book a CSFloat listing appears in, changes price in and leaves. The send is
  // engine-driven (`CsfloatSellingService.advance`), so this walk is what proves a create, the way
  // the market walk proves a sellitem. A delist or reprice is proved by the listing's own read,
  // which is proof demand (`CsfloatSellingService.needs`); the walk here keeps the book current.
  CSFLOAT_CREATE: ['csfloat-stall'],
  CSFLOAT_REPRICE: ['csfloat-stall'],
  CSFLOAT_CANCEL: ['csfloat-stall'],
  // The own buy-order book is where a CSFloat buy order changes its terms and leaves.
  CSFLOAT_BUY_ORDER_EDIT: ['csfloat-buy-orders'],
  CSFLOAT_BUY_ORDER_CANCEL: ['csfloat-buy-orders']
};

/**
 * The reads a hint asks for (`onSignal`), beside `NUDGES` for a send. A session coming up asks for
 * every surface in `SURFACE_ORDER` and every unit, which is that list rather than one of these.
 */
export const SIGNAL_READS: Readonly<Record<'gcItem' | 'gcItemRemoved' | 'orderChanged' | 'buyOrderChanged', readonly Surface[]>> = {
  /** Any Game Coordinator item event, plus the unit it names. */
  gcItem: ['gc-inventory'],
  /** An item leaving the inventory: the only notice a listing may have sold, since the market pushes nothing. */
  gcItemRemoved: ['steam-market', 'steam-market-history', 'steam-wallet'],
  /** A sale, a fill, a cancellation or a hold, on either side. */
  orderChanged: ['steam-wallet', 'steam-market-history'],
  /** A buy order's change can put an item in the inventory. */
  buyOrderChanged: ['gc-inventory']
};

/** The CSFloat surfaces on a cadence while the account's CSFloat connection is not `DISCONNECTED`. */
export const CSFLOAT_PASS_SURFACES: readonly Surface[] = ['csfloat-account-status', 'csfloat-stall', 'csfloat-trades', 'csfloat-inventory', 'csfloat-buy-orders'];

/**
 * The longest an owned transfer lets a surface wait, whatever its tier's cadence: the offers
 * while any transfer between owned accounts is open, and the inventory and trade history once
 * its offer has been accepted.
 */
export const TRANSFER_INTERVALS_MS = { offers: 30_000, inventoryAfterAccept: 30_000, historyAfterAccept: 60_000 } as const;

/** A Game Coordinator surface, which nothing reads without a CS2 session. */
export function isGcSurface(surface: Surface): boolean {
  return surface.startsWith('gc-');
}
