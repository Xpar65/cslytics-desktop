import type { AccountId, GcStatus } from '@cslytics/ports';
import type { ObservationRow } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { freshness, surfaceName, type Surface, type SurfaceRef } from '../kernel/evidence.js';
import type { EngineSignal } from '../kernel/signals.js';
import { errorMessage } from '../kernel/support.js';
import { BackoffLedger, BLOCKED_ELSEWHERE_RETRY_MS } from '../policy/backoff.js';
import { baseIntervalMs, hasOpenCommitment, isDue, latestFor, SURFACE_ORDER, type Tier } from '../policy/cadence.js';
import { proofDueAtMs, type ProofDemand } from '../policy/proof.js';
import type { InventoryService } from '../surfaces/inventory.js';
import type { MarketService } from '../surfaces/market.js';
import type { StorageService } from '../surfaces/storage.js';
import type { TradeService } from '../surfaces/trades.js';
import type { SessionService } from '../surfaces/session.js';
import type { CsfloatAccountService } from '../surfaces/csfloat-account.js';
import type { CsfloatListingService } from '../surfaces/csfloat-listings.js';
import type { CsfloatInventoryService } from '../surfaces/csfloat-inventory.js';
import type { CsfloatTradeService } from '../surfaces/csfloat-trades.js';
import type { CsfloatBuyOrderService } from '../surfaces/csfloat-buy-orders.js';
import type { Settling } from './settle.js';

export type RefreshServices = {
  inventory: InventoryService;
  storage: StorageService;
  market: MarketService;
  trades: TradeService;
  /** `observe` answers once what it read is settled. */
  settle: Settling;
  /**
   * What the work waiting for proof needs walked, derived from the database whenever the loop asks
   * (`policy/proof.ts`). Absent, nothing is waiting.
   */
  demand?: (accountId: AccountId) => readonly ProofDemand[];
  /** Owns steam-persona; present whenever the engine has a session surface. */
  session: SessionService;
  /** Absent on a Steam-only profile, which is a supported state rather than a degraded one. */
  csfloatAccount?: CsfloatAccountService;
  csfloatListings?: CsfloatListingService;
  csfloatInventory?: CsfloatInventoryService;
  csfloatTrades?: CsfloatTradeService;
  csfloatBuyOrders?: CsfloatBuyOrderService;
};

/**
 * The one governed read (settling and read path plan §4): what an orchestrator, a command hop or
 * the window calls instead of a surface's own `sync`. Answers with the walk that settles the
 * question, or with nothing when the budget's breaker refused the read.
 */
export type Observe = (accountId: AccountId, ref: SurfaceRef, options?: ObserveOptions) => Promise<ObservationRow | undefined>;
export type ObserveOptions = {
  /**
   * No walk that began before this moment answers. Proof after a mutation passes the moment the
   * mutation returned: a walk already in flight when it was sent can have read the book before
   * Steam changed it, however recently that walk finished (rule 1). An existing walk is reused
   * only if it began strictly after, the way `postAttempt` proves an absence; a walk this call
   * made itself may share the moment, which on a frozen test clock it always does.
   */
  startedAfter?: string;
};

/** What the window is told after a pass. Surfaces only — never rows (plan §4.5). */
export type RefreshNotice = { accountId: AccountId; surfaces: readonly Surface[]; at: string };

/** Why an account is not currently refreshing, in the words the window shows. */
export type RefreshStatus = {
  accountId: AccountId;
  tier: Tier;
  running: boolean;
  /** Set when every due read is being held off, with the reason and when it lifts. */
  heldUntil?: string;
  reason?: string;
};

/** A running loop, and the handle that cuts its sleep short when a signal arrives. */
type LoopControl = { stop: boolean; wake: (() => void) | undefined };

const DEBOUNCE_MS = 2_000;
/** How long a pass sleeps when nothing is due. Short enough to notice a tier change. */
const IDLE_TICK_MS = 30_000;

