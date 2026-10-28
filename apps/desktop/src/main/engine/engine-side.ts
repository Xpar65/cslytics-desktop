import type { CredentialVault } from '@cslytics/ports';
import type { ChangeNotification, EngineConnection, EngineStatus, HostPage } from '../../shared/api.js';
import type { PurgeOutcome, PurgeRequest } from '../runtime/account-clear.js';
import type { SettingsStore } from '../settings-store.js';
import type { LocalRuntimeTransport } from './local-runtime.js';
import { REMOTE_HOST_OWNS, RemoteHostTransport } from './remote-host.js';

/**
 * The engine side of the desktop: whichever engine this profile is set to drive, behind the one
 * seam main forwards commands through (remote engine host plan D1–D3). Local is the Engine Runtime
 * forked beside the window; remote is a host on another machine. Switching is a setting written,
 * the old transport closed and the new one started; the window reloads on top of it.
 *
 * No Electron here beyond what the local transport brings through its factory, so the shape is
 * plain: a token lives in the vault under `engine-host:<url>` (D2), a remote connection opens no
 * local record and takes no lock (D3), and the commands a host owns are refused by name (D5).
 */

export type EngineSideOptions = {
  settings: SettingsStore;
  vault: CredentialVault;
  desktopVersion: string;
  /** Builds the local transport; main composes the Electron pieces it needs. */
  local: () => LocalRuntimeTransport;
  onNotice: (notice: ChangeNotification) => void;
  /** The engine connection's state moved: the window re-reads `engine.status`. */
  onHostState: () => void;
  /** The remote transport's fetch; a test hands it a host with no socket. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

export type EngineSide = {
  readonly connection: EngineConnection;
  /** The local runtime, when the connection is local; what quitting stops. */
  readonly local: LocalRuntimeTransport | null;
  start(): void;
  invoke(command: unknown): Promise<unknown>;
  status(): EngineStatus;
  /** The sentence a main-answered command gets in remote mode, or null when it may go ahead. */
  refusal(type: string): string | null;
  connect(request: { url: string; label: string; token: string }): Promise<EngineStatus>;
  disconnect(): Promise<EngineStatus>;
  restartWithPurge(request: PurgeRequest): Promise<PurgeOutcome>;
  pages(): Promise<HostPage[]>;
  /** A request to one of the host's own routes, with the token (plan D12). Refused with no host. */
  hostRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: string }>;
  /** The connected host's origin, for a page's view; null with no host. */
  hostOrigin(): string | null;
  /** The token the connected host wants, for a view that must send it with every request; null with no host. */
  hostToken(): string | null;
  close(): Promise<void>;
};

/** The vault key a host's token is kept under. */
export function hostTokenKey(url: string): string {
  return `engine-host:${normaliseUrl(url)}`;
}

/** A host URL as stored and compared: `http` or `https`, no trailing slash, nothing else. */
export function normaliseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('An engine host URL starts with http:// or https://');
  if (parsed.search || parsed.hash) throw new Error('An engine host URL names a host and a port, nothing after them');
  return parsed.toString().replace(/\/+$/, '');
}

export function createEngineSide(options: EngineSideOptions): EngineSide {
  const log = options.log ?? ((line: string) => console.warn(line));
  let connection: EngineConnection = options.settings.current().engine;
  let local: LocalRuntimeTransport | null = null;
  let remote: RemoteHostTransport | null = null;
  let remoteToken: string | null = null;
  /** The sentence a remote with no stored token shows, until one is entered. */
  let missingToken = false;

  const startLocal = (): void => {
    local = options.local();
    void local.start().catch(() => undefined);
  };

  const startRemote = async (url: string): Promise<void> => {
    const token = await options.vault.get(hostTokenKey(url)).catch(() => null);
    missingToken = token === null || token === '';
    remoteToken = token ?? '';
    remote = new RemoteHostTransport({
      url,
      token: token ?? '',
      onNotice: options.onNotice,
      onState: () => options.onHostState(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      log
    });
    remote.start();
  };

  const status = (): EngineStatus => {
    if (connection.kind === 'local' || !remote) return { kind: 'local', desktopVersion: options.desktopVersion };
    const state = remote.state();
    return {
      kind: 'remote',
      desktopVersion: options.desktopVersion,
      url: connection.url,
      label: connection.label,
      state: missingToken ? 'refused' : state.state,
      since: state.since,
      build: state.build,
      accounts: state.accounts,
      detail: missingToken ? 'No token is stored for this host. Enter it below.' : state.detail
    };
  };

  const stopCurrent = async (): Promise<void> => {
    if (local) {
      await local.close();
      local = null;
    }
    if (remote) {
      await remote.close();
      remote = null;
      remoteToken = null;
    }
  };

  const side: EngineSide = {
    get connection() { return connection; },
    get local() { return local; },
    start() {
      if (connection.kind === 'local') startLocal();
      else void startRemote(connection.url);
    },
    invoke(command) {
      if (local) return local.invoke(command);
      if (remote) return remote.invoke(command);
      return Promise.reject(new Error('The engine is not running'));
    },
    status,
    refusal(type) {
      return connection.kind === 'remote' ? REMOTE_HOST_OWNS[type] ?? null : null;
    },
    async connect(request) {
      const url = normaliseUrl(request.url);
      const key = hostTokenKey(url);
      let token = request.token.trim();
      if (token === '') {
        const stored = await options.vault.get(key).catch(() => null);
        if (!stored) throw new Error('Enter the token the engine host was started with.');
        token = stored;
      } else {
        await options.vault.set(key, token);
      }
      const label = request.label.trim() || new URL(url).host;
      await stopCurrent();
      connection = options.settings.writeEngine({ kind: 'remote', url, label }).engine;
      await startRemote(url);
      options.onHostState();
      return status();
    },
    async disconnect() {
      await stopCurrent();
      connection = options.settings.writeEngine({ kind: 'local' }).engine;
      startLocal();
      options.onHostState();
      return status();
    },
    restartWithPurge(request) {
      if (!local) return Promise.reject(new Error(REMOTE_HOST_OWNS[request.mode === 'remove' ? 'accounts.remove' : 'accounts.reset']));
      return local.restartWithPurge(request);
    },
    pages() {
      return remote ? remote.pages() : Promise.resolve([]);
    },
    hostRequest(method, path, body) {
      if (!remote) return Promise.reject(new Error('No engine host is connected.'));
      return remote.hostRequest(method, path, body);
    },
    hostOrigin() {
      return remote ? remote.url : null;
    },
    hostToken() {
      return remote ? remoteToken : null;
    },
    close: stopCurrent
  };
  return side;
}
