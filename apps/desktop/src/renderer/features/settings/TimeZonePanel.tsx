import React, { useMemo, useState } from 'react';
import { Caption, Notice, Panel, PanelHeader, Select } from '../../components/ui.js';
import { chooseTimeZone, formatDateTime, timeZones, useTimeZone, utcOffsetLabel } from '../../lib/time.js';

/**
 * Settings › General › Time zone: which zone every date and time in the window is printed in.
 *
 * The default follows Windows. A chosen zone moves only the printing: a lock still lifts, and a
 * retry still fires, at the instant Steam or CSFloat named.
 */

const SYSTEM = '';

export function TimeZonePanel(): React.JSX.Element {
  const { settings, resolved, system } = useTimeZone();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(), []);

  async function choose(value: string): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await chooseTimeZone(value === SYSTEM ? null : value);
    } catch (failure) {
      setError(`The time zone could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <PanelHeader title="Time zone" icon="globe" />
      <div className="panel-body stack">
        <div className="currency-setting">
          <label className="currency-setting-label" htmlFor="time-zone">Show dates and times in</label>
          <Select label="Time zone" value={settings.zone ?? SYSTEM} disabled={saving} onChange={(value) => void choose(value)}>
            <option value={SYSTEM}>Match Windows · {system} ({utcOffsetLabel(system)})</option>
            {zones.map((zone) => <option key={zone} value={zone}>{zone} ({utcOffsetLabel(zone)})</option>)}
          </Select>
        </div>
        <Caption icon="clock" tone="quiet">
          Now {formatDateTime(new Date().toISOString())} · {resolved} ({utcOffsetLabel(resolved)})
        </Caption>
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}
