import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type DesktopSettings, type TimeSettings } from '../../shared/api.js';
import { engine } from './engine.js';

/**
 * Which time zone the window prints dates in, and the one place a date becomes words.
 *
 * Kept the way `currency.ts` keeps the base: read once before the first render, replaced by what
 * main stored on each write, and read through one store so a change repaints every date at once.
 * `zone` is the setting (`null` follows Windows); `resolved` is the IANA zone actually used.
 *
 * Every formatter in the window goes through here rather than `toLocaleString`, so a date is never
 * printed in a zone other than the chosen one. Only the printing moves: what is compared against
 * the clock stays an instant.
 */

export type TimeZoneState = { settings: TimeSettings; resolved: string; system: string };

const SYSTEM_ZONE = (() => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

let snapshot: TimeZoneState = stateOf(DEFAULT_SETTINGS.time);
const listeners = new Set<() => void>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function stateOf(settings: TimeSettings): TimeZoneState {
  return { settings, resolved: settings.zone ?? SYSTEM_ZONE, system: SYSTEM_ZONE };
}

function publish(settings: DesktopSettings): void {
  snapshot = stateOf(settings.time);
  formatters.clear();
  for (const listener of listeners) listener();
}

export async function startTime(): Promise<void> {
  try {
    publish(await engine.settings());
  } catch {
    // Windows' zone stands until main answers.
  }
}

/** Stores a zone (`null` to follow Windows) and repaints with what main stored. Throws when it could not be saved. */
export async function chooseTimeZone(zone: string | null): Promise<void> {
  publish(await engine.writeTime({ zone }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTimeZone(): TimeZoneState {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Every IANA zone this build knows, UTC first. */
export function timeZones(): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...supported.filter((zone) => zone !== 'UTC')];
}

/** "UTC+11", "UTC−3:30", "UTC" for a zone, at the given moment (daylight saving moves it). */
export function utcOffsetLabel(zone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((entry) => entry.type === 'timeZoneName')?.value;
    return part ? part.replace('GMT', 'UTC').replace('-', '−') : zone;
  } catch {
    return zone;
  }
}

// ---------------------------------------------------------------------------- formatters

const DATE_TIME: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
const DATE_ONLY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

function formatterFor(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { ...options, timeZone: snapshot.resolved });
    formatters.set(key, formatter);
  }
  return formatter;
}

function dateOf(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A moment with the given fields, in the chosen zone. The general form the named ones below use. */
export function formatInZone(value: string | number | Date, options: Intl.DateTimeFormatOptions): string {
  const date = dateOf(value);
  return date ? formatterFor(options).format(date) : String(value);
}

/** "29 Nov 2026, 19:00" in the chosen zone; "—" for none; the input back when it is not a date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatInZone(iso, DATE_TIME);
}

/** "29 Nov 2026" in the chosen zone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatInZone(iso, DATE_ONLY);
}

/** "19:00" in the chosen zone. */
export function formatClock(value: string | number | Date): string {
  return formatInZone(value, CLOCK);
}
