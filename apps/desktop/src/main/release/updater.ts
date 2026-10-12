import electronUpdater from 'electron-updater';
import type { UpdateState } from '../../shared/release.js';
import { nextUpdateState, type UpdateEvent } from './update-state.js';

/** First check after launch: late enough not to compete with the launch sweep for the network. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

/**
 * Self-update (desktop release plan D4): electron-updater against the generic feed that
 * `electron-builder.config.mjs` writes into every installed copy's `app-update.yml`.
 *
 * Downloads in the background and installs when the app quits, or at once from *Restart to update*.
 * Never forced, never a downgrade, never a prerelease. Each downloaded installer is checked against
 * the publisher name the installed copy was built with before it runs, which is what stops a feed
 * that has been tampered with from installing anything unsigned.
 *
 * An unpackaged run never touches electron-updater at all: it has no `app-update.yml`, and asking it
 * to check would only log an error every four hours.
 */
export class DesktopUpdater {
  private current: UpdateState;
  private started = false;

  constructor(
    private readonly packaged: boolean,
    private readonly userAgent: string,
    private readonly onChange: () => void
  ) {
    this.current = packaged ? { phase: 'idle' } : { phase: 'disabled', reason: 'Development builds do not update themselves.' };
  }

  state(): UpdateState {
    return this.current;
  }

  start(): void {
    if (!this.packaged || this.started) return;
    this.started = true;
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.requestHeaders = { 'User-Agent': this.userAgent };
    const now = (): string => new Date().toISOString();
    autoUpdater.on('checking-for-update', () => this.apply({ type: 'checking' }));
    autoUpdater.on('update-available', (info) => this.apply({ type: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => this.apply({ type: 'not-available', at: now() }));
    autoUpdater.on('download-progress', (progress) => this.apply({ type: 'progress', percent: progress.percent }));
    autoUpdater.on('update-downloaded', (event) => this.apply({ type: 'downloaded', version: event.version }));
    autoUpdater.on('error', (error) => this.apply({ type: 'error', message: error instanceof Error ? error.message : String(error), at: now() }));
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /** Asks the feed now. Failures arrive as the `error` event, so this never throws. */
  async check(): Promise<void> {
    if (!this.packaged) return;
    try {
      await electronUpdater.autoUpdater.checkForUpdates();
    } catch {
      // Already reported through the `error` event.
    }
  }

  /**
   * Quits and runs the downloaded installer. The installer is started first and waits for this
   * process to exit; `before-quit` still shuts the Engine Runtime down, so a mutation in flight
   * recovers on the next launch the way any quit does.
   */
  install(): void {
    if (this.current.phase !== 'ready') throw new Error('No update has been downloaded yet.');
    electronUpdater.autoUpdater.quitAndInstall(true, true);
  }

  private apply(event: UpdateEvent): void {
    const next = nextUpdateState(this.current, event);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.onChange();
  }
}
