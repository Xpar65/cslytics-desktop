import type {
  AccountId,
  CredentialVault,
  CsfloatAccountPort,
  CsfloatCredentialRef,
  CsfloatMe,
  CsfloatMePatch,
  CsfloatMeResult,
  CsfloatReadResult,
  CsfloatStanding,
  CsfloatUpdateResult
} from '@cslytics/ports';
import { readResult, venueRefusal } from './outcome.js';
import { CsfloatTransport, requireKey, type CsfloatResponse, type CsfloatTransportResult } from './transport.js';

/**
 * `/me`: who this key speaks for, what it is allowed to do, and what it is owed.
 *
 * The classification below is the load-bearing part. `401` is the venue saying the key is not
 * usable; `429` and a timeout say nothing about the key at all, and the engine must not let
 * either end a working connection (CSF-02, CSF-21). A `200` carrying an unparsable body is
 * `malformed`, not an empty account: a suspicious success is the shape absence usually arrives in.
 *
 * Readiness and restriction fields are copied through untouched into `flags`. This adapter has no
 * opinion on what CSFloat calls them, which is what lets a field it has never seen still reach
 * the engine rather than being dropped on the floor.
 */
const IDENTITY_KEYS = ['steam_id', 'steamid', 'steam_id64', 'steamid64', 'id'] as const;

/**
 * Readiness and restriction fields copied through to the engine, from the live `/me` captured
 * 2026-09-11 (fixtures/csfloat/INDEX.md). Allowlisted rather than copied wholesale, because
 * `flags` lands in `csfloat_account_status.flags_json` and SQLite is forever.
 *
 * `fee` and `withdraw_fee` are rates, not amounts, and they are what a proceeds estimate will
 * need; `has_api_key`, `has_2fa` and `know_your_customer` are the three readiness signals CSFloat
 * actually publishes.
 *
 * `suspended_until` is the one restriction field CSFloat has been seen to send
 * (`fixtures/csfloat/contracts/me-suspended.json`): `/me` stays HTTP 200, the key is added while
 * the account is suspended and kept, with its past timestamp, once the suspension ends. Before it
 * was listed here a suspended account read as fully connected and ready, and a listing create was
 * admitted straight into CSFloat's `code 138` refusal.
 */
const FLAG_KEYS = [
  'has_api_key', 'has_2fa', 'know_your_customer', 'fee', 'withdraw_fee', 'flags',
  'stall_public', 'away', 'online', 'obfuscated_id', 'extension_setup_at',
  'preferences', 'statistics', 'subscriptions', 'notification_topic_opt_out',
  'payment_accounts', 'stripe_connect', 'trade_ban', 'trade_bans', 'restrictions', 'ban_reason', 'banned',
  'suspended_until'
] as const;

/**
 * Fields that must never leave this adapter, whatever else changes.
 *
 * `/me` carries the user's email address and their Steam trade token. Neither is readiness, both
 * are durable if they reach `flags_json`, and a trade token is a capability. The allowlist above
 * already excludes them; this is the belt that makes adding one back a deliberate act, asserted
 * by `tests/unit/csfloat-account-adapter.test.ts`.
 */
export const NEVER_COPIED = ['email', 'trade_token', 'avatar', 'api_key', 'apikey'] as const;

export class CsfloatAccountAdapter implements CsfloatAccountPort {
  constructor(
    private readonly vault: CredentialVault,
    private readonly transport: CsfloatTransport = new CsfloatTransport()
  ) {}

  async verifyKey(accountId: AccountId, key: string): Promise<CsfloatMeResult> {
    if (!key.trim()) return { kind: 'rejected', reason: 'invalid-key', status: 0, raw: null };
    return classify(await this.transport.send({ accountId, method: 'GET', path: '/me', key }));
  }

  async getMe(_accountId: AccountId, credential: CsfloatCredentialRef): Promise<CsfloatMeResult> {
    const key = await requireKey(this.vault, credential);
    return classify(await this.transport.send({ method: 'GET', path: '/me', key }));
  }

  /**
   * `PATCH /me` with only the fields named. The website sends `{away: false}` and
   * `{stall_public: true}` as separate one-field bodies (captured 2026-09-22), and this
   * sends nothing it was not asked to: a body that echoed the whole profile back would be a
   * write of every field, including ones this app has no business setting.
   */
  async updateMe(accountId: AccountId, credential: CsfloatCredentialRef, patch: CsfloatMePatch): Promise<CsfloatUpdateResult> {
    const key = await requireKey(this.vault, credential);
    const body: Record<string, boolean> = {};
    if (patch.away !== undefined) body['away'] = patch.away;
    if (patch.stallPublic !== undefined) body['stall_public'] = patch.stallPublic;
    if (Object.keys(body).length === 0) return { kind: 'ok', raw: null };
    return classifyUpdate(await this.transport.send({ accountId, method: 'PATCH', path: '/me', key, body }));
  }

  async getStanding(accountId: AccountId, credential: CsfloatCredentialRef): Promise<CsfloatReadResult<CsfloatStanding>> {
    const key = await requireKey(this.vault, credential);
    return readResult(await this.transport.send({ accountId, method: 'GET', path: '/me/account-standing', key }), readStanding);
  }
}

/**
 * `/me/account-standing` as documented from the profile page's own call
 * (`fixtures/csfloat/contracts/me-account-standing.json`). `standing` is required and kept as
 * sent; a restriction needs both its time and its category to be worth keeping, and one without
 * either is dropped rather than invented. Nothing in this body is a secret, so `raw` is the body.
 */
