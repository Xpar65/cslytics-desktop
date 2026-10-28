import React, { useCallback, useEffect, useState } from 'react';
import { ENGINE_HOST_SURFACE, type EngineStatus } from '../../../shared/api.js';
import { engine } from '../../lib/engine.js';
import { Button, Field, KeyValue, Notice, Panel, PanelHeader, StatusBadge } from '../../components/ui.js';
import type { Tone } from '../../lib/labels.js';

/**
 * Settings › This desktop › Engine host (remote engine host plan D2, D8): which engine this window
 * drives, and the form that points it at a host on another machine.
 *
 * Everything shown is main's answer to `engine.status`, read again on each `engine-host` change
 * notice. The token goes one way, into the vault; no answer carries it back, and the field is
 * cleared once it has been sent. The host's build is shown beside this desktop's version because
 * the two are meant to be built together (D8): when they were not, a command the host does not
 * know answers with the host's own sentence and nothing else is disabled.
 */
export function EngineHostPanel(): React.JSX.Element {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((): void => {
    void engine.engineStatus().then((next) => {
      setStatus(next);
      if (next.kind === 'remote') {
        setUrl((current) => current || next.url);
        setLabel((current) => current || next.label);
      }
    }).catch((failure: unknown) => setError(message(failure)));
  }, []);

  useEffect(() => {
    read();
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes(ENGINE_HOST_SURFACE)) read();
    });
  }, [read]);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await engine.connectHost({ url: url.trim(), label: label.trim(), token });
      setToken('');
      // Every read, cursor and connection the window holds belongs to the engine that was just
      // replaced; the reload opens on the new one, as a remove or reset reloads.
      window.location.reload();
    } catch (failure) {
      setError(message(failure));
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await engine.disconnectHost();
      window.location.reload();
    } catch (failure) {
      setError(message(failure));
      setBusy(false);
    }
  }

  const remote = status?.kind === 'remote' ? status : null;
  const state = remote ? describeState(remote) : null;

  return (
    <Panel>
      <PanelHeader
        icon="globe"
        title="Engine host"
        badge={state ? <StatusBadge label={state.label} tone={state.tone} icon={state.icon} title={remote?.detail ?? undefined} /> : null}
      />
      <div className="panel-body stack" data-testid="engine-host-page" data-kind={status?.kind ?? 'loading'} data-state={remote?.state ?? 'local'}>
        <p className="quiet">
          Drive an engine host running elsewhere instead of the engine on this computer. Your accounts and the trading record then stay on that machine.
        </p>
        <KeyValue rows={[
          { label: 'Engine', value: status === null ? '…' : remote ? `${remote.label} · ${remote.url}` : 'On this computer' },
          { label: 'This desktop', value: status ? `CSlytics ${status.desktopVersion}` : '…' },
          ...(remote ? [
            { label: 'Host build', value: remote.build ?? 'Not reported by this host' },
            { label: 'Accounts', value: remote.accounts.length === 0 ? (remote.state === 'connected' ? 'None' : '…') : remote.accounts.join(', ') },
            { label: 'Since', value: new Date(remote.since).toLocaleString() }
          ] : [])
        ]} />
        {remote?.detail && remote.state !== 'connected' ? (
          <Notice tone={remote.state === 'refused' ? 'error' : 'warn'} role="status" title={state?.label}>{remote.detail}</Notice>
        ) : null}
        {remote && remote.build === null && remote.state === 'connected' ? (
          <Notice tone="unknown" role="status">
            This host does not say which engine build it runs, so whether it was built with this desktop cannot be checked. A command it does not know answers with its own sentence.
          </Notice>
        ) : null}
        <Field label="Host address" hint="With its http:// or https:// scheme.">
          <input className="input" type="url" value={url} disabled={busy} placeholder="address and port" autoComplete="off" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label="Label">
          <input className="input" type="text" value={label} disabled={busy} maxLength={64} placeholder="Optional" autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="Token" hint={remote ? 'Leave blank to keep the one already stored.' : 'Kept encrypted on this computer.'}>
          <input className="input" type="password" value={token} disabled={busy} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
        </Field>
        <div className="toolbar">
          <Button variant="primary" icon="link" loading={busy} disabled={url.trim() === ''} onClick={() => void connect()}>
            {remote ? 'Reconnect' : 'Connect to host'}
          </Button>
          {remote ? (
            <Button icon="unlink" disabled={busy} onClick={() => void disconnect()} title="Back to the engine on this computer. The host keeps running; the token stays stored.">
              Use this computer
            </Button>
          ) : null}
        </div>
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function describeState(status: Extract<EngineStatus, { kind: 'remote' }>): { label: string; tone: Tone; icon: 'check-circle' | 'loader' | 'wifi-off' | 'x-circle' } {
  switch (status.state) {
    case 'connected': return { label: 'Connected', tone: 'positive', icon: 'check-circle' };
    case 'connecting': return { label: 'Connecting…', tone: 'accent', icon: 'loader' };
    case 'unreachable': return { label: 'Unreachable', tone: 'negative', icon: 'wifi-off' };
    case 'refused': return { label: 'Token refused', tone: 'negative', icon: 'x-circle' };
  }
}

function message(failure: unknown): string {
  const text = failure instanceof Error ? failure.message : String(failure);
  return text.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim();
}
