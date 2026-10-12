import { NOTIFICATION_KINDS, type NotificationKind, type NotificationKindId, type Route, type Severity } from './kinds.js';

export type { Route, Severity } from './kinds.js';

/**
 * The record of what the app has told the user, as a pure reducer.
 *
 * No React, no `window`, no clock of its own: every action carries its time, every selector takes
 * the time it is asked at, and a unit test can drive it in Node the way `item-actions.ts` is
 * driven. The provider is the only thing that dispatches to it, and the bell, the toast stack and
 * the centre only ever read it through the selectors below.
 *
 * Nothing here is evidence and nothing here persists. The record is lost on relaunch by design:
 * a condition is re-derived from the reads on the next launch, and an event that matters after
 * the window closes is an engine fact the engine already wrote (plan §7.2).
 */

/** One row of the record. Everything a toast, the bell and the centre show is derived from it. */
export type Notification = {
  /** An event's id is the caller's; a condition's is its key, so a re-assert finds it again. */
  id: string;
  kind: NotificationKindId;
  shape: 'event' | 'condition';
  severity: Severity;
  /** The account it is about, or null for something about the app itself. */
  accountId: string | null;
  title: string;
  body: string;
  action: { label: string; route: Route } | null;
  /** When it was last raised. A condition that flaps keeps one row and moves this forward. */
  raisedAt: string;
  /** Conditions only: when it stopped holding. `null` while it holds, and always for an event. */
  resolvedAt: string | null;
  /** False until the bell has been opened since this was raised. The badge counts these. */
  seen: boolean;
  /** Whether its toast may still be on screen. Closing a toast is not seeing the row. */
  toast: 'showing' | 'gone';
};

/** Newest first. */
export type NotificationState = { readonly rows: readonly Notification[] };

export const EMPTY_STATE: NotificationState = { rows: [] };

export type NotificationAction =
  /** An event: something happened once. `id` is the caller's, so the reducer stays pure. */
  | { type: 'raise'; id: string; kind: NotificationKindId; accountId?: string | null | undefined; variant?: string | undefined; at: string }
  /** A condition holds. Asserting one that already holds changes nothing. */
  | { type: 'assert'; kind: NotificationKindId; accountId?: string | null | undefined; variant?: string | undefined; at: string }
  /** A condition stopped holding. Resolving one that does not hold changes nothing. */
  | { type: 'resolve'; kind: NotificationKindId; accountId?: string | null | undefined; at: string }
  /** The toast's × or its action. The row stays, and stays unseen. */
  | { type: 'close-toast'; id: string }
  /** The bell was opened: the count is what clears, and it clears whole. */
  | { type: 'mark-all-seen' };

export type Registry = Readonly<Record<string, NotificationKind>>;

/** How long a toast stays, by severity. After that only the bell's count says anything happened. */
export const TOAST_LIFETIME_MS: Readonly<Record<Severity, number>> = {
  info: 6_000,
  success: 6_000,
  warn: 10_000,
  error: 15_000
};

/** At most this many toasts at once; the rest are one "+N more" line. */
export const MAX_TOASTS = 3;

/** A condition is one row per kind per account, and this is its id. */
export function conditionKey(kind: string, accountId: string | null | undefined): string {
  return `${kind}:${accountId ?? ''}`;
}

export function reduce(
  state: NotificationState,
  action: NotificationAction,
  registry: Registry = NOTIFICATION_KINDS
): NotificationState {
  switch (action.type) {
    case 'raise': {
      const kind = expect(registry, action.kind, 'event');
      return { rows: [build(kind, action.id, action.kind, action.accountId, action.variant, action.at), ...state.rows] };
    }
    case 'assert': {
      const kind = expect(registry, action.kind, 'condition');
      const key = conditionKey(action.kind, action.accountId);
      const existing = state.rows.find((row) => row.id === key);
      if (existing && existing.resolvedAt === null) return state;
      // A condition that comes back is the same row raised again, not a second row: one entry
      // with the latest time is what a flapping network should leave behind.
      const fresh = build(kind, key, action.kind, action.accountId, action.variant, action.at);
      return { rows: [fresh, ...state.rows.filter((row) => row.id !== key)] };
    }
    case 'resolve': {
      expect(registry, action.kind, 'condition');
      const key = conditionKey(action.kind, action.accountId);
      const index = state.rows.findIndex((row) => row.id === key && row.resolvedAt === null);
      if (index === -1) return state;
      return { rows: state.rows.map((row, at) => (at === index ? { ...row, resolvedAt: action.at, toast: 'gone' } : row)) };
    }
    case 'close-toast': {
      const index = state.rows.findIndex((row) => row.id === action.id && row.toast === 'showing');
      if (index === -1) return state;
      return { rows: state.rows.map((row, at) => (at === index ? { ...row, toast: 'gone' } : row)) };
    }
    case 'mark-all-seen': {
      if (state.rows.every((row) => row.seen)) return state;
      return { rows: state.rows.map((row) => (row.seen ? row : { ...row, seen: true })) };
    }
  }
}

