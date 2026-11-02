import React, { useEffect, useState } from 'react';
import type { DesktopSettings } from '../../../shared/api.js';
import { useCslytics } from '../../lib/cslytics.js';
import { engine } from '../../lib/engine.js';
import { BrandMark, Icon, type IconName } from '../../components/Icon.js';
import { Button, Spinner } from '../../components/ui.js';

/** What a sign-in unlocks, as the gate map has it (pricing behind sign-in plan §4). */
const UNLOCKS: ReadonlyArray<{ icon: IconName; label: string }> = [
  { icon: 'trending-up', label: 'Prices and order books' },
  { icon: 'activity', label: 'Float curves, on Steam and CSFloat' },
  { icon: 'dashboard', label: 'The Items and Portfolio pages' }
];

/**
 * The CSlytics sign-in card (pricing behind sign-in plan §7.7, D1).
 *
 * Offered over the window at every launch that finds no sign-in stored, until the person ticks
 * *Don't show this again*. Whether it opens is decided once, when the window first knows both the
 * sign-in and `settings.json`, so signing out later in the same window does not bring it back.
 * *Skip for now* closes it for this launch, and a sign-in finishing closes it. It is never a wall:
 * sign-in stays on the indicator at the foot of the sidebar, the account page and every lock.
 */
export function SignInPrompt({ settings, paused, onSettings }: {
  settings: DesktopSettings | null;
  /** A Steam sign-in is on screen. The card waits behind it and keeps whether it was skipped. */
  paused: boolean;
  onSettings: (next: DesktopSettings) => void;
}): React.JSX.Element | null {
  const status = useCslytics();
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = status !== null && (status.state === 'signedIn' || status.state === 'unconfirmed');

  useEffect(() => {
    if (open !== null || settings === null || status === null) return;
    setOpen(status.state === 'signedOut' && settings.prompts.cslyticsSignIn === 'show');
  }, [open, settings, status]);

  // A sign-in that finishes, from here or from anywhere else, has done what the card asked.
  useEffect(() => {
    if (open && stored) setOpen(false);
  }, [open, stored]);

  if (!open || paused || status === null || settings === null) return null;

  const run = (step: () => Promise<unknown>): void => {
    setBusy(true);
    void step().catch(() => undefined).finally(() => setBusy(false));
  };
  const hidden = settings.prompts.cslyticsSignIn === 'hidden';
  const toggleHidden = (): void => run(async () => {
    onSettings(await engine.writePrompts({ ...settings.prompts, cslyticsSignIn: hidden ? 'show' : 'hidden' }));
  });
  const waiting = status.state === 'signingIn';

  return (
    <div className="signin-prompt-backdrop" data-testid="signin-prompt">
      <section className="signin-prompt" role="dialog" aria-modal="true" aria-labelledby="signin-prompt-title">
        <header className="signin-prompt-head">
          <BrandMark size={36} />
          <h2 id="signin-prompt-title" className="signin-prompt-title">Sign in to CSlytics</h2>
        </header>
        <p className="signin-prompt-lead">Signing in gives you CSlytics&rsquo; pricing data:</p>
        <ul className="signin-prompt-list">
          {UNLOCKS.map((unlock) => (
            <li key={unlock.label}>
              <span className="signin-prompt-list-icon"><Icon name={unlock.icon} size={15} /></span>
              {unlock.label}
            </li>
          ))}
        </ul>
        <div className="signin-prompt-facts">
          <p className="signin-prompt-core">
            <Icon name="check-circle" size={15} />
            <span>Everything you do on Steam works without it: listing, buy orders, and moving items in and out of storage units.</span>
          </p>
          {/*
            True while the website's sign-in is Steam OpenID (Steam names the account, nothing more),
            and while no Steam session, credential, listing or trade leaves main for a CSlytics server.
            Price and curve requests do name the items asked about, so this never says CSlytics
            knows nothing of what is held.
          */}
          <p className="signin-prompt-core" data-tone="negative" data-testid="signin-prompt-no-access">
            <Icon name="x-circle" size={15} />
            <span>
              <strong>CSlytics can&rsquo;t use your Steam account.</strong> It works like &ldquo;Sign in with Google&rdquo;:
              Steam tells us who you are, never your password. Your listings and trades go straight from this app,
              never through CSlytics.
            </span>
          </p>
        </div>
        {waiting ? (
          <div className="signin-prompt-wait" role="status">
            <Spinner size={16} />
            <span>Approve the sign-in in your browser.</span>
            <Button variant="subtle" disabled={busy} onClick={() => run(engine.cslyticsCancelSignIn)}>Cancel</Button>
          </div>
        ) : (
          <div className="signin-prompt-actions">
            <Button variant="primary" size="lg" icon="log-in" loading={busy} onClick={() => run(engine.cslyticsSignIn)}>Sign in with CSlytics</Button>
            <div className="signin-prompt-foot">
              <button type="button" role="checkbox" aria-checked={hidden} className="signin-prompt-hide" disabled={busy} onClick={toggleHidden}>
                <span className="check" data-checked={hidden} aria-hidden="true">
                  {hidden ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                </span>
                Don&rsquo;t show this again
              </button>
              <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Skip for now</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
