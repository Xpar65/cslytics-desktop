import { TradingEngine, type AccountRow, type ServiceOverrides } from '@cslytics/engine';
import type { EnginePorts } from '@cslytics/ports';
import {
  acquireRuntimeLock, createRuntimeDispatch, openTradingRecord, releaseRuntimeLock, runtimeCommandSchema,
  type ChangeNotification, type RuntimeDispatch
} from '@cslytics/runtime';

/**
 * What a ports module hands the host: the engine's ports, composed by whoever knows how sessions
 * are made on this machine, and the one question the dispatch asks beside them.
 */
export type HostPorts = {
  ports: EnginePorts;
  /** Whether a session can be brought up for this account without a person: the auth port's answer. */
  hasStoredCredential(accountId: string): Promise<boolean>;
  /** Releases what the ports hold — Steam clients, sockets, timers — when the host closes. */
  close?(): Promise<void>;
};

/** An account the record should hold a row for before anything connects it. */
export type HostAccount = { accountId: string; steamId64: string; accountName: string };

export type HostOptions = {
  /** The trading record: a file path, or `:memory:` for a run that keeps nothing. */
  record: string;
  ports: HostPorts;
  /** A wrong policy injected for a test; never set in production. */
  overrides?: ServiceOverrides;
  /** Rows ensured before anything connects. An account already known by name or SteamID64 is updated, never duplicated. */
  accounts?: readonly HostAccount[];
  /** Accounts connected in this order, one at a time, as a window would. A failure is logged and the next is tried. */
  connect?: readonly string[];
  /** Whether a connect also asks the Game Coordinator for a session. Default true. */
  cs2?: boolean;
  /** The account whose surfaces are kept on the active cadence; the rest run in the background. */
  active?: string | null;
  /** Whether to take the single-writer lock beside a file record. Default true; `:memory:` never locks. */
  lock?: boolean;
  log?: (line: string) => void;
};

export type Host = {
  readonly engine: TradingEngine;
  readonly record: string;
  /** Validates and answers one runtime command. A command the runtime does not know is refused by name. */
  invoke(command: unknown): Promise<unknown>;
  /** Registers a listener for the engine's unprompted change notices. Returns its unsubscribe. */
  subscribe(listener: (notice: ChangeNotification) => void): () => void;
  accounts(): readonly AccountRow[];
  /** Stops the engine, releases the ports, closes the record and the lock. Idempotent. */
  close(): Promise<void>;
};

/**
 * One engine over one record, driven by runtime commands and nothing else.
 *
 * The host is the desktop's utility process without the desktop: the same `TradingEngine`, the
 * same dispatch table, the same record. What differs is who composes the ports and who sends the
 * commands. Here both are the caller's: a ports module decides how sessions are made, and a
 * script, a scheduler or a person at a terminal sends the commands over HTTP (`http.ts`) or in
 * process. Nothing about the trading record changes between the two, which is the test the
 * engine's charter sets: the same engine and the same file, headless, on a server, or under a
 * different UI, with nothing removed.
 */
export async function createHost(options: HostOptions): Promise<Host> {
  const log = options.log ?? ((line: string) => console.error(line));
  const { ports, hasStoredCredential } = options.ports;
  const inMemory = options.record === ':memory:';
  const lockPath = `${options.record}.runtime.lock`;
  const lockFd = inMemory || options.lock === false ? null : acquireRuntimeLock(lockPath);
  let database;
  try {
    database = openTradingRecord(options.record, () => ports.clock.now().toISOString());
  } catch (error) {
    if (lockFd !== null) releaseRuntimeLock(lockFd, lockPath);
    throw error;
  }
  const engine = new TradingEngine(database, ports, options.overrides ?? {});
  const dispatch: RuntimeDispatch = createRuntimeDispatch(engine, hasStoredCredential);
  const listeners = new Set<(notice: ChangeNotification) => void>();
  engine.onChanged = (notice) => {
    const change: ChangeNotification = { kind: 'changed', accountId: notice.accountId, surfaces: [...notice.surfaces], at: notice.at };
    for (const listener of listeners) {
      try { listener(change); } catch { /* a listener's failure is its own */ }
    }
  };

  let closed = false;
  const host: Host = {
    engine,
    record: options.record,
    async invoke(command) {
      if (closed) throw new Error('The host is closed');
      return dispatch(runtimeCommandSchema.parse(command));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    accounts: () => engine.listAccounts(),
    async close() {
      if (closed) return;
      closed = true;
      engine.onChanged = undefined;
      listeners.clear();
      engine.shutdown();
      await options.ports.close?.().catch((error: unknown) => log(`ports did not close cleanly: ${message(error)}`));
      database.close();
      if (lockFd !== null) releaseRuntimeLock(lockFd, lockPath);
    }
  };

  for (const account of options.accounts ?? []) {
    engine.ensureAccount(account.accountId, account.steamId64, account.accountName);
  }
  for (const accountId of options.connect ?? []) {
    try {
      const report = await dispatch({ type: 'session.connect', accountId, ...(options.cs2 === undefined ? {} : { cs2: options.cs2 }) }) as { steam?: { kind?: string }; lastError?: string | null };
      log(`connected ${accountId}: ${report?.steam?.kind ?? 'unknown'}${report?.lastError ? ` (${report.lastError})` : ''}`);
    } catch (error) {
      log(`connect ${accountId} failed: ${message(error)}`);
    }
  }
  if (options.active !== undefined) engine.setActiveAccount(options.active);
  return host;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
