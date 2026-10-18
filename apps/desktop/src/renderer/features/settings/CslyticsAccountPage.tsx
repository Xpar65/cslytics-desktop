import React, { useCallback, useEffect, useState } from 'react';
import type { CslyticsStatus, SignInProblem } from '@cslytics/cslytics-account';
import { engine } from '../../lib/engine.js';
import { relativeTime } from '../../lib/format.js';
import { Badge, Button, KeyValue, Notice, Panel, PanelHeader } from '../../components/ui.js';

/**
 * Settings › This desktop › CSlytics account: the optional sign-in (CSlytics account sign-in plan §6).
 *
 * Everything shown is main's answer to `cslytics.status`, read again on each `cslytics-account`
 * change notice. The page says who is signed in, on which plan, and when the website last confirmed
 * it. It promises no feature: signing in unlocks nothing yet, and when it does, each feature says so
 * where it appears.
 */
export function CslyticsAccountPage(): React.JSX.Element {
  const [status, setStatus] = useState<CslyticsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((): void => {
    void engine.cslyticsStatus().then(setStatus).catch((failure: unknown) => setError(message(failure)));
  }, []);

  useEffect(() => {
    read();
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('cslytics-account')) read();
    });
  }, [read]);

  async function act(run: () => Promise<CslyticsStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await run());
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state;
  const signedIn = state === 'signedIn' || state === 'unconfirmed';
  return (
    <Panel>
      <PanelHeader
        title="CSlytics account"
        icon="user"
        badge={state === 'signedIn' ? <Badge tone="positive">Signed in</Badge>
          : state === 'unconfirmed' ? <Badge tone="warn">Not confirmed</Badge>
            : null}
      />
      <div className="panel-body stack" data-testid="cslytics-account-page" data-state={state ?? 'loading'}>
        {status === null && error === null ? <p className="muted">…</p> : null}

        {state === 'signedOut' ? (
          <>
            <p>
              Sign in with your CSlytics account. It is optional: everything in this app works without it,
              and your Steam accounts are never shared with CSlytics.
            </p>
            {status?.ended ? (
              <Notice tone="warn" title="Your sign-in ended">
                {status.ended.persona ? `${status.ended.persona} was signed out by CSlytics` : 'CSlytics signed this desktop out'}
                {` ${relativeTime(status.ended.at)}. Sign in again to reconnect.`}
              </Notice>
            ) : null}
            {status?.problem ? <Notice tone="error" role="status">{problemText(status.problem)}</Notice> : null}
            <div className="toolbar">
              <Button variant="primary" icon="log-in" loading={busy} onClick={() => void act(engine.cslyticsSignIn)}>
                Sign in with CSlytics
              </Button>
            </div>
          </>
        ) : null}

        {state === 'signingIn' ? (
          <>
            <Notice tone="info" role="status" title="Finish signing in in your browser">
              CSlytics opened in your browser. This page updates when you are done there.
            </Notice>
            <div className="toolbar">
              <Button icon="external-link" loading={busy} onClick={() => void act(engine.cslyticsSignIn)}>
                Open the browser again
              </Button>
              <Button disabled={busy} onClick={() => void act(engine.cslyticsCancelSignIn)}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}

        {signedIn && status ? (
          <>
            <KeyValue rows={[
              { label: 'Signed in as', value: status.account?.persona ?? (status.account ? 'Your CSlytics account' : 'Checking…') },
              { label: 'Plan', value: status.tier ? tierLabel(status.tier) : '…' },
              { label: 'Last confirmed', value: status.verifiedAt ? relativeTime(status.verifiedAt) : 'Not yet' }
            ]} />
            {state === 'unconfirmed' && status.verifiedAt ? (
              <Notice tone="warn" role="status">
                CSlytics has not answered since this app started. Your sign-in is kept.
              </Notice>
            ) : null}
            <div className="toolbar">
              <Button icon="refresh" loading={busy} onClick={() => void act(engine.cslyticsVerify)}>
                Check now
              </Button>
              <Button icon="log-out" disabled={busy} onClick={() => void act(engine.cslyticsSignOut)}>
                Sign out
              </Button>
            </div>
          </>
        ) : null}

        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function problemText(problem: SignInProblem): string {
  switch (problem) {
    case 'declined': return 'The sign-in was declined in the browser.';
    case 'timedOut': return 'The sign-in timed out before the browser came back. Try again.';
    case 'failed': return 'The sign-in did not complete. Try again.';
    case 'unavailable': return 'CSlytics did not answer. Check your connection and try again.';
    case 'storage': return 'This computer could not store the sign-in securely, so it was not kept.';
    case 'browser': return 'Your browser could not be opened.';
  }
}

function tierLabel(tier: string): string {
  return tier === 'FREE' ? 'Free' : tier === 'PRO' ? 'Pro' : tier === 'PREMIUM' ? 'Premium' : tier;
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
