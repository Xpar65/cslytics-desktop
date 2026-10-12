import type React from 'react';
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  PALETTE_TOKENS,
  resolveTheme,
  type Theme,
  type ThemePreference
} from '../../shared/themes/index.js';
import { engine } from './engine.js';

/**
 * Which theme the window is in, and the one place a palette reaches the page.
 *
 * A theme is data (`shared/themes/`); painting it is setting each of its tokens on `<html>`, where
 * every rule in `app.css` reads them. The choice itself is main's, in `settings.json`: this module
 * reads it once before the first render, so the first frame is already in the right colours, and
 * writes it back through `settings.write`, showing what main stored rather than what was asked.
 *
 * "Match Windows" resolves here, from `prefers-color-scheme`. Main points Chromium's theme source
 * at Windows for that choice and at the theme's own scheme otherwise, so the query is only ever
 * consulted when it is the answer.
 */
export type Appearance = { preference: ThemePreference; theme: Theme };

const READ_DEADLINE_MS = 2_000;

let preference: ThemePreference = DEFAULT_THEME_PREFERENCE;
let snapshot: Appearance = { preference, theme: resolveTheme(preference, true) };
const listeners = new Set<() => void>();
const darkQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

/** Every token of a theme as inline style, for a subtree drawn in a theme other than the window's. */
export function paletteStyle(theme: Theme): React.CSSProperties {
  const style: Record<string, string> = { colorScheme: theme.scheme };
  for (const token of PALETTE_TOKENS) style[token] = theme.palette[token];
  return style as React.CSSProperties;
}

function paint(theme: Theme): void {
  const root = document.documentElement;
  for (const token of PALETTE_TOKENS) root.style.setProperty(token, theme.palette[token]);
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = theme.id;
}

function refresh(): void {
  snapshot = { preference, theme: resolveTheme(preference, darkQuery?.matches ?? true) };
  paint(snapshot.theme);
  for (const listener of listeners) listener();
}

/**
 * Reads the stored choice and paints it. Awaited before the first render; a read that fails or
 * stalls paints the default rather than holding the window blank.
 */
export async function startAppearance(): Promise<void> {
  try {
    const stored = await Promise.race([
      engine.settings(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('settings.read timed out')), READ_DEADLINE_MS))
    ]);
    preference = stored.appearance.theme;
  } catch {
    // The default stands for this run; choosing a theme in Settings says so if saving fails too.
  }
  refresh();
  darkQuery?.addEventListener('change', () => {
    if (preference === 'system') refresh();
  });
}

/** Stores a new choice and paints what main answers. Throws when it could not be saved. */
export async function chooseTheme(next: ThemePreference): Promise<void> {
  const stored = await engine.writeAppearance({ theme: next });
  preference = stored.appearance.theme;
  refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => snapshot);
}
