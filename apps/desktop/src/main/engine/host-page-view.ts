import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { CHANGE_CHANNEL, type ChangeNotification, type HostPage, type HostPageBounds } from '../../shared/api.js';

/**
 * A page the connected host serves, shown over the window's content area (remote engine host plan
 * D12). The page is remote content and is treated as such: its own sandboxed view on its own
 * session, no navigation off the host's origin, no new windows, and a preload that exposes the
 * same two bridge functions the window has plus one for the host's own route. The token never
 * reaches the page: this view's session adds it to every request the page makes to the host, so
 * the host's pages and assets load under the same token check as everything else (D9).
 */

export type HostPageViewOptions = {
  /** The compiled host-page preload. */
  preload: string;
  /** The connected host's origin and token, read when a page is shown; null with no host. */
  host: () => { origin: string; token: string } | null;
  window: () => BrowserWindow | null;
};

const PARTITION = 'host-page';

export class HostPageView {
  private view: WebContentsView | null = null;
  private attached = false;
  private page: HostPage | null = null;
  private origin: string | null = null;

  constructor(private readonly options: HostPageViewOptions) {}

  /** Whether an IPC message came from this view, which is the only sender its channels answer. */
  isSender(contents: WebContents): boolean {
    return this.view !== null && this.view.webContents === contents;
  }

  current(): HostPage | null {
    return this.page;
  }

  /** Shows the page at these bounds; a different page loads, the same one only moves. */
  show(page: HostPage, bounds: HostPageBounds): void {
    const window = this.options.window();
    const host = this.options.host();
    if (!window || window.isDestroyed() || !host) throw new Error('No engine host is connected.');
    if (!this.view || this.origin !== host.origin) {
      this.close();
      this.origin = host.origin;
      const pageSession = session.fromPartition(PARTITION);
      // The token rides on every request the page makes to its own host, and on nothing else.
      pageSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        if (details.url.startsWith(`${host.origin}/`)) requestHeaders['Authorization'] = `Bearer ${host.token}`;
        callback({ requestHeaders });
      });
      const view = new WebContentsView({
        webPreferences: {
          preload: this.options.preload,
          session: pageSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.warn(`host page: ${url} failed to load (${code} ${description})`);
      });
      view.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`${host.origin}/`)) event.preventDefault();
      });
      this.view = view;
      this.page = null;
    }
    const view = this.view;
    if (!this.page || this.page.id !== page.id || this.page.path !== page.path) {
      this.page = page;
      void view.webContents.loadURL(`${host.origin}${page.path}`).catch(() => undefined);
    }
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    });
    if (!this.attached) {
      window.contentView.addChildView(view);
      this.attached = true;
    }
  }

  /** Takes the view off the window and keeps the page, so showing it again is a move, not a reload. */
  hide(): void {
    if (!this.view || !this.attached) return;
    const window = this.options.window();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(this.view);
    this.attached = false;
  }

  /** Drops the view and its page; the next show loads afresh. */
  close(): void {
    this.hide();
    if (this.view) {
      try { this.view.webContents.close(); } catch { /* already gone */ }
    }
    this.view = null;
    this.page = null;
    this.origin = null;
  }

  /** The engine's change notices reach the page the way they reach the window. */
  notify(notice: ChangeNotification): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.send(CHANGE_CHANNEL, notice);
  }
}
