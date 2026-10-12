import type {
  AccountId,
  Authed,
  GcConnectionState,
  GcStatus,
  GuardPrompt,
  QrChallenge,
  QrState,
  SessionStatus
} from '@cslytics/ports';
import { canonicalAccountId } from '../db/database.js';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage } from '../kernel/support.js';
import { BackoffLedger, BLOCKED_ELSEWHERE_RETRY_MS } from '../policy/backoff.js';
import type { InventoryService } from './inventory.js';

/** How often a supervised account has its local GC state re-read. Reaches no network. */
const SUPERVISE_TICK_MS = 10_000;
/** The backoff ledger key for reconnect attempts; not a surface, so it cannot collide. */
const RECONNECT = 'session:reconnect';

export type ConnectionPhase =
  | 'CONNECTED' | 'CONNECTING' | 'STEAM_ONLY' | 'BLOCKED_ELSEWHERE'
  | 'DISCONNECTED' | 'SIGNED_OUT' | 'EXPIRED';

export type AccountConnection = {
  accountId: AccountId;
  phase: ConnectionPhase;
  steam: SessionStatus;
  gc: GcStatus;
  hasSavedCredential: boolean;
  /** Why the last attempt stopped. null when none has run, or the last one worked. */
  lastError: string | null;
  observedAt: string;
};

export type AuthedAccount = { kind: 'authed'; accountId: AccountId; accountName: string; steamId64: string };
export type LoginOutcome = GuardPrompt | AuthedAccount;

type Attempt = {
  username: string;
  boundId: string;
  terminal: QrState | null;
};

/** True when the last attempt failed for want of something only a person can supply. */
function needsCredentials(message: string | null): boolean {
  if (!message) return false;
  return /guard code/i.test(message)
    || /refresh token/i.test(message)
    || /rejected the stored session/i.test(message);
}

/**
 * Pure. The one place a connection phase is decided.
 */
export function classifyConnection(input: {
  steam: SessionStatus;
  gc: GcStatus;
  hasSavedCredential: boolean;
  connecting: boolean;
  everConnected: boolean;
  lastError: string | null;
}): ConnectionPhase {
  if (input.connecting) return 'CONNECTING';
  if (input.gc.state === 'BLOCKED_ELSEWHERE') return 'BLOCKED_ELSEWHERE';
  if (input.steam.kind === 'authenticated') {
    return input.gc.state === 'CONNECTED' ? 'CONNECTED' : 'STEAM_ONLY';
  }
  if (!input.hasSavedCredential || input.steam.kind === 'expired') return 'EXPIRED';
  if (needsCredentials(input.lastError)) return 'EXPIRED';
  if (input.lastError || input.everConnected) return 'DISCONNECTED';
  return 'SIGNED_OUT';
}

/**
 * Auth orchestration: login attempts, cached reconnect, sign-out, and the connection phase.
 *
 * `connect` never throws. It returns the observed state plus `lastError`. One blocked
 * account must not stop the launch sweep (steam/auth.md, "Sessions on launch").
 *
 * The GC event loop is started once per account and survives reconnect and sign-out. A
 * replaced queue loses every later GC event in silence.
 */
