/**
 * Where a version's notes are read: cslytics.com/changelog, one entry per desktop release, anchored
 * by version. The window shows the link; main opens it (`release.notes`), so the renderer never
 * holds a URL it can open itself. Not baked into installed copies: moving the page breaks a link,
 * nothing more.
 */
export const CHANGELOG_URL = 'https://cslytics.com/changelog';

export function changelogEntryUrl(version: string): string {
  return `${CHANGELOG_URL}#app-${encodeURIComponent(version)}`;
}
