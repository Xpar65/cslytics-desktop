import SteamUser from 'steam-user';
import type { AccountId } from '@cslytics/ports';
import type { CredentialVault } from './vault.js';
import { refreshTokenKey } from './vault.js';

/** The subset of steam-user used by auth and GC, kept structural for deterministic tests. */
export type SteamClient = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  logOn(details: { refreshToken: string; machineName: string }): void;
  logOff(): void;
  webLogOn(): void;
  gamesPlayed(apps: number[]): void;
  /**
   * Raw Game Coordinator send, present on a real steam-user. Optional because the structural
   * fakes in unit tests need not carry it; the store adapter throws when it is absent.
   */
  sendToGC?(appid: number, msgType: number, protoHeader: object | null, payload: Buffer, callback?: (...args: any[]) => void): void;
  /** steam-user fills this from ClientWalletInfoUpdate; absent until Steam has said. */
  wallet?: { hasWallet: boolean; currency: number; balance: number };
  /**
   * steam-user's raw Game Coordinator send. `globaloffensive` covers the casket messages; the
   * crate and terminal messages it does not know are sent through this. A `{}` header means a
   * protobuf body, `null` a struct body — the same rule the library applies internally.
   */
  sendToGC?(appId: number, msgType: number, protoBufHeader: Record<string, never> | null, payload: Buffer): void;
  /**
   * Persona data for one or more SteamIDs. Present on a real steam-user; optional on structural
   * fakes that do not exercise the persona surface.
   */
  getPersonas?(steamids: string[]): Promise<unknown>;
  steamID?: { getSteamID64?(): string; toString(): string } | null;
};

export type SteamClientFactory = () => SteamClient;

export type ConnectedSteamClient = {
  user: SteamClient;
  steamId64: string;
};

export type SteamClientWebSession = ConnectedSteamClient & {
  cookies: string[];
  sessionId: string;
};

type ClientRecord = {
  token: string;
  user: SteamClient;
  connected: boolean;
  /** Set when this record has been retired. A retired client is never brought back up. */
  retired: boolean;
  steamId64: string | undefined;
  connection: Promise<ConnectedSteamClient> | undefined;
  web: { cookies: string[]; sessionId: string } | undefined;
  webSession: Promise<{ cookies: string[]; sessionId: string }> | undefined;
};

export const CLIENT_LOGON_TIMEOUT_MS = 60_000;

/**
 * How long closing waits for Steam to answer each logoff. The runtime is killed two seconds after
 * main asks it to stop, so this leaves room to close the record after it.
 */
export const CLIENT_LOGOFF_TIMEOUT_MS = 1_500;

function createSteamUser(): SteamClient {
  // One client per account owns the authenticated CM connection used by both web sessions
  // and the CS2 GC. A second steam-user login can replace the first session and, more
  // importantly, cannot consume the web/mobile refresh token the old auth adapter issued.
  // `dataDirectory: null` turns off steam-user's own file store, which otherwise writes to
  // %LOCALAPPDATA%\doctormckay\node-steamuser — outside the profile, surviving uninstall and
  // account removal. A refresh-token logon reads nothing from it but a cached cell id.
  return new SteamUser({
    renewRefreshTokens: true,
    autoRelogin: true,
    machineIdType: 2,
    dataDirectory: null
  }) as SteamClient;
}

/**
 * Account-keyed owner of Steam client sessions.
 *
 * steam-session issues a `['web', 'client']` refresh token. This pool consumes that token
 * exactly once and shares the resulting SteamUser with auth (web cookies) and GC. A caller
 * timing out does not cause another logOn: the original attempt remains observable and a
 * late `loggedOn` event makes the next call succeed without replacing the session.
 */
export class SteamClientSessionPool {
  private readonly records = new Map<string, ClientRecord>();

  constructor(
    private readonly vault: CredentialVault,
    private readonly createUser: SteamClientFactory = createSteamUser
  ) {}