/**
 * Keeps every signed-in account's surfaces current without anybody clicking anything.
 *
 * One loop per account, driven by `ports.clock.sleep` rather than `setInterval`. That is the
 * difference between a cadence a `VirtualClock` can prove and one no test can reach: the
 * convergence tick used real timers and, as a result, nothing in the repository asserted
 * anything about when it ran.
 *
 * The loop's entire vocabulary is the surfaces' own `sync*` methods. It has **no verb for
 * re-sending a mutation** — that is repository rule 1, and it is the rule that automatic refresh
 * most endangers, because "the write timed out, try again" is one line away from a scheduler
 * that already knows how to retry. An action left `AWAITING_OBSERVATION` is resolved by
 * observing the surface that could prove its effect, which is what `ConvergenceService` already
 * does with the evidence this loop keeps fresh.
 *
 * The second endangered rule is 5. A scheduled read hits a stale session, a partial page and a
 * suspicious successful-empty far more often than a person pressing a button ever did, so a
 * failed pass records the incomplete observation the surface already writes, backs off, and
 * concludes nothing. Nothing here publishes an empty set.
 */
export class RefreshService {
  private readonly loops = new Map<AccountId, LoopControl>();
  private readonly tiers = new Map<AccountId, Tier>();
  private readonly requested = new Map<AccountId, Set<string>>();
  private readonly debounceUntilMs = new Map<AccountId, number>();
  private readonly backoff: BackoffLedger;
  private readonly held = new Map<AccountId, { until: number; reason: string }>();
  private readonly passes = new Map<AccountId, Promise<readonly Surface[]>>();
  private stopped = false;
  private unsubscribe: (() => void) | undefined;

  /** Set by the composition root so a completed pass can reach the window. */
  onChanged: ((notice: RefreshNotice) => void) | undefined;

  constructor(
    protected readonly context: EngineContext,
    protected readonly services: RefreshServices,
    backoff = new BackoffLedger()
  ) {
    this.backoff = backoff;
    this.unsubscribe = context.signals.subscribe((signal) => this.onSignal(signal));
  }

  // --- lifecycle -----------------------------------------------------------

  /** Begins keeping one account current. A second call is ignored rather than starting a race. */
  start(accountId: AccountId): void {
    if (this.stopped || this.loops.has(accountId)) return;
    const control: LoopControl = { stop: false, wake: undefined };
    this.loops.set(accountId, control);
    void this.loop(accountId, control).catch((error: unknown) => {
      this.context.database.addEvent(accountId, 'refresh-loop-error', { message: errorMessage(error) }, this.context.now());
    }).finally(() => {
      if (this.loops.get(accountId) === control) this.loops.delete(accountId);
    });
  }

  stopAccount(accountId: AccountId): void {
    const control = this.loops.get(accountId);
    if (!control) return;
    control.stop = true;
    control.wake?.();
    this.loops.delete(accountId);
    this.requested.delete(accountId);
    this.held.delete(accountId);
    this.backoff.forget(accountId);
  }

  stop(): void {
    this.stopped = true;
    for (const accountId of [...this.loops.keys()]) this.stopAccount(accountId);
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
    for (const known of this.loops.keys()) this.tiers.set(known, known === accountId ? 'ACTIVE' : 'BACKGROUND');
    if (accountId) this.wake(accountId);
  }

  /** Drops every account to background — a hidden window, or a machine going to sleep. */
  setAllBackground(): void {
    for (const known of this.loops.keys()) this.tiers.set(known, 'BACKGROUND');
  }

  tier(accountId: AccountId): Tier {
    return this.tiers.get(accountId) ?? 'BACKGROUND';
  }

  /**
   * The accounts this service is keeping current: the ones with a loop, which a Steam session
   * started. A machine waking up refreshes these and no others, because reading an account is
   * enough to sign it in (`getWebSession` logs on whatever it is asked about), and an account its
   * owner left signed out must stay that way.
   */
  keptCurrent(): AccountId[] {
    return [...this.loops.keys()];
  }

