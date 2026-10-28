import type { VenueId } from './marketplaces.js';

/**
 * The pages of the window, by id.
 *
 * Kept apart from `App.tsx`, which owns their labels, icons and order, so that a feature can name
 * a destination — a notification's action says "Open Settings" — without importing the shell that
 * renders it. A new page is added here first; `App.tsx` then fails to typecheck until it has a
 * sidebar entry and a count.
 */
export const SECTION_IDS = [
  'portfolio',
  'inventory',
  'trades',
  'items',
  'listings',
  'buy-orders',
  'records',
  'store',
  'settings',
  // A page a connected engine host serves, shown in a view (remote engine host plan D12). Which
  // one is the shell's state; the id is the slot they share.
  'host-page'
] as const;

export type Section = (typeof SECTION_IDS)[number];

/**
 * The tabs of the Records page, in the order they are shown. The same rule holds: a new tab is
 * added here, and `App.tsx` fails to typecheck until it has a label and an icon.
 */
export const RECORD_TABS = ['orders', 'history', 'trades', 'ledger'] as const;

export type RecordTab = (typeof RECORD_TABS)[number];

/**
 * The pages of Settings: this desktop's (general, the CSlytics sign-in, the engine host), an
 * account's overview, and one per marketplace, named by its id in `MARKETPLACES`. A page that
 * offers to set up a venue opens its page by that id.
 */
export type SettingsPage = 'general' | 'cslytics' | 'engine' | 'overview' | VenueId;
