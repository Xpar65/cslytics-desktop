import {
  SteamClientSessionPool,
  SteamGcAdapter,
  SteamMarketAdapter,
  SteamPersonaAdapter,
  SteamSessionAuthAdapter,
  SteamInGameStoreAdapter,
  SteamTradeAdapter,
  type CheckoutHost,
  type CheckoutRequest
} from '@cslytics/adapters-steam';
import { CsfloatAccountAdapter, CsfloatBuyOrderAdapter, CsfloatListingAdapter, CsfloatInventoryAdapter, CsfloatTradeAdapter, CsfloatTransport } from '@cslytics/adapters-csfloat';
import { acquireRuntimeLock, createRuntimeDispatch, openTradingRecord, releaseRuntimeLock, RuntimeClock, type RuntimeCommand } from '@cslytics/runtime';
import { clearAccount, purgeRequestFrom, type PurgeOutcome } from './account-clear.js';
import { SchemaBackupError, SchemaNewerThanAppError, TradingEngine, type EngineDatabase } from '@cslytics/engine';
import type { CredentialVault, EnginePorts, StoreApprovalOutcome } from '@cslytics/ports';

// Electron documents this as `process.parentPort` in a utility process. The `'electron'`
// module's .d.ts still lists a named export, but the ESM export map does not have one —
// `import { parentPort } from 'electron'` throws before this process can talk to main.
const parentPort = process.parentPort;
if (!parentPort) throw new Error('Engine Runtime requires an Electron utility-process parent');

// Fail loudly and specifically if persistence is unavailable, rather than at the first write.
try {
  await import('node:sqlite');
} catch (error) {
  throw new Error(
    `Engine Runtime cannot load node:sqlite on Node ${process.versions.node}. `
    + 'Node 24+ exposes it unflagged; earlier versions need --experimental-sqlite, which Electron '
    + `main passes via execArgv. Underlying error: ${error instanceof Error ? error.message : String(error)}`
  );
}

const dbPath = process.argv[2];
if (!dbPath) throw new Error('Missing Engine Runtime database path');
const lockPath = `${dbPath}.runtime.lock`;
const lockFd = acquireRuntimeLock(lockPath);

/**
 * Opens the trading record, or says by name why it cannot and stops.
 *
 * A record a newer build wrote, and an upgrade whose backup could not be written, both leave the
 * record untouched and refuse (desktop release plan D8, D9). Main is told the sentence before the
 * process goes, because an exit code is all it would otherwise have, and "failed to start with
 * code 1" sends a person looking for the wrong thing. Main kills this process when it hears it;
 * waiting for that rather than exiting here is what makes sure the message is delivered first.
 */
async function openRecord(path: string): Promise<EngineDatabase> {
  try {
    return openTradingRecord(path, () => clock.now().toISOString());
  } catch (error) {
    if (!(error instanceof SchemaNewerThanAppError) && !(error instanceof SchemaBackupError)) throw error;
    releaseRuntimeLock(lockFd, lockPath);
    parentPort.postMessage({ kind: 'fatal', reason: error.message });
    // Main answers with a kill; this timer is only for a main that never does.
    setTimeout(() => process.exit(1), 10_000);
    // Never settles, so nothing below runs against a record that was refused.
    return await new Promise<EngineDatabase>(() => undefined);
  }
}

class ParentCheckoutHost implements CheckoutHost {
  private sequence = 1;
  private readonly pending = new Map<number, { resolve: (value: StoreApprovalOutcome) => void; reject: (error: Error) => void }>();

  constructor() {
    parentPort.on('message', (event) => {
      const message = event.data as { kind?: string; id?: number; ok?: boolean; outcome?: StoreApprovalOutcome; error?: string };
      if (message?.kind !== 'checkout-response' || typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok && message.outcome) waiter.resolve(message.outcome);
      else waiter.reject(new Error(String(message.error ?? 'checkout failed')));
    });
  }

  approve(request: CheckoutRequest): Promise<StoreApprovalOutcome> {
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      parentPort.postMessage({ kind: 'checkout-request', id, accountId: request.accountId, txnId: request.txnId,
        url: request.url, cookies: request.cookies, timeoutMs: request.timeoutMs });
    });
  }
}

class ParentVault implements CredentialVault {
  private sequence = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor() {
    parentPort.on('message', (event) => {
      const message = event.data;
      if (message?.kind !== 'vault-response') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(String(message.error)));
    });
  }

  get(key: string): Promise<string | null> { return this.call('get', key); }
  async set(key: string, value: string): Promise<void> { await this.call('set', key, value); }
  async delete(key: string): Promise<void> { await this.call('delete', key); }

  private call(operation: string, key: string, value?: string): Promise<any> {
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      parentPort.postMessage({ kind: 'vault-request', id, operation, key, value });
    });
  }
}

