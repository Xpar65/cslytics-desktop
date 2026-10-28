import React from 'react';
import type { MarketplaceStatus } from '@cslytics/engine';
import { engine } from '../../lib/engine.js';
import { Button, Field, Notice, Panel, PanelHeader, StatusBadge } from '../../components/ui.jsx';
import type { IconName } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import type { Tone } from '../../lib/labels.js';
import { formatRelative } from '../../lib/labels.js';

/**
 * One account's CSFloat connection.
 *
 * Three things here are requirements rather than styling choices.
 *
 * The key field is `type="password"`, has `autoComplete="off"`, and is **cleared the moment the
 * call returns, whatever it returned** — including on failure, when the temptation to leave it
 * for another try is strongest. There is no path that reads a stored key back into this window
 * (CSF-03), so a key left in a form field is the only copy the renderer would ever hold.
 *
 * Every state is named, and they are not collapsed. "Throttled" and "Unavailable" are not
 * "Invalid key": the first two mean CSFloat did not answer and the stored credential is still
 * the right one, and showing them as a bad key would send the user hunting for a new key to fix
 * a network problem (CSF-21).
 *
 * Disconnect and Forget are separate buttons with different words, because one stops using a
 * credential and the other deletes it (CSF-02).
 */

const LABELS: Record<MarketplaceStatus['status'], { text: string; tone: Tone; icon: IconName; hint: string }> = {
  CONNECTED: { text: 'Connected', tone: 'positive', icon: 'check-circle', hint: 'Listings, sales and balances are read with the saved key.' },
  CHECKING: { text: 'Checking…', tone: 'accent', icon: 'loader', hint: 'Asking CSFloat whether the saved key still works.' },
  INVALID_KEY: { text: 'Key rejected', tone: 'negative', icon: 'x-circle', hint: 'CSFloat refused the saved key. Replace it below, or forget it.' },
  RESTRICTED: { text: 'Restricted by CSFloat', tone: 'warn', icon: 'ban', hint: 'The key works but CSFloat has restricted this account.' },
  THROTTLED: { text: 'Rate limited', tone: 'warn', icon: 'hourglass', hint: 'CSFloat asked us to slow down. The saved key is still in use.' },
  UNAVAILABLE: { text: 'CSFloat unreachable', tone: 'warn', icon: 'wifi-off', hint: 'CSFloat did not answer. The saved key is still in use.' },
  DISCONNECTED: { text: 'Disconnected', tone: 'quiet', icon: 'unlink', hint: 'The key is saved but not in use. Connect again to resume.' },
  NOT_CONNECTED: { text: 'Not connected', tone: 'quiet', icon: 'circle-dot', hint: 'Paste a developer key from your CSFloat profile to connect.' }
};

/** What a connected key lets the app do, behind the "i" on the panel. */
const KEY_INFO = (
  <>
    <div className="panel-info-title">A connected key lets this app</div>
    <ul>
      <li>Read your CSFloat balance, fees, standing and sales</li>
      <li>List items from your Steam inventory, change their prices and delist them</li>
      <li>Edit and cancel your CSFloat buy orders</li>
      <li>Set your stall away or public</li>
    </ul>
    <div className="panel-info-note">
      <p>
        A CSFloat sale is delivered by a Steam trade offer, so delivering one also needs Steam
        signed in, and you confirm the offer in the Steam Mobile app.
      </p>
      <p>
        Forget key deletes the key from this computer only. To stop it working anywhere, revoke it
        on your CSFloat profile.
      </p>
    </div>
  </>
);

