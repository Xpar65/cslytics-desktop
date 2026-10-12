/**
 * This build's version, stamped from `apps/desktop/package.json` by `electron.vite.config.ts`.
 *
 * Not `app.getVersion()`: Electron answers that from the package it was launched with, and a copy
 * started as `electron out/main/index.js` — how every journey starts it — finds none and reports
 * Electron's own version, 37.x. The stop switch would then judge the wrong version and the header
 * would name one that was never released. `O-RELEASE-01` is what found it.
 */
declare const __CSLYTICS_DESKTOP_VERSION__: string | undefined;

export const DESKTOP_VERSION: string = typeof __CSLYTICS_DESKTOP_VERSION__ === 'string' ? __CSLYTICS_DESKTOP_VERSION__ : '0.0.0';
