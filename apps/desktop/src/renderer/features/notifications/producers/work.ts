import { useEffect } from 'react';
import type { NotificationApi } from '../NotificationProvider.js';
import { browserSeenStore, failureKey, readSeenFailures } from '../../work/work-seen.js';

/**
 * The engine's reason on a CSFloat listing from a storage unit that CSFloat never saw.
 *
 * The same text as `CSFLOAT_VISIBILITY_TIMEOUT_REASON` in `packages/engine/src/policy/csfloat-selling.ts`.
 * The window imports the engine for types only, so the text is repeated here, and
 * `tests/unit/work-notifications.test.ts` fails if the two ever differ.
 */
export const VISIBILITY_TIMEOUT_REASON = 'CSFloat did not show the item within 10 minutes; it stays in main inventory';

/** The part of a `work.open` row this producer reads. */
export type WorkFailureRow = { accountId: string; commandId: string; commandKind: string; memberId: string; memberState: string; reason: string | null };

/**
 * Listings from storage that timed out waiting for CSFloat, and have not been shown yet.
 *
 * `seen` holds `failureKey`s: those already toasted in this window, and those the work panel was
 * opened on in any launch (`features/work/work-seen.ts`). Either means the person has been told.
 */
export function timedOutRows<T extends WorkFailureRow>(rows: readonly T[], seen: ReadonlySet<string>): T[] {
  return rows.filter((row) => row.commandKind === 'CSFLOAT_CREATE' && row.memberState === 'FAILED'
    && row.reason === VISIBILITY_TIMEOUT_REASON && !seen.has(failureKey(row)));
}

/**
 * A CSFloat listing from a storage unit that ran out of time.
 *
 * The fact is the engine's: the operation failed with its timeout reason, and an event row records
 * it. This reads `work.open` for every account — the work panel reads only the accounts in scope,
 * and a timeout on another account is still news — on mount, every thirty seconds, and when a read
 * lands that could have ended a wait. One toast per member.
 *
 * `work.open` keeps the 25 most recent commands. A timeout that scrolls out of that before the
 * window reads it is not toasted; the `csfloat-visibility-timeout` event row is the durable record.
 */
export function useWorkFailureProducer({ raise }: Pick<NotificationApi, 'raise'>): void {
  useEffect(() => {
    let cancelled = false;
    const raised = new Set<string>();
    const read = (): void => {
      void window.trading.invoke({ type: 'accounts.list' }).then(async (raw) => {
        const accounts = Array.isArray(raw) ? raw as Array<{ id: string }> : [];
        if (accounts.length === 0) return;
        const page = await window.trading.invoke({ type: 'work.open', accountIds: accounts.map((account) => account.id) })
          .catch(() => null) as { rows?: WorkFailureRow[] } | null;
        if (cancelled || !Array.isArray(page?.rows)) return;
        const seen = new Set([...readSeenFailures(browserSeenStore()), ...raised]);
        for (const row of timedOutRows(page.rows, seen)) {
          raised.add(failureKey(row));
          raise('csfloat.visibility-timeout', { accountId: row.accountId });
        }
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('csfloat-inventory') || notice.surfaces.includes('gc-inventory')) read();
    });
    const timer = setInterval(read, 30_000);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); };
  }, [raise]);
}
