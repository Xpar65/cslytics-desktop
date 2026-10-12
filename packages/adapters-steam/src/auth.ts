import { randomUUID } from 'node:crypto';
import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  LoginSession
} from 'steam-session';
import type {
  AccountId,
  Authed,
  GuardMethod,
  GuardPrompt,
  QrChallenge,
  QrState,
  SessionStatus,
  SteamAuthPort
} from '@cslytics/ports';
import type { CredentialVault } from './vault.js';
import { refreshTokenKey } from './vault.js';
import {
  SteamClientSessionPool,
  type SteamClientWebSession
} from './client-session.js';

type LoginRecord = {
  /** Bound local id, or null until Steam names the account (QR). */
  accountId: string | null;
  session: LoginSession;
  state: QrState;
  expiresAtMs: number;
  /** Set once the attempt can never succeed. Later calls fail fast instead of hanging. */
  terminal: string | null;
  authenticated?: Authed;
  resolveAuthenticated: (value: Authed) => void;
  rejectAuthenticated: (error: Error) => void;
  authenticatedPromise: Promise<Authed>;
};

/**
 * How long an attempt may poll before Steam's confirmation is considered missed.
 *
 * steam-session defaults to 30 seconds, which is shorter than it takes a person to unlock a
 * phone, open the Steam app and scan a QR code — so the default turns an ordinary login into
 * a timeout. Three minutes is long enough to walk to the phone and short enough that a dead
 * attempt does not poll Steam forever.
 */
export const LOGIN_TIMEOUT_MS = 180_000;

/**
 * Makes the session an attempt runs on. Injecting one is how a test drives the adapter
 * through Steam's real event sequences without a network.
 */
export type LoginSessionFactory = () => LoginSession;

/** Client-audience tokens are accepted by steam-user and therefore by the CS2 GC. */
export const AUTH_TOKEN_PLATFORM = EAuthTokenPlatformType.SteamClient;

function steamClientSession(): LoginSession {
  return new LoginSession(AUTH_TOKEN_PLATFORM, {
    machineId: true,
    machineFriendlyName: 'CSlytics'
  });
}

export class SteamSessionAuthAdapter implements SteamAuthPort {
  private readonly logins = new Map<string, LoginRecord>();
  private readonly accounts = new Map<string, { authed: Authed; web: SteamClientWebSession }>();

  /**
   * `createSession` exists so a test can drive the event sequence Steam produces — approved,
   * denied, timed out, errored — against the real adapter. It is composition in the same
   * shape as `SteamMarketAdapter`'s injected `fetch`, not a fault-injection hook: the
   * adapter cannot tell an injected session from the default one.
   */
  constructor(
    private readonly vault: CredentialVault,
    private readonly createSession: LoginSessionFactory = steamClientSession,
    private readonly clients = new SteamClientSessionPool(vault)
  ) {}

  async beginQrLogin(accountId: AccountId = ''): Promise<QrChallenge> {
    const record = this.createRecord(boundAccountId(accountId));
    const result = await record.session.startWithQR();
    if (!result.qrChallengeUrl) throw new Error('Steam did not return a QR challenge URL');
    const sessionHandle = randomUUID();
    this.logins.set(sessionHandle, record);
    return { challengeUrl: result.qrChallengeUrl, sessionHandle, expiresAtMs: record.expiresAtMs };
  }

  /**
   * Reports what is known about an attempt. This never invents progress: `pending` means the
   * adapter has not been told anything, not that the login is healthy.
   */
  async pollQrLogin(sessionHandle: string): Promise<QrState> {
    const record = this.record(sessionHandle);
    // steam-session stops polling at its own deadline; if that fired without an event
    // reaching us, the attempt is over regardless of what the last state said.
    if (record.state.kind === 'pending' && Date.now() >= record.expiresAtMs) {
      record.state = { kind: 'expired' };
      record.terminal = 'Steam login timed out';
    }
    return clone(record.state);
  }

