import { currencySymbol } from './labels.js';
import type { ItemRow } from './types.js';

/**
 * Presentation helpers.
 *
 * Everything here is computed from the raw GC item. There is no catalogue in V1, so items
 * cannot be shown by their market name yet — but wear tier, StatTrak/Souvenir and float are
 * all derivable, and together they make a list of 720 assets readable instead of a wall of
 * def_index numbers. Catalogue enrichment slots in above this without changing the engine.
 */

export type WearTier = { code: 'FN' | 'MW' | 'FT' | 'WW' | 'BS'; label: string; variable: string };

const TIERS: ReadonlyArray<{ max: number } & WearTier> = [
  { max: 0.07, code: 'FN', label: 'Factory New', variable: '--wear-fn' },
  { max: 0.15, code: 'MW', label: 'Minimal Wear', variable: '--wear-mw' },
  { max: 0.38, code: 'FT', label: 'Field-Tested', variable: '--wear-ft' },
  { max: 0.45, code: 'WW', label: 'Well-Worn', variable: '--wear-ww' },
  { max: 1.01, code: 'BS', label: 'Battle-Scarred', variable: '--wear-bs' }
];

export function wearTier(paintWear: number | null): WearTier | null {
  if (paintWear === null) return null;
  return TIERS.find((tier) => paintWear < tier.max) ?? null;
}

/** Steam econ quality ids that change how an item reads. */
export function qualityLabel(quality: number): string | null {
  if (quality === 9) return 'StatTrak™';
  if (quality === 12) return 'Souvenir';
  return null;
}

export function formatFloat(paintWear: number | null): string {
  return paintWear === null ? '—' : paintWear.toFixed(5);
}

/** Items with the same name group together; float and seed distinguish the copies. */
export function groupKey(item: ItemRow): string {
  return `${item.quality}:${item.def_index}:${item.paint_index ?? 'none'}:${wearTier(item.paint_wear)?.code ?? 'none'}`;
}

/**
 * Integer cents in the currency Steam named them in.
 *
 * `null` is a currency we have not observed, or several that disagree — the amount is still
 * printed, without a symbol, because inventing one would claim the figure is in a currency
 * nobody said it was.
 */
export function formatCents(cents: number | null | undefined, currency: number | null = 21): string {
  if (cents === null || cents === undefined) return '—';
  return `${currencySymbol(currency)}${(cents / 100).toFixed(2)}`;
}

/**
 * Ledger money. `UNKNOWN` is a value of its own — printing `0` or `—` would invent a figure
 * DATA-04 forbids. Callers that only have cents and no basis must not use this.
 */
export function formatObservedAmount(
  amountCents: number | null | undefined,
  amountBasis: 'EVIDENCED' | 'UNKNOWN' | undefined,
  currency: number | null = 21
): string {
  if (amountBasis !== 'EVIDENCED' || amountCents === null || amountCents === undefined) return 'Amount unknown';
  return formatCents(amountCents, currency);
}

export function isTradable(item: ItemRow, now = new Date()): boolean {
  if (!item.tradable_after) return true;
  const date = new Date(item.tradable_after);
  return Number.isNaN(date.getTime()) || date <= now;
}

export function isTradeProtected(item: ItemRow, now = new Date()): boolean {
  if (!item.trade_protected_until) return false;
  const date = new Date(item.trade_protected_until);
  return !Number.isNaN(date.getTime()) && date > now;
}

export function relativeTime(iso: string, now = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
