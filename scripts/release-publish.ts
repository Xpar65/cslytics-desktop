/**
 * Publishes a signed release to both places it is downloaded from, and proves the two hold the same
 * bytes (desktop release plan §7).
 *
 *   CSLYTICS_RELEASE_TARGET=<ssh-host>:<folder> pnpm release:publish
 *   pnpm release:publish --verify      # check both places again, upload nothing
 *   pnpm release:publish --rehearse    # read a rehearsal manifest and print the plan
 *
 * Run it in the clone of the public repository the release was built in, after `release:desktop`.
 * It reads `release-<version>.json` from the packager's output folder (`CSLYTICS_PACKAGE_DIR`) and
 * refuses a manifest that is a rehearsal, unsigned or built from a dirty tree; a file whose bytes no
 * longer match it; a checkout that is not at the manifest's commit; and a tag `v<version>` that the
 * remote does not point at that commit, so the GitHub Release can only ever name the code it was
 * built from.
 *
 * Order matters because installed copies act on `latest.yml` the moment it changes:
 *   1. the GitHub Release is created as a draft with every file, the manifest and the release notes
 *      (the SHA-256 of each file), and checked by the SHA-256 GitHub computes of each asset; a draft
 *      left by an interrupted run is given only the files it lacks;
 *   2. every file but the feed is copied to the release host and checked there by `sha512sum`;
 *   3. the GitHub Release is published;
 *   4. the feed is copied under a temporary name, moved into place in one step, and checked;
 *   5. the release host fetches every file from the public feed URL, through Cloudflare, the way a
 *      user would, and checks it. Nothing is downloaded back over this machine's connection.
 * A failure in steps 1 to 3 stops the run before the feed changes. Every step is safe to run again;
 * `--verify` repeats every check and uploads nothing.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPDATE_FEED_URL } from '../apps/desktop/src/main/release/identity.js';

export type ReleaseArtefact = { file: string; local: string; bytes: number; sha512: string };
export type ReleaseManifest = {
  version: string;
  rehearsal: boolean;
  commit: string;
  dirty: boolean;
  publisher: string | null;
  certificateSha1: string | null;
  builtAt: string;
  artefacts: ReleaseArtefact[];
};

/** An scp destination, `host:folder`. A drive letter is refused: `C:\x` names a host called `C`. */
export function parseTarget(target: string): { host: string; folder: string } {
  const match = /^([^:\s]+):(.+)$/.exec(target.trim());
  if (!match || match[1]!.length === 1) throw new Error(`CSLYTICS_RELEASE_TARGET must be <ssh-host>:<folder>, not ${target}`);
  // Relative to the remote home folder, where ssh starts; a leading tilde would arrive quoted.
  const folder = match[2]!.replace(/^~\//, '').replace(/\/+$/, '');
  if (folder.includes("'")) throw new Error('the release folder may not contain a quote');
  return { host: match[1]!, folder };
}

/** The manifest's files in upload order; the feed must be last, because copies act on it at once. */
export function uploadOrder(manifest: ReleaseManifest): { files: ReleaseArtefact[]; feed: ReleaseArtefact } {
  const feed = manifest.artefacts.at(-1);
  if (!feed || feed.file !== 'latest.yml') throw new Error('the manifest must list latest.yml last');
  const files = manifest.artefacts.slice(0, -1);
  if (files.some((entry) => entry.file === 'latest.yml')) throw new Error('the manifest lists latest.yml twice');
  return { files, feed };
}

/** What differs between the manifest and the digests found somewhere (SHA-512, base64). */
export function digestProblems(expected: readonly ReleaseArtefact[], found: ReadonlyMap<string, string>, where: string): string[] {
  return expected.flatMap((entry) => {
    const digest = found.get(entry.file);
    if (digest === undefined) return [`${where} does not have ${entry.file}`];
    return digest === entry.sha512 ? [] : [`${where} has different bytes for ${entry.file}`];
  });
}

/**
 * What differs between local files and the GitHub Release, by the SHA-256 GitHub computes of each
 * asset (`sha256:<hex>`). An asset GitHub has not finished digesting counts as different.
 */
export function assetProblems(files: readonly string[], localSha256: ReadonlyMap<string, string>, digests: ReadonlyMap<string, string>): string[] {
  return files.flatMap((file) => {
    const digest = digests.get(file);
    if (digest === undefined) return [`GitHub does not have ${file}`];
    return digest === `sha256:${localSha256.get(file)}` ? [] : [`GitHub has different bytes for ${file}`];
  });
}

/** The release notes: what was built, from which commit, signed by whom, and how to check a download. */
export function releaseNotes(manifest: ReleaseManifest, sha256: ReadonlyMap<string, string>, repository: string): string {
  const rows = manifest.artefacts
    .filter((entry) => entry.file !== 'latest.yml')
    .map((entry) => `| \`${entry.file}\` | ${(entry.bytes / 1024 / 1024).toFixed(1)} MB | \`${sha256.get(entry.file) ?? 'missing'}\` |`);
  return [
    `CSlytics ${manifest.version}, built from [\`${manifest.commit.slice(0, 12)}\`](https://github.com/${repository}/commit/${manifest.commit}) and signed by \`${manifest.publisher}\`.`,
    '',
    '`CSlytics-Setup` is the full installer; `CSlytics-Web-Setup` is the small one, which downloads the',
    'app package beside it. The same files are on `downloads.cslytics.com`.',
    '',
    '| File | Size | SHA-256 |',
    '|---|---|---|',
    ...rows,
    '',
    'Check a download in PowerShell with `Get-FileHash <file>`: the hash must match the table, and the',
    `file's *Digital Signatures* tab must name \`${manifest.publisher}\`.`,
    ''
  ].join('\n');
}

function hash(algorithm: 'sha256' | 'sha512', bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const rehearse = process.argv.includes('--rehearse');
  const verifyOnly = process.argv.includes('--verify');
  const outputDir = process.env.CSLYTICS_PACKAGE_DIR?.trim() || join(root, 'apps', 'desktop', 'dist');
  const { version } = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string };
  const tag = `v${version}`;

  const refuse = (reason: string): never => {
    console.error(`publish refused: ${reason}`);
    process.exit(1);
  };
  const run = (command: string, args: string[], options: { cwd?: string } = {}): string =>
    execFileSync(command, args, { cwd: options.cwd ?? root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const git = (...args: string[]): string => run('git', args);

  const manifestPath = join(outputDir, `release-${version}${rehearse ? '-rehearsal' : ''}.json`);
  if (!existsSync(manifestPath)) refuse(`there is no ${manifestPath}; run release:desktop${rehearse ? ' --rehearse' : ''} first`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
  if (manifest.version !== version) refuse(`the manifest is for ${manifest.version}, the checkout is ${version}`);
  if (!rehearse && (manifest.rehearsal || !manifest.publisher || !manifest.certificateSha1)) refuse('the manifest is a rehearsal or unsigned; only a signed release is published');
  if (!rehearse && manifest.dirty) refuse('the release was built from a dirty tree');

  let order: ReturnType<typeof uploadOrder>;
  try { order = uploadOrder(manifest); } catch (error) { return refuse((error as Error).message); }
  const localPath = (entry: ReleaseArtefact): string => join(outputDir, entry.local);
  const localBytes = new Map(manifest.artefacts.map((entry) => [entry.file, readFileSync(localPath(entry))]));
  const local = digestProblems(manifest.artefacts, new Map([...localBytes].map(([file, bytes]) => [file, hash('sha512', bytes)])), 'the output folder');
  if (local.length) refuse(`the files changed after the manifest was written:\n  - ${local.join('\n  - ')}`);

  const origin = git('remote', 'get-url', 'origin');
  const repository = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(origin)?.[1] ?? refuse(`origin is not a GitHub repository: ${origin}`);
  if (!rehearse) {
    if (git('rev-parse', 'HEAD') !== manifest.commit) refuse(`the checkout is not at ${manifest.commit}, the commit the release was built from`);
    if (git('status', '--porcelain') !== '') refuse('the checkout has uncommitted changes');
    const remote = git('ls-remote', '--tags', 'origin', tag, `${tag}^{}`).split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
    const pointsAt = (remote.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? remote.find(([, ref]) => ref === `refs/tags/${tag}`))?.[0];
    if (pointsAt !== manifest.commit) refuse(`the remote tag ${tag} ${pointsAt ? `points at ${pointsAt}` : 'does not exist'}; push it at ${manifest.commit}`);
  }

  const sha256 = new Map([...localBytes].map(([file, bytes]) => [file, hash('sha256', bytes)]));
  const notesPath = join(outputDir, `release-notes-${version}.md`);
  writeFileSync(notesPath, releaseNotes(manifest, sha256, repository));
  const githubFiles = [...manifest.artefacts.map(localPath), manifestPath];

  const targetText = process.env.CSLYTICS_RELEASE_TARGET?.trim();
  if (rehearse) {
    console.log(`Rehearsal: CSlytics ${version} from ${manifest.commit.slice(0, 12)}, ${repository}, nothing uploaded.`);
    console.log(`  1. GitHub draft ${tag} with ${githubFiles.map((path) => basename(path)).join(', ')}, notes ${notesPath}`);
    console.log(`  2. to ${targetText ?? '<CSLYTICS_RELEASE_TARGET>'}: ${order.files.map((entry) => entry.file).join(', ')}`);
    console.log(`  3. publish ${tag}  4. latest.yml  5. check ${UPDATE_FEED_URL}`);
    return;
  }
  if (!targetText) return refuse('CSLYTICS_RELEASE_TARGET is required: the release host as <ssh-host>:<folder>');
  let target: ReturnType<typeof parseTarget>;
  try { target = parseTarget(targetText); } catch (error) { return refuse((error as Error).message); }

  const stop = (where: string, problems: string[], count: number): void => {
    if (problems.length) refuse(`${where}:\n  - ${problems.join('\n  - ')}`);
    console.log(`  ${where}: ${count === 1 ? 'the file matches' : `${count} files match`} the manifest`);
  };
  // GitHub computes a SHA-256 of every asset it stores, so the release is checked against those
  // rather than downloaded back. Drafts are listed only to an authenticated caller, as here.
  const githubRelease = (): { state: 'none' | 'draft' | 'published'; digests: Map<string, string> } => {
    const releases = JSON.parse(run('gh', ['api', `repos/${repository}/releases?per_page=100`])) as Array<{
      tag_name: string; draft: boolean; assets: Array<{ name: string; digest: string | null }>;
    }>;
    const release = releases.find((entry) => entry.tag_name === tag);
    if (!release) return { state: 'none', digests: new Map() };
    return { state: release.draft ? 'draft' : 'published', digests: new Map(release.assets.map((asset) => [asset.name, asset.digest ?? ''])) };
  };
  const megabytes = (paths: readonly string[]): string => `${(paths.reduce((sum, path) => sum + statSync(path).size, 0) / 1024 / 1024).toFixed(0)} MB`;
  const hostDigests = (files: readonly ReleaseArtefact[]): Map<string, string> => {
    const listing = run('ssh', [target.host, `cd '${target.folder}' && sha512sum -- ${files.map((entry) => `'${entry.file}'`).join(' ')}`]);
    return new Map(listing.split(/\r?\n/).map((line) => /^([0-9a-f]{128})\s+\*?(.+)$/.exec(line.trim())).filter((match) => match !== null)
      .map((match) => [match[2]!, Buffer.from(match[1]!, 'hex').toString('base64')]));
  };
  const copy = (entry: ReleaseArtefact, remoteName = entry.file): void => {
    console.log(`  copying ${entry.file} (${megabytes([localPath(entry)])}) to ${target.host}`);
    // Relative to the file's own folder: scp reads `C:\...` as a host called `C`.
    run('scp', ['-q', basename(entry.local), `${target.host}:${target.folder}/${remoteName}`], { cwd: dirname(localPath(entry)) });
  };

  console.log(`Publishing CSlytics ${version} from ${manifest.commit.slice(0, 12)} to ${repository} and ${target.host}`);
  const localSha256 = new Map([...sha256, [basename(manifestPath), hash('sha256', readFileSync(manifestPath))]]);
  let github = githubRelease();
  if (!verifyOnly && github.state !== 'published') {
    // A draft left by an interrupted run keeps the files it already holds intact.
    const missing = githubFiles.filter((path) => assetProblems([basename(path)], localSha256, github.digests).length > 0);
    if (missing.length) console.log(`  uploading ${missing.length} files (${megabytes(missing)}) to GitHub; this prints nothing until it finishes`);
    if (github.state === 'none') {
      run('gh', ['release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--title', `CSlytics ${version}`, '--notes-file', notesPath, ...missing]);
    } else {
      if (missing.length) run('gh', ['release', 'upload', tag, '--repo', repository, '--clobber', ...missing]);
      run('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notesPath]);
    }
    github = githubRelease();
  }
  if (github.state === 'none') refuse(`there is no GitHub Release ${tag} to check`);
  stop(`GitHub Release ${tag}`, assetProblems(githubFiles.map((path) => basename(path)), localSha256, github.digests), githubFiles.length);

  if (!verifyOnly) for (const entry of order.files) copy(entry);
  stop(`release host ${target.host}`, digestProblems(order.files, hostDigests(order.files), 'the release host'), order.files.length);

  if (!verifyOnly && github.state === 'draft') {
    run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
    console.log(`  GitHub Release ${tag} published`);
  }
  if (!verifyOnly) {
    copy(order.feed, 'latest.yml.tmp');
    run('ssh', [target.host, `cd '${target.folder}' && mv -f latest.yml.tmp latest.yml`]);
  }
  stop('release host feed', digestProblems([order.feed], hostDigests([order.feed]), 'the release host'), 1);

  // What the public URL serves, through Cloudflare, fetched by the release host the way a user's
  // machine would: from any network, and without downloading the release again over this one.
  console.log(`  checking what ${UPDATE_FEED_URL} serves, through Cloudflare, from the release host`);
  const served = new Map<string, string>();
  for (const entry of manifest.artefacts) {
    try {
      const line = run('ssh', [target.host, `f=$(mktemp) && curl -fsS -o "$f" '${UPDATE_FEED_URL}/${entry.file}' && sha512sum "$f"; s=$?; rm -f "$f"; exit $s`]);
      const hex = /^([0-9a-f]{128})\s/.exec(line)?.[1];
      if (hex) served.set(entry.file, Buffer.from(hex, 'hex').toString('base64'));
    } catch {
      // Left out of `served`, so it is reported as missing below.
    }
  }
  stop(UPDATE_FEED_URL, digestProblems(manifest.artefacts, served, UPDATE_FEED_URL), manifest.artefacts.length);

  console.log(`\nCSlytics ${version} is published. SHA-256, as in the release notes (${notesPath}):`);
  for (const entry of manifest.artefacts) console.log(`  ${sha256.get(entry.file)}  ${entry.file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
