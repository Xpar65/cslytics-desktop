/**
 * Builds, signs, packages and smoke-tests a desktop release, and writes its manifest
 * (desktop release plan §7).
 *
 *   CSLYTICS_SIGN_SHA1=<thumbprint> CSLYTICS_PUBLISHER_NAME="<subject>" pnpm release:desktop
 *   pnpm release:desktop --rehearse
 *
 * A release refuses a dirty tree, a HEAD without the tag `v<version>`, and a missing certificate:
 * an installed copy trusts an update only if the same publisher signed it, and it can never be told
 * otherwise, so an unsigned or mislabelled build must never reach the feed. `--rehearse` runs every
 * step except the signature and those checks, and says so in the manifest; it is how the pipeline
 * is exercised without the YubiKey.
 *
 * It does not upload; `release-publish.ts` does. The artefacts and the manifest land in the
 * packager's output folder (`CSLYTICS_PACKAGE_DIR`, or `apps/desktop/dist`) for it:
 * the web installer and the app package it downloads, the full installer and its blockmap, and
 * `latest.yml`, which must name only the full installer (`release-feed.ts`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedProblems } from './release-feed.js';
import { smokePackaged } from './smoke-packaged.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const rehearse = process.argv.includes('--rehearse');
const { version } = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string };
const outputDir = process.env.CSLYTICS_PACKAGE_DIR?.trim() || join(root, 'apps', 'desktop', 'dist');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function run(command: string, env: NodeJS.ProcessEnv): void {
  execFileSync(command, { cwd: root, env, stdio: 'inherit', shell: true });
}

function refuse(reason: string): never {
  console.error(`release refused: ${reason}`);
  process.exit(1);
}

const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
const thumbprint = process.env.CSLYTICS_SIGN_SHA1?.trim() || null;
const publisher = process.env.CSLYTICS_PUBLISHER_NAME?.trim() || null;

if (!rehearse) {
  if (dirty) refuse('the working tree has uncommitted changes; a release is built from a commit, not from a tree');
  if (!git('tag', '--points-at', 'HEAD').split(/\r?\n/).includes(`v${version}`)) refuse(`HEAD is not tagged v${version}, the version in apps/desktop/package.json`);
  if (!thumbprint || !publisher) refuse('CSLYTICS_SIGN_SHA1 and CSLYTICS_PUBLISHER_NAME are required; installed copies accept updates only from that publisher');
}

// A rehearsal never signs, even with the certificate plugged in, so that it cannot produce an
// artefact that looks releasable from a tree that was not.
const env: NodeJS.ProcessEnv = { ...process.env, CSLYTICS_PACKAGE_DIR: outputDir };
if (rehearse) {
  delete env.CSLYTICS_SIGN_SHA1;
  delete env.CSLYTICS_PUBLISHER_NAME;
}

console.log(`${rehearse ? 'Rehearsing' : 'Releasing'} CSlytics ${version} from ${commit.slice(0, 12)}${dirty ? ' (dirty tree)' : ''} into ${outputDir}`);
run('pnpm build', env);
run('pnpm --filter @cslytics/desktop exec electron-builder --config electron-builder.config.mjs --win --publish never', env);

const failures = await smokePackaged(outputDir);
if (failures.length) refuse(`the packaged app failed its smoke test:\n${failures.map((line) => `  - ${line}`).join('\n')}`);

// Upload order: everything a feed or a web installer can point at goes up before `latest.yml`. The
// web target writes into `nsis-web/`; everything is published flat in `/win/`, because the web
// installer fetches its package from the feed folder itself.
const artefacts = [
  join('nsis-web', `cslytics-desktop-${version}-x64.nsis.7z`),
  join('nsis-web', `CSlytics-Web-Setup-${version}.exe`),
  `CSlytics-Setup-${version}.exe`,
  `CSlytics-Setup-${version}.exe.blockmap`,
  'latest.yml'
].map((local) => {
  const path = join(outputDir, local);
  if (!existsSync(path)) refuse(`the packager did not produce ${local}`);
  return { file: basename(local), local, bytes: statSync(path).size, sha512: createHash('sha512').update(readFileSync(path)).digest('base64') };
});

const feed = feedProblems(readFileSync(join(outputDir, 'latest.yml'), 'utf8'), version);
if (feed.length) refuse(`latest.yml must name only the full installer:\n${feed.map((line) => `  - ${line}`).join('\n')}`);

const manifestPath = join(outputDir, `release-${version}${rehearse ? '-rehearsal' : ''}.json`);
writeFileSync(manifestPath, `${JSON.stringify({
  version,
  rehearsal: rehearse,
  commit,
  dirty,
  publisher: rehearse ? null : publisher,
  certificateSha1: rehearse ? null : thumbprint,
  builtAt: new Date().toISOString(),
  artefacts
}, null, 2)}\n`);

console.log(`\n${rehearse ? 'Rehearsal' : 'Release'} manifest: ${manifestPath}`);
if (rehearse) {
  console.log('A rehearsal is unsigned and must not be published.');
} else {
  console.log('Next: CSLYTICS_RELEASE_TARGET=<ssh-host>:<folder> pnpm release:publish, which uploads these to the GitHub');
  console.log('Release and the release host in this order, the feed last, and checks every place against the manifest.');
}
