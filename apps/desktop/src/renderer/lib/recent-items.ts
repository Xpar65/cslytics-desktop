import { withoutWear } from './skin-name.js';

/**
 * The items this window opened last, for the Items page's empty state.
 *
 * Window state, like the sidebar's pin: what a person looked at is not a fact about the accounts,
 * so it is neither in the trading record nor in `settings.json`, and a new profile starts empty.
 * Names and picture handles only; a handle is a `cs-image:` reference main resolves, never a URL.
 *
 * One entry per skin. The name kept is the market name last opened, wear and all, so a tile goes
 * back to the wear the person was reading; the tile itself shows the skin, and opening a second
 * wear of it moves the one tile to the front rather than adding another that reads the same.
 */

export type RecentItem = { name: string; imageUrl: string | null };

const KEY = 'cslytics.items.recent';
const MAX = 8;

export function recentItems(): RecentItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return oncePerSkin(parsed
      .filter((row): row is RecentItem => typeof row === 'object' && row !== null && typeof (row as RecentItem).name === 'string')
      .map((row) => ({ name: row.name, imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null })))
      .slice(0, MAX);
  } catch {
    // A hand-edited or truncated value is no history, not a broken page.
    return [];
  }
}

/** Puts `item` first, once per skin, and keeps the newest eight. */
export function rememberItem(item: RecentItem): RecentItem[] {
  const next = oncePerSkin([item, ...recentItems()]).slice(0, MAX);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full or denied: the page still works */ }
  }
  return next;
}

/** The first entry of each skin, in order: a list written before tiles dropped the wear may hold two. */
function oncePerSkin(rows: readonly RecentItem[]): RecentItem[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const skin = withoutWear(row.name);
    if (seen.has(skin)) return false;
    seen.add(skin);
    return true;
  });
}