export class SessionService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly lastError = new Map<AccountId, string | null>();
  private readonly connecting = new Set<AccountId>();
  private readonly everConnected = new Set<AccountId>();
  /** Accounts a supervisor loop is watching, and the last GC state each was seen in. */
  private readonly supervised = new Map<AccountId, { stop: boolean; lastState: GcConnectionState | null }>();
  /** Accounts the user deliberately signed out. A sign-out must survive the supervisor. */
  private readonly signedOut = new Set<AccountId>();
  private readonly reconnectBackoff = new BackoffLedger();
  private stopped = false;
  protected inventoryService: InventoryService | undefined;
  protected startConvergence: ((accountId: AccountId) => void) | undefined;
  protected startReads: ((accountId: AccountId) => void) | undefined;
  protected stopReads: ((accountId: AccountId) => void) | undefined;

  constructor(protected readonly context: EngineContext) {}

  /**
   * `startConvergence` follows a CS2 session: everything that needs the Game Coordinator.
   * `startReads` follows a Steam session: the refresh loop, which walks what Steam answers over
   * HTTP without one and leaves the GC surfaces until a session exists. `stopReads` ends that
   * loop at sign-out, because reading an account is enough to sign it back in.
   */
  attachRuntime(
    inventory: InventoryService,
    startConvergence: (accountId: AccountId) => void,
    startReads?: (accountId: AccountId) => void,
    stopReads?: (accountId: AccountId) => void
  ): void {
    this.inventoryService = inventory;
    this.startConvergence = startConvergence;
    this.startReads = startReads;
    this.stopReads = stopReads;
  }

  /**
   * True once a CS2 session for this account has come up in this run, so a later drop is being
   * reconnected. False for an account that was only ever signed in to Steam — on purpose, or
   * because the Game Coordinator refused it — which is a thing nobody is fixing on their own.
   */
  supervises(accountId: AccountId): boolean {
    return this.supervised.has(accountId);
  }

  /**
   * Watches one account's CS2 session and brings it back on its own.
   *
   * `connectionStatus` is a local read that reaches no network — the port says so, and says
   * callers are expected to poll it to decide whether to reconnect. Before this existed, three
   * of the four ways a session dies (a CM drop, `playingState` reporting that another computer
   * took the game, a logged-in-elsewhere error) changed adapter state and reached nothing: the
   * window noticed on its ten-second poll and then waited for somebody to press Connect.
   *
   * Two retry schedules, because there are two problems. An ordinary drop backs off
   * exponentially — the network may be gone, and asking faster will not bring it back. Being
   * blocked by another computer is not a fault at all, and no amount of retrying fixes it while
   * they are still playing, so it gets a flat, unhurried minute
   * (steam/gc-inventory.md, `policy/backoff.ts`).
   */
  supervise(accountId: AccountId): void {
    if (this.stopped || this.supervised.has(accountId)) return;
    const control = { stop: false, lastState: null as GcConnectionState | null };
    this.supervised.set(accountId, control);
    void (async () => {
      try {
        while (!control.stop && !this.stopped) {
          await this.superviseOnce(accountId, control);
          await this.context.ports.clock.sleep(SUPERVISE_TICK_MS);
        }
      } finally {
        if (this.supervised.get(accountId) === control) this.supervised.delete(accountId);
      }
    })();
  }

  private async superviseOnce(accountId: AccountId, control: { lastState: GcConnectionState | null }): Promise<void> {
    const status = this.context.ports.gc.connectionStatus(accountId);
    if (status.state !== control.lastState) {
      control.lastState = status.state;
      // A state *change* is the signal, not the state. Emitting every tick would ask the refresh
      // loop to re-sweep every account every ten seconds.
      this.context.signals.emit({
        kind: 'gc-session',
        accountId,
        state: status.state,
        ...(status.detail ? { detail: status.detail } : {})
      });
    }
    if (status.state === 'CONNECTED') {
      this.reconnectBackoff.succeed(accountId, RECONNECT);
      return;
    }
    // A deliberate sign-out is a decision, not a fault. Undoing it automatically would be the
    // app arguing with the user (steam/auth.md, on what signing out means).
    if (this.signedOut.has(accountId) || this.connecting.has(accountId)) return;
    if (!await this.context.ports.auth.hasStoredCredential(accountId)) return;
    const nowMs = this.context.ports.clock.now().getTime();
    const held = this.reconnectBackoff.state(accountId, RECONNECT);
    if (held && held.notBeforeMs > nowMs) return;
    const report = await this.connect(accountId);
    if (report.phase === 'CONNECTED') return;
    // Two failures, two schedules. A block is not a fault and does not escalate — the other
    // computer will stop playing eventually, and the attempt is how this one finds out — while
    // an ordinary drop backs off, because the network may simply be gone.
    if (status.state === 'BLOCKED_ELSEWHERE') this.reconnectBackoff.hold(accountId, RECONNECT, this.blockedRetryMs(), nowMs);
    else this.reconnectBackoff.fail(accountId, RECONNECT, SUPERVISE_TICK_MS, nowMs);
  }

  /**
   * How long to wait before asking again for a session another computer is holding.
   *
   * Its own method so a saboteur can prove the schedule matters: with it at zero the supervisor
   * becomes a reconnect storm against a block that only the other computer can clear.
   */
  protected blockedRetryMs(): number {
    return BLOCKED_ELSEWHERE_RETRY_MS;
  }

  /** Stops every supervisor. Call before disposing the runtime. */
  stopSupervising(): void {
    this.stopped = true;
    for (const control of this.supervised.values()) control.stop = true;
    this.supervised.clear();
  }

  async beginQrLogin(): Promise<QrChallenge> {
    const challenge = await this.context.ports.auth.beginQrLogin('');
    this.attempts.set(challenge.sessionHandle, { username: '', boundId: '', terminal: null });
    return challenge;
  }

  async pollQrLogin(sessionHandle: string): Promise<QrState & { accountId?: AccountId }> {
    const attempt = this.attempts.get(sessionHandle);
    if (!attempt) throw new Error(`Login session ${sessionHandle} is no longer active`);
    if (attempt.terminal) return attempt.terminal;
    const state = await this.context.ports.auth.pollQrLogin(sessionHandle);
    if (state.kind === 'confirmed') {
      const bound = await this.bindAuthed(state.accountName, {
        kind: 'authed',
        accountName: state.accountName,
        steamId64: state.steamId64
      });
      return { ...state, accountId: bound.accountId };
    }
    return state;
  }

  async beginCredentialLogin(username: string, password: string): Promise<LoginOutcome> {
    const existing = this.context.database.findAccountByName(username);
    const boundId = existing?.id ?? canonicalAccountId(username);
    const result = await this.context.ports.auth.beginCredentialLogin(boundId, username, password);
    if (result.kind === 'authed') return this.bindAuthed(boundId, result);
    this.attempts.set(result.sessionHandle, { username, boundId, terminal: null });
    return result;
  }

  async submitGuardCode(sessionHandle: string, code: string): Promise<AuthedAccount> {
    const attempt = this.attempts.get(sessionHandle);
    if (!attempt || attempt.terminal) throw new Error(`Login session ${sessionHandle} is no longer active`);
    const authed = await this.context.ports.auth.submitGuardCode(sessionHandle, code);
    const preferred = attempt?.boundId || authed.accountName;
    const bound = await this.bindAuthed(preferred, authed);
    this.attempts.delete(sessionHandle);
    return bound;
  }

  async cancelLogin(sessionHandle: string): Promise<void> {
    const attempt = this.attempts.get(sessionHandle);
    if (attempt) attempt.terminal = { kind: 'failed', message: 'Login cancelled' };
    await this.context.ports.auth.cancelLogin(sessionHandle);
  }

  /**
   * The cached path: stored credential, GC handshake, event loop. Never throws.
   *
   * `cs2: false` stops after Steam. It is how the launch sweep opens an account whose owner plays
   * CS2 on it elsewhere: asking the Game Coordinator would only find the session held. Either way
   * a Steam session that came up starts the refresh loop, so listings, orders, trades and the
   * wallet stay current whether or not the Game Coordinator answers.
   */
  async connect(accountId: AccountId, options: { cs2?: boolean } = {}): Promise<AccountConnection> {
    const cs2 = options.cs2 ?? true;
    // An explicit connect withdraws a previous sign-out; the supervisor may resume from here.
    this.signedOut.delete(accountId);
    this.connecting.add(accountId);
    try {
      try {
        if (await this.context.ports.auth.hasStoredCredential(accountId)) {
          await this.context.ports.auth.refreshSession(accountId);
        }
      } catch (error) {
        this.lastError.set(accountId, errorMessage(error));
      }
      if (cs2) {
        try {
          await this.ensureGc(accountId);
        } catch (error) {
          if (!this.lastError.get(accountId)) this.lastError.set(accountId, errorMessage(error));
        }
      }
      // After the GC attempt rather than before it: a loop started first would hold the GC
      // surfaces for the few seconds the handshake takes, and say so. When the handshake worked,
      // `startConvergence` has already started the loop and this is ignored.
      try {
        if ((await this.context.ports.auth.status(accountId)).kind === 'authenticated') this.startReads?.(accountId);
      } catch { /* no Steam session to keep current */ }
    } finally {
      this.connecting.delete(accountId);
    }
    const report = await this.connection(accountId);
    if (report.phase === 'CONNECTED') {
      this.lastError.set(accountId, null);
      this.everConnected.add(accountId);
      if (this.context.database.account(accountId)) {
        const events = this.context.database.events(accountId);
        if (!events.some((event) => event.kind === 'session-connected')) {
          this.context.database.addEvent(accountId, 'session-connected', { accountId }, this.context.now());
        }
      }
      return this.connection(accountId);
    }
    return report;
  }

  /** Observed state only. Reaches no network. */
  async connection(accountId: AccountId): Promise<AccountConnection> {
    let steam: SessionStatus = { kind: 'expired', reason: 'no-refresh-token' };
    let hasSavedCredential = false;
    try {
      steam = await this.context.ports.auth.status(accountId);
    } catch (error) {
      if (!this.lastError.get(accountId)) this.lastError.set(accountId, errorMessage(error));
    }
    try {
      hasSavedCredential = await this.context.ports.auth.hasStoredCredential(accountId);
    } catch { /* a vault that cannot be read is not a stored credential */ }
    const gc = this.context.ports.gc.connectionStatus(accountId);
    const lastError = this.lastError.get(accountId) ?? null;
    const phase = classifyConnection({
      steam,
      gc,
      hasSavedCredential,
      connecting: this.connecting.has(accountId),
      everConnected: this.everConnected.has(accountId),
      lastError
    });
    return {
      accountId,
      phase,
      steam,
      gc,
      hasSavedCredential,
      lastError,
      observedAt: this.context.now()
    };
  }

  async signOut(accountId: AccountId): Promise<AccountConnection> {
    this.signedOut.add(accountId);
    // Its calls stop (AUTH-06). A loop left running would sign it back in at its next walk, and a
    // machine waking up would refresh it, because it would still be one being kept current.
    this.stopReads?.(accountId);
    this.context.ports.gc.disconnect(accountId);
    await this.context.ports.auth.signOut(accountId);
    this.lastError.set(accountId, null);
    this.everConnected.delete(accountId);
    return this.connection(accountId);
  }

  private async bindAuthed(preferredId: string, authed: Authed): Promise<AuthedAccount> {
    const accountId = this.context.database.ensureAccount(
      preferredId,
      authed.steamId64,
      authed.accountName,
      this.context.now()
    );
    await this.context.ports.auth.getWebSession(accountId);
    return { kind: 'authed', accountId, accountName: authed.accountName, steamId64: authed.steamId64 };
  }

  private async ensureGc(accountId: AccountId): Promise<void> {
    if (this.inventoryService) await this.inventoryService.connectGc(accountId);
    else await this.context.ports.gc.connect(accountId, 30_000);
    try {
      this.inventoryService?.startEventLoop(accountId);
      this.startConvergence?.(accountId);
    } catch (error) {
      if (!/already active/i.test(errorMessage(error))) throw error;
    }
    this.supervise(accountId);
  }

  /**
   * Reads this account's current display name and avatar hash from the CM client.
   *
   * A signed-out or unauthenticated session writes nothing — the previous hash stays
   * (rule 1). A timeout or empty answer records an incomplete observation and also
   * leaves the previous row alone.
   */
  syncPersona(accountId: AccountId): Promise<number> {
    return this.context.reads.run(`${accountId}:steam-persona`, () => this.readPersona(accountId));
  }

  private async readPersona(accountId: AccountId): Promise<number> {
    const { database } = this.context;
    const startedAt = this.context.now();
    const account = database.account(accountId);
    if (!account) {
      return database.insertObservation({
        accountId, surface: 'steam-persona', startedAt, finishedAt: this.context.now(),
        complete: false, error: 'unknown-account'
      });
    }
    const steam = await this.context.ports.auth.status(accountId);
    if (steam.kind !== 'authenticated') {
      // Nothing was asked. Returning 0 tells the refresh loop the pass did not complete, without
      // writing an incomplete observation that would wipe scheduling state or clear a hash.
      return 0;
    }
    try {
      const personas = await this.context.ports.persona.getPersonas(accountId, [account.steam_id64]);
      const persona = personas.find((row) => row.steamId64 === account.steam_id64);
      if (!persona?.personaName || !persona.avatarHash) {
        throw new Error('persona-missing');
      }
      const observationId = database.transaction(() => {
        const observationId = database.insertObservation({
          accountId,
          surface: 'steam-persona',
          startedAt,
          finishedAt: this.context.now(),
          complete: true,
          totalExpected: 1
        });
        database.raw().prepare(`
          UPDATE account SET persona_name=?, avatar_hash=?, persona_obs=? WHERE id=?
        `).run(persona.personaName, persona.avatarHash, observationId, accountId);
        return observationId;
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-persona', complete: true, observationId });
      return observationId;
    } catch (error) {
      const failed = database.insertObservation({
        accountId,
        surface: 'steam-persona',
        startedAt,
        finishedAt: this.context.now(),
        complete: false,
        error: errorMessage(error)
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'steam-persona', complete: false, observationId: failed });
      return failed;
    }
  }
}