const clock = new RuntimeClock();
const vault = new ParentVault();
const clients = new SteamClientSessionPool(vault);
const auth = new SteamSessionAuthAdapter(vault, undefined, clients);
const gc = new SteamGcAdapter(vault, 30_000, clients);
const market = new SteamMarketAdapter(auth);
const trade = new SteamTradeAdapter(auth);
// The store shares the GC session `gc` holds. Its checkout is a window, and windows belong to
// main: the runtime asks over parentPort the way it asks the vault, and main answers with what
// the person did. The URL and cookies cross that one seam and are stored nowhere.
const inGameStore = new SteamInGameStoreAdapter(gc, clients, new ParentCheckoutHost());
const persona = new SteamPersonaAdapter(clients);
// One vault instance for both venues, so a Steam token and a CSFloat key cannot be written by
// two writers that do not know about each other (plan §3.8).
const csfloatTransport = new CsfloatTransport();
const csfloat = { account: new CsfloatAccountAdapter(vault,csfloatTransport), listings: new CsfloatListingAdapter(vault,csfloatTransport),
  buyOrders: new CsfloatBuyOrderAdapter(vault,csfloatTransport),
  inventory: new CsfloatInventoryAdapter(vault,csfloatTransport), trades: new CsfloatTradeAdapter(vault,csfloatTransport), vault };
const ports: EnginePorts = { auth, gc, market, trade, inGameStore, persona, clock, csfloat };
const database = await openRecord(dbPath);
const engine = new TradingEngine(database, ports);
// Removing or resetting an account restarts this process with the request on its command line.
// Here and nowhere later: the engine is built but nothing has started, so no loop can write the
// account's rows back, and no request can arrive until `ready` says how it went.
const purgeRequest = purgeRequestFrom(process.argv.slice(3));
const purge: PurgeOutcome | null = purgeRequest ? await clearAccount(engine, purgeRequest) : null;
const dispatch = createRuntimeDispatch(engine, (id) => auth.hasStoredCredential(id));

/**
 * The runtime's one unprompted message to the rest of the app.
 *
 * Coalesced by `ReadBroker` before it gets here, so a two-thousand-item snapshot is one
 * notice rather than two thousand. Fire-and-forget on purpose: nothing acknowledges it, and a
 * notice lost to a closing window costs freshness, never correctness — the window's next read
 * comes from SQLite either way.
 */
engine.onChanged = (notice) => {
  try {
    parentPort.postMessage({ kind: 'changed', accountId: notice.accountId, surfaces: notice.surfaces, at: notice.at });
  } catch {
    // The parent is gone. There is nothing useful to do, and throwing here would take down a
    // refresh pass that had already written its observations.
  }
};
let engineStopped = false;
function stopEngine(): void {
  if (engineStopped) return;
  engineStopped = true;
  engine.shutdown();
}

let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  stopEngine();
  database.close();
  releaseRuntimeLock(lockFd, lockPath);
}

/**
 * How closing the app ends this process. The engine's loops stop first, so nothing more is sent;
 * then every Steam client is logged off, because a process that just exits leaves Steam to time
 * its session out, CS2 still playing, and a launch on the account before then can find its Game
 * Coordinator taken; then the record closes. Main kills this process two seconds after asking, so
 * the logoff is bounded below that (`CLIENT_LOGOFF_TIMEOUT_MS`). A crash still exits through the
 * `exit` handler below, which cannot wait for Steam.
 */
async function shutdown(): Promise<void> {
  stopEngine();
  await clients.closeAll().catch(() => undefined);
  stop();
}

parentPort.on('message', (event) => {
  const message = event.data;
  if (message?.kind === 'shutdown') {
    void shutdown().finally(() => process.exit(0));
    return;
  }
  if (message?.kind !== 'request') return;
  // Main answers its own commands and forwards the rest, so what arrives here is a runtime command.
  void dispatch(message.command as RuntimeCommand)
    .then((value) => parentPort.postMessage({ kind: 'response', id: message.id, ok: true, value }))
    .catch((error) => parentPort.postMessage({
      kind: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error)
    }));
});

// Importing the Steam dependency tree and opening SQLite both happen before this point.
// Main only calls the service ready after all startup work and the request listener exist.
parentPort.postMessage({ kind: 'ready', ...(purge ? { purge } : {}) });

process.on('exit', () => {
  stop();
});