  async connect(
    accountId: AccountId,
    timeoutMs = CLIENT_LOGON_TIMEOUT_MS,
    expectedSteamId64?: string
  ): Promise<ConnectedSteamClient> {
    const token = await this.vault.get(refreshTokenKey(accountId));
    if (!token) throw new Error(`No Steam refresh token for ${accountId}`);

    let record = this.records.get(accountId);
    if (record && record.token !== token) {
      // A successful interactive login supersedes an expired/rejected token. It is safe to
      // retire the old connection because every consumer resolves this same account pool.
      try { record.user.logOff(); } catch { /* already disconnected */ }
      this.records.delete(accountId);
      record = undefined;
    }
    if (!record) {
      record = this.createRecord(accountId, token);
      this.records.set(accountId, record);
    }

    if (record.connected && record.steamId64) {
      assertExpectedAccount(record.steamId64, expectedSteamId64);
      return { user: record.user, steamId64: record.steamId64 };
    }

    record.connection ??= this.beginConnection(accountId, record, true);
    const connected = await withTimeout(
      record.connection,
      timeoutMs,
      `Steam client logon for ${accountId} did not complete within ${timeoutMs}ms`
    );
    assertExpectedAccount(connected.steamId64, expectedSteamId64);
    return connected;
  }

  async getWebSession(
    accountId: AccountId,
    timeoutMs = CLIENT_LOGON_TIMEOUT_MS,
    expectedSteamId64?: string
  ): Promise<SteamClientWebSession> {
    const connected = await this.connect(accountId, timeoutMs, expectedSteamId64);
    const record = this.requiredRecord(accountId);
    if (record.web) return { ...connected, cookies: [...record.web.cookies], sessionId: record.web.sessionId };

    record.webSession ??= this.beginWebSession(record);
    const web = await withTimeout(
      record.webSession,
      timeoutMs,
      `Steam web session for ${accountId} did not complete within ${timeoutMs}ms`
    );
    return { ...connected, cookies: [...web.cookies], sessionId: web.sessionId };
  }

  /**
   * Ends this account's client session without forgetting the account.
   *
   * "Signed out" here means no live connection, not a revoked login: the refresh token stays
   * in the vault so the next `connect` is a reconnect rather than another Guard code. The
   * record is retired rather than merely logged off because `autoRelogin` would otherwise
   * bring the session straight back up behind a window that has just said it is gone.
   */
  signOut(accountId: AccountId): void {
    const record = this.records.get(accountId);
    if (!record) return;
    record.retired = true;
    record.connected = false;
    this.records.delete(accountId);
    try { record.user.logOff(); } catch { /* already disconnected */ }
  }

  /**
   * Logs every client off as the app closes, and resolves once Steam has answered each logoff or
   * `timeoutMs` has passed.
   *
   * A process that simply exits never tells Steam its session is over, so Steam keeps it, CS2 still
   * playing, until it notices the connection is gone; a launch on the same account inside that
   * window can find its Game Coordinator taken "by another computer" that is this one, a moment
   * ago. How long Steam keeps it is not measured (`cslytics-app-docs/steam/auth.md`, "Closing the
   * app"); a logoff means the question never arises. Every record is retired first, so
   * `autoRelogin` brings none back while the rest close. The refresh tokens stay in the vault: the
   * next launch reconnects without a Guard code, as after `signOut`.
   */
  async closeAll(timeoutMs = CLIENT_LOGOFF_TIMEOUT_MS): Promise<void> {
    const records = [...this.records.values()];
    this.records.clear();
    await Promise.all(records.map((record) => logOffAndWait(record, timeoutMs)));
  }

  private createRecord(accountId: string, token: string): ClientRecord {
    const user = this.createUser();
    const record: ClientRecord = {
      token,
      user,
      connected: false,
      retired: false,
      steamId64: undefined,
      connection: undefined,
      web: undefined,
      webSession: undefined
    };

    // Keep permanent listeners on the owner. In particular, an unhandled steam-user
    // `error` event terminates Node, which would take down the Engine Runtime.
    user.on('loggedOn', () => {
      record.connected = true;
      record.steamId64 = steamId64(user);
    });
    user.on('disconnected', () => {
      record.connected = false;
      record.web = undefined;
      record.webSession = undefined;
      // A deliberate sign-out disconnects too, and that one must stay disconnected. Without
      // this the window would say "signed out" over a client quietly waiting to come back up.
      if (record.retired) return;
      // With autoRelogin enabled, steam-user drives this promise to another loggedOn event.
      // A later caller only observes it; it never issues a second logOn.
      record.connection = this.beginConnection(accountId, record, false);
      void record.connection.catch(() => undefined);
    });
    user.on('error', () => {
      // steam-user emits `error` only once the client is logged off for good, and a fatal logoff
      // gets no `disconnected` and no autoRelogin. LoggedInElsewhere is one: another computer
      // playing CS2 on this account kicks this client. Dropping the settled logon is what makes
      // the next `connect` log on again instead of handing back a client that sends nothing.
      record.connected = false;
      record.connection = undefined;
      record.web = undefined;
      record.webSession = undefined;
    });
    user.on('refreshToken', (refreshToken: string) => {
      record.token = refreshToken;
      void this.vault.set(refreshTokenKey(accountId), refreshToken);
    });
    user.on('webSession', (sessionId: string, cookies: string[]) => {
      record.web = { sessionId, cookies: [...cookies] };
    });
    return record;
  }

