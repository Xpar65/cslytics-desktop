import React, { useEffect, useState } from 'react';
import type { AccountLaunch } from '../../../shared/api.js';
import type { AccountCard } from '../accounts/AccountsPanel.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, IconButton, KeyValue, Metric, Notice, Panel, PanelHeader, ProgressBar, StatusBadge, Switch } from '../../components/ui.js';
import { Tip } from '../../components/Tip.js';
import { engine, type HistoryCoverageRow, type ScopeStatusRow } from '../../lib/engine.js';
import { VenueMark } from '../../components/VenueMark.js';
import { accountAction, describeConnection, type ConnectionTone } from '../../lib/connection.js';
import { formatAmount } from '../../lib/money.js';
import { plural, type Tone } from '../../lib/labels.js';
import { freshness, heldCounts } from '../../lib/portfolio.js';
import type { AccountConnection, AccountHoldings } from '../../lib/types.js';

/**
 * The Steam side of one account: the two sessions, the wallet, and who it is.
 *
 * Steam and the CS2 Game Coordinator are two rows because they fail separately, and the most
 * confusing failure this app has is the one where Steam is fine and only the GC is gone — another
 * computer is playing CS2. A single light would send someone to sign in again, which cannot help.
 * The buttons follow `accountAction`: Connect reuses the saved session, Sign in costs a Guard
 * code, and offering the wrong one is a bug rather than a preference.
 *
 * Below them, what this desktop does with the account when it opens. Two switches for the same
 * two sessions: an account can stay signed out until someone presses Connect, or sign in to Steam
 * and leave CS2 alone for a game on another computer. They are `settings.json`'s, not the
 * engine's, and each shows what was stored rather than what was asked for.
 */
const TONE: Record<ConnectionTone, Tone> = { live: 'positive', partial: 'quiet', blocked: 'accent', offline: 'negative' };

function steamRow(connection: AccountConnection | undefined): { icon: IconName; tone: Tone; text: string; detail: string | null } {
  const steam = connection?.steam;
  if (!steam || steam.kind === 'signed-out') return { icon: 'circle', tone: 'quiet', text: 'Signed out', detail: null };
  if (steam.kind === 'authenticating') return { icon: 'loader', tone: 'accent', text: 'Signing in…', detail: null };
  if (steam.kind === 'expired') return { icon: 'x-circle', tone: 'negative', text: 'Expired', detail: steam.reason };
  return { icon: 'check-circle', tone: 'positive', text: 'Signed in', detail: null };
}

function gcRow(connection: AccountConnection | undefined): { icon: IconName; tone: Tone; text: string; detail: string | null } {
  const gc = connection?.gc;
  if (!gc || gc.state === 'DISCONNECTED') return { icon: 'circle', tone: 'quiet', text: 'Off', detail: gc?.detail ?? null };
  if (gc.state === 'BLOCKED_ELSEWHERE') return { icon: 'monitor', tone: 'warn', text: 'Open on another computer', detail: 'Close CS2 there, then reconnect.' };
  return { icon: 'check-circle', tone: 'positive', text: 'Live', detail: null };
}

/** What each of the two sessions lets the app do, behind the "i" on the Session panel. */
const SESSION_INFO = (
  <>
    <div className="panel-info-columns">
      <div>
        <div className="panel-info-title"><Icon name="globe" size={13} />Steam</div>
        <ul>
          <li>Your Community Market listings, sales history and buy orders</li>
          <li>Listing and delisting items, placing and cancelling buy orders</li>
          <li>Your Steam Wallet balance</li>
          <li>Sending, accepting and tracking trade offers</li>
        </ul>
      </div>
      <div>
        <div className="panel-info-title"><Icon name="gamepad" size={13} />CS2</div>
        <ul>
          <li>Your inventory and what is inside each storage unit</li>
          <li>Moving items into and out of storage units, and renaming them</li>
          <li>Buying from the CS2 store</li>
        </ul>
      </div>
    </div>
    <div className="panel-info-note">
      <p>
        CS2 runs on one computer at a time. Opening CS2 elsewhere on this account takes the session
        from this app while Steam keeps working; close the game there, then reconnect here.
      </p>
      <p>
        Signing in saves a Steam login token, encrypted by Windows, so later launches reconnect
        without a password or Guard code. Your password is not saved, and neither are your Steam
        Guard secrets: new listings and trade offers wait for you to confirm them in the Steam
        Mobile app.
      </p>
    </div>
  </>
);

