import type { AccountId } from '../kernel.js';

/**
 * CSFloat account identity, readiness and money, as `/me` reports them.
 *
 * The identity comparison is the whole point of CSF-01: a developer key belongs to a CSFloat
 * account, and the only way to know which Steam account it speaks for is to ask and compare.
 *
 * Balances are **integer USD cents or null**. Null is not zero: a field this app could not read
 * must not present as an empty wallet, and every CSFloat figure in the inspected evidence is USD
 * (cslytics-app-docs/plans/csfloat-marketplace-plan.md §5.4).
 *
 * `flags` carries readiness and restriction fields uninterpreted, exactly as market event codes
 * stay raw on the Steam ports: what a readiness field means is evidence-graded and can change,
 * so the engine decides. A field this adapter has never seen still arrives.
 */
export type CsfloatMe = {
  steamId64: string;
  /** CSFloat's own user id, when it supplies one. Never derived from the SteamID64. */
  userId?: string;
  username?: string;
  availableCents: number | null;
  pendingCents: number | null;
  flags: Readonly<Record<string, unknown>>;
  raw: unknown;
};

/**
 * Why a read did not produce a `/me`.
 *
 * `rejected` is the venue answering: this key is not usable. `throttled` and `unavailable` are
 * not answers at all, and must never invalidate a stored connection — a network blip is not a
 * revoked key (CSF-02).
 */
export type CsfloatMeResult =
  | { kind: 'ok'; me: CsfloatMe }
  | { kind: 'rejected'; reason: 'invalid-key' | 'forbidden' | 'not-found'; status: number; raw: unknown }
  | { kind: 'throttled'; retryAfterMs: number | null; raw: unknown }
  | { kind: 'unavailable'; cause: 'timeout' | 'transport' | 'malformed' | 'redirected'; raw: unknown };

/**
 * An opaque vault key naming one stored credential, such as `csfloat-api-key:<accountId>:<n>`.
 *
 * The engine passes it in rather than letting the adapter decide which key is current, because
 * "which credential is current" is durable state and SQLite owns it. A reply carrying a ref the
 * database has since replaced is evidence from a dead generation (CSF-04).
 */
export type CsfloatCredentialRef = string;

/**
 * The two stall settings CSFloat lets an account change through `PATCH /me`.
 *
 * `away` hides every listing the account has; CSFloat sets it when it suspends an account and
 * does **not** clear it when the suspension ends (seen live, 2026-09-22), which is why the
 * engine has to be able to change it. `stallPublic` is whether other users may see the stall.
 */
export type CsfloatMePatch = { away?: boolean; stallPublic?: boolean };

/**
 * What `PATCH /me` answered. `ok` is the venue acknowledging the attempt — `{"message":"user
 * updated!"}` — and is not proof the setting changed: the engine re-reads `/me` afterwards and
 * shows what came back (rule 1). `refused` carries CSFloat's own `code` and `message`, the way
 * `138: your account is currently suspended` arrives on a listing create.
 */
export type CsfloatUpdateResult =
  | { kind: 'ok'; raw: unknown }
  | { kind: 'rejected'; reason: 'invalid-key' | 'forbidden' | 'not-found' | 'refused'; status: number; code: number | null; message: string | null; raw: unknown }
  | { kind: 'throttled'; retryAfterMs: number | null; raw: unknown }
  | { kind: 'unavailable'; cause: 'timeout' | 'transport' | 'malformed' | 'redirected'; raw: unknown };

/**
 * `GET /me/account-standing`: the venue's rating of the account and what it counts against it.
 *
 * Documented from a browser capture under session-cookie auth (csfloat-general-endpoints.md);
 * whether the developer key opens it is unproven, so a refusal here is a fact about the route,
 * never about the key. `standing` is kept as sent — `excellent`, `good`, `poor`, `at_risk`,
 * `banned` are the values the profile client accepts, and a new one must still arrive.
 */
export type CsfloatStanding = {
  standing: string;
  /** The venue's own progress toward the next penalty, `0..1` as the profile draws it. */
  penaltyProgress: number | null;
  recentRestrictions: ReadonlyArray<{ createdAt: string; category: string }>;
  raw: unknown;
};

/** One read's outcome: the value, or one of the ways `/me` fails to answer. */
export type CsfloatReadResult<T> = { kind: 'ok'; value: T } | Exclude<CsfloatMeResult, { kind: 'ok' }>;

export interface CsfloatAccountPort {
  /**
   * Validates a key that is **not stored yet**, for the connect and replace flows. Writes
   * nothing anywhere: an invalid key must leave the previous connection exactly as it was.
   */
  verifyKey(accountId: AccountId, key: string): Promise<CsfloatMeResult>;
  /** Reads `/me` with the credential the engine names. */
  getMe(accountId: AccountId, credential: CsfloatCredentialRef): Promise<CsfloatMeResult>;
  /** Changes the stall settings in `patch`, and nothing else, with the credential the engine names. */
  updateMe(accountId: AccountId, credential: CsfloatCredentialRef, patch: CsfloatMePatch): Promise<CsfloatUpdateResult>;
  /** Reads `/me/account-standing` with the credential the engine names. */
  getStanding(accountId: AccountId, credential: CsfloatCredentialRef): Promise<CsfloatReadResult<CsfloatStanding>>;
}
