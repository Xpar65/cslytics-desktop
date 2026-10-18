import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { STEAM_RUNTIME_EXTERNALS } from './src/shared/build-contract.js';

// The version main reports and the stop switch judges (`src/main/release/version.ts`).
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

export default defineConfig({
  main: {
    define: { __CSLYTICS_DESKTOP_VERSION__: JSON.stringify(version) },
    plugins: [
      externalizeDepsPlugin({
        // These packages export TypeScript source within this workspace. Bundle
        // them so the production utility process never depends on a TS loader.
        exclude: [
          '@cslytics/adapters-csfloat',
          '@cslytics/adapters-steam',
          '@cslytics/catalogue',
          '@cslytics/cslytics-account',
          '@cslytics/engine',
          '@cslytics/market-data',
          '@cslytics/ports'
        ]
      })
    ],
    build: {
      // `app.asar` is an archive, not encryption: anyone can unpack the installer and read main.
      // Minifying makes that harder; it hides nothing, so no secret may ever be bundled here.
      minify: true,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'engine-runtime': resolve('src/main/runtime/engine-runtime.ts')
        },
        // These CommonJS packages load package-relative assets at runtime.
        external: [...STEAM_RUNTIME_EXTERNALS]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Sandboxed Electron renderers cannot execute ESM preload scripts. The nearest
        // package.json is ESM, so electron-vite would otherwise emit index.mjs and the
        // context bridge would never be installed. Keep this one-file bridge CommonJS.
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        // The catalogue barrel reaches `node:crypto` and `node:fs`, which a browser bundle cannot
        // resolve, and rollup fails on the whole build the moment the module enters the graph. The
        // renderer wants image URLs and the real/norm float conversion, and `browser.ts` is exactly
        // those pure modules. Aliasing here rather than at each import keeps the rule in one place:
        // whatever a component writes, the renderer gets the browser-safe half, and `check:deps`
        // refuses a name that half does not export before the build has to.
        '@cslytics/catalogue': resolve('../../packages/catalogue/src/browser.ts'),
        // The same split for market data: the window formats figures with the currency table and
        // never opens the cache or fetches a book, so it gets the pure half only.
        '@cslytics/market-data': resolve('../../packages/market-data/src/browser.ts')
      }
    },
    plugins: [react()]
  }
});