  status(accountId: AccountId): RefreshStatus {
    const hold = this.held.get(accountId);
    const base: RefreshStatus = { accountId, tier: this.tier(accountId), running: this.loops.has(accountId) };
    if (!hold || hold.until <= this.context.ports.clock.now().getTime()) return base;
    return { ...base, heldUntil: new Date(hold.until).toISOString(), reason: hold.reason };
  }

  // --- explicit requests ---------------------------------------------------

  /**
   * `Refresh now`. Forces every surface for this account past its due time.
   *
   * Past the *timer*, never past the budget: the shared read bucket still applies, so pressing
   * it for twenty accounts queues rather than floods. The post-reconnect sweep uses the same
   * path, because "a session just came back" and "the user asked" want the same thing — the one
   * window in which the world could have changed unobserved (plan §1).
   */
  async refreshNow(accountId: AccountId, options: { contents?: boolean } = {}): Promise<readonly Surface[]> {
    const wanted = this.requested.get(accountId) ?? new Set<string>();
    for (const surface of SURFACE_ORDER) {
      if (surface === 'gc-casket') continue;
      wanted.add(surface);
    }
    if (options.contents !== false) wanted.add('gc-casket:*');
    this.requested.set(accountId, wanted);
    this.backoff.forget(accountId);
    this.held.delete(accountId);
    return this.pass(accountId);
  }

  /**
   * Reads the named surfaces if they are not already fresh, and waits for them.
   *
   * This is what a command calls when it needs current evidence *before* it acts — buy-order
   * admission needs a fresh wallet and book, and would otherwise fail closed against evidence
   * that the loop was about to refresh a second later.
   */
  async ensureFresh(accountId: AccountId, surfaces: readonly Surface[]): Promise<void> {
    for (const surface of surfaces) {
      const ref: SurfaceRef = { surface, scope: { kind: 'account' } };
      // `FRESHNESS`, never the cadence. The cadence answers "when is this next worth reading?",
      // and for a background account that interval is deliberately longer than the window the
      // evidence is trusted for — so asking `isDue` here returned "fresh" for a surface the
      // caller's own admission was about to reject as stale, which is the opposite of what this
      // call promises. Backoff is deliberately not consulted either: a caller that needs current
      // evidence to act on is exactly the case the backoff timer should not silently answer for.
      if (freshness(latestFor(this.context.database, accountId, ref), surface, this.context.ports.clock.now()) === 'FRESH') continue;
      await this.read(accountId, ref);
    }
  }

  /**
   * One read of one account surface, now, whatever its age — through the read budget and the
   * breaker like any other. For a caller that is waiting for the world to change rather than for
   * evidence to be current: a CSFloat listing from a unit waits for CSFloat's copy of the
   * inventory to show the retrieved item, and a read inside the freshness window is exactly what
   * it needs (`CsfloatSellingService.awaitVisibility`).
   */
  async readNow(accountId: AccountId, surface: Surface): Promise<boolean> {
    const changed = await this.read(accountId, { surface, scope: { kind: 'account' } });
    if (changed) this.notify(accountId, [surface]);
    return changed;
  }

