/** Build/runtime names shared by electron-vite, Electron main, and regression tests. */
export const DESKTOP_PRELOAD_ENTRY = 'index.cjs';
/** The preload of the view a connected host's page is shown in (remote engine host plan D12): the same bridge, over a narrower channel. */
export const HOST_PAGE_PRELOAD_ENTRY = 'host-page.cjs';

/**
 * CommonJS Steam packages which must remain intact beside the desktop app.
 * They resolve package-relative files at runtime and cannot be inlined into the ESM utility.
 */
export const STEAM_RUNTIME_EXTERNALS = [
  'globaloffensive',
  'steam-session',
  'steam-user'
] as const;
