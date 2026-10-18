import type { CredentialVault } from '@cslytics/ports';
import { AccountFile, type StoredAccount } from './account-file.js';
import type { AccountIssuer, AccountRecord, IssuerAnswer, TokenSet } from './issuer.js';
import { openLoopbackListener, type CallbackListener, type CallbackOutcome, type OpenListener } from './loopback.js';
import { codeChallenge, randomToken } from './pkce.js';

/** The vault key of the refresh token. One desktop profile belongs to one CSlytics person. */
export const REFRESH_TOKEN_KEY = 'cslytics-refresh-token';

/** How long a stored sign-in keeps its features while the website does not answer. */
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60_000;
/** How long the browser has to come back before the attempt ends. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed rather than sent. */
const ACCESS_MARGIN_MS = 60_000;

export type CslyticsAccountState = 'signedOut' | 'signingIn' | 'signedIn' | 'unconfirmed';

/** Why the last sign-in attempt did not finish. The window turns each into words. */
export type SignInProblem = 'declined' | 'timedOut' | 'failed' | 'unavailable' | 'storage' | 'browser';

export type CslyticsStatus = {
  /**
   * `unconfirmed`: a sign-in is stored and the website has not confirmed it since this desktop
   * started, either because it has not been asked yet or because it did not answer.
   */
  state: CslyticsAccountState;
  account: { userId: string; persona: string | null; steamId64: string | null } | null;
  tier: string | null;
  /** Empty unless signed in, or unconfirmed inside the offline grace. */
  features: readonly string[];
  verifiedAt: string | null;
  graceUntil: string | null;
  /** The website refused the stored sign-in, and when. Cleared by the next sign-in or sign-out. */
  ended: { persona: string | null; at: string } | null;
  problem: SignInProblem | null;
};

export type CslyticsAccountOptions = {
  issuer: AccountIssuer;
  vault: CredentialVault;
  file: AccountFile;
  /** Opens the authorize page in the person's own browser. */
  openBrowser: (url: string) => Promise<void>;
  deviceLabel: string;
  now?: () => number;
  listen?: OpenListener;
  /** Called after every change of status; main announces it to the window. */
  onChange?: () => void;
};

type Attempt = { listener: CallbackListener; verifier: string; url: string; generation: number };
type AccessAnswer = { kind: 'ok'; token: string; fresh: boolean } | { kind: 'refused' } | { kind: 'unavailable' } | { kind: 'stale' };

/**
 * The CSlytics account on this desktop, held by main and nowhere else.
 *
 * Signing in is optional and changes nothing the app does with Steam: the engine never sees this
 * class, and the window opens the same either way. What it holds is the refresh token in the
 * vault, the account as last verified in `cslytics-account.json`, and the access token in memory.
 * Only the website refusing the stored sign-in signs a person out; an outage leaves everything as
 * it was and reports `unconfirmed`.
 *
 * Every asynchronous step carries the generation it started in. Signing out or starting a new
 * sign-in moves the generation on, and an answer that arrives for an older one writes nothing.
 */
export class CslyticsAccount {
  protected stored: StoredAccount | null = null;
  protected refreshToken: string | null = null;
  protected access: { token: string; expiresAt: number } | null = null;
  protected confirmed = false;
  protected generation = 0;
  private attempt: Attempt | null = null;
  private ended: CslyticsStatus['ended'] = null;
  private problem: SignInProblem | null = null;
  private refreshing: Promise<AccessAnswer> | null = null;
  private verifying: Promise<void> | null = null;
  protected readonly now: () => number;
  private readonly listen: OpenListener;

  constructor(protected readonly options: CslyticsAccountOptions) {
    this.now = options.now ?? Date.now;
    this.listen = options.listen ?? openLoopbackListener;
  }

  /**
   * Reads what a previous run left. The vault is written before the file on sign-in and deleted
   * before it on sign-out, so a file without a credential is the remains of an interrupted
   * sign-out and is removed; a credential without a file is an interrupted sign-in, which the
   * next verification completes.
   */
  async start(): Promise<void> {
    await this.recover();
    this.changed();
  }

  protected async recover(): Promise<void> {
    this.stored = this.options.file.read();
    let token: string | null = null;
    try {
      token = await this.options.vault.get(REFRESH_TOKEN_KEY);
    } catch {
      token = null;
    }
    if (token === null) {
      if (this.stored !== null) this.options.file.remove();
      this.stored = null;
      return;
    }
    this.refreshToken = token;
  }