  async beginCredentialLogin(accountId: AccountId, username: string, password: string): Promise<GuardPrompt | Authed> {
    const record = this.createRecord(boundAccountId(accountId) ?? boundAccountId(username));
    const sessionHandle = randomUUID();
    this.logins.set(sessionHandle, record);
    try {
      const result = await record.session.startWithCredentials({ accountName: username, password });
      // The caller's password is not retained by this adapter after startWithCredentials returns.
      if (!result.actionRequired) {
        const authed = await record.authenticatedPromise;
        this.logins.delete(sessionHandle);
        return authed;
      }
      return {
        kind: 'guard-prompt',
        sessionHandle,
        methods: (result.validActions ?? []).map((action) => guardMethod(action.type)).filter(isPresent),
        expiresAtMs: record.expiresAtMs
      };
    } catch (error) {
      this.logins.delete(sessionHandle);
      throw error;
    }
  }

  /**
   * Submits one Guard code. A rejected code leaves the attempt alive so the next code can be
   * typed; a dead attempt is reported as dead rather than replaying its original error.
   */
  async submitGuardCode(sessionHandle: string, code: string): Promise<Authed> {
    const record = this.record(sessionHandle);
    if (record.terminal) throw new Error(record.terminal);
    if (Date.now() >= record.expiresAtMs) {
      record.terminal = 'Steam login timed out';
      throw new Error(record.terminal);
    }
    await record.session.submitSteamGuardCode(code);
    const authed = await record.authenticatedPromise;
    this.logins.delete(sessionHandle);
    return authed;
  }

  /** Abandons an attempt. Safe to call on a handle that is already gone. */
  async cancelLogin(sessionHandle: string): Promise<void> {
    const record = this.logins.get(sessionHandle);
    if (!record) return;
    this.logins.delete(sessionHandle);
    record.terminal = 'Login cancelled';
    try { record.session.cancelLoginAttempt(); } catch { /* already finished; nothing to cancel */ }
    record.rejectAuthenticated(new Error('Login cancelled'));
  }

  async refreshSession(accountId: AccountId): Promise<Authed> {
    const token = await this.vault.get(refreshTokenKey(accountId));
    if (!token) throw new Error(`No refresh token stored for ${accountId}`);
    const web = await this.clients.getWebSession(accountId);
    const authed: Authed = {
      kind: 'authed',
      accountName: accountId,
      steamId64: web.steamId64
    };
    this.accounts.set(accountId, { authed, web });
    return authed;
  }

  async getWebSession(accountId: AccountId): Promise<{ cookies: string[]; sessionId: string; steamId64: string }> {
    let account = this.accounts.get(accountId);
    if (!account) {
      await this.refreshSession(accountId);
      account = this.accounts.get(accountId)!;
    }
    return {
      cookies: [...account.web.cookies],
      sessionId: account.web.sessionId,
      steamId64: account.authed.steamId64
    };
  }

  /**
   * Drops this account's live Steam session without forgetting the account.
   *
   * The refresh token stays in the vault, so `status` falls back to `signed-out` — a saved
   * account with no connection — and the next `refreshSession` reconnects without a Guard
   * code. That asymmetry is the point: leaving a window is not revoking a login, and an app
   * that deleted the token here would charge a rate-limited Steam attempt for a stray click.
   */
  async signOut(accountId: AccountId): Promise<void> {
    this.accounts.delete(accountId);
    this.clients.signOut(accountId);
  }

  /**
   * Signs out first, then deletes the token. The order matters: a live client renews its refresh
   * token on its own and writes the new one to the vault, and only a retired client cannot.
   */
  async forgetSignIn(accountId: AccountId): Promise<void> {
    await this.signOut(accountId);
    await this.vault.delete(refreshTokenKey(accountId));
  }

  async hasStoredCredential(accountId: AccountId): Promise<boolean> {
    return (await this.vault.get(refreshTokenKey(accountId))) !== null;
  }

