import type { AccountIssuer, AccountRecord, IssuerAnswer, TokenSet } from './issuer.js';
import { codeChallenge, randomToken } from './pkce.js';
import { AUTHORIZE_PATH, DESKTOP_CLIENT_ID } from './website.js';

/**
 * A deterministic twin of the website's issuer, for offline tests and journeys.
 *
 * It keeps the rules the real one keeps, because those rules are what the desktop is proved
 * against: a code is single-use and bound to its challenge and redirect; a refresh rotates; the
 * token a rotation spent is accepted again only within 60 seconds of that rotation, and after that
 * seeing it revokes the session; `/me` reads the current tier, not the one the token was minted with.
 */
export type OracleUser = { userId: string; steamId64: string | null; persona: string | null; tier: string; features: string[] };

type Code = { challenge: string; redirectUri: string; userId: string; issuedAt: number; used: boolean };
type Session = {
  id: string;
  userId: string;
  deviceLabel: string;
  createdAt: number;
  current: string;
  previous: string | null;
  rotatedAt: number;
  revoked: boolean;
};

const ACCESS_SECONDS = 600;
const CODE_MS = 60_000;
const PREVIOUS_TOKEN_MS = 60_000;

export class OracleAccountIssuer implements AccountIssuer {
  /** Every call, in order, with the token or code it presented. */
  readonly requests: Array<{ kind: 'exchange' | 'refresh' | 'revoke' | 'me'; presented: string }> = [];
  /** While false, every call answers `unavailable` without being processed. */
  available = true;
  private readonly users = new Map<string, OracleUser>();
  private readonly codes = new Map<string, Code>();
  private readonly sessions = new Map<string, Session>();
  private readonly accessTokens = new Map<string, { sessionId: string; expiresAt: number }>();
  private loseNext = false;
  private held: Promise<void> | null = null;

  constructor(private readonly now: () => number, readonly origin = 'https://cslytics.test') {}

  addUser(user: OracleUser): void {
    this.users.set(user.userId, { ...user, features: [...user.features] });
  }

  /** The tier changed on the website: `/me` reports it at once; tokens already issued do not. */
  setTier(userId: string, tier: string, features: string[]): void {
    const user = this.users.get(userId);
    if (user) this.users.set(userId, { ...user, tier, features: [...features] });
  }

  /** The person removed every connected desktop on the website. */
  revokeAll(): void {
    for (const session of this.sessions.values()) session.revoked = true;
  }

  /** The next refresh is carried out, and its answer lost on the way back. */
  loseNextRefreshResponse(): void {
    this.loseNext = true;
  }

  /** Holds every call until the returned function is called. */
  hold(): () => void {
    let release: () => void = () => undefined;
    this.held = new Promise<void>((resolve) => { release = resolve; });
    return () => { this.held = null; release(); };
  }

  authorizeUrl(request: { redirectUri: string; challenge: string; state: string }): string {
    const url = new URL(AUTHORIZE_PATH, this.origin);
    url.searchParams.set('client_id', DESKTOP_CLIENT_ID);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('code_challenge', request.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  /** What the website sends the browser to when `userId` approves the request in `authorizeUrl`. */
  approve(authorizeUrl: string, userId: string): string {
    const request = new URL(authorizeUrl);
    const redirect = new URL(request.searchParams.get('redirect_uri') ?? '');
    const code = randomToken();
    this.codes.set(code, {
      challenge: request.searchParams.get('code_challenge') ?? '',
      redirectUri: redirect.toString(),
      userId,
      issuedAt: this.now(),
      used: false
    });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', request.searchParams.get('state') ?? '');
    return redirect.toString();
  }

  /** What the website sends the browser to when the person declines. */
  decline(authorizeUrl: string): string {
    const request = new URL(authorizeUrl);
    const redirect = new URL(request.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', request.searchParams.get('state') ?? '');
    return redirect.toString();
  }

  async exchangeCode(request: { code: string; verifier: string; redirectUri: string; deviceLabel: string }): Promise<IssuerAnswer<TokenSet>> {
    await this.wait();
    this.requests.push({ kind: 'exchange', presented: request.code });
    if (!this.available) return { kind: 'unavailable', detail: 'oracle offline' };
    const code = this.codes.get(request.code);
    if (!code || code.used || this.now() - code.issuedAt > CODE_MS) return { kind: 'refused' };
    code.used = true;
    if (code.redirectUri !== request.redirectUri || codeChallenge(request.verifier) !== code.challenge) return { kind: 'refused' };
    const session: Session = {
      id: `session-${this.sessions.size + 1}`,
      userId: code.userId,
      deviceLabel: request.deviceLabel,
      createdAt: this.now(),
      current: randomToken(),
      previous: null,
      rotatedAt: this.now(),
      revoked: false
    };
    this.sessions.set(session.id, session);
    return { kind: 'ok', value: this.mint(session) };
  }

  async refresh(refreshToken: string): Promise<IssuerAnswer<TokenSet>> {
    await this.wait();
    this.requests.push({ kind: 'refresh', presented: refreshToken });
    if (!this.available) return { kind: 'unavailable', detail: 'oracle offline' };
    for (const session of this.sessions.values()) {
      if (session.revoked) continue;
      const isCurrent = session.current === refreshToken;
      const isRetry = session.previous === refreshToken && this.now() - session.rotatedAt <= PREVIOUS_TOKEN_MS;
      if (!isCurrent && !isRetry) {
        if (session.previous === refreshToken) session.revoked = true;
        continue;
      }
      session.previous = refreshToken;
      session.current = randomToken();
      session.rotatedAt = this.now();
      const tokens = this.mint(session);
      if (this.loseNext) {
        this.loseNext = false;
        return { kind: 'unavailable', detail: 'response lost' };
      }
      return { kind: 'ok', value: tokens };
    }
    return { kind: 'refused' };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.requests.push({ kind: 'revoke', presented: refreshToken });
    if (!this.available) return;
    for (const session of this.sessions.values()) {
      if (session.current === refreshToken || session.previous === refreshToken) session.revoked = true;
    }
  }

  async me(accessToken: string): Promise<IssuerAnswer<AccountRecord>> {
    await this.wait();
    this.requests.push({ kind: 'me', presented: accessToken });
    if (!this.available) return { kind: 'unavailable', detail: 'oracle offline' };
    const access = this.accessTokens.get(accessToken);
    const session = access ? this.sessions.get(access.sessionId) : undefined;
    const user = session ? this.users.get(session.userId) : undefined;
    if (!access || !session || !user || session.revoked || access.expiresAt <= this.now()) return { kind: 'refused' };
    return {
      kind: 'ok',
      value: {
        userId: user.userId,
        steamId64: user.steamId64,
        persona: user.persona,
        tier: user.tier,
        features: [...user.features],
        featureMapVersion: 1,
        session: { id: session.id, deviceLabel: session.deviceLabel, createdAt: new Date(session.createdAt).toISOString() }
      }
    };
  }

  /** Whether the session a refresh token belongs to is still live here. */
  isLive(refreshToken: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.current === refreshToken) return !session.revoked;
    }
    return false;
  }

  private mint(session: Session): TokenSet {
    const accessToken = randomToken();
    this.accessTokens.set(accessToken, { sessionId: session.id, expiresAt: this.now() + ACCESS_SECONDS * 1000 });
    return { accessToken, refreshToken: session.current, expiresInSeconds: ACCESS_SECONDS };
  }

  private async wait(): Promise<void> {
    if (this.held) await this.held;
  }
}
