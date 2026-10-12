import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { engine, listAccountsWhenReady, ResponseDeadlineError, type SavedAccount } from '../../lib/engine.js';
import {
  classifyFailure,
  deadlineFailure,
  describeGuardMethods,
  describeQr,
  guardCodeIssue,
  isGuardCodeSendable,
  normaliseGuardCode,
  secondsUntilCodeRotation,
  stepLabel,
  waitingDetail,
  type Failure,
  type LoginStep,
  type QrState
} from './login-machine.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';
import { Button, Field, Panel, Pill } from '../../components/ui.jsx';

/**
 * Sign-in.
 *
 * Shown three ways, all of them over the shell rather than instead of it. It adds an account
 * the app has never seen; it re-signs one it knows, when Steam has stopped accepting the saved
 * refresh token and wants a password and a Guard code again; and `onCancel` makes every one of
 * those reversible — a user who opened it by mistake must be able to get back to the window
 * without signing anything out.
 *
 * `account` is what tells the second case from the first. It pins the Steam username, because
 * that screen was opened from one account's card and signing a *different* account in from it
 * would answer a question nobody asked.
 *
 * Two paths, both secret-free from the app's point of view:
 *
 * - QR: approve in the Steam mobile app.
 * - Credentials: username and password, then a Guard code the user reads off their phone.
 *
 * Once either completes, Steam issues a refresh token which goes to the OS credential vault,
 * and later launches reconnect without any of this.
 *
 * Everything a login can be — running, waiting on a phone, rejected, expired, or simply
 * unanswered — is reported in this window. The wording of each state lives in
 * `../lib/login-machine.ts`, which is where it is tested.
 */

type Mode = 'qr' | 'credentials';

/** What the user is looking at. Orthogonal to `pending`, which is what the app is doing. */
type Stage =
  | { kind: 'form' }
  | { kind: 'guard'; sessionHandle: string; methods: string[] }
  | { kind: 'qr'; sessionHandle: string; dataUrl: string; expiresAtMs: number; state: QrState; challengeUrl: string };

type Pending = { step: LoginStep; startedAt: number };

/** Focus after React has re-rendered; a field is still disabled while its attempt is pending. */
function focusSoon(input: React.RefObject<HTMLInputElement | null>): void {
  setTimeout(() => input.current?.focus(), 0);
}

