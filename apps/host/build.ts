import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the host into one file a server runs with `node out/host.mjs`. Node's own modules stay
 * external; so does everything a ports module brings, because the module is loaded at run time
 * from the path `--ports` names and resolves its own dependencies from where it lives.
 */
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, 'package.json'));
const { build } = require('esbuild') as { build(options: Record<string, unknown>): Promise<void> };

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'out/host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['node:*'],
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  sourcemap: false,
  logLevel: 'info'
});