  /**
   * One governed read, answered once it is settled (plan D4).
   *
   * The orchestrators used to call the surfaces themselves. Those reads took no token from the
   * read budget and never met the breaker — and the Steam market adapter has no limiter of its
   * own, so the most frequent automatic reads in the app, the convergence heartbeat's, were the
   * ones nothing throttled. Everything now comes through `read`.
   *
   * With `startedAfter`, a complete walk that began after it is reused rather than repeated.
   * Without it the read always happens: a heartbeat asks because time has passed. A read can join
   * a walk another caller already started (the surfaces coalesce them), and a joined walk that
   * began too early is not the answer — so it reads once more.
   */
  async observe(accountId: AccountId, ref: SurfaceRef, options: ObserveOptions = {}): Promise<ObservationRow | undefined> {
    const { database } = this.context;
    const { startedAfter } = options;
    const answers = (row: ObservationRow | undefined): row is ObservationRow =>
      row !== undefined && (startedAfter === undefined || row.started_at >= startedAfter);
    const before = latestFor(database, accountId, ref);
    if (startedAfter !== undefined && before?.complete === 1 && before.started_at > startedAfter) {
      await this.services.settle.settled(accountId);
      return before;
    }
    // Only a row that appeared during this call is its answer. A refused read leaves the last
    // walk newest, and handing that back would pass an old walk off as this one.
    let answer: ObservationRow | undefined;
    for (let tries = 0; tries < 2; tries += 1) {
      const attempted = await this.read(accountId, ref);
      const latest = latestFor(database, accountId, ref);
      answer = latest && latest.id !== before?.id && answers(latest) ? latest : undefined;
      if (!attempted || answer) break;
    }
    if (answer) this.notify(accountId, [ref.surface]);
    await this.services.settle.settled(accountId);
    return answer;
  }

  // --- the loop ------------------------------------------------------------

  private wake(accountId: AccountId): void {
    this.loops.get(accountId)?.wake?.();
  }

  private async loop(accountId: AccountId, control: LoopControl): Promise<void> {
    while (!control.stop && !this.stopped) {
      await this.pass(accountId);
      if (control.stop || this.stopped) return;
      await this.rest(accountId, control);
    }
  }

  /**
   * Sleeps until the next thing is due, a signal wakes us, or the idle tick expires.
   *
   * The wake path matters: without it a GC event arriving one second into a twenty-minute sleep
   * would wait twenty minutes to be acted on, which is the current behaviour this whole service
   * exists to remove.
   */
  private async rest(accountId: AccountId, control: LoopControl): Promise<void> {
    const nowMs = this.context.ports.clock.now().getTime();
    let earliest = nowMs + IDLE_TICK_MS;
    const demand = this.demand(accountId);
    const gc = this.context.ports.gc.connectionStatus(accountId);
    for (const ref of this.scopes(accountId, demand)) {
      if (!this.waitsFor(ref, gc)) continue;
      const verdict = this.verdict(accountId, ref, demand);
      if (verdict.due) { earliest = nowMs; break; }
      if (Number.isFinite(verdict.nextDueAtMs)) earliest = Math.min(earliest, verdict.nextDueAtMs);
    }
    const delay = Math.max(0, Math.min(earliest - nowMs, IDLE_TICK_MS));
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    control.wake = wake;
    try {
      await Promise.race([this.context.ports.clock.sleep(delay), woken]);
    } finally {
      control.wake = undefined;
    }
  }

  /**
   * Whether the loop waits for this scope to come due. A Game Coordinator surface cannot be read
   * without a session, so while there is none it is not waited for at all. A requested or
   * proof-demanded surface is always due, and a loop that waited for one it cannot read would wake
   * at once, skip it in the pass, and wake again, forever. A session coming up asks for every
   * surface itself (`onSignal`), which is when they become worth waiting for.
   */
  protected waitsFor(ref: SurfaceRef, gc: GcStatus): boolean {
    return !isGcSurface(ref.surface) || gc.state === 'CONNECTED';
  }

  /**
   * One pass over one account, serialised against every other pass for that account.
   *
   * `Refresh now` and the loop both call this, and a user pressing the button while a cadence
   * pass is mid-walk must not start a second walk of the same book — two `mylistings` walks
   * racing produce two observations of the same moment and burn the budget twice.
   */
  protected pass(accountId: AccountId): Promise<readonly Surface[]> {
    const prior = this.passes.get(accountId) ?? Promise.resolve<readonly Surface[]>([]);
    const next = prior.catch(() => []).then(() => this.runPass(accountId));
    this.passes.set(accountId, next);
    void next.catch(() => undefined).finally(() => {
      if (this.passes.get(accountId) === next) this.passes.delete(accountId);
    });
    return next;
  }

