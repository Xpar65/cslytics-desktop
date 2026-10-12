import React, { useId, useState } from 'react';
import {
  SYSTEM_THEMES,
  THEME_PREFERENCES,
  THEMES,
  type Theme,
  type ThemeId,
  type ThemePreference
} from '../../../shared/themes/index.js';
import { chooseTheme, paletteStyle, useAppearance } from '../../lib/appearance.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Notice, Panel, PanelHeader } from '../../components/ui.js';

/** A theme's mark beside its name; one not listed takes the sun or the moon by its scheme. */
const THEME_ICONS: Partial<Record<ThemeId, IconName>> = { amber: 'flame', neon: 'zap' };

/**
 * Settings › General › Appearance: which theme the window is drawn in.
 *
 * One card per entry in `THEME_PREFERENCES`, so a theme added to the registry appears here with no
 * edit to this file. Each card's preview is drawn in that theme's own palette — the tokens are set
 * on the preview, and the same rules that draw the window draw it — so what a person picks is what
 * the window becomes. A choice applies at once and is main's to keep (`settings.json`); the card
 * shows what main stored.
 */
export function AppearancePanel(): React.JSX.Element {
  const { preference } = useAppearance();
  const [saving, setSaving] = useState<ThemePreference | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: ThemePreference): Promise<void> {
    if (next === preference || saving) return;
    setSaving(next);
    setError(null);
    try {
      await chooseTheme(next);
    } catch (failure) {
      setError(`The theme could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Panel>
      <PanelHeader title="Appearance" icon="palette" subtitle="How this window looks. Remembered on this computer." />
      <div className="panel-body stack">
        <div className="theme-picker" role="radiogroup" aria-label="Theme">
          {THEME_PREFERENCES.map((id) => (
            <ThemeOption
              key={id}
              id={id}
              checked={preference === id}
              disabled={saving !== null}
              onChoose={() => void choose(id)}
            />
          ))}
        </div>
        {error ? <Notice tone="error" role="status">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function ThemeOption({ id, checked, disabled, onChoose }: {
  id: ThemePreference;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
}): React.JSX.Element {
  const describedBy = useId();
  const system = id === 'system';
  const label = system ? 'Match Windows' : THEMES[id].label;
  const description = system ? 'Dark or light, as Windows is set' : THEMES[id].description;
  const icon: IconName = system ? 'monitor' : THEME_ICONS[id] ?? (THEMES[id].scheme === 'light' ? 'sun' : 'moon');
  return (
    <label className="theme-option" data-checked={checked} data-disabled={disabled || undefined}>
      <input
        type="radio"
        name="theme"
        className="theme-option-input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={onChoose}
      />
      {system ? (
        // Both halves of the choice, side by side: whichever Windows is set to is what shows.
        <span className="theme-preview-pair">
          <ThemePreview theme={THEMES[SYSTEM_THEMES.dark]} />
          <ThemePreview theme={THEMES[SYSTEM_THEMES.light]} />
        </span>
      ) : <ThemePreview theme={THEMES[id]} />}
      <span className="theme-option-text">
        <span className="theme-option-label">
          <Icon name={icon} size={14} />
          {label}
          {checked ? <Icon name="check" size={14} className="theme-option-check" /> : null}
        </span>
        <span className="theme-option-hint" id={describedBy}>{description}</span>
      </span>
    </label>
  );
}

/** A small window in the theme's own colours: its frame, a navigation rail, and a panel with a primary button. */
function ThemePreview({ theme }: { theme: Theme }): React.JSX.Element {
  return (
    <span className="theme-preview" style={paletteStyle(theme)} aria-hidden="true">
      <span className="theme-preview-titlebar" />
      <span className="theme-preview-body">
        <span className="theme-preview-rail">
          <span className="theme-preview-nav" data-selected="true" />
          <span className="theme-preview-nav" />
          <span className="theme-preview-nav" />
        </span>
        <span className="theme-preview-page">
          <span className="theme-preview-panel">
            <span className="theme-preview-line" data-strong="true" />
            <span className="theme-preview-line" />
            <span className="theme-preview-row">
              <span className="theme-preview-button" />
              <span className="theme-preview-dot" data-tone="positive" />
              <span className="theme-preview-dot" data-tone="negative" />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}
