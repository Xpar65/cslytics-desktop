import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { CredentialVault } from '@cslytics/ports';
import { reapRuntimeLock, reapRuntimeLockWhenGone } from '@cslytics/runtime/lock';
import type { ChangeNotification } from '../../shared/api.js';
import { purgeArgument, type PurgeOutcome, type PurgeRequest } from '../runtime/account-clear.js';
import type { CheckoutOpenRequest, CheckoutOutcome } from '../checkout/checkout-window.js';

/**
 * The Engine Runtime beside the window: a utility process over this profile's `trading.sqlite`,
 * asked by message and answered by id (remote engine host plan D1). Everything that was main's
 * about that process lives here under one name: the fork, the ready and fatal messages, the vault
 * and checkout relays the runtime asks over the same pipe, the stop on quit, and the restart with
 * an account purged for remove and reset. Nothing in it changed but its address.
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type LocalRuntimeOptions = {
  userData: string;
  /** The compiled runtime entry, resolved by main from its own `__dirname`. */
  entry: string;
  vault: CredentialVault;
  /** Valve's checkout page is a window, and windows are main's; the runtime asks over the pipe. */
  checkout: (request: CheckoutOpenRequest) => Promise<CheckoutOutcome>;
  onNotice: (notice: ChangeNotification) => void;
  /** The runtime is listening: the one preference the engine steers by is pushed here. */
  onReady: () => void;
  /** Whether the app is quitting, so an exit then is deliberate rather than a failure. */
  isQuitting: () => boolean;
};