export function readStanding(body: unknown): CsfloatStanding | null {
  if (!isRecord(body)) return null;
  const standing = text(body.standing);
  if (!standing) return null;
  const progress = body.penalty_progress;
  const recentRestrictions = Array.isArray(body.recent_restrictions)
    ? body.recent_restrictions.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return [];
      const createdAt = text(entry.created_at), category = text(entry.category);
      return createdAt && category && Number.isFinite(Date.parse(createdAt))
        ? [{ createdAt: new Date(createdAt).toISOString(), category }]
        : [];
    })
    : [];
  return {
    standing,
    penaltyProgress: typeof progress === 'number' && Number.isFinite(progress) ? progress : null,
    recentRestrictions,
    raw: body
  };
}

/**
 * The same classification as a read, plus the one case a write adds: a 4xx that is the venue
 * refusing *this request* rather than the key. Its `code` and `message` are kept because they are
 * the reason a person will read ("your account is currently suspended"), and nothing else in the
 * body is.
 */
export function classifyUpdate(result: CsfloatTransportResult): CsfloatUpdateResult {
  if (result.kind === 'failure') return { kind: 'unavailable', cause: result.cause, raw: result.detail };
  const refusal = venueRefusal(result.body);
  if (result.status === 401) return { kind: 'rejected', reason: 'invalid-key', status: 401, ...refusal, raw: null };
  if (result.status === 403) return { kind: 'rejected', reason: 'forbidden', status: 403, ...refusal, raw: null };
  if (result.status === 404) return { kind: 'rejected', reason: 'not-found', status: 404, ...refusal, raw: null };
  if (result.status === 429) return { kind: 'throttled', retryAfterMs: retryDelay(result), raw: null };
  if ([400, 409, 422].includes(result.status)) return { kind: 'rejected', reason: 'refused', status: result.status, ...refusal, raw: null };
  if (!result.ok) return { kind: 'unavailable', cause: 'transport', raw: { status: result.status } };
  return { kind: 'ok', raw: { status: result.status, message: refusal.message } };
}

export function classify(result: CsfloatTransportResult): CsfloatMeResult {
  if (result.kind === 'failure') return { kind: 'unavailable', cause: result.cause, raw: result.detail };
  if (result.status === 401) return { kind: 'rejected', reason: 'invalid-key', status: 401, raw: result.body ?? result.text };
  if (result.status === 403) return { kind: 'rejected', reason: 'forbidden', status: 403, raw: result.body ?? result.text };
  if (result.status === 404) return { kind: 'rejected', reason: 'not-found', status: 404, raw: result.body ?? result.text };
  if (result.status === 429) return { kind: 'throttled', retryAfterMs: retryDelay(result), raw: result.body ?? result.text };
  if (!result.ok) return { kind: 'unavailable', cause: 'transport', raw: { status: result.status, body: result.body ?? result.text } };
  const me = readMe(result.body);
  return me ? { kind: 'ok', me } : { kind: 'unavailable', cause: 'malformed', raw: result.body ?? truncate(result.text) };
}

/**
 * A `/me` is only usable if it names a SteamID64, because the identity comparison is what makes
 * the key attachable at all. Everything else may be missing and stays null or absent.
 */
export function readMe(body: unknown): CsfloatMe | null {
  if (!isRecord(body)) return null;
  const user = isRecord(body.user) ? body.user : body;
  const steamId64 = steamId(user) ?? steamId(body);
  if (!steamId64) return null;
  const flags: Record<string, unknown> = {};
  for (const key of FLAG_KEYS) {
    if ((NEVER_COPIED as readonly string[]).includes(key)) continue;
    if (key in user) flags[key] = user[key];
    else if (key in body) flags[key] = body[key];
  }
  // Counts the account owner acts on, and the only top-level fields worth carrying.
  for (const key of ['pending_offers', 'actionable_trades'] as const) {
    if (key in body) flags[key] = body[key];
  }
  const me: CsfloatMe = {
    steamId64,
    availableCents: cents(user.balance) ?? cents(body.balance),
    pendingCents: cents(user.pending_balance) ?? cents(body.pending_balance),
    flags,
    // The body minus the fields that must never be stored or logged (`NEVER_COPIED`).
    raw: scrub(body)
  };
  const userId = text(user.obfuscated_id) ?? text(user.user_id);
  if (userId) me.userId = userId;
  const username = text(user.username) ?? text(user.steam_name) ?? text(user.name);
  if (username) me.username = username;
  return me;
}

/** A SteamID64 is 17 digits and arrives as a string; a number would already have lost precision. */
function steamId(source: Record<string, unknown>): string | undefined {
  for (const key of IDENTITY_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && /^\d{17}$/.test(value)) return value;
  }
  return undefined;
}

/** Money must be an integer count of cents. A float, a string or a negative is not money here. */
function cents(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryDelay(response: CsfloatResponse): number | null {
  if (response.rate.retryAfterMs !== null) return response.rate.retryAfterMs;
  if (response.rate.resetAtMs !== null) return Math.max(0, response.rate.resetAtMs - Date.now());
  return null;
}

/** A WAF or error page can be megabytes. Keep enough to recognise it and no more. */
function truncate(text: string): string {
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
}

/** Drops `NEVER_COPIED` fields anywhere in a `/me` body, at any depth. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(NEVER_COPIED as readonly string[]).includes(key))
    .map(([key, item]) => [key, scrub(item)]));
}