export function MarketplacePanel({
  accountId,
  status,
  onChanged,
  footer
}: {
  accountId: string;
  status: MarketplaceStatus | null;
  onChanged: (status: MarketplaceStatus) => void;
  /** What the host does with a working connection, under the key controls. */
  footer?: React.ReactNode | undefined;
}): React.JSX.Element {
  const [apiKey, setApiKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const state = status?.status ?? 'NOT_CONNECTED';
  const label = LABELS[state];
  const hasKey = state !== 'NOT_CONNECTED';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await engine.connectMarketplace(accountId, apiKey);
      setMessage(explain(result));
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'The desktop connection is unavailable' });
    } finally {
      // Always, on every path: a failed attempt must not leave the key sitting in the DOM.
      setApiKey('');
      setBusy(false);
      try {
        onChanged(await engine.marketplaceStatus(accountId));
      } catch {
        // A status read that fails changes nothing about what was just done.
      }
    }
  }

  async function act(work: () => Promise<MarketplaceStatus>): Promise<void> {
    setBusy(true);
    try {
      onChanged(await work());
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'The desktop connection is unavailable' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelHeader
        mark={<VenueMark venue="csfloat" size={16} />}
        title="CSFloat"
        info={{ label: 'What a CSFloat key allows', content: KEY_INFO }}
        badge={<StatusBadge label={label.text} tone={label.tone} icon={label.icon} title={label.hint} />}
      />
      <div className="panel-body stack" data-testid="marketplace-panel" data-status={state}>
        {status?.remoteSteamId ? (
          <div className="field-hint" data-testid="marketplace-identity">
            Key belongs to CSFloat account {status.remoteSteamId}
            {status.checkedAt ? ` · last checked ${formatRelative(status.checkedAt)}` : ''}
          </div>
        ) : null}
        {status?.reason ? <div className="field-hint" data-testid="marketplace-reason">{status.reason}</div> : null}

        {hasKey ? (
          <div className="toolbar">
            <Button size="sm" icon="refresh" disabled={busy} data-testid="marketplace-refresh"
              onClick={() => void act(() => engine.refreshMarketplace(accountId))}>Check now</Button>
            {state !== 'DISCONNECTED' ? (
              <Button size="sm" icon="unlink" disabled={busy} data-testid="marketplace-disconnect" title="Stops using the key. It stays saved."
                onClick={() => void act(() => engine.disconnectMarketplace(accountId, 'disconnect'))}>Disconnect</Button>
            ) : null}
            <Button size="sm" variant="danger" icon="trash" disabled={busy} data-testid="marketplace-forget" title="Deletes the saved key from Windows. It is not revoked at CSFloat."
              onClick={() => void act(() => engine.disconnectMarketplace(accountId, 'forget'))}>Forget key</Button>
          </div>
        ) : null}

        <form onSubmit={(event) => void submit(event)} className="stack">
          <Field
            label={hasKey ? 'Replace the saved key' : 'CSFloat API key'}
            icon="key"
          >
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid="marketplace-key"
              value={apiKey}
              disabled={busy}
              placeholder="Paste your developer key"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" icon="link" loading={busy} disabled={busy || !apiKey.trim()} data-testid="marketplace-connect">
              {hasKey ? 'Replace key' : 'Connect'}
            </Button>
          </div>
        </form>
        {message ? <Notice tone={message.tone} role="status"><span data-testid="marketplace-message">{message.text}</span></Notice> : null}
        {footer}
      </div>
    </Panel>
  );
}

/** What happened, in words that name the next action rather than a status code. */
function explain(result: import('@cslytics/engine').ConnectResult): { tone: 'success' | 'error' | 'warn'; text: string } {
  if (result.kind === 'connected') return { tone: 'success', text: `Connected to CSFloat account ${result.remoteSteamId}.` };
  if (result.kind === 'identity-mismatch') {
    return { tone: 'error', text: `That key belongs to CSFloat account ${result.remoteSteamId}, not ${result.expectedSteamId}. Nothing was saved or replaced.` };
  }
  if (result.kind === 'rejected') return { tone: 'error', text: `CSFloat refused the key (${result.reason}). The saved connection is unchanged.` };
  return { tone: 'warn', text: `CSFloat could not be reached (${result.reason}). The saved connection is unchanged.` };
}
