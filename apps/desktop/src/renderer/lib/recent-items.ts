/**
 * The items this window opened last, for the Items page's empty state.
 *
 * Window state, like the sidebar's pin: what a person looked at is not a fact about the accounts,
 * so it is neither in the trading record nor in `settings.json`, and a new profile starts empty.
 * Names and picture handles only; a handle is a `cs-image:` reference main resolves, never a URL.
 */

export type RecentItem = { name: string; imageUrl: string | null };

const KEY = 'cslytics.items.recent';
const MAX = 8;

export function recentItems(): RecentItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is RecentItem => typeof row === 'object' && row !== null && typeof (row as RecentItem).name === 'string')
      .map((row) => ({ name: row.name, imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null }))
      .slice(0, MAX);
  } catch {
    // A hand-edited or truncated value is no history, not a broken page.
    return [];
  }
}

/** Puts `item` first, once, and keeps the newest eight. */
export function rememberItem(item: RecentItem): RecentItem[] {
  const next = [item, ...recentItems().filter((row) => row.name !== item.name)].slice(0, MAX);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full or denied: the page still works */ }
  }
  return next;
}
