import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChangeNotification, EngineCommand, TradingDesktopApi } from '../shared/api.js';

/** Must match `CHANGE_CHANNEL` in `shared/api.ts`. This file cannot import that module: it pulls Zod, and a sandboxed preload can only `require` Electron's allowlisted modules. */
const CHANGE_CHANNEL = 'trading:changed';

function asChangeNotification(payload: unknown): ChangeNotification | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.kind !== 'changed' || typeof row.accountId !== 'string' || row.accountId.length < 1) return null;
  if (typeof row.at !== 'string' || row.at.length < 1) return null;
  if (!Array.isArray(row.surfaces) || row.surfaces.length > 16) return null;
  if (row.surfaces.some((surface) => typeof surface !== 'string' || surface.length < 1)) return null;
  return { kind: 'changed', accountId: row.accountId, surfaces: row.surfaces as string[], at: row.at };
}

const api: TradingDesktopApi = Object.freeze({
  invoke(command: EngineCommand): Promise<unknown> {
    return ipcRenderer.invoke('trading:command', command);
  },

  /**
   * Unprompted change notices from the Engine Runtime.
   *
   * Validated here rather than trusted: this is the one place data crosses into the renderer
   * without the renderer having asked for it, and the isolated world is exactly where a
   * malformed payload should stop. A notice that fails the schema is dropped — the window then
   * shows data one cadence interval old, which is the safe direction.
   */
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