  async status(accountId: AccountId): Promise<SessionStatus> {
    const account = this.accounts.get(accountId);
    if (account) return { kind: 'authenticated', steamId64: account.authed.steamId64, accountName: account.authed.accountName };
    const token = await this.vault.get(refreshTokenKey(accountId));
    return token ? { kind: 'signed-out' } : { kind: 'expired', reason: 'no-refresh-token' };
  }

  private createRecord(accountId: string | null): LoginRecord {
    const session = this.createSession();
    session.loginTimeout = LOGIN_TIMEOUT_MS;
    let resolveAuthenticated!: (value: Authed) => void;
    let rejectAuthenticated!: (error: Error) => void;
    const authenticatedPromise = new Promise<Authed>((resolve, reject) => {
      resolveAuthenticated = resolve;
      rejectAuthenticated = reject;
    });
    // The QR path polls for state and never awaits this promise, so a rejection would
    // otherwise surface as an unhandled rejection and take the runtime down with it.
    // The state recorded below is what the QR caller reads instead.
    authenticatedPromise.catch(() => undefined);
    const record: LoginRecord = {
      accountId,
      session,
      state: { kind: 'pending', remoteInteraction: false },
      expiresAtMs: Date.now() + LOGIN_TIMEOUT_MS,
      terminal: null,
      authenticatedPromise,
      resolveAuthenticated,
      rejectAuthenticated
    };
    session.on('remoteInteraction', () => {
      if (record.state.kind === 'pending') record.state = { kind: 'pending', remoteInteraction: true };
    });
    session.on('timeout', () => {
      record.state = { kind: 'expired' };
      record.terminal = 'Steam login timed out';
      record.rejectAuthenticated(new Error(record.terminal));
    });
    session.on('error', (error: Error) => {
      // Without this the QR poller would report `pending` forever against a dead session.
      record.state = { kind: 'failed', message: error.message };
      record.terminal = error.message;
      record.rejectAuthenticated(error);
    });
    session.on('authenticated', () => {
      void this.completeAuthentication(record);
    });
    return record;
  }

  private async completeAuthentication(record: LoginRecord): Promise<void> {
    try {
      const refreshToken = required(record.session.refreshToken, 'Steam authenticated without a refresh token');
      const steamId64 = required(record.session.steamID?.toString(), 'Steam authenticated without a SteamID');
      const accountName = required(
        record.session.accountName || record.accountId,
        'Steam authenticated without an account name'
      );
      const accountId = record.accountId ?? canonicalSteamUsername(accountName);
      record.accountId = accountId;
      const authed: Authed = {
        kind: 'authed',
        accountName,
        steamId64
      };
      await this.vault.set(refreshTokenKey(accountId), refreshToken);
      const web = await this.clients.getWebSession(accountId, undefined, steamId64);
      record.authenticated = authed;
      record.state = { kind: 'confirmed', accountName: authed.accountName, steamId64 };
      this.accounts.set(accountId, { authed, web });
      record.resolveAuthenticated(authed);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      record.state = { kind: 'failed', message: failure.message };
      record.terminal = failure.message;
      record.rejectAuthenticated(failure);
    }
  }

  private record(sessionHandle: string): LoginRecord {
    const record = this.logins.get(sessionHandle);
    // A handle the adapter has never seen means the attempt is gone — a restarted Engine
    // Runtime, or a login that already finished. Say so; the caller can only start over.
    if (!record) throw new Error(`Steam login session ${sessionHandle} is no longer active`);
    return record;
  }
}

function guardMethod(type: EAuthSessionGuardType): GuardMethod | undefined {
  if (type === EAuthSessionGuardType.DeviceCode) return 'device-code';
  if (type === EAuthSessionGuardType.DeviceConfirmation) return 'device-confirmation';
  if (type === EAuthSessionGuardType.EmailCode) return 'email-code';
  if (type === EAuthSessionGuardType.EmailConfirmation) return 'email-confirmation';
  return undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function boundAccountId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalSteamUsername(username: string): string {
  return username.trim().toLowerCase();
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined || value === '') throw new Error(message);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
