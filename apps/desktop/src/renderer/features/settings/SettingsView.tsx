import React, { useEffect, useState } from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import type { AccountLaunch } from '../../../shared/api.js';
import { engine } from '../../lib/engine.js';
import type { AccountCard } from '../accounts/AccountsPanel.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Empty, Notice, Panel, Switch } from '../../components/ui.js';
import { VenueMark } from '../../components/VenueMark.js';
import type { AccountConnection, AccountHoldings } from '../../lib/types.js';
import { MARKETPLACES, type VenueId } from '../../lib/marketplaces.js';
import type { SettingsPage } from '../../lib/sections.js';
import { accountAttention, type AttentionAction } from './attention.js';
import { AboutPanel } from './AboutPanel.js';
import { AppearancePanel } from './AppearancePanel.js';
import { CurrencyPanel } from './CurrencyPanel.js';
import { AccountOverview } from './AccountOverview.js';
import { CsfloatAccountPage } from './CsfloatAccountPage.js';
import { CslyticsAccountPage } from './CslyticsAccountPage.js';
import { EngineHostPanel } from './EngineHostPanel.js';
import { SteamAccountPage } from './SteamAccountPage.js';

/**
 * Settings: this desktop on one side, one account on the other.
 *
 * Two kinds of setting sit here and they are not the same kind. *General* is the window and the
 * one engine policy that applies to every account. *Account* is whichever account the bar above
 * has selected — the page has no picker of its own beyond the rail, so it can never disagree
 * with the header: on the all-accounts scope the rail lists the accounts, and picking one there
 * selects it in the bar the way clicking its tab would. Each marketplace is one entry in that
 * group; a third venue is one more entry, not a longer page.
 *
 * The rail remembers the last page on this computer. A per-account page remembered while the
 * scope is every account falls back to General rather than showing a page about nobody.
 */
export type { SettingsPage };

const DESKTOP_PAGES: ReadonlyArray<{ id: SettingsPage; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'cslytics', label: 'CSlytics account', icon: 'user' },
  { id: 'engine', label: 'Engine host', icon: 'globe' }
];
const ACCOUNT_PAGES: ReadonlyArray<{ id: SettingsPage; label: string; icon?: IconName; venue?: VenueId }> = [
  { id: 'overview', label: 'Overview', icon: 'user' },
  ...MARKETPLACES.map((market) => ({ id: market.id, label: market.label, venue: market.id }))
];
const PAGE_KEY = 'cslytics.settings.page';

function isAccountPage(page: SettingsPage): boolean {
  return ACCOUNT_PAGES.some((entry) => entry.id === page);
}

/**
 * The page Settings opens on next. The rail calls it on every pick; a page elsewhere calls it to
 * send someone to one page — a venue's plus opens that venue's — which is the same fact: Settings
 * opens where it was last asked to be.
 */
export function rememberSettingsPage(page: SettingsPage): void {
  try { localStorage.setItem(PAGE_KEY, page); } catch { /* remembered for this session only */ }
}

function rememberedPage(hasAccount: boolean): SettingsPage {
  let stored: string | null = null;
  try { stored = localStorage.getItem(PAGE_KEY); } catch { /* a private window remembers nothing */ }
  const known = [...DESKTOP_PAGES, ...ACCOUNT_PAGES].find((entry) => entry.id === stored)?.id;
  if (known && (hasAccount || !isAccountPage(known))) return known;
  return hasAccount ? 'overview' : 'general';
}

