import React, { useState } from 'react';
import type { AccountConnection, AccountHoldings } from '../../lib/types.js';
import { describeConnection, type ConnectionTone } from '../../lib/connection.js';
import { formatAmount } from '../../lib/money.js';
import { freshness, heldCounts } from '../../lib/portfolio.js';
import type { Tone } from '../../lib/labels.js';
import { Avatar } from '../../components/Avatar.js';
import { Button, Empty, IconButton, Panel, PanelHeader, StatusBadge } from '../../components/ui.jsx';

/**
 * The account cards on the portfolio: every account the Engine Runtime has a row for, as a
 * summary.
 *
 * A card says how the account is and links to where something can be done about it. Connect,
 * sign in and sign out live on Settings › Account, in one place, so that an action has one home
 * and the card cannot offer the wrong one. Nothing here claims a session exists: every state
 * comes from `session.status`, the runtime's observation of what is actually connected.
 */

export type AccountCard = {
  accountId: string;
  accountName: string;
  steamId64: string;
  /** True when the OS vault still holds a refresh token, so Connect has something to reuse. */
  hasSession: boolean;
  /** `avatar:<40hex>` when observed; otherwise null and the face falls back to initials. */
  avatarRef: string | null;
  /** The Steam display name when a persona walk has observed one. */
  personaName: string | null;
};

const TONE: Record<ConnectionTone, Tone> = { live: 'positive', partial: 'quiet', blocked: 'accent', offline: 'negative' };

export function AccountsPanel({
  accounts,
  holdings = [],
  connections,
  connecting,
  busy,
  onOpen,
  onManage,
  onAddAccount
}: {
  accounts: readonly AccountCard[];
  holdings?: readonly AccountHoldings[] | undefined;
  connections: readonly AccountConnection[];
  /** Accounts with a connect in flight. */
  connecting: ReadonlySet<string>;
  busy: boolean;
  onOpen: (accountId: string) => void;
  /** Settings › Account for this account: where connect, sign in and sign out live. */
  onManage: (accountId: string) => void;
  onAddAccount: () => void;
}): React.JSX.Element {
  return (
    <Panel>
      <PanelHeader
        icon="users"
        title={accounts.length === 1 ? 'Steam' : 'Steam accounts'}
        subtitle={accounts.length === 0
          ? 'No Steam account has been added yet.'
          : 'Reconnected from saved sessions on launch. Manage an account to sign in where Steam asks for a code.'}
        actions={accounts.length > 0 ? <Button size="sm" icon="plus" onClick={onAddAccount}>Add another</Button> : null}
      />
      <div className="panel-body">
        {accounts.length === 0 ? (
          <Empty
            icon="user-plus"
            title="Nothing to connect yet"
            hint="Add a Steam account and this window reconnects it on every later launch."
            action={<Button variant="primary" icon="plus" onClick={onAddAccount}>Add your first account</Button>}
          />
        ) : (
          <div className="account-cards">
            {accounts.map((account, index) => (
              <AccountCardView
                key={account.accountId}
                index={index}
                account={account}
                holding={holdings.find((row) => row.accountId === account.accountId)}
                connection={connections.find((row) => row.accountId === account.accountId)}
                connecting={connecting.has(account.accountId)}
                busy={busy}
                onOpen={onOpen}
                onManage={onManage}
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function AccountCardView({
  index,
  account,
  holding,
  connection,
  connecting,
  busy,
  onOpen,
  onManage
}: {
  index: number;
  account: AccountCard;
  holding: AccountHoldings | undefined;
  connection: AccountConnection | undefined;
  connecting: boolean;
  busy: boolean;
  onOpen: (accountId: string) => void;
  onManage: (accountId: string) => void;
}): React.JSX.Element {
  const summary = describeConnection(connection);
  const [copied, setCopied] = useState(false);
  const age = freshness(holding?.wallet?.observedAt ?? null);
  const items = holding ? heldCounts(holding.counts).total : null;
  const listings = holding ? holding.counts.listingsActive + holding.counts.listingsOnHold + holding.counts.listingsAwaitingConfirmation : null;

  return (
    <article className="account-card" data-tone={summary.tone} style={{ animationDelay: `${Math.min(index, 6) * 50}ms` }}>
      <div className="account-card-head">
        <Avatar name={account.accountName} size={40} presence={connecting ? 'connecting' : summary.tone} photo={account.avatarRef} />
        <div className="account-card-id">
          <span className="account-card-name">{account.accountName}</span>
          <span className="account-card-steamid">
            <span>{account.steamId64 ? `Steam ID ${account.steamId64}` : 'no Steam ID observed yet'}</span>
            {account.steamId64 ? (
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
            ) : null}
          </span>
        </div>
        <span className="account-card-state">
          <StatusBadge
            label={connecting ? 'connecting…' : summary.label}
            tone={connecting ? 'accent' : TONE[summary.tone]}
            icon={connecting ? 'loader' : summary.tone === 'live' ? 'check-circle' : summary.tone === 'blocked' ? 'monitor' : summary.tone === 'offline' ? 'wifi-off' : 'circle-dot'}
            title={summary.detail}
          />
        </span>
      </div>

      <p className="account-card-detail">
        {connecting
          ? 'Reusing the saved session, then asking Steam for a CS2 Game Coordinator session.'
          : summary.detail}
      </p>

      {holding ? (
        <div className="account-card-stats">
          <div className="account-card-stat">
            <div className="account-card-stat-label">Steam wallet</div>
            <div className="account-card-stat-value" data-tone={age.tone} title={holding.wallet ? `observed ${age.label}` : undefined}>
              {formatAmount(holding.wallet?.balanceCents ?? null, holding.currency)}
            </div>
            {/* A second venue's balance, under the first and never added to it: it is another currency's money. */}
            {holding.csfloatWallet ? (
              <div className="account-card-stat-sub">CSFloat {formatAmount(holding.csfloatWallet.availableCents, holding.csfloatWallet.currency)}</div>
            ) : null}
          </div>
          <div className="account-card-stat">
            <div className="account-card-stat-label">Items</div>
            <div className="account-card-stat-value">{items?.toLocaleString() ?? '—'}</div>
          </div>
          <div className="account-card-stat">
            <div className="account-card-stat-label">Listings</div>
            <div className="account-card-stat-value">{listings?.toLocaleString() ?? '—'}</div>
          </div>
        </div>
      ) : null}

      <div className="account-card-actions">
        <Button iconRight="arrow-right" aria-label={`Open ${account.accountName}`} onClick={() => onOpen(account.accountId)}>Open</Button>
        <span className="toolbar-spacer" />
        <Button
          variant={summary.action === 'none' ? 'ghost' : 'primary'}
          icon="settings"
          disabled={busy}
          aria-label={`Manage ${account.accountName}`}
          title="Connection, sign-in and marketplaces for this account"
          onClick={() => onManage(account.accountId)}
        >
          Manage
        </Button>
      </div>
    </article>
  );
}
