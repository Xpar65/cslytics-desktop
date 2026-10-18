import { AUTHORIZE_PATH, DESKTOP_CLIENT_ID } from './website.js';

/** What the token endpoint hands back. The access token is opaque here: only the issuer reads it. */
export type TokenSet = { accessToken: string; refreshToken: string; expiresInSeconds: number };

/** The account as `GET /api/desktop/me` reports it, read from the website's database at that moment. */
export type AccountRecord = {
  userId: string;
  steamId64: string | null;
  persona: string | null;
  tier: string;
  features: string[];
  featureMapVersion: number;
  session: { id: string; deviceLabel: string; createdAt: string };
};

/**
 * Three answers, kept apart because only one of them may sign a person out.
 *
 * `refused` is the issuer saying this grant or token is dead: `invalid_grant` from the token
 * endpoint, or 401 from `/me`. `unavailable` is everything else — no connection, a timeout, a 429,
 * a 5xx, a redirect, a body that does not parse, or an error that says the request was wrong rather
 * than the grant. An outage, or a fault on either side, must never cost a person their sign-in.
 */
export type IssuerAnswer<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused' }
  | { kind: 'unavailable'; detail: string };

export interface AccountIssuer {
  readonly origin: string;
  authorizeUrl(request: { redirectUri: string; challenge: string; state: string }): string;
  exchangeCode(request: { code: string; verifier: string; redirectUri: string; deviceLabel: string }): Promise<IssuerAnswer<TokenSet>>;
  refresh(refreshToken: string): Promise<IssuerAnswer<TokenSet>>;
  /** Best effort: the local sign-out has already happened, and nothing waits on this. */
  revoke(refreshToken: string): Promise<void>;
  me(accessToken: string): Promise<IssuerAnswer<AccountRecord>>;
}

export type FetchInit = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  signal: AbortSignal;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<{ status: number; json(): Promise<unknown> }>;

const LIMITS = { token: 4096, text: 256, features: 256 };

export class HttpAccountIssuer implements AccountIssuer {
  constructor(
    readonly origin: string,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = 15_000
  ) {}

  authorizeUrl(request: { redirectUri: string; challenge: string; state: string }): string {
    const url = new URL(AUTHORIZE_PATH, this.origin);
    url.searchParams.set('client_id', DESKTOP_CLIENT_ID);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('code_challenge', request.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  exchangeCode(request: { code: string; verifier: string; redirectUri: string; deviceLabel: string }): Promise<IssuerAnswer<TokenSet>> {
    return this.token({
      grant_type: 'authorization_code',
      code: request.code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
      client_id: DESKTOP_CLIENT_ID,
      device_label: request.deviceLabel
    });
  }

  refresh(refreshToken: string): Promise<IssuerAnswer<TokenSet>> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: DESKTOP_CLIENT_ID });
  }

  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.fetchImpl(new URL('/api/desktop/revoke', this.origin).toString(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, client_id: DESKTOP_CLIENT_ID }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000))
      });
    } catch {
      // The device stays listed on the website until its idle expiry; the person can revoke it there.
    }
  }

  async me(accessToken: string): Promise<IssuerAnswer<AccountRecord>> {
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchImpl(new URL('/api/desktop/me', this.origin).toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      return unavailable(error);
    }
    if (response.status === 401) return { kind: 'refused' };
    if (response.status !== 200) return { kind: 'unavailable', detail: `HTTP ${response.status}` };
    const record = parseAccount(await body(response));
    return record ? { kind: 'ok', value: record } : { kind: 'unavailable', detail: 'malformed account' };
  }

  private async token(form: Record<string, string>): Promise<IssuerAnswer<TokenSet>> {
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchImpl(new URL('/api/desktop/token', this.origin).toString(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      return unavailable(error);
    }
    const parsed = await body(response);
    if (response.status === 200) {
      const tokens = parseTokens(parsed);
      return tokens ? { kind: 'ok', value: tokens } : { kind: 'unavailable', detail: 'malformed token response' };
    }
    if (response.status === 400 && isRecord(parsed) && parsed['error'] === 'invalid_grant') return { kind: 'refused' };
    const error = isRecord(parsed) && typeof parsed['error'] === 'string' ? ` ${parsed['error'].slice(0, 40)}` : '';
    return { kind: 'unavailable', detail: `HTTP ${response.status}${error}` };
  }
}

async function body(response: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function unavailable(error: unknown): { kind: 'unavailable'; detail: string } {
  const name = error instanceof Error ? error.name : 'Error';
  return { kind: 'unavailable', detail: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'no connection' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= LIMITS.text ? value : undefined;
}

export function parseTokens(value: unknown): TokenSet | null {
  if (!isRecord(value)) return null;
  const { access_token: access, refresh_token: refresh, token_type: type, expires_in: expires } = value;
  if (!boundedString(access, LIMITS.token) || !boundedString(refresh, LIMITS.token)) return null;
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer') return null;
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) return null;
  return { accessToken: access, refreshToken: refresh, expiresInSeconds: expires };
}

export function parseAccount(value: unknown): AccountRecord | null {
  if (!isRecord(value) || !isRecord(value['session'])) return null;
  const session = value['session'];
  const steamId64 = optionalText(value['steamId64']);
  const persona = optionalText(value['persona']);
  const features = value['features'];
  if (!boundedString(value['userId'], LIMITS.text) || !boundedString(value['tier'], LIMITS.text)) return null;
  if (steamId64 === undefined || persona === undefined) return null;
  if (!Array.isArray(features) || features.length > LIMITS.features || !features.every((key) => boundedString(key, LIMITS.text))) return null;
  if (typeof value['featureMapVersion'] !== 'number' || !Number.isInteger(value['featureMapVersion'])) return null;
  if (!boundedString(session['id'], LIMITS.text) || typeof session['deviceLabel'] !== 'string' || !boundedString(session['createdAt'], LIMITS.text)) return null;
  return {
    userId: value['userId'],
    steamId64,
    persona,
    tier: value['tier'],
    features: features as string[],
    featureMapVersion: value['featureMapVersion'],
    session: { id: session['id'], deviceLabel: session['deviceLabel'].slice(0, LIMITS.text), createdAt: session['createdAt'] }
  };
}