  status(): CslyticsStatus {
    const state = this.state();
    const stored = state === 'signedIn' || state === 'unconfirmed' ? this.stored : null;
    const graceUntil = stored ? Date.parse(stored.verifiedAt) + OFFLINE_GRACE_MS : null;
    const features = state === 'signedIn' && stored ? stored.features
      : state === 'unconfirmed' && stored && graceUntil !== null && this.now() < graceUntil ? stored.features
        : [];
    return {
      state,
      account: stored ? { userId: stored.userId, persona: stored.persona, steamId64: stored.steamId64 } : null,
      tier: stored ? stored.tier : null,
      features: [...features],
      verifiedAt: stored ? stored.verifiedAt : null,
      graceUntil: state === 'unconfirmed' && graceUntil !== null ? new Date(graceUntil).toISOString() : null,
      ended: this.ended,
      problem: this.problem
    };
  }

  /**
   * Starts a sign-in in the person's browser, or opens the browser again at the same page when an
   * attempt is already waiting. Does nothing while signed in: switching person is sign out first.
   */
  async signIn(): Promise<CslyticsStatus> {
    if (this.attempt) {
      await this.open(this.attempt);
      return this.status();
    }
    if (this.refreshToken !== null) return this.status();
    this.problem = null;
    this.ended = null;
    const verifier = randomToken();
    const state = randomToken();
    let listener: CallbackListener;
    try {
      listener = await this.listen(state, SIGN_IN_TIMEOUT_MS);
    } catch {
      this.problem = 'failed';
      this.changed();
      return this.status();
    }
    const url = this.options.issuer.authorizeUrl({ redirectUri: listener.redirectUri, challenge: codeChallenge(verifier), state });
    const attempt: Attempt = { listener, verifier, url, generation: ++this.generation };
    this.attempt = attempt;
    void listener.outcome.then((outcome) => this.finish(attempt, outcome)).catch(() => undefined);
    await this.open(attempt);
    this.changed();
    return this.status();
  }

  cancelSignIn(): CslyticsStatus {
    const attempt = this.attempt;
    if (attempt) {
      this.attempt = null;
      this.generation += 1;
      attempt.listener.close();
      this.changed();
    }
    return this.status();
  }

  /** Asks the website who is signed in, now. One verification at a time; a second call joins it. */
  async verify(): Promise<CslyticsStatus> {
    if (this.refreshToken === null) return this.status();
    this.verifying ??= this.confirm(this.generation).finally(() => { this.verifying = null; });
    await this.verifying;
    return this.status();
  }

  /**
   * Signs out here first, then tells the website. The local sign-out cannot fail on the network,
   * and a revoke that never arrives leaves a device the person can still remove on the website.
   */
  async signOut(): Promise<CslyticsStatus> {
    if (this.attempt) this.cancelSignIn();
    const token = this.refreshToken;
    await this.forget();
    this.ended = null;
    this.problem = null;
    this.changed();
    if (token !== null) void this.options.issuer.revoke(token).catch(() => undefined);
    return this.status();
  }

  /**
   * Whether an answer that started in `generation` may still be written. Signing out, cancelling
   * and starting again all move the generation on, so a late answer for a previous sign-in, or a
   * previous person, is dropped on arrival.
   */
  protected isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** Only the issuer's refusal ends a sign-in. Everything else is an outage, and changes nothing. */
  protected signsOut(answer: { kind: string }): boolean {
    return answer.kind === 'refused';
  }

  /** What `cslytics-account.json` holds after a verification. Never a token. */
  protected recordFor(record: AccountRecord): StoredAccount {
    return {
      format: 1,
      userId: record.userId,
      steamId64: record.steamId64,
      persona: record.persona,
      tier: record.tier,
      features: record.features,
      featureMapVersion: record.featureMapVersion,
      sessionId: record.session.id,
      verifiedAt: new Date(this.now()).toISOString()
    };
  }

  /**
   * A rotation spends the token that was presented, so the new one replaces it in memory before
   * anything else can read it, and then in the vault. Presenting the spent token again would be
   * replay, and the website revokes the whole session for it.
   */
  protected async adoptRotation(tokens: TokenSet): Promise<void> {
    this.refreshToken = tokens.refreshToken;
    this.access = { token: tokens.accessToken, expiresAt: this.now() + tokens.expiresInSeconds * 1000 };
    await this.options.vault.set(REFRESH_TOKEN_KEY, tokens.refreshToken);
  }

  private state(): CslyticsAccountState {
    if (this.attempt) return 'signingIn';
    if (this.refreshToken === null) return 'signedOut';
    return this.confirmed ? 'signedIn' : 'unconfirmed';
  }

  private async open(attempt: Attempt): Promise<void> {
    try {
      await this.options.openBrowser(attempt.url);
    } catch {
      if (this.attempt === attempt) {
        this.attempt = null;
        this.generation += 1;
        attempt.listener.close();
      }
      this.problem = 'browser';
    }
  }

