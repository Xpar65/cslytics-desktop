/**
 * Launches the packaged app and proves it can run (desktop release plan §4, §8).
 *
 *   pnpm package:desktop && pnpm smoke:packaged
 *
 * The unit and journey suites run the build in `out/` with this repository's node_modules beside
 * it, which is exactly how an undeclared runtime dependency hides: `protobufjs` and `lzma` resolved
 * from the workspace and would have failed in an installer. This starts `win-unpacked\CSlytics.exe`
 * with a throwaway profile and no network, and requires that
 *
 *  1. the window opens and the bridge answers;
 *  2. the Engine Runtime starts and opens a trading record in that profile (`accounts.list`);
 *  3. `release.status` reports a packaged build of the manifest's version;
 *  4. every runtime dependency the manifest declares resolves from inside `app.asar`, including the
 *     ones only loaded later, like the store's LZMA decoder.
 *
 * `CSLYTICS_PACKAGE_DIR` points at the packager's output when it is not `apps/desktop/dist`.
 * Windows only; it is not part of `pnpm check`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { electronDisplayArgs } from './electron-display.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };

export async function smokePackaged(packageDir = process.env.CSLYTICS_PACKAGE_DIR?.trim() || join(root, 'apps', 'desktop', 'dist')): Promise<string[]> {
  const executable = join(packageDir, 'win-unpacked', 'CSlytics.exe');
  if (!existsSync(executable)) return [`no packaged app at ${executable}; run pnpm package:desktop first`];
  const profile = mkdtempSync(join(tmpdir(), 'cslytics-smoke-'));
  const failures: string[] = [];
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`, '--host-resolver-rules=MAP * ~NOTFOUND', ...electronDisplayArgs()],
    timeout: 60_000
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof (window as unknown as { trading?: unknown }).trading === 'object', undefined, { timeout: 30_000 });

    const invoke = (command: unknown): Promise<unknown> => page.evaluate(async (payload) =>
      (window as unknown as { trading: { invoke(command: unknown): Promise<unknown> } }).trading.invoke(payload), command);

    let accounts: unknown = null;
    for (let attempt = 0; attempt < 60 && accounts === null; attempt += 1) {
      try { accounts = await invoke({ type: 'accounts.list' }); } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (!Array.isArray(accounts)) failures.push('the Engine Runtime never answered accounts.list');
    else if (accounts.length !== 0) failures.push(`a fresh profile listed ${accounts.length} accounts`);
    if (!existsSync(join(profile, 'trading.sqlite'))) failures.push('no trading.sqlite in the profile passed with --user-data-dir');

    const status = await invoke({ type: 'release.status' }) as { version: string; packaged: boolean; update: { phase: string } };
    if (status.version !== manifest.version) failures.push(`release.status reports ${status.version}; the manifest says ${manifest.version}`);
    if (!status.packaged) failures.push('release.status says the packaged app is not packaged');
    if (status.update.phase === 'disabled') failures.push('the packaged app has its updater disabled');

    const resolved = await app.evaluate(({ app: electronApp }, names) => {
      const { createRequire } = process.getBuiltinModule('node:module') as typeof import('node:module');
      const { join: joinPath } = process.getBuiltinModule('node:path') as typeof import('node:path');
      const require = createRequire(joinPath(electronApp.getAppPath(), 'package.json'));
      return names.map((name) => {
        try { return { name, at: require.resolve(name) }; } catch (error) { return { name, error: error instanceof Error ? error.message : String(error) }; }
      });
    }, Object.keys(manifest.dependencies));
    for (const entry of resolved) {
      if ('error' in entry) failures.push(`${entry.name} does not resolve inside the package: ${entry.error}`);
      else if (!/app\.asar/.test(entry.at)) failures.push(`${entry.name} resolved outside the package: ${entry.at}`);
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = await smokePackaged();
  if (failures.length) {
    console.error(`packaged smoke FAILED\n${failures.map((line) => `  - ${line}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`packaged smoke: CSlytics ${manifest.version} started, opened its record, and resolved ${Object.keys(manifest.dependencies).length} runtime dependencies from app.asar`);
}
