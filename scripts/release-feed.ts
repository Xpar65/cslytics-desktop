/**
 * What `latest.yml` may say (desktop release plan §4). Every installed copy updates from it, and an
 * update is safe only through the full installer: electron-updater checks that file's Authenticode
 * publisher. A feed that names the web installer, or carries a `packages:` entry for it, would have
 * the signature checked on the small installer alone and the package checked only against this same
 * feed, which whoever holds the host could rewrite. electron-builder writes exactly that feed when
 * the two targets share a publish entry, so the release refuses it rather than trusting the config.
 *
 * Line-based on purpose: the file is generated, and the checks need no YAML parser.
 */
export function feedProblems(latestYml: string, version: string): string[] {
  const installer = `CSlytics-Setup-${version}.exe`;
  const problems: string[] = [];
  const lines = latestYml.split(/\r?\n/);
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim().replace(/^'(.*)'$/, '$1');

  if (value('version') !== version) problems.push(`the feed's version is ${value('version') ?? 'missing'}, not ${version}`);
  if (value('path') !== installer) problems.push(`the feed's path is ${value('path') ?? 'missing'}, not ${installer}`);
  const urls = lines.map((line) => /^\s*-\s+url:\s*(.+)$/.exec(line)?.[1]?.trim()).filter((url): url is string => url !== undefined);
  if (urls.length === 0) problems.push('the feed lists no files');
  for (const url of urls) if (url !== installer) problems.push(`the feed lists ${url}; it may list only ${installer}`);
  if (lines.some((line) => /^\s*packages:/.test(line))) problems.push('the feed carries a web-installer package; updates must go through the full signed installer');
  return problems;
}