  private async runPass(accountId: AccountId): Promise<readonly Surface[]> {
    if (this.stopped) return [];
    const nowMs = this.context.ports.clock.now().getTime();
    const debounceUntil = this.debounceUntilMs.get(accountId);
    if (debounceUntil !== undefined && debounceUntil > nowMs) {
      // A burst of GC events is still arriving. Waiting the rest of the window is what turns
      // twenty received items into one snapshot rather than twenty (requirements INV-06).
      await this.context.ports.clock.sleep(debounceUntil - nowMs);
      this.debounceUntilMs.delete(accountId);
    }

    const gc = this.context.ports.gc.connectionStatus(accountId);
    const observed: Surface[] = [];
    const demand = this.demand(accountId);
    for (const ref of this.scopes(accountId, demand)) {
      if (this.stopped) break;
      if (isGcSurface(ref.surface) && gc.state !== 'CONNECTED') {
        // Not a failure and not an escalating one: the GC being held elsewhere is a fact about
        // another computer, and asking faster cannot change it (steam/gc-inventory.md). A session
        // that never came up in this run — CS2 left off at launch, or refused — is not held at
        // all: nothing is reconnecting it, the Steam surfaces are still being read, and "not
        // refreshing" would be untrue (steam/auth.md, "Launch preferences").
        if (gc.state === 'BLOCKED_ELSEWHERE' || this.services.session.supervises(accountId)) {
          this.holdGc(accountId, gc.state === 'BLOCKED_ELSEWHERE' ? 'blocked-elsewhere' : 'gc-disconnected');
        }
        continue;
      }
      if (!this.verdict(accountId, ref, demand).due) continue;
      const changed = await this.read(accountId, ref);
      if (changed) observed.push(ref.surface);
    }

    if (observed.length > 0) this.notify(accountId, [...new Set(observed)]);
    return observed;
  }

  /**
   * Reads one surface, through the read budget, recording the outcome in the backoff ledger.
   *
   * The surfaces write their own observations — including the *incomplete* one a failure
   * produces — so this never interprets a result. It only learns whether to come back sooner or
   * later.
   */
  protected async read(accountId: AccountId, ref: SurfaceRef): Promise<boolean> {
    const name = surfaceName(ref);
    const breaker = await this.context.governors.admitRead(accountId, name);
    if (!breaker.canAttempt()) {
      this.backoff.hold(accountId, name, 30_000, this.context.ports.clock.now().getTime());
      return false;
    }
    this.consume(accountId, name);
    try {
      // No account lock here. The surfaces coalesce concurrent reads of the same scope
      // themselves (`kernel/support.ts` SingleFlight), and taking the lock would queue an
      // unattended walk in front of the user's own command.
      const complete = await this.walk(accountId, ref);
      if (complete) {
        breaker.success();
        this.backoff.succeed(accountId, name);
        this.held.delete(accountId);
      } else {
        breaker.failure();
        this.decay(accountId, ref, 'incomplete-observation');
      }
      return true;
    } catch (error) {
      breaker.failure();
      this.decay(accountId, ref, errorMessage(error));
      return false;
    }
  }

