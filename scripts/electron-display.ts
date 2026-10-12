/**
 * Whether the Electron window may appear on the operator's display.
 *
 * Windows virtual desktops cannot own this: creating one switches the console, and moving a
 * window after `firstWindow()` still flashes and steals focus. Chromium `--headless` keeps the
 * window off the display from the first frame, which is what an agent-driven run needs.
 * D-05 (QR) is the exception that still needs a person to see the window.
 *
 * It lives in `scripts/` rather than `tests/` because the packaged smoke uses it too, and the smoke
 * ships in the public repository, which carries no tests (`export-public.ts`).
 */

export const HEADED_ENV = 'CSLYTICS_E2E_HEADED';
/** Same name as `QR_APPROVED_ENV` in `qr-gate.ts`; kept as a literal so this file stays free of operator imports. */
const QR_APPROVED_ENV = 'CSLYTICS_E2E_QR_APPROVED';

export function headedRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env[HEADED_ENV];
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  if (env.HEADED === '1') return true;
  return env[QR_APPROVED_ENV] === '1';
}

export function electronDisplayArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return headedRequested(env) ? [] : ['--headless'];
}