// ------------------------------------------------------------------------------------ selectors

/** The toasts on screen right now, newest first, and how many more there are than fit. */
export function toasts(state: NotificationState, nowMs: number): { visible: Notification[]; overflow: number } {
  const live = state.rows.filter((row) => showing(row, nowMs));
  return { visible: live.slice(0, MAX_TOASTS), overflow: Math.max(0, live.length - MAX_TOASTS) };
}

/** When the next toast is due to leave, or null when none is on screen. The provider's timer. */
export function nextToastExpiry(state: NotificationState, nowMs: number): number | null {
  let next: number | null = null;
  for (const row of state.rows) {
    if (!showing(row, nowMs)) continue;
    const at = expiresAt(row);
    if (next === null || at < next) next = at;
  }
  return next;
}

/** The bell's badge. */
export function unseenCount(state: NotificationState): number {
  return state.rows.filter((row) => !row.seen).length;
}

/** The centre's two groups: what holds right now, then everything else, newest first. */
export function centre(state: NotificationState): { now: Notification[]; earlier: Notification[] } {
  return {
    now: state.rows.filter((row) => isLive(row)),
    earlier: state.rows.filter((row) => !isLive(row))
  };
}

// -------------------------------------------------------------------------------------- helpers

function isLive(row: Notification): boolean {
  return row.shape === 'condition' && row.resolvedAt === null;
}

function expiresAt(row: Notification): number {
  return Date.parse(row.raisedAt) + TOAST_LIFETIME_MS[row.severity];
}

function showing(row: Notification, nowMs: number): boolean {
  return row.toast === 'showing' && row.resolvedAt === null && nowMs < expiresAt(row);
}

function build(
  kind: NotificationKind,
  id: string,
  kindId: NotificationKindId,
  accountId: string | null | undefined,
  variant: string | undefined,
  at: string
): Notification {
  return {
    id,
    kind: kindId,
    shape: kind.shape,
    severity: kind.severity,
    accountId: accountId ?? null,
    title: kind.title,
    body: bodyOf(kind, variant),
    // A per-account fact opens on its account: the registry names the page, the row names the account.
    action: kind.action
      ? { label: kind.action.label, route: { ...kind.action.route, accountId: kind.action.route.accountId ?? accountId ?? null } }
      : null,
    raisedAt: at,
    resolvedAt: null,
    seen: false,
    toast: 'showing'
  };
}

function bodyOf(kind: NotificationKind, variant: string | undefined): string {
  if (typeof kind.body === 'string') return kind.body;
  const chosen = variant === undefined ? undefined : kind.body[variant];
  if (chosen !== undefined) return chosen;
  // A variant the registry does not declare is a producer bug the types catch; at runtime the
  // first sentence is still the right kind of sentence, and better than an empty toast.
  return Object.values(kind.body)[0] ?? '';
}

/**
 * The wrong verb is a programming error, and it fails loudly at the first run rather than
 * quietly producing a condition that never resolves or an event that never repeats.
 */
function expect(registry: Registry, id: string, shape: 'event' | 'condition'): NotificationKind {
  const kind = registry[id];
  if (kind === undefined) throw new Error(`Unknown notification kind "${id}". Add it to NOTIFICATION_KINDS first.`);
  if (kind.shape !== shape) {
    throw new Error(shape === 'event'
      ? `"${id}" is a condition. Use assert and resolve, not raise.`
      : `"${id}" is an event. Use raise, not assert or resolve.`);
  }
  return kind;
}