  /**
   * Dispatches to the surface that owns this read. The only verbs the loop has, and — since every
   * automatic read comes through `observe` — the only place in the orchestration a surface walks.
   */
  protected async walk(accountId: AccountId, ref: SurfaceRef): Promise<boolean> {
    const { database } = this.context;
    if (ref.surface === 'steam-persona') {
      const id = await this.services.session.syncPersona(accountId);
      if (id === 0) return false;
      return database.observation(accountId, id)?.complete === 1;
    }
    if (ref.surface === 'gc-inventory') {
      const id = await this.services.inventory.sync(accountId);
      return database.observation(accountId, id)?.complete === 1;
    }
    if (ref.surface === 'gc-storage-units') {
      // The unit list only. Contents follow their own triggers — see `policy/cadence.ts`.
      const ids = await this.services.storage.syncUnits(accountId, false);
      return ids.every((id) => database.observation(accountId, id)?.complete === 1);
    }
    if (ref.surface === 'gc-casket') {
      const id = await this.services.storage.syncCasket(accountId, ref.scope.id ?? '');
      return database.observation(accountId, id)?.complete === 1;
    }
    if (ref.surface === 'steam-market') {
      // Settling is not this walk's business: the settler runs every reconciler after any
      // complete walk. When it was, this one settled listings and forgot buy orders, and a
      // cancel said "Cancelling" for hours after the walks stopped showing the order (N-BUY-10).
      return (await this.services.market.sync(accountId)).complete;
    }
    if (ref.surface === 'steam-market-history') {
      const id = await this.services.market.orders.syncHistory(accountId);
      return database.observation(accountId, id)?.complete === 1;
    }
    if (ref.surface === 'steam-wallet') {
      const id = await this.services.market.syncWallet(accountId);
      return database.observation(accountId, id)?.complete === 1;
    }
    if (ref.surface === 'steam-trade-inventory') {
      const id = await this.services.trades.syncEligibility(accountId);
      return Boolean(this.context.database.observation(accountId,id)?.complete);
    }
    if (ref.surface === 'csfloat-account-status') {
      // No connection is not a failed read: nothing was asked, and the scheduler must not back
      // off a surface that has no venue behind it on this account.
      if (!this.services.csfloatAccount) return true;
      const status = await this.services.csfloatAccount.refreshStatus(accountId);
      return status.status === 'CONNECTED' || status.status === 'NOT_CONNECTED' || status.status === 'DISCONNECTED';
    }
    if (ref.surface === 'csfloat-stall') {
      if (!this.services.csfloatListings) return true;
      return (await this.services.csfloatListings.syncStall(accountId)).complete;
    }
    if (ref.surface === 'csfloat-buy-orders') {
      if (!this.services.csfloatBuyOrders) return true;
      return (await this.services.csfloatBuyOrders.sync(accountId)).complete;
    }
    if (ref.surface === 'csfloat-listing') {
      if (!this.services.csfloatListings) return true;
      return database.observation(accountId, await this.services.csfloatListings.syncListing(accountId, ref.scope.id ?? ''))?.complete === 1;
    }
    if (ref.surface === 'csfloat-trades' && this.services.csfloatTrades) return Boolean(database.observation(accountId,await this.services.csfloatTrades.sync(accountId))?.complete);
    if (ref.surface === 'csfloat-inventory' && this.services.csfloatInventory) return Boolean(database.observation(accountId,await this.services.csfloatInventory.sync(accountId))?.complete);
    if (ref.surface === 'steam-trade-offers') return (await this.services.trades.syncOffers(accountId)).complete;
    // Completeness here means contiguous coverage, not "the request returned": an incomplete
    // history walk leaves the checkpoint alone and backs the surface off, so the next pass
    // re-reads the gap rather than stepping over it.
    if (ref.surface === 'steam-trade-history') return (await this.services.trades.syncHistory(accountId)).complete;
    return false;
  }

  /**
   * Tells the window that something changed.
   *
   * Surfaces, never rows. The window re-reads through the read models it already uses, which is
   * what keeps `read/views.ts` the only path data travels and makes a dropped notice cost one
   * stale second rather than a wrong screen (plan §4.5).
   */
  protected notify(accountId: AccountId, surfaces: readonly Surface[]): void {
    this.onChanged?.({ accountId, surfaces, at: this.context.now() });
  }

  // --- scheduling state ----------------------------------------------------

  /** What the waiting work needs walked, read from the database each time (plan D5). */
  protected demand(accountId: AccountId): readonly ProofDemand[] {
    return this.services.demand?.(accountId) ?? [];
  }

