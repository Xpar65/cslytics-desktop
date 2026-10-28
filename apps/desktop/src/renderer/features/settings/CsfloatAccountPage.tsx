import React, { useEffect, useState } from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import { engine } from '../../lib/engine.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Badge, Button, IconButton, Metric, Notice, Panel, PanelHeader, ProgressBar, Switch } from '../../components/ui.js';
import { formatDateTime, formatRelative, formatUsd, humanize, plural } from '../../lib/labels.js';
import { MarketplacePanel } from './MarketplacePanel.js';
import { STANDING_SCALE, feeRate, pendingCounts, readinessRows, standingView, statisticRows, type ReadinessTone } from './csfloat-profile.js';

/**
 * One account's CSFloat page.
 *
 * Top to bottom: what the venue has ruled (only when there is something to say), the money, the
 * stall's two switches, readiness (shown, never enforced), the counts CSFloat keeps, and the
 * connection itself. The connection panel is `MarketplacePanel`, unchanged, because it is where
 * the key rules live and what the live journeys drive.
 *
 * The switches show `/me` read back after every change, never the request (CSF-28). While a
 * change is in flight they are disabled rather than optimistic: a switch that moved on its own
 * and then moved back is how a person learns to distrust the page.
 *
 * A suspension that has ended stays on screen until dismissed, because the thing it leaves
 * behind — a stall still away — is what the person has to undo, and a band that faded on its own
 * would take the reminder with it. The dismissal is this computer's, so it lives in localStorage.
 */
const DISMISSED_KEY = 'cslytics.settings.dismissed-suspension';

function dismissedUntil(accountId: string): string | null {
  try { return localStorage.getItem(`${DISMISSED_KEY}:${accountId}`); } catch { return null; }
}

/** Forgets this page's dismissal for one account; removing or resetting the account calls it. */
export function forgetDismissedSuspension(accountId: string): void {
  try { localStorage.removeItem(`${DISMISSED_KEY}:${accountId}`); } catch { /* nothing was kept */ }
}

const READINESS_ICON: Record<ReadinessTone, { icon: IconName; tone: string }> = {
  ok: { icon: 'check-circle', tone: 'positive' },
  attention: { icon: 'alert-triangle', tone: 'warn' },
  off: { icon: 'circle', tone: 'quiet' },
  unknown: { icon: 'circle-dot', tone: 'quiet' }
};