export function SteamAccountPage({ account, remote, connection, connecting, holding, lastError, busy, launch, onLaunch, onConnect, onSignIn, onSignOut }: {
  account: AccountCard;
  /** The account is a connected engine host's (remote engine host plan D5, D6): nothing here connects, signs in or out. */
  remote: boolean;
  connection: AccountConnection | undefined;
  connecting: boolean;
  holding: AccountHoldings | undefined;
  lastError: string | null;
  busy: boolean;
  /** This account's launch preferences; null until `settings.json` has been read. */
  launch: AccountLaunch | null;
  onLaunch: (next: AccountLaunch) => Promise<void>;
  onConnect: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const summary = describeConnection(connection);
  const action = accountAction({ phase: connection?.phase, hasSavedCredential: connection?.hasSavedCredential ?? account.hasSession, connecting });
  const signedIn = connection?.steam.kind === 'authenticated';
  const steam = steamRow(connection);
  const gc = gcRow(connection);
  const age = freshness(holding?.wallet?.observedAt ?? null);
  const held = holding ? heldCounts(holding.counts) : null;
  const [copied, setCopied] = useState(false);

  return (
    <div className="stack-lg" data-testid="steam-page">
      <Panel>
        <PanelHeader
          mark={<VenueMark venue="steam" size={16} />}
          title="Session"
          info={{ label: 'What signing in allows', content: SESSION_INFO }}
          badge={<StatusBadge label={connecting ? 'connecting…' : summary.label} tone={connecting ? 'accent' : TONE[summary.tone]} title={summary.detail} />}
        />
        <div className="panel-body stack">
          <div className="session-rows">
            <div className="session-row" data-tone={steam.tone}>
              <span className="session-icon"><Icon name="globe" size={15} /></span>
              <span className="session-name">Steam</span>
              <span className="session-state"><Icon name={steam.icon} size={13} />{steam.text}</span>
              {steam.detail ? <span className="session-detail">{steam.detail}</span> : null}
            </div>
            <div className="session-row" data-tone={gc.tone}>
              <span className="session-icon"><Icon name="gamepad" size={15} /></span>
              <span className="session-name">CS2</span>
              <span className="session-state"><Icon name={gc.icon} size={13} />{connecting ? 'connecting…' : gc.text}</span>
              {gc.detail && !connecting ? <span className="session-detail">{gc.detail}</span> : null}
            </div>
          </div>

          {!connecting && lastError && action === 'sign-in' && !remote ? (
            <Notice tone="unknown" role="status" title="Steam would not accept the saved session">{lastError}</Notice>
          ) : null}

          {remote ? (
            <p className="quiet" data-testid="steam-host-note">Managed by the engine host.</p>
          ) : <div className="toolbar">
            {action === 'connect' ? <Button variant="primary" icon="link" disabled={busy} onClick={onConnect}>{signedIn ? 'Connect CS2' : 'Connect'}</Button> : null}
            {action === 'sign-in' ? <Button variant="primary" icon="log-in" disabled={busy} onClick={onSignIn}>Sign in</Button> : null}
            {action === 'connecting' ? <Button variant="primary" loading disabled>Connecting</Button> : null}
            {action === 'none' && summary.gcReady ? (
              <Button icon="refresh" disabled={busy} onClick={onConnect} title="Asks Steam for a Game Coordinator session again. A live one is confirmed rather than replaced.">Reconnect CS2</Button>
            ) : null}
            <span className="toolbar-spacer" />
            {signedIn ? (
              <Button variant="ghost" icon="log-out" disabled={busy || connecting} onClick={onSignOut} title="Ends the session in this window. The saved sign-in is kept.">Sign out</Button>
            ) : null}
          </div>}
        </div>
      </Panel>

      {remote ? null : <LaunchPanel launch={launch} onLaunch={onLaunch} />}

      <div className="metrics">
        <Metric label="Wallet" icon="wallet" tone="accent" value={formatAmount(holding?.wallet?.balanceCents ?? null, holding?.currency ?? null)} note={holding?.wallet ? age.label : undefined} />
        <Metric label="Inventory" icon="package" value={(held?.main ?? 0).toLocaleString()} />
        <Metric label="Storage" icon="archive" value={(held?.crated ?? 0).toLocaleString()} note={`in ${plural(holding?.counts.storageUnits ?? 0, 'unit')}`} />
        <Metric label="Listed" icon="tag" value={holding ? (holding.counts.listingsActive + holding.counts.listingsOnHold).toLocaleString() : '—'} />
        <Metric label="Buy orders" icon="receipt" value={(holding?.counts.buyOrdersActive ?? 0).toLocaleString()} />
      </div>

      <HistoryPanel accountId={account.accountId} />

      <Panel>
        <PanelHeader icon="user" title="Identity" />
        <div className="panel-body">
          <KeyValue rows={[
            { label: 'Steam ID', mono: true, value: (
              <span className="inline">
                {account.steamId64}
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
              </span>
            ) },
            { label: 'Account', value: account.accountName },
            { label: 'Display name', value: account.personaName ?? '—' }
          ]} />
        </div>
      </Panel>
    </div>
  );
}

const HISTORIES: ReadonlyArray<{ surface: HistoryCoverageRow['surface']; label: string; unit: string }> = [
  { surface: 'steam-market-history', label: 'Market history', unit: 'events' },
  { surface: 'steam-trade-history', label: 'Trade history', unit: 'trades' }
];

const HISTORY_INFO = (
  <>
    <p>
      Steam keeps every sale, purchase and trade this account ever made. The record reads each log
      from the newest entry down, a few pages every couple of minutes, because Steam refuses an
      account that asks for its whole history at once. The figure is how much of Steam's own count
      the record holds so far.
    </p>
    <p>
      Reading pauses when Steam asks this account to slow down, and carries on by itself. Refresh
      now reads what is new; it never hurries the older pages.
    </p>
  </>
);

/**
 * How much of each history the record holds, and whether it is still reading.
 *
 * Two logs, two meters, each from `history.coverage` and the broker's own word on the scope
 * (`refresh.status`): a meter alone would show a backfill the venue has paused as merely slow. The
 * figures are Steam's and move as new entries land, so a complete history can read as owed again
 * for a minute after a sale. Re-read on every change notice for the account, because a walk that
 * failed sends none, and on a slow tick for the same reason.
 */
function HistoryPanel({ accountId }: { accountId: string }): React.JSX.Element {
  const [rows, setRows] = useState<HistoryCoverageRow[]>([]);
  const [scopes, setScopes] = useState<ScopeStatusRow[]>([]);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void engine.readHistoryCoverage(accountId).then((next) => { if (live) setRows(next); }).catch(() => undefined);
      void engine.readRefreshStatus([accountId]).then(([status]) => { if (live) setScopes(status?.scopes ?? []); }).catch(() => undefined);
    };
    read();
    const unsubscribe = engine.subscribeToChanges((notice) => { if (notice.accountId === accountId) read(); });
    const tick = setInterval(read, 30_000);
    return () => { live = false; unsubscribe(); clearInterval(tick); };
  }, [accountId]);

  return (
    <Panel>
      <PanelHeader icon="history" title="History" info={{ label: 'How history is read', content: HISTORY_INFO }} />
      <div className="panel-body history-rows" data-testid="history-coverage">
        {HISTORIES.map(({ surface, label, unit }) => {
          const row = rows.find((candidate) => candidate.surface === surface);
          const scope = scopes.find((candidate) => candidate.ref.surface === surface && candidate.ref.scope.kind === 'account');
          const state = historyState(row, scope);
          const covered = row?.covered ?? 0;
          const total = row?.total ?? null;
          return (
            <div key={surface} className="history-row" data-surface={surface} data-state={state.kind}>
              <div className="history-head">
                <span className="history-name">{label}</span>
                <span className="history-figure num">{total === null ? covered.toLocaleString() : `${covered.toLocaleString()} of ${total.toLocaleString()}`} {unit}</span>
              </div>
              <ProgressBar value={covered} max={total ?? Math.max(covered, 1)} tone={state.tone} label={`${label}: ${covered} of ${total ?? 'unknown'} ${unit}`} />
              <div className="history-state quiet">
                {state.detail ? <Tip content={state.detail}>{state.text}</Tip> : state.text}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

type HistoryState = { kind: 'unread' | 'reading' | 'paused' | 'stopped' | 'complete'; text: string; detail?: string; tone: 'accent' | 'positive' | 'warn' };

/** The state a meter shows under it: the broker's hold first, then the coverage's own word. */
export function historyState(row: HistoryCoverageRow | undefined, scope: ScopeStatusRow | undefined): HistoryState {
  if (!row || row.observedAt === null) return { kind: 'unread', text: 'not read yet', tone: 'accent' };
  if (scope?.state === 'held' && scope.until) {
    const until = new Date(scope.until);
    const text = `paused until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return { kind: 'paused', text, tone: 'warn', ...(scope.reason ? { detail: `Steam answered: ${scope.reason}. Reading carries on by itself.` } : {}) };
  }
  if (row.stopped) return { kind: 'stopped', text: 'stopped before the end', detail: `The older pages could not be followed (${row.stopped}). A later read of new entries starts them again.`, tone: 'warn' };
  if (row.remaining === null || row.remaining > 0) return { kind: 'reading', text: 'reading older pages', tone: 'accent' };
  return { kind: 'complete', text: `complete, ${freshness(row.observedAt).label}`, tone: 'positive' };
}

/**
 * What this desktop does with the account when it opens.
 *
 * CS2 means nothing without Steam, so its switch is off and disabled while sign-in is; its own
 * choice is kept underneath and comes back when sign-in does. Each change writes at once and the
 * switches then show what `settings.json` holds — there is no Save button. A change applies at the
 * next launch: it signs nothing in or out now.
 */
function LaunchPanel({ launch, onLaunch }: {
  launch: AccountLaunch | null;
  onLaunch: (next: AccountLaunch) => Promise<void>;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (next: AccountLaunch): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onLaunch(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel>
      <PanelHeader icon="play" title="When CSlytics opens" />
      <div className="panel-body stack">
        <Switch
          checked={launch?.signIn ?? true}
          disabled={launch === null || saving}
          label="Sign in to Steam"
          hint="Off, nothing signs in until you press Connect."
          onChange={(signIn) => { if (launch) void change({ ...launch, signIn }); }}
        />
        <Switch
          checked={(launch?.signIn ?? true) && (launch?.cs2 ?? true)}
          disabled={launch === null || saving || !launch.signIn}
          label="Connect to CS2"
          hint="Needed for inventory and storage units."
          onChange={(cs2) => { if (launch) void change({ ...launch, cs2 }); }}
        />
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}