  private verdict(accountId: AccountId, ref: SurfaceRef, demand: readonly ProofDemand[]): ReturnType<typeof isDue> {
    const name = surfaceName(ref);
    const pending = this.context.database.raw().prepare(`SELECT state FROM transfer_batch
      WHERE (account_id=? OR destination_account_id=?) AND state NOT IN ('DONE','ENDED','FAILED')`).all(accountId,accountId);
    const delivery = pending.some(b=>b.state === 'AWAITING_DELIVERY');
    const transferIntervalMs = pending.length && ref.surface === 'steam-trade-offers' ? 30_000
      : delivery && ref.surface === 'gc-inventory' ? 30_000
      : delivery && ref.surface === 'steam-trade-history' ? 60_000 : Infinity;
    const observation = latestFor(this.context.database, accountId, ref);
    const now = this.context.ports.clock.now();
    return isDue({
      ref,
      tier: this.tier(accountId),
      observation,
      now,
      backoff: this.backoff.state(accountId, name),
      requested: this.isRequested(accountId, ref),
      hasOpenCommitment: hasOpenCommitment(this.context.database, accountId),transferIntervalMs,
      proofDueAtMs: proofDueAtMs(ref, demand, observation?.started_at, now.getTime())
    });
  }

  /**
   * Every scope this account has: the account-wide surfaces, one ref per known casket, and one per
   * CSFloat listing that waiting work needs read. A listing is never read on a timer for its own
   * sake: only while a delist or reprice waits on it (CSF-45), and then on its own cadence too.
   */
  private scopes(accountId: AccountId, demand: readonly ProofDemand[]): SurfaceRef[] {
    const refs: SurfaceRef[] = SURFACE_ORDER
      .filter((surface) => surface !== 'gc-casket')
      .map((surface) => ({ surface, scope: { kind: 'account' as const } }));
    if (this.requested.get(accountId)?.has('steam-trade-inventory')) refs.push({surface:'steam-trade-inventory',scope:{kind:'account'}});
    const marketplace = this.context.database.raw().prepare("SELECT status FROM marketplace_connection WHERE account_id=? AND venue='csfloat'").get(accountId);
    if (marketplace && marketplace.status !== 'DISCONNECTED') {
      for (const surface of ['csfloat-account-status','csfloat-stall','csfloat-trades','csfloat-inventory','csfloat-buy-orders'] as const) refs.push({surface,scope:{kind:'account'}});
      const listings = new Set(demand.filter((need) => need.ref.surface === 'csfloat-listing' && need.ref.scope.id).map((need) => need.ref.scope.id!));
      for (const id of listings) refs.push({ surface: 'csfloat-listing', scope: { kind: 'item', id } });
    }
    const caskets = this.context.database.raw()
      .prepare(`SELECT casket_id FROM storage_unit WHERE account_id=?`)
      .all(accountId) as Array<{ casket_id: string }>;
    for (const unit of caskets) {
      refs.push({ surface: 'gc-casket', scope: { kind: 'casket', id: unit.casket_id } });
    }
    return refs;
  }

  private isRequested(accountId: AccountId, ref: SurfaceRef): boolean {
    const wanted = this.requested.get(accountId);
    if (!wanted) return false;
    if (ref.surface === 'gc-casket') return wanted.has('gc-casket:*') || wanted.has(surfaceName(ref));
    return wanted.has(ref.surface);
  }

  protected request(accountId: AccountId, ...surfaces: string[]): void {
    const wanted = this.requested.get(accountId) ?? new Set<string>();
    for (const surface of surfaces) wanted.add(surface);
    this.requested.set(accountId, wanted);
    this.wake(accountId);
  }

  private consume(accountId: AccountId, name: string): void {
    const wanted = this.requested.get(accountId);
    if (!wanted) return;
    wanted.delete(name);
    if (name.startsWith('gc-casket:')) wanted.delete('gc-casket:*');
    if (wanted.size === 0) this.requested.delete(accountId);
  }

