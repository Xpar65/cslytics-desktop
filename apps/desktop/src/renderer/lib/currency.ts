import { useSyncExternalStore } from 'react';
import type { FxRates } from '@cslytics/market-data';
import { baseCurrencyOf, DEFAULT_CURRENCY, type CurrencySettings, type DesktopSettings } from '../../shared/api.js';
import { engine } from './engine.js';

/**
 * The currency settings as the window sees them (portfolio and pricing plan §5.2), kept the way
 * `appearance.ts` keeps the theme: read once at start, replaced by what main stored on each write,
 * and read by components through one store so a change repaints every figure at once.
 *
 * `base` is what cross-account figures are shown in. `accountPagesInBase` is the toggle: off, an
 * account's own pages are native; on, they convert too. A typed price never reads this. `fx` is
 * main's newest rate snapshot, for the read-only hint beside a typed price and nothing else: every
 * figure the window shows converted was converted by main.
 */

export type Currency = { settings: CurrencySettings; base: string; fx: FxRates | null };

let snapshot: Currency = { settings: DEFAULT_CURRENCY, base: 'USD', fx: null };
const listeners = new Set<() => void>();

function publish(settings: DesktopSettings, fx: FxRates | null = snapshot.fx): void {
  snapshot = { settings: settings.currency, base: baseCurrencyOf(settings), fx };
  for (const listener of listeners) listener();
}

async function readFx(): Promise<FxRates | null> {
  try {
    return await engine.marketFx();
  } catch {
    return null;
  }
}

export async function startCurrency(): Promise<void> {
  try {
    const [settings, fx] = await Promise.all([engine.settings(), readFx()]);
    publish(settings, fx);
  } catch {
    // The defaults stand until main answers; a window without settings still prints every code.
  }
}

/** Re-reads the settings and the rates: main may have pinned the base from the first wallet it observed. */
export async function refreshCurrency(): Promise<void> {
  try {
    const [settings, fx] = await Promise.all([engine.settings(), readFx()]);
    publish(settings, fx);
  } catch {
    // As above.
  }
}

export async function chooseBaseCurrency(code: string): Promise<void> {
  publish(await engine.writeCurrency({ ...snapshot.settings, base: code, baseSource: 'chosen' }));
}

export async function setAccountPagesInBase(on: boolean): Promise<void> {
  publish(await engine.writeCurrency({ ...snapshot.settings, showAccountPagesInBase: on }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrency(): Currency {
  return useSyncExternalStore(subscribe, () => snapshot);
}
