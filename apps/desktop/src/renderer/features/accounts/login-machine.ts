/**
 * The vocabulary the sign-in window uses to talk about a login attempt.
 *
 * This module is deliberately pure: no React, no IPC. What a login *is doing* and what a
 * failure *means* are the two things most worth getting right here, and both are testable
 * without a DOM. See tests/unit/login-feedback.test.ts.
 *
 * Two rules shape the copy:
 *
 * - Never claim more than was observed. If Steam stopped answering we do not know whether the
 *   attempt died or is still in flight, and the message says so rather than asserting failure.
 * - A failure is only useful if it says what to do next, so every failure carries a `resume`
 *   telling the window which field to send the user back to.
 */

export type LoginStep =
  | 'starting-credentials'
  | 'submitting-guard'
  | 'starting-qr'
  | 'refreshing';

/** How long the window waits for one call before it stops claiming to know anything. */
export const RESPONSE_DEADLINE_MS = 90_000;

export type Failure = {
  title: string;
  detail: string;
  /** Which part of the form can act on this: retype credentials, retype a code, or start over. */
  resume: 'credentials' | 'guard' | 'restart';
  /**
   * True when the outcome was never observed. An ambiguous failure is not proof the login
   * failed, and the window must not say it was — the attempt may still be running at Steam.
   */
  ambiguous: boolean;
};

const STEP_LABELS: Record<LoginStep, string> = {
  'starting-credentials': 'Signing in to Steam…',
  'submitting-guard': 'Checking your Steam Guard code…',
  'starting-qr': 'Asking Steam for a sign-in code…',
  refreshing: 'Reconnecting with the saved token…'
};

export function stepLabel(step: LoginStep): string {
  return STEP_LABELS[step];
}

/**
 * Escalating patience copy. Silence for the first few seconds — feedback that immediately
 * apologises reads worse than feedback that waits — then increasingly explicit about the wait.
 */
export function waitingDetail(step: LoginStep, elapsedMs: number): string | null {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 4) return null;
  if (seconds < 15) {
    return step === 'starting-qr' ? 'Steam usually answers in a moment.' : `Waiting on Steam — ${seconds}s.`;
  }
  if (seconds < 40) return `Still waiting on Steam — ${seconds}s. Slow answers are normal under load.`;
  return `Steam has not answered in ${seconds}s. You can keep waiting, or cancel and try again.`;
}

/** The message shown when the window's own deadline passes without an answer. */
export function deadlineFailure(step: LoginStep): Failure {
  return {
    title: 'Steam did not answer',
    detail:
      `${stepLabel(step)} — no response in ${Math.round(RESPONSE_DEADLINE_MS / 1000)}s. `
      + 'The attempt may still be running at Steam, so this is not proof that it failed. '
      + 'Check the Steam mobile app for a pending approval before trying again.',
    resume: 'restart',
    ambiguous: true
  };
}

/**
 * Turns what crossed the IPC boundary into something a person can act on.
 *
 * steam-session rejects with the name of the Steam EResult (`TwoFactorCodeMismatch`,
 * `InvalidPassword`, …), and only the message survives the trip from the Engine Runtime, so
 * the name is what we match on. Anything unrecognised is shown verbatim rather than flattened
 * into "something went wrong".
 */