  protected decay(accountId: AccountId, ref: SurfaceRef, reason: string): void {
    const name = surfaceName(ref);
    const nowMs = this.context.ports.clock.now().getTime();
    const base = baseIntervalMs(ref.surface, this.tier(accountId));
    const state = this.backoff.fail(accountId, name, Number.isFinite(base) ? base : 60_000, nowMs);
    this.held.set(accountId, { until: state.notBeforeMs, reason });
  }

  protected holdGc(accountId: AccountId, reason: string): void {
    const nowMs = this.context.ports.clock.now().getTime();
    for (const surface of ['gc-inventory', 'gc-storage-units']) {
      this.backoff.hold(accountId, surface, BLOCKED_ELSEWHERE_RETRY_MS, nowMs);
    }
    this.held.set(accountId, { until: nowMs + BLOCKED_ELSEWHERE_RETRY_MS, reason });
  }

  // --- signals -------------------------------------------------------------

  /**
   * Turns a hint into a request. Every branch schedules a *read*; none concludes anything.
   *
   * The interesting one is a `gc-item` removal. The Game Coordinator keeps a listed item in the
   * inventory until it sells (`db/steam-listing.ts`), so an item leaving it is the only notice this
   * app ever gets that a listing may have sold, because the Community Market pushes nothing. What
   * it earns is a market walk, then a history walk, then a wallet read — three observations that
   * can actually establish what happened, rather than an inference that it did.
   */
  protected onSignal(signal: EngineSignal): void {
    const { accountId } = signal;
    if (!this.loops.has(accountId)) return;
    if (signal.kind === 'gc-item') {
      const nowMs = this.context.ports.clock.now().getTime();
      this.debounceUntilMs.set(accountId, nowMs + DEBOUNCE_MS);
      this.request(accountId, 'gc-inventory');
      if (signal.casketId) this.request(accountId, `gc-casket:${signal.casketId}`);
      if (signal.change === 'removed') {
        this.request(accountId, 'steam-market', 'steam-market-history', 'steam-wallet');
      }
      return;
    }
    if (signal.kind === 'gc-session') {
      if (signal.state === 'CONNECTED') {
        // The reconnect sweep. The gap is the one window in which the world could have moved
        // with nobody watching (plan §1), so everything is suspect, contents included.
        this.backoff.forget(accountId);
        this.held.delete(accountId);
        this.request(accountId, ...SURFACE_ORDER.filter((surface) => surface !== 'gc-casket'), 'gc-casket:*');
      } else {
        this.holdGc(accountId, signal.state === 'BLOCKED_ELSEWHERE' ? 'blocked-elsewhere' : 'gc-disconnected');
      }
      return;
    }
    if (signal.kind === 'mutation-settled') {
      // The action this settled is in the database with its need, which the next scheduling
      // decision reads (plan D5): waking the loop is all a Steam action needs. Trade and CSFloat
      // sends still nudge, for the drivers that own them.
      this.wake(accountId);
      for (const surface of NUDGES[signal.actionKind] ?? []) this.request(accountId, surface);
      if (signal.actionKind.startsWith('trade.')) {
        const batches = this.context.database.raw().prepare(`SELECT account_id,destination_account_id FROM transfer_batch
          WHERE (account_id=? OR destination_account_id=?) AND state NOT IN ('DONE','ENDED','FAILED')`).all(accountId,accountId);
        for (const batch of batches) for (const other of [String(batch.account_id),String(batch.destination_account_id)]) {
          if (other !== accountId && this.loops.has(other)) this.request(other,...(NUDGES[signal.actionKind] ?? []));
        }
      }
      return;
    }
    if (signal.kind === 'order-changed') {
      this.request(accountId, 'steam-wallet', 'steam-market-history');
      if (signal.side === 'BUY') this.request(accountId, 'gc-inventory');
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
const NUDGES: Record<string, readonly string[]> = {
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

function isGcSurface(surface: Surface): boolean {
  return surface.startsWith('gc-');
}
