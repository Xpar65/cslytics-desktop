import React, { useEffect, useState } from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import type { AccountLaunch } from '../../../shared/api.js';
import type { AccountCard } from '../accounts/AccountsPanel.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';
import { Button, ConfirmDialog, IconButton, Panel, PanelHeader, StatusBadge } from '../../components/ui.js';
import { VenueMark } from '../../components/VenueMark.js';
import { describeConnection, type ConnectionTone } from '../../lib/connection.js';
import { engine } from '../../lib/engine.js';
import { formatAmount } from '../../lib/money.js';
import { formatDate, formatUsd, plural, type Tone } from '../../lib/labels.js';
import { freshness, heldCounts } from '../../lib/portfolio.js';
import type { AccountConnection, AccountHoldings } from '../../lib/types.js';
import { accountAttention, type AttentionAction } from './attention.js';
import { standingView } from './csfloat-profile.js';
import type { SettingsPage } from './SettingsView.js';

/**
 * One account at a glance: who it is, what it needs, and one card per venue.
 *
 * The strip in the middle is the page. It lists what the person has to do, derived from the same
 * reads the cards show (`attention.ts`), and it is not rendered at all when there is nothing —
 * a healthy account is quiet. The cards are four lines and an arrow; the venue page behind each
 * has the detail. Sign out sits at the foot, quiet and alone: it ends a session and keeps
 * everything.
 *
 * Above it, in a panel of their own, the two things that erase: resetting the account's data and
 * removing the account. Each asks for the account name to be typed, and says before it does
 * anything what goes, what stays, and that the other accounts reconnect a moment later — the
 * engine restarts to do it (steam/auth.md, "Removing or resetting an account").
 */
const TONE: Record<ConnectionTone, Tone> = { live: 'positive', partial: 'quiet', blocked: 'accent', offline: 'negative' };

const VENUE_LABEL: Record<MarketplaceStatus['status'], { text: string; tone: Tone }> = {
  CONNECTED: { text: 'Connected', tone: 'positive' },
  CHECKING: { text: 'Checking', tone: 'accent' },
  INVALID_KEY: { text: 'Key rejected', tone: 'negative' },
  RESTRICTED: { text: 'Restricted', tone: 'warn' },
  THROTTLED: { text: 'Rate limited', tone: 'warn' },
  UNAVAILABLE: { text: 'Unreachable', tone: 'warn' },
  DISCONNECTED: { text: 'Disconnected', tone: 'quiet' },
  NOT_CONNECTED: { text: 'Not connected', tone: 'quiet' }
};

