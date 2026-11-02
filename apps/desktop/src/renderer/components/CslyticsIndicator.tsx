import React from 'react';
import type { CslyticsStatus } from '@cslytics/cslytics-account';
import { useCslytics } from '../lib/cslytics.js';
import { Icon } from './Icon.js';

type Look = { tone: 'live' | 'partial' | 'blocked' | undefined; name: string; detail: string; title: string };

/** How each sign-in state reads at a glance: a lit dot and a name when signed in, a plain one when not. */
function look(status: CslyticsStatus | null): Look {
  if (status === null) return { tone: undefined, name: 'CSlytics', detail: 'Checking the sign-in', title: 'CSlytics account' };
  const name = status.account?.persona ?? 'CSlytics account';
  switch (status.state) {
    case 'signedIn':
      return { tone: 'live', name, detail: 'Signed in to CSlytics', title: `Signed in to CSlytics as ${name}` };
    case 'unconfirmed':
      return {
        tone: 'partial', name, detail: 'Signed in to CSlytics',
        title: `Signed in to CSlytics as ${name}. CSlytics has not confirmed it since the app started; prices keep working meanwhile.`
      };
    case 'signingIn':
      return { tone: 'blocked', name: 'Signing in', detail: 'Approve it in your browser', title: 'Signing in to CSlytics: approve it in your browser' };
    case 'signedOut':
      return {
        tone: undefined, name: 'Not signed in', detail: 'Sign in to CSlytics',
        title: 'Not signed in to CSlytics. Prices, float curves, Items and Portfolio need a free sign-in.'
      };
  }
}

/**
 * The CSlytics sign-in at a glance, at the foot of the sidebar (pricing behind sign-in plan §7.7).
 * The name is the Steam persona of the CSlytics login, which need not be any account this window
 * manages. Pressing it opens Settings › CSlytics account.
 */
export function CslyticsIndicator({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const status = useCslytics();
  const { tone, name, detail, title } = look(status);
  return (
    <button
      type="button"
      className="nav-item cslytics-indicator"
      data-testid="cslytics-indicator"
      data-state={status?.state ?? 'loading'}
      title={title}
      aria-label={title}
      onClick={onOpen}
    >
      <span className="cslytics-indicator-badge" aria-hidden="true">
        <Icon name="user" size={15} />
        <span className="conn-dot" data-tone={tone} />
      </span>
      <span className="nav-text cslytics-indicator-text">
        <span className="cslytics-indicator-name">{name}</span>
        <span className="cslytics-indicator-detail">{detail}</span>
      </span>
    </button>
  );
}
