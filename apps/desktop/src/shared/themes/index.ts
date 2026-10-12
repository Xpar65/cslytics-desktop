import { amber } from './amber.js';
import { dark } from './dark.js';
import { light } from './light.js';
import { neon } from './neon.js';
import type { Theme } from './palette.js';

export { PALETTE_TOKENS, type Palette, type PaletteToken, type Theme } from './palette.js';

/**
 * Every theme this build ships, in the order Settings lists them.
 *
 * To add one: copy `light.ts` or `dark.ts` to a new file, give it a new `id`, label, description,
 * scheme and values (spreading another theme's palette and overriding a few tokens is a whole
 * theme), then add the id below and the theme to `THEMES`. Settings lists it with a preview drawn
 * in its own colours, `settings.json` accepts its id, and the window's caption buttons follow it.
 * Nothing else changes: no stylesheet names a theme. `theme-palettes.test.ts` holds every theme to
 * the same contrast floor the dark theme was designed to, and to solid window colours.
 *
 * An id is stored in `settings.json`, so it never changes once shipped. A build that reads an id it
 * does not know — written by a newer build — shows the default rather than refusing the file.
 */
export const THEME_IDS = ['dark', 'light', 'amber', 'neon'] as const;
export type ThemeId = typeof THEME_IDS[number];

export const THEMES: Readonly<Record<ThemeId, Theme>> = { dark, light, amber, neon };

/** Which theme stands in for each way Windows can lean, under "Match Windows". */
export const SYSTEM_THEMES: Readonly<Record<Theme['scheme'], ThemeId>> = { dark: 'dark', light: 'light' };

/** What a person chooses in Settings: a theme, or whichever one Windows asks for. */
export const THEME_PREFERENCES = ['system', ...THEME_IDS] as const;
export type ThemePreference = typeof THEME_PREFERENCES[number];

/** The house look, and what a profile with no `settings.json` opens in. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return THEMES[SYSTEM_THEMES[systemPrefersDark ? 'dark' : 'light']];
  return THEMES[preference];
}

/**
 * The colours main paints outside the page: the window behind it before the first paint, and the
 * strip Windows draws minimise, maximise and close on. Taken from the palette, so a theme states
 * them once; each must be a solid colour, which the theme test checks.
 */
export function windowChrome(theme: Theme): { background: string; titlebar: string; symbols: string } {
  return {
    background: theme.palette['--cs-bg'],
    titlebar: theme.palette['--cs-titlebar-bg'],
    symbols: theme.palette['--cs-titlebar-text']
  };
}
