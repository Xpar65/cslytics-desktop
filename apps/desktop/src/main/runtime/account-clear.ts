import type { PurgeMode, PurgeResult } from '@cslytics/engine';

/**
 * Removing or resetting an account, at the one moment it is safe: a freshly started Engine
 * Runtime that has opened the record and started nothing (steam/auth.md, "Removing or resetting
 * an account").
 *
 * Main restarts the runtime with the request on its command line; the runtime clears the account
 * before it answers a single request and says how it went in its `ready` message. Type-only
 * imports, so main can name the argument without loading the engine.
 */
export type PurgeRequest = { accountId: string; mode: PurgeMode };

export type PurgeOutcome =
  | { ok: true; accountId: string; mode: PurgeMode; rows: number }
  | { ok: false; accountId: string; mode: PurgeMode; error: string };

const FLAG = '--purge=';

/** The command-line argument main passes to a runtime that is to clear an account. */
export function purgeArgument(request: PurgeRequest): string {
  return `${FLAG}${request.mode}:${request.accountId}`;
}

/** The request on a runtime's command line, if there is one. */
export function purgeRequestFrom(argv: readonly string[]): PurgeRequest | null {
  const argument = argv.find((value) => value.startsWith(FLAG));
  if (!argument) return null;
  const body = argument.slice(FLAG.length);
  const separator = body.indexOf(':');
  const mode = body.slice(0, separator);
  const accountId = body.slice(separator + 1);
  if (separator < 0 || (mode !== 'remove' && mode !== 'reset') || accountId.length === 0) return null;
  return { mode, accountId };
}

/** What the runtime needs from the engine for this; the facade, or a test's stand-in. */
export type AccountClearer = {
  removeAccount(accountId: string): Promise<PurgeResult>;
  resetAccount(accountId: string): PurgeResult;
};

/** Clears the account and reports, never throws: a failed purge changes nothing and the runtime starts as usual. */
export async function clearAccount(engine: AccountClearer, request: PurgeRequest): Promise<PurgeOutcome> {
  try {
    const result = request.mode === 'remove'
      ? await engine.removeAccount(request.accountId)
      : engine.resetAccount(request.accountId);
    const rows = Object.values(result.deleted).reduce((total, count) => total + count, 0);
    return { ok: true, accountId: request.accountId, mode: request.mode, rows };
  } catch (error) {
    return { ok: false, accountId: request.accountId, mode: request.mode, error: error instanceof Error ? error.message : String(error) };
  }
}