export function CsfloatAccountPage({ accountId, status, onChanged }: {
  accountId: string;
  status: MarketplaceStatus | null;
  onChanged: (status: MarketplaceStatus) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<'away' | 'public' | 'check' | 'eligibility' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => dismissedUntil(accountId));
  useEffect(() => { setDismissed(dismissedUntil(accountId)); setMessage(null); }, [accountId]);

  const connected = status?.status === 'CONNECTED';
  const hasKey = status !== null && status.status !== 'NOT_CONNECTED';
  const restriction = status?.restriction ?? null;
  const flags = status?.flags ?? {};

  async function act(kind: NonNullable<typeof busy>, work: () => Promise<MarketplaceStatus | void>, done?: string): Promise<void> {
    setBusy(kind);
    setMessage(null);
    try {
      const next = await work();
      if (next) onChanged(next);
      if (done) setMessage({ tone: 'success', text: done });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      // The venue's answer is whatever `/me` says now, not what was asked for.
      try { onChanged(await engine.marketplaceStatus(accountId)); } catch { /* the page keeps what it had */ }
    } finally {
      setBusy(null);
    }
  }

  const stallBack = (): Promise<void> => act('away', () => engine.updateMarketplaceStall(accountId, { away: false }), 'Stall is back');

  const standing = !restriction ? null
    : restriction.state === 'suspended' ? (
      <Notice tone="error" role="status" title={`Suspended until ${formatDateTime(restriction.until)}`}>
        New listings refused · reprice and delist still work
      </Notice>
    ) : restriction.state === 'stale' ? (
      <Notice tone="warn" role="status" title={`Suspension due to have ended ${formatRelative(restriction.until)}`}
        action={<Button size="sm" icon="refresh" loading={busy === 'check'} disabled={busy !== null} onClick={() => void act('check', () => engine.refreshMarketplace(accountId))}>Check now</Button>}>
        Blocked until CSFloat confirms it
      </Notice>
    ) : dismissed === restriction.until ? null : (
      <Notice tone="warn" role="status" title={`Suspension ended ${formatRelative(restriction.until)}`}
        action={<span className="inline">
          {status?.stall.away ? <Button size="sm" icon="eye" loading={busy === 'away'} disabled={busy !== null || !connected} onClick={() => void stallBack()}>Bring stall back</Button> : null}
          <IconButton icon="x" size="sm" label="Dismiss" onClick={() => {
            try { localStorage.setItem(`${DISMISSED_KEY}:${accountId}`, restriction.until); } catch { /* remembered for this session only */ }
            setDismissed(restriction.until);
          }} />
        </span>}>
        {status?.stall.away ? 'Stall still away · listings hidden' : null}
      </Notice>
    );

  const readiness = readinessRows(flags);
  const statistics = statisticRows(flags);
  const pending = pendingCounts(flags);
  const fee = feeRate(flags['fee']);
  const withdraw = feeRate(flags['withdraw_fee']);
  const rating = standingView(status?.standing);

  return (
    <div className="stack-lg" data-account-id={accountId} data-testid="csfloat-page">
      {standing}

      {hasKey ? (
        <Panel>
          <PanelHeader
            icon="shield-check"
            title="Standing"
            badge={rating ? <Badge tone="quiet" icon="clock">{formatRelative(rating.observedAt)}</Badge> : null}
          />
          <div className="panel-body stack" data-testid="csfloat-standing">
            {/* The venue's own scale, every step named, the current one lit. */}
            <div className="standing-meter" role="img" aria-label={rating ? `Standing: ${rating.label}` : 'Standing not read'}>
              {STANDING_SCALE.map((step, index) => (
                <span
                  key={step.value}
                  className="standing-step"
                  data-tone={step.tone}
                  data-active={rating?.index === index || undefined}
                  data-passed={rating !== null && rating.index !== null && index < rating.index ? 'true' : undefined}
                >
                  {step.label}
                </span>
              ))}
            </div>
            {rating ? (
              <div className="standing-facts">
                {rating.daysToImprove !== null ? (
                  <span className="inline"><Icon name="clock" size={13} />Improves in {plural(rating.daysToImprove, 'day')}</span>
                ) : null}
                {rating.nextPenalty ? (
                  <span className="inline quiet"><Icon name="alert-triangle" size={13} />Next: {rating.nextPenalty.toLowerCase()}</span>
                ) : null}
              </div>
            ) : null}
            {rating && rating.penaltyProgress !== null && rating.penaltyProgress > 0 ? (
              <ProgressBar value={rating.penaltyProgress} max={1} tone="warn" label="Penalty progress" />
            ) : null}
            {rating && rating.restrictions.length > 0 ? (
              <div className="restrictions">
                {rating.restrictions.map((row) => (
                  <span key={`${row.category}:${row.createdAt}`} className="restriction" data-category={row.category}>
                    <Icon name={row.category === 'pardon' ? 'check-circle' : 'ban'} size={12} />
                    {humanize(row.category)}
                    <span className="quiet">{formatRelative(row.createdAt)}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {hasKey ? (
        <div className="metrics" data-testid="csfloat-balance">
          <Metric label="Available" icon="dollar-sign" tone="accent" value={formatUsd(status.availableCents)} note={status.observedAt ? formatRelative(status.observedAt) : 'not read yet'} />
          <Metric label="Pending" icon="hourglass" value={formatUsd(status.pendingCents)} />
          <Metric label="Fee" icon="percent" value={fee ?? '—'} note={withdraw ? `withdraw ${withdraw}` : undefined} />
          {pending.trades ? <Metric label="Trades to act on" icon="inbox" tone="accent" value={pending.trades.toLocaleString()} /> : null}
        </div>
      ) : null}

      {hasKey ? (
        <Panel>
          <PanelHeader icon="store" title="Stall" />
          <div className="panel-body stack" data-testid="csfloat-stall">
            <Switch
              checked={status.stall.away === true}
              disabled={busy !== null || !connected || status.stall.away === null}
              label="Away"
              hint="Hides every listing."
              onChange={(next) => void act('away', () => engine.updateMarketplaceStall(accountId, { away: next }))}
            />
            <Switch
              checked={status.stall.public === true}
              disabled={busy !== null || !connected || status.stall.public === null}
              label="Public"
              onChange={(next) => void act('public', () => engine.updateMarketplaceStall(accountId, { stallPublic: next }))}
            />
            {message ? <Notice tone={message.tone} role="status">{message.text}</Notice> : null}
          </div>
        </Panel>
      ) : null}

      {hasKey ? (
        <div className="grid-2">
          <Panel>
            <PanelHeader icon="shield-check" title="Readiness" />
            <div className="panel-body flush">
              <div className="readiness" data-testid="csfloat-readiness">
                {readiness.map((row) => (
                  <div key={row.key} className="readiness-row" data-tone={READINESS_ICON[row.tone].tone}>
                    <span className="readiness-icon"><Icon name={row.icon} size={14} /></span>
                    <span className="readiness-label">{row.label}</span>
                    <span className="readiness-value"><Icon name={READINESS_ICON[row.tone].icon} size={12} />{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
          <Panel>
            <PanelHeader icon="activity" title="Activity" />
            <div className="panel-body">
              {statistics.length > 0 ? (
                <div className="stat-row">
                  {statistics.map((row) => (
                    <span key={row.key} className="stat">
                      <span className="stat-value num">{row.value.toLocaleString()}</span>
                      <span className="stat-label">{row.label}</span>
                    </span>
                  ))}
                </div>
              ) : <span className="field-hint">—</span>}
            </div>
          </Panel>
        </div>
      ) : null}

      <MarketplacePanel
        accountId={accountId}
        status={status}
        onChanged={onChanged}
        footer={connected ? (
          <>
            <div className="toolbar">
              <Button
                size="sm"
                icon="shield-check"
                loading={busy === 'eligibility'}
                disabled={busy !== null}
                title="Reads the Steam inventory the way CSFloat sees it, to learn what can be listed."
                onClick={() => void act('eligibility', async () => { await engine.csfloatRefresh(accountId, true); }, 'Eligibility refreshed from CSFloat and Steam')}
              >
                Refresh eligibility
              </Button>
            </div>
            {message && busy === null ? <Notice tone={message.tone} role="status">{message.text}</Notice> : null}
          </>
        ) : null}
      />
    </div>
  );
}
