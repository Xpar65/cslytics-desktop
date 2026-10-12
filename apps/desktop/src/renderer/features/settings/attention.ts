import type { MarketplaceStatus } from '@cslytics/engine';
import type { AccountLaunch } from '../../../shared/api.js';
import type { IconName } from '../../components/Icon.js';
import { accountAction, describeConnection } from '../../lib/connection.js';
import { formatDate } from '../../lib/labels.js';
import type { AccountConnection } from '../../lib/types.js';

/**
 * What one account needs from the person, derived, never stored.
 *
 * Each row is a glance and at most one button. The list is empty for a healthy account and the
 * strip that renders it disappears — silence is the good state, and a green "all fine" banner
 * would teach the eye to ignore the strip. Tone is colour only where something is wrong:
 * `error` blocks work now, `warn` wants a look.
 *
 * The one row that matters most is the stall trap: CSFloat sets the stall away when it suspends
 * an account and never clears it, so the moment a suspension is observed to have ended with the
 * stall still away is exactly when nothing the account has listed is visible and nobody has
 * been told (seen live, 2026-09-22). A stall the user set away themselves is not here — it
 * is their choice, and the venue card and account tab show it as a fact. So is an account in the
 * state this desktop opens it in — signed out, or signed in to Steam without CS2: that is what was
 * asked for, not something to fix.
 */
export type AttentionAction = 'sign-in' | 'connect' | 'stall-back' | 'replace-key' | 'check-csfloat';

export type Attention = {
  id: string;
  tone: 'warn' | 'error';
  icon: IconName;
  /** A few words. */
  text: string;
  /** What one click does. A date to wait out has none. */
  action: { label: string; kind: AttentionAction } | null;
};

export function accountAttention(input: {
  connection: AccountConnection | undefined;
  connecting: boolean;
  venue: MarketplaceStatus | null | undefined;
  /** How `settings.json` opens this account. Absent is the default, signed in to both. */
  launch?: AccountLaunch | undefined;
}): Attention[] {
  const items: Attention[] = [];
  const summary = describeConnection(input.connection);
  const action = accountAction({
    phase: input.connection?.phase,
    hasSavedCredential: input.connection?.hasSavedCredential ?? false,
    connecting: input.connecting
  });
  if (action === 'sign-in') items.push({ id: 'steam-sign-in', tone: 'warn', icon: 'log-in', text: 'Steam needs a new sign-in', action: { label: 'Sign in', kind: 'sign-in' } });
  else if (action === 'connect' && !asOpened(input.connection?.phase, input.launch)) items.push({ id: 'steam-connect', tone: 'warn', icon: 'link', text: 'Not connected to Steam', action: { label: 'Connect', kind: 'connect' } });
  if (summary.tone === 'blocked') items.push({ id: 'gc-blocked', tone: 'warn', icon: 'monitor', text: 'CS2 is open on another computer', action: null });

  const venue = input.venue;
  if (!venue || venue.status === 'NOT_CONNECTED') return items;
  const restriction = venue.restriction;
  if (restriction?.state === 'suspended') {
    items.push({ id: 'csfloat-suspended', tone: 'error', icon: 'ban', text: `Suspended on CSFloat until ${formatDate(restriction.until)}`, action: null });
  } else if (restriction?.state === 'stale') {
    items.push({ id: 'csfloat-suspension-stale', tone: 'warn', icon: 'hourglass', text: 'CSFloat suspension due to have ended', action: { label: 'Check now', kind: 'check-csfloat' } });
  } else if (restriction?.state === 'ended' && venue.stall.away === true) {
    items.push({ id: 'csfloat-stall-away', tone: 'warn', icon: 'eye-off', text: 'Stall still away since the suspension · listings hidden', action: { label: 'Bring it back', kind: 'stall-back' } });
  }
  // The venue's own warning, in its own words: at risk means the next restriction is permanent.
  if (venue.standing?.standing === 'banned') items.push({ id: 'csfloat-standing', tone: 'error', icon: 'ban', text: 'Banned on CSFloat', action: null });
  else if (venue.standing?.standing === 'at_risk') items.push({ id: 'csfloat-standing', tone: 'warn', icon: 'alert-triangle', text: 'CSFloat standing at risk · next restriction is a permanent ban', action: null });
  if (venue.status === 'INVALID_KEY') items.push({ id: 'csfloat-key', tone: 'error', icon: 'key', text: 'CSFloat rejected the saved key', action: { label: 'Replace key', kind: 'replace-key' } });
  if (venue.status === 'RESTRICTED') items.push({ id: 'csfloat-restricted', tone: 'warn', icon: 'ban', text: 'Restricted by CSFloat', action: null });
  if (venue.flags['know_your_customer'] === 'expired') items.push({ id: 'csfloat-kyc', tone: 'warn', icon: 'shield-check', text: 'CSFloat verification expired', action: null });
  return items;
}

/** True when the account is in the state its launch preferences open it in. */
function asOpened(phase: AccountConnection['phase'] | undefined, launch: AccountLaunch | undefined): boolean {
  if (!launch) return false;
  if (!launch.signIn) return phase === 'SIGNED_OUT';
  return !launch.cs2 && phase === 'STEAM_ONLY';
}