  private beginConnection(
    accountId: string,
    record: ClientRecord,
    initiate: boolean
  ): Promise<ConnectedSteamClient> {
    return new Promise<ConnectedSteamClient>((resolve, reject) => {
      const success = (): void => {
        const actualSteamId64 = steamId64(record.user);
        cleanup();
        record.connected = true;
        record.steamId64 = actualSteamId64;
        resolve({ user: record.user, steamId64: actualSteamId64 });
      };
      const failure = (error: unknown): void => {
        cleanup();
        record.connection = undefined;
        reject(asError(error));
      };
      const guard = (): void => {
        failure(new Error(
          `Steam rejected the stored client refresh token for ${accountId} and requested another Guard code`
        ));
      };
      const cleanup = (): void => {
        record.user.removeListener('loggedOn', success);
        record.user.removeListener('error', failure);
        record.user.removeListener('steamGuard', guard);
      };

      record.user.once('loggedOn', success);
      record.user.once('error', failure);
      record.user.once('steamGuard', guard);
      if (initiate) {
        try {
          record.user.logOn({ refreshToken: record.token, machineName: 'CSlytics' });
        } catch (error) {
          failure(error);
        }
      }
    });
  }

  private beginWebSession(record: ClientRecord): Promise<{ cookies: string[]; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const success = (sessionId: string, cookies: string[]): void => {
        cleanup();
        const web = { sessionId: required(sessionId, 'Steam web session did not include sessionid'), cookies: [...cookies] };
        record.web = web;
        resolve(web);
      };
      const failure = (error: unknown): void => {
        cleanup();
        record.webSession = undefined;
        reject(asError(error));
      };
      const cleanup = (): void => {
        record.user.removeListener('webSession', success);
        record.user.removeListener('error', failure);
      };

      record.user.once('webSession', success);
      record.user.once('error', failure);
      // steam-user normally negotiates this automatically after loggedOn. Calling webLogOn
      // is also its documented refresh path and closes the race where that event happened
      // before auth asked for the cookies.
      try { record.user.webLogOn(); } catch (error) { failure(error); }
    });
  }

  private requiredRecord(accountId: string): ClientRecord {
    const record = this.records.get(accountId);
    if (!record) throw new Error(`Steam client session for ${accountId} is not active`);
    return record;
  }
}

/**
 * Retires one client and logs it off. A logged-on client is waited for: steam-user sends
 * `ClientLogOff` and emits `disconnected` when Steam answers, or by itself after four seconds,
 * longer than closing can wait. A client that never finished logging on has no session for Steam
 * to end, and steam-user only closes its socket, so there is nothing to wait for.
 */
function logOffAndWait(record: ClientRecord, timeoutMs: number): Promise<void> {
  const loggedOn = record.connected;
  record.retired = true;
  record.connected = false;
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      record.user.removeListener('disconnected', done);
      record.user.removeListener('error', done);
      resolve();
    };
    if (loggedOn) {
      record.user.once('disconnected', done);
      record.user.once('error', done);
      timer = setTimeout(done, timeoutMs);
    }
    try { record.user.logOff(); } catch { /* already disconnected */ }
    if (!loggedOn) done();
  });
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function steamId64(user: SteamClient): string {
  const id = user.steamID?.getSteamID64?.() ?? user.steamID?.toString();
  return required(id, 'Steam client logged on without a SteamID');
}

function assertExpectedAccount(actual: string, expected?: string): void {
  if (expected && actual !== expected) {
    throw new Error(`Steam refresh token belongs to ${actual}, expected ${expected}`);
  }
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined || value === '') throw new Error(message);
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