export function SignIn({
  onSignedIn,
  onCancel,
  connectedAccountIds = [],
  title,
  account
}: {
  onSignedIn: (session: { accountId: string; accountName: string; steamId64: string }) => void;
  /** Present only when there is somewhere to go back to. */
  onCancel?: (() => void) | undefined;
  /** Accounts this window already holds a session for. Listed, but not offered again. */
  connectedAccountIds?: readonly string[] | undefined;
  /** The heading. Which of the three screens this is, in the user's words. */
  title?: string | undefined;
  /**
   * Set when signing in one account the app already knows. Pins the username and drops the
   * saved-account list. `hasSavedSession` separates "Steam stopped accepting the token" from
   * "there has never been one" — different facts, and only one of them blames Steam.
   */
  account?: { accountId: string; accountName: string; hasSavedSession: boolean } | undefined;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('credentials');
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [username, setUsername] = useState(account?.accountName ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);

  const codeInput = useRef<HTMLInputElement | null>(null);
  const usernameInput = useRef<HTMLInputElement | null>(null);
  /**
   * Electron IPC cannot be cancelled, so a call the user walked away from still resolves.
   * Every attempt carries a number; a reply whose number is stale is dropped rather than
   * being allowed to move a window that has since moved on.
   */
  const attempt = useRef(0);

  const busy = pending !== null;

  useEffect(() => {
    // Nothing to choose between when the screen was opened from one account's card.
    if (account) return undefined;
    let cancelled = false;
    void listAccountsWhenReady(40, 250, () => !cancelled).then((accounts) => {
      if (!cancelled) setSavedAccounts(accounts.filter((row) => row.hasSession));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [account]);

  // One timer drives every elapsed count and countdown on this screen.
  const ticking = busy || stage.kind === 'qr' || stage.kind === 'guard';
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [ticking]);

  /** Abandons whatever is in flight and tells Steam to stop polling for it. */
  const abandon = useCallback((handle?: string) => {
    attempt.current += 1;
    setPending(null);
    if (handle) void engine.cancelLogin(handle).catch(() => undefined);
  }, []);

  /**
   * Runs one step of a login, keeping exactly one story on screen: what is happening, or why
   * it stopped. `step` is what the user is told; `resume` decides where a failure leaves them.
   */
  const run = useCallback(async (step: LoginStep, work: () => Promise<void>): Promise<void> => {
    const ticket = ++attempt.current;
    setFailure(null);
    setPending({ step, startedAt: Date.now() });
    try {
      await work();
    } catch (error) {
      if (attempt.current !== ticket) return;
      const classified = error instanceof ResponseDeadlineError ? deadlineFailure(step) : classifyFailure(error);
      setFailure(classified);
      if (classified.resume === 'guard') {
        setCode('');
        focusSoon(codeInput);
      } else if (classified.resume === 'credentials') {
        setPassword('');
        setStage({ kind: 'form' });
        focusSoon(usernameInput);
      } else {
        setStage({ kind: 'form' });
      }
    } finally {
      if (attempt.current === ticket) setPending(null);
    }
  }, []);

  const submitGuard = useCallback(async (sessionHandle: string, raw: string): Promise<void> => {
    await run('submitting-guard', async () => {
      const authed = await engine.submitGuardCode(sessionHandle, normaliseGuardCode(raw));
      setCode('');
      setPassword('');
      onSignedIn(authed);
    });
  }, [run, onSignedIn]);

  const signInWithPassword = useCallback(async (): Promise<void> => {
    // Captured before the await: a code typed up front is spent on the prompt it belongs to.
    const upfront = code;
    await run('starting-credentials', async () => {
      const result = await engine.beginCredentialLogin(username.trim(), password);
      if (result.kind === 'authed') {
        setPassword('');
        setCode('');
        onSignedIn(result);
        return;
      }
      setStage({ kind: 'guard', sessionHandle: result.sessionHandle, methods: result.methods });
      if (isGuardCodeSendable(upfront)) {
        void submitGuard(result.sessionHandle, upfront);
      } else {
        focusSoon(codeInput);
      }
    });
  }, [run, username, password, code, onSignedIn, submitGuard]);

  const showQrCode = useCallback(async (): Promise<void> => {
    await run('starting-qr', async () => {
      const result = await engine.beginQrLogin();
      setStage({
        kind: 'qr',
        sessionHandle: result.sessionHandle,
        expiresAtMs: result.expiresAtMs,
        dataUrl: await QRCode.toDataURL(result.challengeUrl, { width: 240, margin: 0 }),
        challengeUrl: result.challengeUrl,
        state: { kind: 'pending', remoteInteraction: false }
      });
    });
  }, [run]);

  const reconnect = useCallback(async (accountId: string): Promise<void> => {
    await run('refreshing', async () => {
      const authed = await engine.refreshSession(accountId);
      onSignedIn(authed);
    });
  }, [run, onSignedIn]);

  // QR polling. A single failed poll observes nothing, so transient errors are tolerated;
  // only a run of them, or a handle Steam no longer knows, ends the attempt.
  const qrHandle = stage.kind === 'qr' ? stage.sessionHandle : null;
  useEffect(() => {
    if (!qrHandle) return undefined;
    let consecutiveErrors = 0;
    let stopped = false;
    const timer = setInterval(() => {
      void engine.pollQrLogin(qrHandle).then((state) => {
        if (stopped) return;
        consecutiveErrors = 0;
        if (state.kind === 'confirmed') {
          stopped = true;
          setStage({ kind: 'form' });
          onSignedIn({
            accountId: state.accountId ?? state.accountName ?? '',
            accountName: state.accountName ?? '',
            steamId64: state.steamId64 ?? ''
          });
          return;
        }
        setStage((current) => (current.kind === 'qr' && current.sessionHandle === qrHandle
          ? { ...current, state }
          : current));
      }).catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        consecutiveErrors += 1;
        if (!/no longer active/i.test(message) && consecutiveErrors < 3) return;
        stopped = true;
        setStage({ kind: 'form' });
        setFailure(classifyFailure(error));
      });
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [qrHandle, onSignedIn]);

  // Escape backs out, the same as the button, but only when nothing is mid-flight.
  useEffect(() => {
    if (!onCancel) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      abandon(stage.kind === 'form' ? undefined : stage.sessionHandle);
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy, stage, abandon]);

  const rotation = secondsUntilCodeRotation(now);
  const codeIssue = guardCodeIssue(code);
  const heading = title ?? (account ? `Sign in as ${account.accountName}` : 'Connect a Steam account');
  const subtitle = account
    // Said plainly, because the alternative reading — that the account was lost — is both the
    // obvious one and wrong. The account and its data are still here; only the token Steam
    // was accepting is not, and for an account that never had one, not even that.
    ? account.hasSavedSession
      ? 'Steam will not accept the saved session for this account. It needs the password and a Guard code once more.'
      : 'This account has no saved sign-in yet. Signing in stores one, and later launches reconnect on their own.'
    : savedAccounts.length > 0
      ? 'Pick a saved account, or sign in with a password or a QR code.'
      : 'Sign in with your password and a Guard code, or scan a QR code with the Steam app. The app never asks for or stores a 2FA secret.';

  return (
    <div className="signin" data-overlay={onCancel ? 'true' : undefined} role={onCancel ? 'dialog' : undefined} aria-modal={onCancel ? true : undefined} aria-label={heading}>
      <div className="signin-card">
        <Panel>
          <div className="signin-hero">
            <span className="signin-hero-icon">
              {account ? <Avatar name={account.accountName} size={44} square photo={savedAccounts.find((row) => row.id === account.accountId)?.avatarRef} /> : <Icon name="log-in" size={22} />}
            </span>
            <div className="grow">
              <div className="signin-title">{heading}</div>
              <div className="signin-subtitle">{subtitle}</div>
            </div>
          </div>
          <div className="panel-body stack">
            {savedAccounts.length > 0 ? (
              <div className="field">
                <span className="field-label">Saved accounts</span>
                <div className="signin-accounts">
                  {savedAccounts.map((saved) => {
                    // Already signed in *in this window*. Shown rather than hidden, because a
                    // saved account vanishing from the list reads as a lost refresh token.
                    const connected = connectedAccountIds.includes(saved.id);
                    return (
                      <button
                        key={saved.id}
                        type="button"
                        className="signin-account"
                        disabled={busy || stage.kind !== 'form' || connected}
                        aria-label={connected ? `${saved.accountName} is already connected` : `Reconnect as ${saved.accountName}`}
                        onClick={() => void reconnect(saved.id)}
                      >
                        <Avatar name={saved.accountName} size={32} presence={connected ? 'live' : undefined} photo={saved.avatarRef} />
                        <span className="signin-account-text">
                          <span className="signin-account-name">{saved.accountName}</span>
                          <span className="signin-account-meta">
                            {connected ? 'Already connected in this window' : 'Reconnect with the saved session'}
                          </span>
                        </span>
                        {connected ? <Icon name="check-circle" size={16} /> : <Icon name="chevron-right" size={16} />}
                      </button>
                    );
                  })}
                </div>
                <span className="field-hint">Uses the refresh token stored for that Steam username. Steam still has to accept it.</span>
              </div>
            ) : null}

            {savedAccounts.length > 0 ? <div className="signin-divider">or sign in</div> : null}

            <div className="toolbar">
              <Pill
                selected={mode === 'credentials'}
                disabled={busy || stage.kind !== 'form'}
                icon="key"
                onClick={() => { setMode('credentials'); setFailure(null); }}
              >
                Password &amp; Guard code
              </Pill>
              <Pill
                selected={mode === 'qr'}
                disabled={busy || stage.kind !== 'form'}
                icon="qr-code"
                onClick={() => { setMode('qr'); setFailure(null); }}
              >
                QR code
              </Pill>
            </div>

            {mode === 'credentials' && stage.kind !== 'qr' ? (
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy) return;
                  if (stage.kind === 'guard') {
                    if (isGuardCodeSendable(code)) void submitGuard(stage.sessionHandle, code);
                  } else if (username.trim() && password) {
                    void signInWithPassword();
                  }
                }}
              >
                {stage.kind === 'form' ? (
                  <>
                    <Field
                      label="Steam username"
                      icon="user"
                      hint={account ? 'Fixed: this screen was opened from that account’s card.' : undefined}
                    >
                      <input
                        ref={usernameInput}
                        className="input"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        disabled={busy}
                        readOnly={account !== undefined}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus={account === undefined}
                      />
                    </Field>
                    <Field label="Password" icon="lock" hint="Held only for this attempt, then discarded for a refresh token.">
                      <input
                        className="input"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={busy}
                        autoComplete="off"
                      />
                    </Field>
                  </>
                ) : null}

                <Field
                  label="Steam Guard code"
                  icon="smartphone"
                  hint={stage.kind === 'guard'
                    ? `${describeGuardMethods(stage.methods)} The code on the phone changes in ${rotation}s.`
                    : `Optional. Enter one now and it is sent the moment Steam asks — otherwise you will be asked next. Codes change in ${rotation}s.`}
                >
                  <input
                    ref={codeInput}
                    className="input"
                    value={code}
                    onChange={(event) => setCode(normaliseGuardCode(event.target.value))}
                    placeholder="XXXXX"
                    maxLength={10}
                    disabled={busy}
                    inputMode="text"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    style={{ letterSpacing: '0.2em', fontFamily: 'var(--cs-font-mono)', textTransform: 'uppercase' }}
                  />
                </Field>
                {codeIssue ? <div className="field-hint" data-tone="warn">{codeIssue}</div> : null}

                {stage.kind === 'guard' ? (
                  <Button type="submit" variant="primary" size="lg" icon="shield-check" disabled={busy || !isGuardCodeSendable(code)}>
                    Verify code
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" size="lg" icon="log-in" disabled={busy || !username.trim() || !password}>
                    Sign in
                  </Button>
                )}
              </form>
            ) : null}

            {mode === 'qr' && stage.kind === 'qr' ? (
              <QrPanel
                dataUrl={stage.dataUrl}
                challengeUrl={stage.challengeUrl}
                state={stage.state}
                remainingMs={stage.expiresAtMs - now}
                onCancel={() => { abandon(stage.sessionHandle); setStage({ kind: 'form' }); }}
                onNewCode={() => { abandon(stage.sessionHandle); void showQrCode(); }}
              />
            ) : null}

            {mode === 'qr' && stage.kind !== 'qr' ? (
              <div className="stack">
                <div className="field-hint">Open the Steam mobile app, go to Steam Guard, and scan the code that appears here.</div>
                <Button variant="primary" size="lg" icon="qr-code" disabled={busy} onClick={() => void showQrCode()}>
                  Show QR code
                </Button>
              </div>
            ) : null}

            {pending ? (
              <Progress
                label={stepLabel(pending.step)}
                detail={waitingDetail(pending.step, now - pending.startedAt)}
                onCancel={() => {
                  abandon(stage.kind === 'form' ? undefined : stage.sessionHandle);
                  if (stage.kind !== 'qr') setStage({ kind: 'form' });
                }}
              />
            ) : null}

            {failure && !pending ? <FailureNotice failure={failure} /> : null}

            <div className="signin-foot">
              {onCancel ? (
                <Button
                  variant="ghost"
                  icon="chevron-left"
                  onClick={() => {
                    // Tell Steam to stop polling for whatever this screen started before leaving.
                    abandon(stage.kind === 'form' ? undefined : stage.sessionHandle);
                    onCancel();
                  }}
                >
                  Back to the accounts
                </Button>
              ) : <span />}
              {stage.kind === 'guard' && !busy ? (
                <Button
                  variant="ghost"
                  icon="undo"
                  onClick={() => { abandon(stage.sessionHandle); setStage({ kind: 'form' }); setCode(''); }}
                >
                  Start over
                </Button>
              ) : null}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * The QR code plus whatever Steam has told us about it.
 *
 * A code that expired or was denied is not shown: scanning it cannot work any more, and
 * leaving it on screen invites exactly that.
 */
function QrPanel({
  dataUrl,
  challengeUrl,
  state,
  remainingMs,
  onCancel,
  onNewCode
}: {
  dataUrl: string;
  challengeUrl: string;
  state: QrState;
  remainingMs: number;
  onCancel: () => void;
  onNewCode: () => void;
}): React.JSX.Element {
  const progress = describeQr(state, remainingMs);
  if (progress.kind === 'failed') {
    return (
      <div className="stack">
        <FailureNotice failure={progress.failure} />
        <div className="toolbar">
          <Button variant="primary" icon="refresh" onClick={onNewCode}>Show a new code</Button>
          <Button variant="ghost" onClick={onCancel}>Back</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="qr-frame">
        <img src={dataUrl} alt="Steam sign-in QR code" data-challenge-url={challengeUrl} />
      </div>
      <div className="progress" data-tone={progress.tone}>
        <span className="progress-icon"><Icon name={progress.tone === 'busy' ? 'loader' : 'smartphone'} size={15} /></span>
        <div className="progress-body">
          <div className="progress-label">{progress.title}</div>
          <div className="progress-detail">{progress.detail}</div>
        </div>
      </div>
      <div className="field-hint">
        This authorises login only — market-listing confirmations still happen on your phone.
      </div>
      <Button variant="ghost" icon="x" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/** The one place the window says "something is happening", with a way out of it. */
function Progress({
  label,
  detail,
  onCancel
}: {
  label: string;
  detail: string | null;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="progress" data-tone="busy" role="status">
      <span className="progress-icon"><Icon name="loader" size={15} /></span>
      <div className="progress-body">
        <div className="progress-label">{label}</div>
        {detail ? <div className="progress-detail">{detail}</div> : null}
      </div>
      <span className="progress-action"><Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button></span>
    </div>
  );
}

/**
 * A stopped login, explained. Ambiguous outcomes get their own tone: nothing was observed, so
 * the window must not dress the result up as a failure.
 */
function FailureNotice({ failure }: { failure: Failure }): React.JSX.Element {
  return (
    <div className="notice" data-tone={failure.ambiguous ? 'unknown' : 'error'} role="alert">
      <span className="notice-icon"><Icon name={failure.ambiguous ? 'alert-circle' : 'x-circle'} size={16} /></span>
      <div className="notice-body">
        <div className="notice-title">{failure.title}</div>
        <div className="notice-detail">{failure.detail}</div>
      </div>
    </div>
  );
}
