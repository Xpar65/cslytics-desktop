import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The bridge a connected host's page gets in its view (remote engine host plan D12): the window's
 * two functions over a narrower channel main answers only for this view and only for engine and
 * catalogue reads and commands, plus `host`, forwarded verbatim to the host's own command route
 * with the token main holds. The page never sees the token and never sees a desktop command.
 *
 * Like the window's preload this cannot import `shared/api.ts`: it pulls Zod, and a sandboxed
 * preload may only `require` Electron's allowlisted modules.
 */

/** Must match `CHANGE_CHANNEL` in `shared/api.ts`. */
const CHANGE_CHANNEL = 'trading:changed';

type ChangeNotification = { kind: 'changed'; accountId: string; surfaces: string[]; at: string };

function asChangeNotification(payload: unknown): ChangeNotification | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.kind !== 'changed' || typeof row.accountId !== 'string' || row.accountId.length < 1) return null;
  if (typeof row.at !== 'string' || row.at.length < 1) return null;
  if (!Array.isArray(row.surfaces) || row.surfaces.length > 16) return null;
  if (row.surfaces.some((surface) => typeof surface !== 'string' || surface.length < 1)) return null;
  return { kind: 'changed', accountId: row.accountId, surfaces: row.surfaces as string[], at: row.at };
}

const api = Object.freeze({
  /** An engine command or a catalogue read, answered as the window's pages are answered. */
  invoke(command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('host-page:command', command);
  },
  /** A command of the host's own, answered by the host's own route. */
  host(command: unknown): Promise<unknown> {
    return ipcRenderer.invoke('host-page:host', command);
  },
  subscribe(listener: (notification: ChangeNotification) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = asChangeNotification(payload);
      if (parsed) listener(parsed);
    };
    ipcRenderer.on(CHANGE_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(CHANGE_CHANNEL, handler); };
  }
});

contextBridge.exposeInMainWorld('trading', api);
