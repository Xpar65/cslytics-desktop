import type { AccountId } from '../kernel.js';

/**
 * Interactive Steam login: QR, Guard, and reconnecting from a stored refresh token.
 *
 * No 2FA secret appears anywhere in this file, and none may. Repository rule 2 is enforced over
 * shipped source, request schemas and dependencies by `pnpm check:secrets`.
 */
/**
 * A login attempt is only ever *observed*, never assumed. `pending` means nothing is known
 * yet; `failed` carries the reason Steam gave so a caller can say something truer than
 * "something went wrong". A poll that throws is ambiguous and says nothing about the attempt.
 */
export type QrState =
  | { kind: 'pending'; remoteInteraction: boolean }
  | { kind: 'confirmed'; accountName: string; steamId64: string }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failed'; message: string };

export type GuardMethod = 'device-code' | 'device-confirmation' | 'email-code' | 'email-confirmation';

export type GuardPrompt = {
  kind: 'guard-prompt';
  sessionHandle: string;
  methods: GuardMethod[];
  /** Epoch milliseconds after which the adapter stops polling and the attempt is dead. */
  expiresAtMs: number;
};

export type QrChallenge = {
  challengeUrl: string;
  sessionHandle: string;
  /** Epoch milliseconds after which the adapter stops polling and the attempt is dead. */
  expiresAtMs: number;
};

export type Authed = {
  kind: 'authed';
  accountName: string;
  steamId64: string;
};

export type SessionStatus =
  | { kind: 'signed-out' }
  | { kind: 'authenticating' }
  | { kind: 'authenticated'; steamId64: string; accountName: string }
  | { kind: 'expired'; reason: string };

export interface SteamAuthPort {
  beginQrLogin(accountId: AccountId): Promise<QrChallenge>;
  pollQrLogin(sessionHandle: string): Promise<QrState>;
  beginCredentialLogin(accountId: AccountId, username: string, password: string): Promise<GuardPrompt | Authed>;
  submitGuardCode(sessionHandle: string, code: string): Promise<Authed>;
  /** Abandons an in-flight attempt so a user who gives up stops spending Steam's poll budget. */
  cancelLogin(sessionHandle: string): Promise<void>;
  refreshSession(accountId: AccountId): Promise<Authed>;
  getWebSession(accountId: AccountId): Promise<{ cookies: string[]; sessionId: string; steamId64: string }>;
  status(accountId: AccountId): Promise<SessionStatus>;
  /** Ends this account's live session without forgetting it. The stored credential survives. */
  signOut(accountId: AccountId): Promise<void>;
  /**
   * Ends the session and deletes the stored credential, so the next connect needs QR or a Guard
   * code. Only removing the account calls it; signing out never does (AUTH-06, AUTH-10).
   */
  forgetSignIn(accountId: AccountId): Promise<void>;
  /** True when a credential this app can reconnect from is stored. Never returns the value. */
  hasStoredCredential(accountId: AccountId): Promise<boolean>;
}
