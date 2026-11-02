import React, { useState } from 'react';
import type { CslyticsStatus } from '@cslytics/cslytics-account';
import { lockReason, type Feature } from '../../shared/command-access.js';
import { useCslytics } from '../lib/cslytics.js';
import { engine } from '../lib/engine.js';
import { Icon } from './Icon.js';
import { Tip } from './Tip.js';
import { Button } from './ui.js';

/**
 * A price this desktop shows only to a signed-in person (pricing behind sign-in plan §7.6).
 *
 * The placeholder is a generic shape drawn here, blurred, and never the item's own data: main
 * fetched nothing for a locked surface, so there is nothing real to blur (plan D11). One button,
 * which starts the sign-in in the browser; while one is open it says so and offers to stop it.
 * What the surface shows once signed in is in the tip, not on the page.
 */
export type LockShape = 'page' | 'curve' | 'book' | 'inline';

export function SignInLock({ status, feature, title, tip, shape, testId }: {
  status: CslyticsStatus;
  feature: Feature;
  title: string;
  tip: string;
  shape: LockShape;
  testId?: string | undefined;
}): React.JSX.Element {
  const reason = lockReason(status, feature);
  const action = <SignInAction status={status} plan={reason === 'tier'} />;
  if (shape === 'inline') {
    return (
      <div className="signin-lock-inline" data-testid={testId} data-feature={feature} data-reason={reason ?? undefined}>
        <Icon name="lock" size={12} />
        <span className="signin-lock-inline-title">{title}</span>
        <Tip content={tip} label={`What ${title.toLowerCase()} shows`} />
        {action}
      </div>
    );
  }
  return (
    <div className="signin-lock" data-shape={shape} data-testid={testId} data-feature={feature} data-reason={reason ?? undefined}>
      <div className="signin-lock-placeholder" aria-hidden="true">
        <Placeholder shape={shape} />
      </div>
      <div className="signin-lock-overlay">
        <span className="signin-lock-icon"><Icon name="lock" size={18} /></span>
        <span className="signin-lock-title">
          {title}
          <Tip content={tip} label={`What ${title.toLowerCase()} shows`} />
        </span>
        {action}
      </div>
    </div>
  );
}

/**
 * The surface when the feature is held, and the lock when it is not. Nothing is drawn while the
 * status is still being read, so a signed-in person never sees a lock flash, and a signed-out one
 * never mounts a surface whose commands main would refuse.
 */
export function Walled({ feature, title, tip, shape = 'page', testId, children }: {
  feature: Feature;
  title: string;
  tip: string;
  shape?: Exclude<LockShape, 'inline'> | undefined;
  testId?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const status = useCslytics();
  if (status === null) return null;
  if (lockReason(status, feature) === null) return <>{children}</>;
  return <SignInLock status={status} feature={feature} title={title} tip={tip} shape={shape} testId={testId} />;
}

/** Sign in, or the sign-in already waiting in the browser; a plan that lacks the feature says so instead. */
function SignInAction({ status, plan }: { status: CslyticsStatus; plan: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  if (plan) return <span className="signin-lock-note">Not in your plan</span>;
  const run = (step: () => Promise<unknown>): void => {
    setBusy(true);
    void step().catch(() => undefined).finally(() => setBusy(false));
  };
  if (status.state === 'signingIn') {
    return (
      <span className="signin-lock-actions">
        <span className="signin-lock-note">Waiting for your browser</span>
        <Button size="sm" variant="subtle" disabled={busy} onClick={() => run(engine.cslyticsCancelSignIn)}>Cancel</Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="primary" icon="log-in" loading={busy} onClick={() => run(engine.cslyticsSignIn)}>
      Sign in to CSlytics
    </Button>
  );
}

/** A generic shape for the blur: the same curve, book or page for every item. */
function Placeholder({ shape }: { shape: Exclude<LockShape, 'inline'> }): React.JSX.Element {
  if (shape === 'curve') {
    return (
      <svg viewBox="0 0 400 160" preserveAspectRatio="none" className="signin-lock-svg">
        <path d="M0 30 C 60 40, 90 70, 140 85 S 260 120, 400 128" className="signin-lock-line" />
        <path d="M0 50 C 70 60, 110 92, 160 104 S 280 136, 400 142" className="signin-lock-line signin-lock-line-faint" />
      </svg>
    );
  }
  if (shape === 'book') {
    return (
      <div className="signin-lock-rows">
        {[72, 58, 44, 30, 22].map((width, index) => <span key={index} style={{ width: `${width}%` }} />)}
      </div>
    );
  }
  return (
    <div className="signin-lock-page">
      <span className="signin-lock-figure" />
      <span className="signin-lock-figure" />
      <span className="signin-lock-figure" />
      <svg viewBox="0 0 400 120" preserveAspectRatio="none" className="signin-lock-svg">
        <path d="M0 100 L 60 84 L 120 92 L 180 60 L 240 70 L 300 40 L 360 48 L 400 30" className="signin-lock-line" />
      </svg>
    </div>
  );
}
