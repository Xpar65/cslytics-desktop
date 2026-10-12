import type { AccountConnection, ConnectionPhase } from './types.js';

/**
 * How an account's connection reads on screen.
 *
 * There are two independent connections behind every account and the window has to keep them
 * apart. Steam authentication is what the market and the wallet run on; the CS2 Game
 * Coordinator is what inventory and storage units run on. They fail separately, and the most
 * confusing failure this app has is the one where Steam is perfectly healthy and only the GC
 * is gone — because another computer signed into the same account is playing CS2, which takes
 * the Game Coordinator session away.
 *
 * A single "connected / disconnected" light would send someone to sign in again, which cannot
 * possibly help. So each state says what is actually wrong and what to do about it.
 *
 * The phase is decided once, in the engine. This module switches on that phase and owns only
 * the wording.
 */
export type ConnectionTone = 'live' | 'partial' | 'blocked' | 'offline';

export type ConnectionSummary = {
  tone: ConnectionTone;
  /** Two or three words, for the account tab. */
  label: string;
  /** A sentence, for the tooltip and the detail line. */
  detail: string;
  /** True when inventory and storage-unit reads can run right now. */
  gcReady: boolean;
  /**
   * What the account card should offer, and the reason this type exists rather than a boolean.
   *
   * `connect` is the cached path: a stored refresh token, no password, no Guard code.
   * `sign-in` is the interactive one, which costs a rate-limited Steam attempt and a code off
   * the user's phone. Offering the wrong one is not a cosmetic mistake — the failure this
   * whole module exists for, the CS2 session held by another computer, reads as "signed out"
   * to anyone who has not been told otherwise, and signing in again cannot possibly fix it.
   */
  action: 'sign-in' | 'connect' | 'none';
};

export function describeConnection(connection: AccountConnection | undefined): ConnectionSummary {
  if (!connection) {
    return {
      tone: 'offline',
      label: 'signed out',
      detail: 'This account has no Steam session in this window. Connect to reuse the saved session.',
      gcReady: false,
      action: 'connect'
    };
  }

  const phase: ConnectionPhase = connection.phase;
  switch (phase) {
    case 'CONNECTED':
      return {
        tone: 'live',
        label: 'Steam + CS2',
        detail: 'Signed in to Steam with a live CS2 Game Coordinator session. Inventory and storage units can be read.',
        gcReady: true,
        action: 'none'
      };
    case 'CONNECTING':
      return {
        tone: 'partial',
        label: 'connecting',
        detail: 'Signing in to Steam.',
        gcReady: false,
        action: 'none'
      };
    case 'STEAM_ONLY':
      return {
        tone: 'partial',
        label: 'Steam only',
        detail: connection.gc.detail
          ? `Signed in to Steam; no CS2 Game Coordinator session — ${connection.gc.detail}. Market and wallet still work; a sync will try again.`
          : 'Signed in to Steam; no CS2 Game Coordinator session yet. Market and wallet still work, and a sync will connect one.',
        gcReady: false,
        action: 'connect'
      };
    case 'BLOCKED_ELSEWHERE':
      return {
        tone: 'blocked',
        label: 'CS2 in use elsewhere',
        detail: connection.gc.detail
          ?? 'Another computer signed into this Steam account holds the CS2 session. Close CS2 there, then sync again.',
        gcReady: false,
        action: 'connect'
      };
    case 'DISCONNECTED':
      return {
        tone: 'partial',
        label: 'disconnected',
        detail: 'The Steam session in this window dropped. A retry may fix it without asking for a password or a Guard code.',
        gcReady: false,
        action: 'connect'
      };
    case 'SIGNED_OUT':
      return {
        tone: 'offline',
        label: 'signed out',
        detail: 'This account has no Steam session in this window. Connect to reuse the saved session.',
        gcReady: false,
        action: 'connect'
      };
    case 'EXPIRED':
      if (!connection.hasSavedCredential) {
        return {
          tone: 'offline',
          label: 'not connected',
          detail: 'No saved sign-in for this account. Signing in stores one, and later launches reconnect on their own.',
          gcReady: false,
          action: 'sign-in'
        };
      }
      return {
        tone: 'offline',
        label: 'session expired',
        detail: connection.steam.kind === 'expired'
          ? `Steam rejected the stored session (${connection.steam.reason}). Sign in again.`
          : 'Steam rejected the stored session. Sign in again.',
        gcReady: false,
        action: 'sign-in'
      };
    default: {
      const _never: never = phase;
      return _never;
    }
  }
}

/**
 * The worst state across several accounts, for a single indicator over all of them.
 *
 * Worst rather than most common: an all-accounts view that reads "live" while one account
 * cannot see its inventory is the reason someone spends ten minutes wondering why a sync did
 * nothing.
 */
const SEVERITY: Record<ConnectionTone, number> = { live: 0, partial: 1, blocked: 2, offline: 3 };

export function worstTone(summaries: readonly ConnectionSummary[]): ConnectionTone {
  return summaries.reduce<ConnectionTone>(
    (worst, summary) => (SEVERITY[summary.tone] > SEVERITY[worst] ? summary.tone : worst),
    'live'
  );
}

export type AccountAction = 'none' | 'connecting' | 'connect' | 'sign-in';

export function accountAction(input: {
  phase?: ConnectionPhase | undefined;
  hasSavedCredential: boolean;
  connecting: boolean;
}): AccountAction {
  if (input.connecting || input.phase === 'CONNECTING') return 'connecting';
  if (input.phase === 'CONNECTED') return 'none';
  if (input.phase === 'EXPIRED') return 'sign-in';
  if (input.phase === 'SIGNED_OUT') return input.hasSavedCredential ? 'connect' : 'sign-in';
  if (!input.phase) return input.hasSavedCredential ? 'connect' : 'sign-in';
  return 'connect';
}

export const CONNECTION_PHASES: readonly ConnectionPhase[] = [
  'CONNECTED', 'CONNECTING', 'STEAM_ONLY', 'BLOCKED_ELSEWHERE', 'DISCONNECTED', 'SIGNED_OUT', 'EXPIRED'
];
