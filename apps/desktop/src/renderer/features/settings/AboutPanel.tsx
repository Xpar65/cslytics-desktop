import React, { useCallback, useEffect, useState } from 'react';
import type { ReleaseStatus, UpdateState } from '../../../shared/release.js';
import { engine } from '../../lib/engine.js';
import { Button, KeyValue, Notice, Panel, PanelHeader } from '../../components/ui.js';

/**
 * Settings › General › About: which build this is, whether a newer one is waiting, and whether the
 * stop switch has refused anything in this version and why (desktop release plan §4, §5).
 *
 * Everything shown is main's answer to `release.status`, read again on each `release` change
 * notice. The reasons under a retirement or a pause are the release host's own words; the
 * notification that sends a person here carries only this repository's.
 */
export function AboutPanel(): React.JSX.Element {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((): void => {
    void engine.releaseStatus().then(setStatus).catch((failure: unknown) => setError(message(failure)));
  }, []);

  useEffect(() => {
    read();
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('release')) read();
    });
  }, [read]);

  async function act(run: () => Promise<ReleaseStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await run());
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  const update = status?.update;
  return (
    <Panel>
      <PanelHeader title="About" icon="info" />
      <div className="panel-body stack" data-testid="about-panel">
        <KeyValue rows={[
          { label: 'Version', value: status ? `CSlytics ${status.version}` : '…' },
          { label: 'Updates', value: update ? describeUpdate(update) : '…' }
        ]} />
        {update?.phase === 'ready' ? (
          <div className="toolbar">
            <Button variant="primary" icon="download" loading={busy} onClick={() => void act(engine.installUpdate)}>
              Restart to update
            </Button>
          </div>
        ) : status?.packaged && update?.phase !== 'disabled' ? (
          <div className="toolbar">
            <Button icon="refresh" loading={busy || update?.phase === 'checking'} onClick={() => void act(engine.checkForUpdate)}>
              Check for updates
            </Button>
          </div>
        ) : null}
        {status?.policy.retired ? (
          <Notice tone="error" role="alert" title="This version can no longer trade">
            {status.policy.retired.reason} Update to {status.policy.retired.below} or later to list, delist, transfer or move items again.
          </Notice>
        ) : null}
        {status && !status.policy.retired ? status.policy.paused.map((rule) => (
          <Notice key={rule.commands.join(',')} tone="warn" title="Paused in this version">
            {rule.reason} Update to {rule.below} or later. Paused: <code>{rule.commands.join(', ')}</code>
          </Notice>
        )) : null}
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function describeUpdate(update: UpdateState): string {
  switch (update.phase) {
    case 'disabled': return update.reason;
    case 'idle': return 'Not checked yet';
    case 'checking': return 'Checking…';
    case 'current': return `Up to date · checked ${new Date(update.checkedAt).toLocaleString()}`;
    case 'downloading': return `Downloading ${update.version} · ${update.percent}%`;
    case 'ready': return `${update.version} is ready to install`;
    case 'error': return `Could not check for updates: ${update.message}`;
  }
}

function message(failure: unknown): string {
  const text = failure instanceof Error ? failure.message : String(failure);
  return text.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim();
}