export function classifyFailure(error: unknown): Failure {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  // Electron prefixes errors rejected by ipcMain.handle. Classify the reason that crossed the
  // boundary, while retaining the original text for an unknown failure.
  const reason = message.replace(
    /^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i,
    ''
  ).trim();

  if (/^InvalidPassword$/i.test(reason)) {
    return {
      title: 'Steam rejected that username or password',
      detail: 'Check both and try again. Repeated wrong attempts get the account rate-limited.',
      resume: 'credentials',
      ambiguous: false
    };
  }
  if (/^(TwoFactorCodeMismatch|TwoFactorActivationCodeMismatch)$/i.test(reason)) {
    return {
      title: 'That Steam Guard code was not accepted',
      detail: 'Codes rotate every 30 seconds. Wait for the next one rather than resending the same digits.',
      resume: 'guard',
      ambiguous: false
    };
  }
  if (/^(InvalidLoginAuthCode|ExpiredLoginAuthCode)$/i.test(reason)) {
    return {
      title: 'That email code was not accepted',
      detail: 'Steam emails a code to the address on the account. Use the newest one — older codes expire.',
      resume: 'guard',
      ambiguous: false
    };
  }
  if (/^(AccountLogonDenied|AccountLogonDeniedNeedTwoFactorCode|AccountLogonDeniedNoMail|AccountLogonDeniedNoMailSent)$/i.test(reason)) {
    return {
      title: 'Steam wants a second factor',
      detail: 'Steam has sent a code to the account’s email or mobile app. Enter it below.',
      resume: 'guard',
      ambiguous: false
    };
  }
  if (/^AccountLogonDeniedVerifiedEmailRequired$/i.test(reason)) {
    return {
      title: 'This account needs a verified email',
      detail: 'Verify the email address on the Steam account, then sign in again.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/^(RateLimitExceeded|AccountLoginDeniedThrottle)$/i.test(reason)) {
    return {
      title: 'Steam is rate-limiting sign-ins',
      detail: 'Too many attempts came from this machine. Wait roughly 30 minutes — retrying now only extends the block.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/^(AccountDisabled|AccountLockedDown|Banned|Suspended)$/i.test(reason)) {
    return {
      title: 'Steam has restricted this account',
      detail: `Steam answered "${reason}". Sign in on the Steam website for the reason; nothing here can change it.`,
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/^(ServiceUnavailable|TryAnotherCM|Busy|Timeout|Fail)$/i.test(reason)) {
    return {
      title: 'Steam is not answering right now',
      detail: `Steam answered "${reason}", which says nothing about whether the attempt went through. Wait a moment, then try again.`,
      resume: 'restart',
      ambiguous: true
    };
  }
  if (/^Steam login timed out$/i.test(reason)) {
    return {
      title: 'The sign-in expired',
      detail: 'Steam stopped waiting for approval. Start a new attempt and confirm it on your phone sooner.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/no longer active/i.test(reason)) {
    return {
      title: 'That sign-in attempt is gone',
      detail: 'It expired, it finished, or the background service restarted. Start a new one.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/No refresh token stored/i.test(reason) || /^No saved account named /i.test(reason)) {
    return {
      title: 'No saved session for this account',
      detail: 'Nothing has signed in under this Steam username on this machine yet. Use a password or the QR code once; reconnects work after that.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/rejected the stored client refresh token/i.test(reason) || /requested another Guard code/i.test(reason)) {
    return {
      title: 'That saved session is no longer valid',
      detail: 'Steam rejected the stored refresh token. Sign in with a password or QR code to store a new one.',
      resume: 'credentials',
      ambiguous: false
    };
  }
  if (/desktop connection is unavailable/i.test(reason)) {
    return {
      title: 'The desktop connection is not available',
      detail: 'Restart the CSlytics desktop app. The login never reached Steam.',
      resume: 'restart',
      ambiguous: false
    };
  }
  if (/Engine Runtime/i.test(reason)) {
    return {
      title: 'The background service is not available',
      detail: `${reason}. Restart the app; no Steam request was made.`,
      resume: 'restart',
      ambiguous: false
    };
  }

  return {
    title: 'Sign-in failed',
    detail: reason || message || 'Steam gave no reason.',
    resume: 'restart',
    ambiguous: false
  };
}

/** Mirrors `QrState` from `@cslytics/ports`; the renderer may not import engine packages. */
export type QrState =
  | { kind: 'pending'; remoteInteraction: boolean }
  | { kind: 'confirmed'; accountId?: string; accountName?: string; steamId64?: string }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failed'; message: string };

export type QrProgress =
  | { kind: 'waiting'; tone: 'busy'; title: string; detail: string }
  | { kind: 'confirmed'; tone: 'ok'; title: string; detail: string }
  | { kind: 'failed'; tone: 'error'; failure: Failure };

/** What the QR panel says, given the last observed state and how long the code stays valid. */
export function describeQr(state: QrState, remainingMs: number): QrProgress {
  if (state.kind === 'confirmed') {
    return { kind: 'confirmed', tone: 'ok', title: 'Approved', detail: 'Finishing the session…' };
  }
  if (state.kind === 'denied') {
    return {
      kind: 'failed',
      tone: 'error',
      failure: {
        title: 'Sign-in was denied on the phone',
        detail: 'The Steam mobile app rejected this attempt. Start a new one if that was not deliberate.',
        resume: 'restart',
        ambiguous: false
      }
    };
  }
  if (state.kind === 'expired') {
    return {
      kind: 'failed',
      tone: 'error',
      failure: {
        title: 'This code expired',
        detail: 'Nobody approved it in time. Ask for a fresh code and scan it straight away.',
        resume: 'restart',
        ambiguous: false
      }
    };
  }
  if (state.kind === 'failed') {
    return { kind: 'failed', tone: 'error', failure: classifyFailure(new Error(state.message)) };
  }

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (state.remoteInteraction) {
    return {
      kind: 'waiting',
      tone: 'busy',
      title: 'Scanned — waiting for approval',
      detail: `Your phone has the request. Approve it there. ${seconds}s left.`
    };
  }
  return {
    kind: 'waiting',
    tone: 'busy',
    title: 'Waiting for a scan',
    detail: seconds > 0
      ? `Scan this with the Steam mobile app. The code is good for ${seconds}s.`
      : 'The code is about to expire.'
  };
}

/** Normalises what a person types: Steam codes are upper-case and never contain spaces. */
export function normaliseGuardCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase().slice(0, 10);
}

/**
 * Why a typed code is not worth sending yet, or null if it is.
 *
 * Steam counts a rejected code against the account's attempt budget, so obviously malformed
 * input is caught here rather than spent there.
 */
export function guardCodeIssue(raw: string): string | null {
  const code = normaliseGuardCode(raw);
  if (code.length === 0) return null;
  if (!/^[0-9A-Z]+$/.test(code)) return 'Guard codes are letters and digits only.';
  if (code.length < 5) return 'Guard codes are five characters.';
  return null;
}

export function isGuardCodeSendable(raw: string): boolean {
  const code = normaliseGuardCode(raw);
  return code.length >= 5 && guardCodeIssue(code) === null;
}

/**
 * Seconds until the mobile app's code rolls over.
 *
 * TOTP codes change on 30-second boundaries of wall-clock time, so this needs no secret and
 * no knowledge of the account — only the clock. Showing it stops people from spending an
 * attempt on a code that is about to be rejected for being stale.
 */
export function secondsUntilCodeRotation(nowMs: number): number {
  return 30 - Math.floor(nowMs / 1000) % 30;
}

const METHOD_NAMES: Record<string, string> = {
  'device-code': 'a code from the Steam mobile app',
  'device-confirmation': 'an approval in the Steam mobile app',
  'email-code': 'a code emailed to the account',
  'email-confirmation': 'a confirmation emailed to the account'
};

/** Plain-English version of the guard methods Steam offered. */
export function describeGuardMethods(methods: readonly string[]): string {
  const named = methods.map((method) => METHOD_NAMES[method] ?? method);
  if (named.length === 0) return 'Steam asked for a device code.';
  if (named.length === 1) return `Steam asked for ${named[0]}.`;
  return `Steam asked for ${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}.`;
}