export function SettingsView({
  accounts, loaded, remote, account, connection, connecting, lastError, holding, venue, onVenue, busy,
  launch, onLaunch, onClear, onSelectAccount, onConnect, onSignIn, onSignOut, sidebarPinned, onSidebarPinned
}: {
  accounts: readonly AccountCard[];
  loaded: boolean;
  /** The engine is a connected host's (remote engine host plan D5): its accounts' sessions, data and the one engine preference are its own. */
  remote: boolean;
  /** The account the bar has selected; null is every account. */
  account: AccountCard | null;
  connection: AccountConnection | undefined;
  connecting: boolean;
  lastError: string | null;
  holding: AccountHoldings | undefined;
  venue: MarketplaceStatus | null;
  onVenue: (accountId: string, status: MarketplaceStatus) => void;
  busy: boolean;
  /** The selected account's launch preferences from `settings.json`; null until it has been read. */
  launch: AccountLaunch | null;
  onLaunch: (accountId: string, next: AccountLaunch) => Promise<void>;
  /** Remove or reset an account. Resolves only when it failed: success reloads the window. */
  onClear: (accountId: string, mode: 'remove' | 'reset') => Promise<void>;
  /** Selects the account in the bar; the rail offers this on the all-accounts scope. */
  onSelectAccount: (accountId: string) => void;
  onConnect: (accountId: string) => void;
  onSignIn: (account: AccountCard) => void;
  onSignOut: (accountId: string) => void;
  sidebarPinned: boolean;
  onSidebarPinned: (next: boolean) => void;
}): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>(() => rememberedPage(account !== null));
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (account === null && isAccountPage(page)) setPage('general');
  }, [account, page]);

  const open = (next: SettingsPage): void => {
    setPage(next);
    setNotice(null);
    rememberSettingsPage(next);
  };

  const attention = account ? accountAttention({ connection, connecting, venue, launch: launch ?? undefined, remote }) : [];

  async function act(kind: AttentionAction): Promise<void> {
    if (!account) return;
    if (kind === 'sign-in') { onSignIn(account); return; }
    if (kind === 'connect') { onConnect(account.accountId); return; }
    if (kind === 'replace-key') { open('csfloat'); return; }
    setActing(true);
    setNotice(null);
    try {
      const next = kind === 'stall-back'
        ? await engine.updateMarketplaceStall(account.accountId, { away: false })
        : await engine.refreshMarketplace(account.accountId);
      onVenue(account.accountId, next);
      if (kind === 'stall-back') setNotice({ tone: 'success', text: 'Stall is back' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      try { onVenue(account.accountId, await engine.marketplaceStatus(account.accountId)); } catch { /* keeps what it had */ }
    } finally {
      setActing(false);
    }
  }

  const navItem = (entry: { id: SettingsPage; label: string; icon?: IconName; venue?: VenueId }, mark?: React.ReactNode): React.JSX.Element => (
    <button
      key={entry.id}
      type="button"
      className="nav-item settings-nav-item"
      data-selected={page === entry.id}
      aria-current={page === entry.id ? 'page' : undefined}
      // The name is the label alone: a count or a dot beside it is a glance, not part of the name.
      aria-label={entry.label}
      onClick={() => open(entry.id)}
    >
      {entry.venue ? <VenueMark venue={entry.venue} size={16} decorative /> : <Icon name={entry.icon ?? 'circle'} size={16} />}
      <span className="nav-text">{entry.label}</span>
      {mark}
    </button>
  );

  const venueDot = (id: SettingsPage): React.ReactNode => {
    if (!account) return null;
    if (id === 'overview' && attention.length > 0) return <span className="nav-count" data-tone="warn">{attention.length}</span>;
    if (id === 'steam' && connection) return <span className="conn-dot" data-tone={connecting ? 'connecting' : connection.phase === 'CONNECTED' ? 'live' : connection.phase === 'BLOCKED_ELSEWHERE' ? 'blocked' : connection.steam.kind === 'authenticated' ? 'partial' : 'offline'} aria-hidden="true" />;
    if (id === 'csfloat' && venue && venue.status !== 'NOT_CONNECTED') {
      const tone = venue.restriction && venue.restriction.state !== 'ended' ? 'offline'
        : venue.status === 'CONNECTED' ? (venue.stall.away ? 'blocked' : 'live')
          : venue.status === 'INVALID_KEY' ? 'offline' : 'partial';
      return <span className="conn-dot" data-tone={tone} aria-hidden="true" />;
    }
    return null;
  };

  return (
    <div className="settings-layout" data-testid="settings-screen">
      <nav className="settings-rail" aria-label="Settings pages">
        <div className="nav-label">This desktop</div>
        {DESKTOP_PAGES.map((entry) => navItem(entry))}
        <div className="nav-label settings-rail-account">
          {account ? <Avatar name={account.accountName} size={16} photo={account.avatarRef} /> : <Icon name="users" size={12} />}
          <span className="ellipsis">{account ? account.accountName : 'Account'}</span>
        </div>
        {account
          ? ACCOUNT_PAGES.map((entry) => navItem(entry, venueDot(entry.id)))
          : accounts.map((row) => (
            // One row per account, where the pages would be: picking one is picking its tab.
            <button
              key={row.accountId}
              type="button"
              className="nav-item settings-nav-item settings-nav-account"
              aria-label={`Select ${row.accountName}`}
              onClick={() => { rememberSettingsPage('overview'); onSelectAccount(row.accountId); }}
            >
              <Avatar name={row.accountName} size={18} photo={row.avatarRef} />
              <span className="nav-text ellipsis">{row.accountName}</span>
              <Icon name="chevron-right" size={12} />
            </button>
          ))}
        {account === null && loaded && accounts.length === 0 ? <div className="settings-rail-hint">Add a Steam account first</div> : null}
      </nav>

      <div className="settings-page" key={`${page}:${account?.accountId ?? 'all'}`}>
        {page === 'general' ? (
          <>
            <AppearancePanel />
            <CurrencyPanel />
            <Panel>
              <div className="panel-body stack">
                <Switch
                  checked={sidebarPinned}
                  onChange={onSidebarPinned}
                  label="Keep the navigation open"
                />
              </div>
            </Panel>
            <ListingProtection accountId={accounts[0]?.accountId ?? null} remote={remote} />
            <AboutPanel />
          </>
        ) : null}

        {page === 'cslytics' ? <CslyticsAccountPage /> : null}
        {page === 'engine' ? <EngineHostPanel /> : null}

        {isAccountPage(page) && account === null ? (
          <Panel>
            <Empty
              icon={loaded ? 'users' : 'loader'}
              title={loaded ? (accounts.length === 0 ? 'No accounts yet' : 'Pick an account') : 'Loading your accounts…'}
              hint={loaded && accounts.length === 0 ? 'Add a Steam account first.' : undefined}
            />
          </Panel>
        ) : null}

        {account && page === 'overview' ? (
          <>
            {notice ? <Notice tone={notice.tone} role="status">{notice.text}</Notice> : null}
            <AccountOverview
              account={account}
              remote={remote}
              connection={connection}
              connecting={connecting}
              venue={venue}
              holding={holding}
              busy={busy || acting}
              launch={launch ?? undefined}
              onOpen={open}
              onAction={(kind) => void act(kind)}
              onSignOut={() => onSignOut(account.accountId)}
              onClear={(mode) => onClear(account.accountId, mode)}
            />
          </>
        ) : null}

        {account && page === 'steam' ? (
          <SteamAccountPage
            account={account}
            remote={remote}
            connection={connection}
            connecting={connecting}
            holding={holding}
            lastError={lastError}
            busy={busy}
            launch={launch}
            onLaunch={(next) => onLaunch(account.accountId, next)}
            onConnect={() => onConnect(account.accountId)}
            onSignIn={() => onSignIn(account)}
            onSignOut={() => onSignOut(account.accountId)}
          />
        ) : null}

        {account && page === 'csfloat' ? (
          <CsfloatAccountPage accountId={account.accountId} status={venue} onChanged={(next) => onVenue(account.accountId, next)} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Double-listing protection.
 *
 * The policy is one switch for every account. Its read is keyed by an account only because it
 * rides on the CSFloat overview, so any account answers it. After a change the switch shows what
 * the engine reads back, not what was asked for.
 */
function ListingProtection({ accountId, remote }: { accountId: string | null; remote: boolean }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let current = true;
    setEnabled(null);
    if (!accountId) return undefined;
    void engine.csfloatOverview(accountId)
      .then((overview) => { if (current) setEnabled(overview.policy.preventDuplicates); })
      .catch((error: unknown) => { if (current) setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [accountId]);

  async function change(next: boolean): Promise<void> {
    if (!accountId) return;
    setBusy(true);
    setMessage(null);
    try {
      await engine.csfloatProtection(next);
      const overview = await engine.csfloatOverview(accountId);
      setEnabled(overview.policy.preventDuplicates);
      setMessage({
        tone: 'success',
        text: overview.policy.preventDuplicates
          ? 'Double-listing protection is on for every account'
          : 'Double-listing protection is off: the same item may be advertised on two venues'
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <div className="panel-body stack">
        {accountId === null ? (
          <span className="field-hint">Add a Steam account to change this.</span>
        ) : (
          <Switch
            checked={enabled ?? false}
            disabled={busy || enabled === null || remote}
            label="Protect against double listing"
            hint={remote
              ? 'Set on the engine host. Refuses to list the same item on Steam and CSFloat at once.'
              : 'Refuses to list the same item on Steam and CSFloat at once.'}
            onChange={(next) => void change(next)}
          />
        )}
        {message ? <Notice tone={message.tone} role="status">{message.text}</Notice> : null}
      </div>
    </Panel>
  );
}
