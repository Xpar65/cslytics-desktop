/**
 * The half of this package a window may load: image URLs and the real/norm float conversion.
 *
 * Everything here is pure — no `node:` import, no fetch, no file — which is the whole test for
 * belonging. The rest of the package reaches `node:crypto` and `node:fs`, which a browser bundle
 * cannot resolve, so the renderer build aliases `@cslytics/catalogue` to this file
 * (`apps/desktop/electron.vite.config.ts`). A name the renderer needs is added here; `check:deps`
 * refuses a renderer import this file does not export, before the build does.
 */
export * from './images.js';
export * from './float.js';
export * from './csfloat-item-class.js';
