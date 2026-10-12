import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WaitingCoverageRow, WaitingKind, WaitingRow as EngineWaitingRow } from '@cslytics/engine';

/**
 * What is waiting on the person, after the host has attached a name and a picture.
 *
 * The engine's own read (`read/queries/waiting.ts`) explains why listings and sent offers are one
 * list. This file is the window's half of it, and it holds one idea the work indicator does not:
 * **this list never drains by itself**. Every other busy surface in the app empties as the engine
 * finishes; this one empties only when a human opens Steam Mobile and taps, because rule 2 means
 * this product can never hold the secret that would let it tap for them.
 */
export type WaitingRow = EngineWaitingRow & {
  name: string;
  imageUrl: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  unresolved: string | null;
};

export type { WaitingCoverageRow, WaitingKind };

export type WaitingState = {
  rows: WaitingRow[];
  coverage: WaitingCoverageRow[];
  /**
   * Whether every walk behind this answer finished.
   *
   * False makes the count a floor rather than a total (rule 5), and the panel says so in words.
   * It is deliberately not folded into `rows.length`: a floor is still worth acting on, and
   * hiding the list until a walk completes would be a worse answer than an honest caveat.
   */
  complete: boolean;
  refresh: () => void;
};

/**
 * The surfaces whose walks write these rows.
 *
 * Both raise a `changed` notice when they land, which is why this needs no poll — and that is not
 * a convenience, it is the design. Every transition in this list *is* an observation: a listing
 * enters it when a walk reads `listings_to_confirm` and leaves it when a later walk reads the
 * listing as active. There is no moment, as there is for a command member going queued → sent,
 * where something changes without an observation to announce it.
 */
const SURFACES = ['steam-market', 'steam-trade-offers'];

/**
 * Everything owed, for a scope.
 *
 * Read once per scope and again on every notice from a surface that could change it. Errors
 * leave the previous answer standing rather than emptying the list: a failed IPC round-trip is
 * not evidence that nothing is waiting, and an obligation list that blinks to zero on a hiccup
 * is the exact failure this feature exists to prevent.
 */
export function useWaiting(accountIds: readonly string[]): WaitingState {
  const [rows, setRows] = useState<WaitingRow[]>([]);
  const [coverage, setCoverage] = useState<WaitingCoverageRow[]>([]);
  const scope = accountIds.join('\0');

  const read = useCallback(() => {
    const ids = scope.split('\0').filter(Boolean);
    if (ids.length === 0) { setRows([]); setCoverage([]); return; }
    void window.trading.invoke({ type: 'waiting.open', accountIds: ids })
      .then((answer) => {
        const page = answer as { kind?: string; rows?: WaitingRow[]; coverage?: WaitingCoverageRow[] };
        if (page?.kind !== 'page' || !Array.isArray(page.rows)) return;
        setRows(page.rows);
        setCoverage(Array.isArray(page.coverage) ? page.coverage : []);
      })
      .catch(() => undefined);
  }, [scope]);

  useEffect(() => { read(); }, [read]);
  useEffect(() => {
    const inScope = new Set(scope.split('\0').filter(Boolean));
    return window.trading.subscribe((notice) => {
      if (!inScope.has(notice.accountId)) return;
      if (notice.surfaces.some((surface) => SURFACES.includes(surface))) read();
    });
  }, [scope, read]);

  // A surface that has never been walked is as incomplete as one whose walk broke off: neither
  // has proved anything about what is waiting, and `observedAt: null` is not "walked and empty".
  const complete = coverage.every((row) => row.observedAt !== null && row.complete === 1);
  return useMemo(() => ({ rows, coverage, complete, refresh: read }), [rows, coverage, complete, read]);
}

/**
 * How long a row has been waiting, in milliseconds, or `null` when no walk has dated it.
 *
 * Measured from the walk that first saw it, never from the mutation that caused it: the app knows
 * when it sent a `sellitem`, but what it can prove is when Steam was first observed holding the
 * listing, and that is the number this screen is allowed to show.
 */
export function waitedFor(row: WaitingRow, now = Date.now()): number | null {
  if (!row.waitingSince) return null;
  const at = new Date(row.waitingSince).getTime();
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** An hour. Long enough that a tap was forgotten rather than merely not made yet. */
export const STALE_AFTER_MS = 3_600_000;

/**
 * Whether a row should read as overdue rather than merely pending.
 *
 * Two independent reasons, and an offer can have both: it has been waiting longer than someone
 * doing this deliberately would take, or it has an expiry Steam will enforce. A listing has no
 * expiry — it simply earns nothing, indefinitely, which is why age alone has to escalate it.
 */
export function isOverdue(row: WaitingRow, now = Date.now()): boolean {
  if (row.expiresAt) {
    const expires = new Date(row.expiresAt).getTime();
    if (Number.isFinite(expires) && expires - now < 24 * STALE_AFTER_MS) return true;
  }
  const waited = waitedFor(row, now);
  return waited !== null && waited >= STALE_AFTER_MS;
}
