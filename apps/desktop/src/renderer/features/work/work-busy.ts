/**
 * Whether an inventory handle is in flight.
 *
 * `work.open` is allowed to keep refused and recently confirmed members so the indicator can
 * still say what happened (N-QUEUE-02). Busy is a different question: a tile whose command
 * has already been refused is free, and a missing `localId` or `stackKey` must never become
 * the empty suffix that made every skin on one account match one refused row.
 */

// `REFUSED` is the outbox's word for a send the engine turned down (`outbox.ts`): the item never
// left, so it is as free as a rejected member's.
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETE', 'DONE', 'REJECTED', 'FAILED', 'BLOCKED', 'STOPPED', 'REFUSED']);

/**
 * Member states in which the app has nothing to do but wait: for Steam to show a send, for a phone,
 * for the other account, for the marketplace to see a retrieve. The indicator shows the hourglass
 * for these, and the arrow only for a member it is moving.
 */
export const WAITING_STATES: ReadonlySet<string> = new Set([
  'AWAITING_OBSERVATION', 'RETRYING', 'AWAITING_CONFIRMATION', 'AWAITING_VENUE', 'ACTIVE', 'ESCROW', 'AWAITING_DELIVERY', 'AWAITING_BUYER', 'AWAITING_VERIFICATION'
]);

export type BusyWorkRow = {
  accountId: string;
  memberState: string;
  localId?: string | null;
  stackKey?: string | null;
};

/**
 * Member states with a hop not yet sent, which is all Stop can halt: queued, held on a reason, not
 * yet prepared, or retrieving ahead of a hop still queued. A member whose hops are all out (a
 * transfer waiting on the phone, a store waiting for its walk) has nothing for Stop to take back.
 */
export const UNSENT_STATES: ReadonlySet<string> = new Set(['PREPARED', 'QUEUED', 'BLOCKED', 'RETRIEVING']);

export function isOpenWork(row: Pick<BusyWorkRow, 'memberState'>): boolean {
  return !TERMINAL.has(row.memberState);
}

export function busyKeysFromWork(work: readonly BusyWorkRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of work) {
    if (!isOpenWork(row)) continue;
    if (row.localId) keys.add(`${row.accountId}:${row.localId}`);
    if (row.stackKey) keys.add(`${row.accountId}:${row.stackKey}`);
  }
  return keys;
}

export function itemIsBusy(
  busyKeys: ReadonlySet<string>,
  item: { accountId: string; localId?: string | null; stackKey?: string | null }
): boolean {
  if (item.localId && busyKeys.has(`${item.accountId}:${item.localId}`)) return true;
  if (item.stackKey && busyKeys.has(`${item.accountId}:${item.stackKey}`)) return true;
  return false;
}