  private async finish(attempt: Attempt, outcome: CallbackOutcome): Promise<void> {
    if (this.attempt !== attempt) return;
    if (outcome.kind !== 'code') {
      this.attempt = null;
      this.problem = outcome.kind === 'cancelled' ? null : outcome.kind === 'declined' ? 'declined' : outcome.kind === 'timedOut' ? 'timedOut' : 'failed';
      this.changed();
      return;
    }
    const answer = await this.options.issuer.exchangeCode({
      code: outcome.code,
      verifier: attempt.verifier,
      redirectUri: attempt.listener.redirectUri,
      deviceLabel: this.options.deviceLabel
    });
    if (this.attempt !== attempt || !this.isCurrent(attempt.generation)) return;
    if (answer.kind !== 'ok') {
      this.attempt = null;
      this.problem = answer.kind === 'refused' ? 'failed' : 'unavailable';
      this.changed();
      return;
    }
    try {
      await this.options.vault.set(REFRESH_TOKEN_KEY, answer.value.refreshToken);
    } catch {
      this.attempt = null;
      this.problem = 'storage';
      this.changed();
      return;
    }
    this.refreshToken = answer.value.refreshToken;
    this.access = { token: answer.value.accessToken, expiresAt: this.now() + answer.value.expiresInSeconds * 1000 };
    this.confirmed = false;
    this.attempt = null;
    await this.confirm(this.generation);
  }

  /** Refreshes when needed, reads `/me`, and records what it says. */
  private async confirm(generation: number): Promise<void> {
    try {
      let access = await this.accessToken(generation);
      if (access.kind === 'stale' || !this.isCurrent(generation)) return;
      if (access.kind !== 'ok') {
        if (this.signsOut(access)) await this.end(); else this.unconfirmed();
        return;
      }
      let answer = await this.options.issuer.me(access.token);
      if (!this.isCurrent(generation)) return;
      if (answer.kind === 'refused' && !access.fresh) {
        // A cached token can be refused for being revoked with its session, or only for age.
        // One refresh tells the two apart.
        this.access = null;
        access = await this.accessToken(generation);
        if (access.kind === 'stale' || !this.isCurrent(generation)) return;
        if (access.kind !== 'ok') {
          if (this.signsOut(access)) await this.end(); else this.unconfirmed();
          return;
        }
        answer = await this.options.issuer.me(access.token);
        if (!this.isCurrent(generation)) return;
      }
      if (answer.kind !== 'ok') {
        if (this.signsOut(answer)) await this.end(); else this.unconfirmed();
        return;
      }
      const stored = this.recordFor(answer.value);
      this.options.file.write(stored);
      this.stored = stored;
      this.confirmed = true;
      this.ended = null;
      this.problem = null;
      this.changed();
    } catch {
      // A vault or disk fault is not the website's answer: keep the sign-in and say it is unconfirmed.
      if (this.isCurrent(generation)) this.unconfirmed();
    }
  }

  private async accessToken(generation: number): Promise<AccessAnswer> {
    if (this.access && this.access.expiresAt - this.now() > ACCESS_MARGIN_MS) {
      return { kind: 'ok', token: this.access.token, fresh: false };
    }
    this.refreshing ??= this.rotate(generation).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async rotate(generation: number): Promise<AccessAnswer> {
    const presented = this.refreshToken;
    if (presented === null) return { kind: 'refused' };
    const answer: IssuerAnswer<TokenSet> = await this.options.issuer.refresh(presented);
    if (!this.isCurrent(generation)) return { kind: 'stale' };
    if (answer.kind === 'refused') return { kind: 'refused' };
    if (answer.kind === 'unavailable') return { kind: 'unavailable' };
    await this.adoptRotation(answer.value);
    return { kind: 'ok', token: answer.value.accessToken, fresh: true };
  }

  private unconfirmed(): void {
    this.confirmed = false;
    this.changed();
  }

  /** The website refused the stored sign-in: forget it, and say whose it was. */
  private async end(): Promise<void> {
    const persona = this.stored?.persona ?? null;
    await this.forget();
    this.ended = { persona, at: new Date(this.now()).toISOString() };
    this.changed();
  }

  /** Vault first, then the file: the order recovery relies on. */
  private async forget(): Promise<void> {
    this.generation += 1;
    this.refreshToken = null;
    this.access = null;
    this.confirmed = false;
    try {
      await this.options.vault.delete(REFRESH_TOKEN_KEY);
    } catch {
      // The credential outlives this run; the next start finds it without a file and asks again.
    }
    this.options.file.remove();
    this.stored = null;
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