export function AccountOverview({ account, connection, connecting, venue, holding, busy, launch, onOpen, onAction, onSignOut, onClear }: {
  account: AccountCard;
  connection: AccountConnection | undefined;
  connecting: boolean;
  venue: MarketplaceStatus | null;
  holding: AccountHoldings | undefined;
  busy: boolean;
  /** How this desktop opens the account; an account in that state is not nagged to connect. */
  launch: AccountLaunch | undefined;
  onOpen: (page: SettingsPage) => void;
  onAction: (kind: AttentionAction) => void;
  onSignOut: () => void;
  /** Resolves only if it failed; on success the window reloads. */
  onClear: (mode: 'remove' | 'reset') => Promise<void>;
}): React.JSX.Element {
  const summary = describeConnection(connection);
  const attention = accountAttention({ connection, connecting, venue, launch });
  const [clearing, setClearing] = useState<'remove' | 'reset' | null>(null);
  // Asked as the dialog opens, so a transfer still waiting on another account is explained before
  // anyone types the name, rather than after the engine has restarted to find out.
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (clearing === null) return undefined;
    let current = true;
    setRefusal(null);
    void engine.accountClearRefusal(account.accountId)
      .then((reason) => { if (current) setRefusal(reason); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [clearing, account.accountId]);
  const signedIn = connection?.steam.kind === 'authenticated';
  const [copied, setCopied] = useState(false);
  const age = freshness(holding?.wallet?.observedAt ?? null);
  const items = holding ? heldCounts(holding.counts).total : null;
  const venueLabel = VENUE_LABEL[venue?.status ?? 'NOT_CONNECTED'];
  const restriction = venue?.restriction ?? null;
  const rating = standingView(venue?.standing);

  return (
    <div className="stack-lg" data-testid="account-overview">
      <header className="account-head">
        <Avatar name={account.accountName} size={52} presence={connecting ? 'connecting' : summary.tone} photo={account.avatarRef} />
        <div className="account-head-text">
          <div className="account-head-name">{account.personaName ?? account.accountName}</div>
          <div className="account-head-meta">
            {account.personaName ? <span>{account.accountName}</span> : null}
            <span className="mono">{account.steamId64}</span>
            <IconButton
              icon={copied ? 'check' : 'copy'}
              size="sm"
              label="Copy Steam ID"
              onClick={() => {
                void navigator.clipboard?.writeText(account.steamId64).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }).catch(() => undefined);
              }}
            />
          </div>
        </div>
        <StatusBadge
          label={connecting ? 'connecting…' : summary.label}
          tone={connecting ? 'accent' : TONE[summary.tone]}
          icon={connecting ? 'loader' : summary.tone === 'live' ? 'check-circle' : summary.tone === 'blocked' ? 'monitor' : summary.tone === 'offline' ? 'wifi-off' : 'circle-dot'}
          title={summary.detail}
        />
      </header>

      {attention.length > 0 ? (
        <section className="attention" aria-label="Needs you" data-testid="account-attention">
          {attention.map((row) => (
            <div key={row.id} className="attention-row" data-tone={row.tone}>
              <span className="attention-icon"><Icon name={row.icon} size={15} /></span>
              <span className="attention-text">{row.text}</span>
              {row.action ? (
                <Button size="sm" variant={row.tone === 'error' ? 'primary' : 'default'} disabled={busy} onClick={() => onAction(row.action!.kind)}>
                  {row.action.label}
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="venue-cards">
        <button type="button" className="venue-card" data-tone={TONE[summary.tone]} onClick={() => onOpen('steam')} aria-label="Open Steam settings">
          <span className="venue-card-head">
            <VenueMark venue="steam" size={16} decorative />
            <span className="venue-card-title">Steam</span>
            <StatusBadge label={connecting ? 'connecting…' : summary.label} tone={connecting ? 'accent' : TONE[summary.tone]} />
          </span>
          <span className="venue-card-row" data-tone={age.tone}>
            <Icon name="wallet" size={13} />
            <span className="num">{formatAmount(holding?.wallet?.balanceCents ?? null, holding?.currency ?? null)}</span>
            {holding?.wallet ? <span className="quiet">{age.label}</span> : null}
          </span>
          <span className="venue-card-row">
            <Icon name="package" size={13} />
            <span className="num">{items?.toLocaleString() ?? '—'}</span>
            {holding ? <span className="quiet">· {plural(holding.counts.storageUnits, 'unit')}</span> : null}
          </span>
          <span className="venue-card-row">
            <Icon name="tag" size={13} />
            <span className="num">{holding ? (holding.counts.listingsActive + holding.counts.listingsOnHold).toLocaleString() : '—'}</span>
            <span className="quiet">listed</span>
          </span>
          <span className="venue-card-go"><Icon name="chevron-right" size={16} /></span>
        </button>

        <button type="button" className="venue-card" data-tone={venueLabel.tone} onClick={() => onOpen('csfloat')} aria-label="Open CSFloat settings">
          <span className="venue-card-head">
            <VenueMark venue="csfloat" size={16} decorative />
            <span className="venue-card-title">CSFloat</span>
            <StatusBadge label={venueLabel.text} tone={venueLabel.tone} />
          </span>
          {venue && venue.status !== 'NOT_CONNECTED' ? (
            <>
              <span className="venue-card-row">
                <Icon name="dollar-sign" size={13} />
                <span className="num">{formatUsd(venue.availableCents)}</span>
                {venue.pendingCents ? <span className="quiet">+ {formatUsd(venue.pendingCents)} pending</span> : null}
              </span>
              {restriction && restriction.state !== 'ended' ? (
                <span className="venue-card-row" data-tone="negative">
                  <Icon name={restriction.state === 'stale' ? 'hourglass' : 'ban'} size={13} />
                  <span>Suspended until {formatDate(restriction.until)}</span>
                </span>
              ) : null}
              {rating ? (
                <span className="venue-card-row" data-tone={rating.tone === 'positive' ? undefined : rating.tone}>
                  <Icon name="shield-check" size={13} />
                  <span>{rating.label}</span>
                  {rating.daysToImprove !== null ? <span className="quiet">· improves in {rating.daysToImprove}d</span> : null}
                </span>
              ) : null}
              <span className="venue-card-row" data-tone={venue.stall.away ? 'warn' : undefined}>
                <Icon name={venue.stall.away ? 'eye-off' : venue.stall.public ? 'eye' : 'lock'} size={13} />
                <span>{venue.stall.away === null ? '—' : venue.stall.away ? 'Stall away' : venue.stall.public ? 'Stall public' : 'Stall private'}</span>
              </span>
            </>
          ) : (
            <span className="venue-card-row"><Icon name="key" size={13} /><span className="quiet">Paste a developer key</span></span>
          )}
          <span className="venue-card-go"><Icon name="chevron-right" size={16} /></span>
        </button>
      </div>

      <Panel>
        <PanelHeader icon="database" title="Data on this computer" />
        <div className="panel-body stack">
          <div className="settings-action">
            <div className="settings-action-text">
              <div className="settings-action-title">Reset account data</div>
              <div className="settings-action-hint">Deletes what CSlytics has recorded for this account and reads it all again from Steam. It stays signed in.</div>
            </div>
            <Button icon="undo" disabled={busy} onClick={() => setClearing('reset')}>Reset data…</Button>
          </div>
          <div className="settings-action">
            <div className="settings-action-text">
              <div className="settings-action-title">Remove account</div>
              <div className="settings-action-hint">Deletes the account and all of its data from this computer, including its saved sign-ins.</div>
            </div>
            <Button variant="danger" icon="trash" disabled={busy} onClick={() => setClearing('remove')}>Remove account…</Button>
          </div>
        </div>
      </Panel>

      <ConfirmDialog
        open={clearing === 'reset'}
        title={`Reset ${account.accountName}?`}
        phrase={account.accountName}
        confirmLabel="Reset account data"
        busyLabel="Resetting…"
        blocked={refusal}
        onConfirm={() => onClear('reset')}
        onClose={() => setClearing(null)}
      >
        <p>This deletes everything CSlytics has recorded about <strong>{account.accountName}</strong> on this computer, then reads it again from Steam:</p>
        <ul>
          <li>items, storage units and the moves between them</li>
          <li>listings, buy orders, trades, market history and the ledger</li>
          <li>work still in progress — Steam may still finish it</li>
        </ul>
        <p>The Steam sign-in, the CSFloat key and this account's settings stay. Nothing on Steam or CSFloat is cancelled. History Steam no longer shows, such as old trades, cannot be read back.</p>
        <p className="quiet">CSlytics restarts its engine to do this, so your other accounts reconnect a moment later. Backups taken before an app upgrade keep a copy until newer ones replace them.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearing === 'remove'}
        title={`Remove ${account.accountName}?`}
        phrase={account.accountName}
        confirmLabel="Remove account"
        busyLabel="Removing…"
        blocked={refusal}
        onConfirm={() => onClear('remove')}
        onClose={() => setClearing(null)}
      >
        <p>This deletes <strong>{account.accountName}</strong> and all of its data from this computer:</p>
        <ul>
          <li>its saved Steam sign-in and CSFloat key</li>
          <li>everything CSlytics recorded about it: items, listings, buy orders, trades, market history and the ledger</li>
          <li>its settings here, and work still in progress — Steam may still finish it</li>
        </ul>
        <p>Nothing on Steam or CSFloat is cancelled. Adding the account again means signing in with Steam Guard or a QR code, and history Steam no longer shows cannot be read back.</p>
        <p className="quiet">CSlytics restarts its engine to do this, so your other accounts reconnect a moment later. Backups taken before an app upgrade keep a copy until newer ones replace them.</p>
      </ConfirmDialog>

      {signedIn ? (
        <footer className="settings-foot">
          <Button variant="ghost" icon="log-out" disabled={busy || connecting} onClick={onSignOut} title="Ends the session in this window. The saved sign-in is kept.">
            Sign out
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
