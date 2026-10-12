/**
 * How wide the item inspector is beside the list or the grid.
 *
 * The divider between them is dragged, so the width is a number the person chose rather than a
 * breakpoint, and each view keeps its own: tiles still read at two columns, but a grouped row needs
 * room for its name, its wear bar, its counts and *Select all* before it stops being a row.
 *
 * Listings has the same join beside its own tiles, and keeps a width of its own for the same
 * reason the two inventory views do: what is comfortable depends on what is beside it. Trades has
 * it beside one trade's items, with the list of trades in a wide rail on the other side.
 *
 * These are the only copies of the numbers. `InspectorSplit` hands them to the grid as custom
 * properties, and the CSS track clamps with the same bounds, so a narrowed window or an opened
 * filter rail cannot squeeze the list below its minimum between drags.
 */

export type InspectorLayout = 'grouped' | 'tiles' | 'listings' | 'trades';

export const INSPECTOR_DEFAULT_WIDTH = 320;
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
/** One arrow-key press on the focused divider. */
export const INSPECTOR_KEY_STEP = 16;

/** The least the list or the grid beside the inspector keeps. */
export const MAIN_MIN_WIDTH: Readonly<Record<InspectorLayout, number>> = { grouped: 480, tiles: 300, listings: 300, trades: 420 };

const WIDTH_KEY: Readonly<Record<InspectorLayout, string>> = {
  grouped: 'cslytics.inventory.inspector-width.grouped',
  tiles: 'cslytics.inventory.inspector-width.tiles',
  listings: 'cslytics.listings.inspector-width',
  trades: 'cslytics.trades.inspector-width'
};

export function inspectorWidthKey(view: InspectorLayout): string {
  return WIDTH_KEY[view];
}

/** A stored width, or the default when what is stored is not one this screen would have written. */
export function readInspectorWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return INSPECTOR_DEFAULT_WIDTH;
  const width = Number(raw);
  if (!Number.isFinite(width) || width < INSPECTOR_MIN_WIDTH || width > INSPECTOR_MAX_WIDTH) return INSPECTOR_DEFAULT_WIDTH;
  return Math.round(width);
}

/**
 * The width a drag may reach.
 *
 * `room` is what the list and the inspector share, measured when the drag starts. The list keeps
 * its minimum out of it; when there is not even that much room, the inspector's own minimum wins,
 * because a window that narrow stacks the two anyway.
 */
export function clampInspectorWidth(width: number, room: number, view: InspectorLayout): number {
  const upper = Number.isFinite(room) ? Math.min(INSPECTOR_MAX_WIDTH, room - MAIN_MIN_WIDTH[view]) : INSPECTOR_MAX_WIDTH;
  const wanted = Number.isFinite(width) ? width : INSPECTOR_DEFAULT_WIDTH;
  return Math.round(Math.max(INSPECTOR_MIN_WIDTH, Math.min(upper, wanted)));
}
