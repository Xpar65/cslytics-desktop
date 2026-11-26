import React, { useEffect, useState } from 'react';
import { DEFAULT_APPLIED_VALUE, type AppliedValueSettings } from '../../../shared/api.js';
import { engine } from '../../lib/engine.js';
import { Button, Notice, Panel, PanelHeader } from '../../components/ui.js';

/**
 * Settings › General › Sticker and charm value: the three shares the inspector's estimate of what
 * is applied to an item is made from (`main/market-data/applied-value.ts`).
 *
 * Each is a percentage of the stickers' or the charm's reference price. A share is kept when its
 * field is left or Enter is pressed, the section is written whole, and the fields then show what
 * main stored. A figure that is not a percentage is refused here and the field goes back to what
 * is stored, so the page never shows a share that is not in use.
 */

const SHARES: ReadonlyArray<{ key: keyof AppliedValueSettings; label: string }> = [
  { key: 'mixedStickerPercent', label: 'Stickers' },
  { key: 'sameStickerPercent', label: 'Four or more of the same sticker' },
  { key: 'charmPercent', label: 'A charm' }
];

/** What the estimate is and where its defaults came from, behind the "i" on the panel. */
const INFO = (
  <>
    <div className="panel-info-title">What these percentages do</div>
    <p>
      The inspector shows what the stickers and charm on an item add to its price: this share of
      their reference price. The defaults are what we measured on sales in late 2026.
    </p>
  </>
);

type Drafts = Record<keyof AppliedValueSettings, string>;

function draftsOf(settings: AppliedValueSettings): Drafts {
  return { sameStickerPercent: String(settings.sameStickerPercent), mixedStickerPercent: String(settings.mixedStickerPercent), charmPercent: String(settings.charmPercent) };
}

function same(a: AppliedValueSettings, b: AppliedValueSettings): boolean {
  return SHARES.every(({ key }) => a[key] === b[key]);
}

export function AppliedValuePanel(): React.JSX.Element {
  const [stored, setStored] = useState<AppliedValueSettings | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(DEFAULT_APPLIED_VALUE));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void engine.settings()
      .then((settings) => {
        if (!current) return;
        setStored(settings.appliedValue);
        setDrafts(draftsOf(settings.appliedValue));
      })
      .catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, []);

  async function write(next: AppliedValueSettings): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const settings = await engine.writeAppliedValue(next);
      setStored(settings.appliedValue);
      setDrafts(draftsOf(settings.appliedValue));
    } catch (failure) {
      setError(`The percentages could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
      if (stored) setDrafts(draftsOf(stored));
    } finally {
      setSaving(false);
    }
  }

  function commit(key: keyof AppliedValueSettings): void {
    if (stored === null || saving) return;
    const text = drafts[key].trim().replace(',', '.');
    const value = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError('A share is a percentage from 0 to 100.');
      setDrafts(draftsOf(stored));
      return;
    }
    if (value === stored[key]) {
      setError(null);
      setDrafts(draftsOf(stored));
      return;
    }
    void write({ ...stored, [key]: value });
  }

  return (
    <Panel>
      <PanelHeader
        title="Sticker and charm value"
        icon="percent"
        info={{ label: 'About sticker and charm value', content: INFO }}
        actions={stored !== null && !same(stored, DEFAULT_APPLIED_VALUE) ? (
          <Button size="sm" variant="ghost" icon="undo" disabled={saving} data-testid="applied-value-defaults" onClick={() => void write(DEFAULT_APPLIED_VALUE)}>
            Use the defaults
          </Button>
        ) : undefined}
      />
      <div className="panel-body stack" data-testid="applied-value-panel">
        {SHARES.map(({ key, label }) => (
          <label className="share-setting" key={key}>
            <span className="share-setting-label">{label}</span>
            <input
              className="input input-sm input-money"
              type="text"
              inputMode="decimal"
              aria-label={`${label}, percent of the reference price`}
              data-testid={`applied-value-${key}`}
              value={drafts[key]}
              disabled={stored === null || saving}
              onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
              onBlur={() => commit(key)}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
            <span className="share-setting-unit" aria-hidden="true">%</span>
          </label>
        ))}
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}