export class LocalRuntimeTransport {
  readonly kind = 'local' as const;
  readonly lockPath: string;
  private runtime: UtilityProcess | null = null;
  private ready = false;
  private failure: string | null = null;
  /** Why the runtime refused to open the trading record, in its own words; outlives its exit code. */
  private fatal: string | null = null;
  /** The runtime `stop` is stopping, whose exit is therefore not a failure. */
  private stopping: UtilityProcess | null = null;
  /** A remove or reset in progress. Commands that arrive meanwhile wait for it. */
  private restarting: Promise<void> | null = null;
  private sequence = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: LocalRuntimeOptions) {
    this.lockPath = join(options.userData, 'trading.sqlite.runtime.lock');
  }

  get running(): boolean {
    return this.runtime !== null;
  }

  /**
   * Forks the Engine Runtime and answers once it is ready, with how the purge it was asked for
   * went. Every handler checks that its child is still *the* runtime: across a restart the old
   * one's last messages and its exit can arrive after the new one exists.
   */
  start(purge?: PurgeRequest): Promise<PurgeOutcome | null> {
    return new Promise((resolve, reject) => {
      this.ready = false;
      this.failure = null;
      this.fatal = null;
      const child = utilityProcess.fork(this.options.entry, [join(this.options.userData, 'trading.sqlite'), ...(purge ? [purgeArgument(purge)] : [])], {
        serviceName: 'CSlytics Engine Runtime',
        // The engine persists through `node:sqlite`, which is unflagged only from Node 24.
        // Electron 37 bundles Node 22, where the module exists but throws without this flag —
        // so tests can pass on a modern local Node while the packaged app fails to open its
        // database. Decide from the Node actually running, not from the Electron version.
        execArgv: sqliteRequiresFlag() ? ['--experimental-sqlite'] : []
      });
      this.runtime = child;
      child.on('message', (message: any) => {
        if (this.runtime !== child) return;
        if (message?.kind === 'ready') {
          this.ready = true;
          console.info('Engine Runtime ready');
          this.options.onReady();
          resolve((message.purge ?? null) as PurgeOutcome | null);
          return;
        }
        if (message?.kind === 'fatal') {
          // The record was refused and left untouched: a newer build wrote it, or the backup before
          // an upgrade could not be made. The runtime waits for this kill so the sentence arrives
          // before its exit does, and every later command answers with the sentence.
          this.fatal = String(message.reason ?? 'The Engine Runtime could not open the trading record.');
          console.error('Engine Runtime refused the trading record:', this.fatal);
          try { child.kill(); } catch { /* already gone */ }
          return;
        }
        if (message?.kind === 'response') {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.ok) waiter.resolve(message.value);
          else waiter.reject(new Error(String(message.error)));
          return;
        }
        if (message?.kind === 'vault-request') {
          void this.handleVaultRequest(message, child);
          return;
        }
        if (message?.kind === 'checkout-request') {
          void this.handleCheckoutRequest(message, child);
          return;
        }
        if (message?.kind === 'changed') {
          // Relayed, not interpreted. Main has no read model and must never grow one.
          this.options.onNotice({ kind: 'changed', accountId: message.accountId, surfaces: message.surfaces, at: message.at });
        }
      });
      child.on('exit', (code) => {
        const deliberate = this.options.isQuitting() || this.stopping === child;
        const phase = deliberate ? 'restarted' : this.ready ? `exited with code ${code}` : `failed to start with code ${code}`;
        const error = new Error(this.fatal ?? `Engine Runtime ${phase}`);
        reject(error);
        if (this.runtime !== child) return;
        if (!deliberate) this.failure = error.message;
        this.ready = false;
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        this.runtime = null;
      });
    });
  }

  /**
   * One request to the Engine Runtime. Rejects rather than throws, so a caller that does not await
   * it — the focus and wake hints — cannot become an uncaught exception in main; and waits out a
   * remove or reset, whose runtime is not listening yet.
   */
  async invoke(command: unknown): Promise<unknown> {
    if (this.restarting) await this.restarting;
    const child = this.runtime;
    if (!child) throw new Error(this.failure ?? 'Engine Runtime is not running');
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ kind: 'request', id, command });
    });
  }

  /**
   * Remove and reset (steam/auth.md, "Removing or resetting an account"): the runtime stopped as
   * closing the app stops it, then started again with the account cleared before it answers
   * anything. Nothing short of that can stop one account's refresh loop, supervisor, event queue
   * and schedulers, so all of them restart; the window reloads and reconnects the other accounts.
   */
  async restartWithPurge(request: PurgeRequest): Promise<PurgeOutcome> {
    if (this.restarting) throw new Error('Another account is being removed or reset. Try again in a moment.');
    // Asked of the running runtime first, so a refusal costs nobody their session.
    const { refusal } = await this.invoke({ type: 'accounts.clearable', accountId: request.accountId }) as { refusal: string | null };
    if (refusal) throw new Error(refusal);
    let finished!: () => void;
    this.restarting = new Promise<void>((resolve) => { finished = resolve; });
    try {
      await this.stop();
      // A runtime that never exited is abandoned; nothing it was asked will be answered.
      for (const waiter of this.pending.values()) waiter.reject(new Error('Engine Runtime restarted'));
      this.pending.clear();
      if (this.options.isQuitting()) throw new Error('CSlytics is closing.');
      let outcome: PurgeOutcome | null;
      try {
        outcome = await this.start(request);
      } catch (error) {
        // The purge is one transaction, so a runtime that died in it left the record whole.
        // Start one without it rather than leave the app with no runtime at all.
        reapRuntimeLock(this.lockPath);
        if (!this.options.isQuitting()) await this.start().catch(() => undefined);
        throw error;
      }
      return outcome ?? { ...request, ok: false, error: 'The Engine Runtime did not say whether the account was cleared.' };
    } finally {
      this.restarting = null;
      finished();
    }
  }

  /**
   * Asks the Engine Runtime to stop the way closing the app does, and resolves once it has gone: a
   * clean shutdown, or a kill after two seconds and up to two more for the exit to land. A restart
   * needs the exit itself, because the next runtime refuses the record while this one holds its
   * lock. The lock is reaped either way.
   */
  stop(): Promise<void> {
    const child = this.runtime;
    if (!child) {
      reapRuntimeLock(this.lockPath);
      return Promise.resolve();
    }
    this.stopping = child;
    return new Promise((resolve) => {
      let finished = false;
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(kill);
        if (giveUp) clearTimeout(giveUp);
        // The runtime has exited or been killed; the lock goes once its pid is really gone.
        void reapRuntimeLockWhenGone(this.lockPath).finally(() => resolve());
      };
      child.once('exit', finish);
      const kill = setTimeout(() => {
        console.warn('engine runtime: still running two seconds after being asked to stop; killing it');
        try { child.kill(); } catch { /* already gone */ }
        giveUp = setTimeout(finish, 2_000);
      }, 2_000);
      try {
        child.postMessage({ kind: 'shutdown' });
      } catch {
        try { child.kill(); } catch { /* already gone */ }
      }
    });
  }

  /** What closing does: the same stop; the transport is then done with. */
  close(): Promise<void> {
    return this.stop();
  }

  /** The lock, reaped without a runtime to wait for: quitting with none running. */
  reapLock(): void {
    reapRuntimeLock(this.lockPath);
  }

  /**
   * The Engine Runtime cannot open a window, so Valve's checkout page is main's to show. The URL
   * and the cookies arrive here and go to the checkout session only; the answer is one word.
   */
  private async handleCheckoutRequest(message: any, child: UtilityProcess): Promise<void> {
    try {
      const outcome = await this.options.checkout({
        accountId: String(message.accountId),
        txnId: String(message.txnId),
        url: String(message.url),
        cookies: Array.isArray(message.cookies) ? message.cookies.map(String) : [],
        timeoutMs: Number(message.timeoutMs) || 600_000
      });
      this.replyTo(child, { kind: 'checkout-response', id: message.id, ok: true, outcome });
    } catch (error) {
      this.replyTo(child, { kind: 'checkout-response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleVaultRequest(message: any, child: UtilityProcess): Promise<void> {
    const vault = this.options.vault;
    try {
      let value: unknown;
      if (message.operation === 'get') value = await vault.get(String(message.key));
      else if (message.operation === 'set') value = await vault.set(String(message.key), String(message.value));
      else if (message.operation === 'delete') value = await vault.delete(String(message.key));
      else throw new Error('Unknown vault operation');
      this.replyTo(child, { kind: 'vault-response', id: message.id, ok: true, value });
    } catch (error) {
      this.replyTo(child, { kind: 'vault-response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Answers the runtime that asked, and only while it is still the runtime. Request ids restart in
   * every runtime, so an answer meant for one that a remove or reset stopped could otherwise settle
   * an unrelated request in the next.
   */
  private replyTo(child: UtilityProcess, message: unknown): void {
    if (this.runtime !== child) return;
    try { child.postMessage(message); } catch { /* it has gone */ }
  }
}

/** True when this Node needs `--experimental-sqlite` to expose `node:sqlite`. */
function sqliteRequiresFlag(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major < 24;
}
