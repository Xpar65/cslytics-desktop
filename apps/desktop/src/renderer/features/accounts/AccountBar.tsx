import React from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import type { AccountConnection, AccountHoldings } from '../../lib/types.js';
import { freshness } from '../../lib/portfolio.js';
import { describeConnection, worstTone } from '../../lib/connection.js';
import { formatAmount } from '../../lib/money.js';
import { plural } from '../../lib/labels.js';
import { Avatar, AvatarStack } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';

export type AccountTab = { accountId: string; accountName: string; steamId64: string; avatarRef?: string | null };

/**
 * The account strip: every account the app knows is a tab, and everything below it is scoped
 * to the selected one.
 *
 * An "all accounts" chip, then one chip per account carrying its face, its wallet and how
 * stale that figure is, and the button that adds another. A tab is *not* a claim that the
 * account is connected — that is what the presence dot on its avatar says, and the two are
 * separate on purpose.
 *
 * The wallet on a chip is the last observed balance. It is captioned by its own staleness
 * because a balance from three days ago looks exactly like a balance from a minute ago, and
 * the difference is the whole question.
 */
export function AccountBar({
  accounts,
  holdings,
  connections,
  connecting,
  scope,
  onSelect,
  onAddAccount,
  canAdd = true,
  busy,
  aside,
  venues,
  now = new Date()
}: {
  accounts: readonly AccountTab[];
  holdings: readonly AccountHoldings[];
  connections: readonly AccountConnection[];
  connecting?: ReadonlySet<string> | undefined;
  /**
   * Each account's CSFloat status, for the one mark the presence dot cannot carry: a venue's
   * ruling on the account. Suspended reads red, a stall away reads amber, and neither is the
   * connection — a suspended account is connected, and that is exactly why it needs its own mark.
   */
  venues?: Readonly<Record<string, MarketplaceStatus | undefined>> | undefined;
  /** `null` is the all-accounts scope. */
  scope: string | null;
  onSelect: (accountId: string | null) => void;
  onAddAccount: () => void;
  /** False when accounts are added elsewhere: a connected engine host's are its own (remote engine host plan D5). */
  canAdd?: boolean | undefined;
  busy: boolean;
  /**
   * The right-hand end of this row, outside the part that scrolls.
   *
   * Window-level chrome that belongs to the accounts rather than to the open section — the work
   * indicator is the one — sits here so it keeps its place when twenty tabs push the row sideways.
   */
  aside?: React.ReactNode;
  now?: Date;
}): React.JSX.Element {
  const summaries = accounts.map((account) => describeConnection(
    connections.find((row) => row.accountId === account.accountId)
  ));
  return (
    <div className="account-bar">
      <div className="account-bar-scroll">
        {/* Only tabs belong in a tablist, so Add account sits beside it rather than inside it. */}
        <div className="account-tabs" role="tablist" aria-label="Accounts">
          <button
            type="button"
            role="tab"
            className="account-tab"
            data-selected={scope === null}
            aria-selected={scope === null}
            onClick={() => onSelect(null)}
          >
            <AvatarStack accounts={accounts.map((account) => ({ name: account.accountName, photo: account.avatarRef }))} />
            <span className="account-tab-text">
              <span className="account-tab-name">All accounts</span>
              <span className="account-tab-meta">
                <span className="conn-dot" data-tone={worstTone(summaries)} aria-hidden="true" />
                {plural(accounts.length, 'account')}
              </span>
            </span>
          </button>

          {accounts.map((account, index) => {
            const holding = holdings.find((row) => row.accountId === account.accountId);
            const age = freshness(holding?.wallet?.observedAt ?? null, now);
            const selected = scope === account.accountId;
            const connection = summaries[index]!;
            const isConnecting = connecting?.has(account.accountId) ?? false;
            const venue = venues?.[account.accountId];
            const flag = venue?.restriction && venue.restriction.state !== 'ended'
              ? { icon: 'ban' as const, tone: 'negative', title: 'Suspended on CSFloat' }
              : venue?.stall.away ? { icon: 'eye-off' as const, tone: 'warn', title: 'CSFloat stall is away' } : null;
            return (
              <button
                key={account.accountId}
                type="button"
                role="tab"
                className="account-tab"
                data-selected={selected}
                aria-selected={selected}
                // The tooltip carries the sentence; the dot carries the glance. A dot alone
                // cannot say "close CS2 on the other computer", which is the only useful thing
                // to know when it is amber.
                title={`${account.accountName} · Steam ID ${account.steamId64}\n${isConnecting ? 'Connecting…' : connection.detail}${holding?.wallet ? `\nWallet read ${age.label}` : ''}${flag ? `\n${flag.title}` : ''}`}
                onClick={() => onSelect(account.accountId)}
              >
                <Avatar name={account.accountName} size={30} presence={isConnecting ? 'connecting' : connection.tone} photo={account.avatarRef} />
                <span className="account-tab-text">
                  <span className="account-tab-name">
                    {account.accountName}
                    {flag ? <span className="account-tab-flag" data-tone={flag.tone} aria-label={flag.title}><Icon name={flag.icon} size={11} /></span> : null}
                  </span>
                  <span className="account-tab-meta" data-tone={age.tone}>
                    {holding?.wallet ? (
                      <>
                        <Icon name="wallet" size={11} />
                        {formatAmount(holding.wallet.balanceCents, holding.currency)}
                      </>
                    ) : (
                      <span className="account-tab-conn" data-tone={connection.tone}>{isConnecting ? 'connecting…' : connection.label}</span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {canAdd ? (
          <button type="button" className="account-tab account-tab-add" disabled={busy} onClick={onAddAccount} title="Sign in to another Steam account">
            <Icon name="user-plus" size={15} />
            <span className="account-tab-name" style={{ fontWeight: 500 }}>Add account</span>
          </button>
        ) : null}
      </div>

      {aside ? <div className="account-bar-aside">{aside}</div> : null}
    </div>
  );
}
