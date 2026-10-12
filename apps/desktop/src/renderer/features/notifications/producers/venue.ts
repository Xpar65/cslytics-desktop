import { useEffect } from 'react';
import type { NotificationApi } from '../NotificationProvider.js';

/**
 * CSFloat's ruling on each account, and the stall it leaves behind.
 *
 * Both conditions are read from `marketplace.status`, a SQLite read the window already makes for
 * the account bar: `restriction` is the suspension judged against its own observation, and `stall`
 * is what `/me` last said. The read repeats when the runtime says the account status or the
 * connection changed, and every thirty seconds besides, because a suspension that ends is only
 * ever noticed by a later read. Nothing here decides a fact; the engine did.
 */
export function useVenueProducer({ assert, resolve }: Pick<NotificationApi, 'assert' | 'resolve'>): void {
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.trading.invoke({ type: 'accounts.list' }).then(async (raw) => {
        const accounts = Array.isArray(raw) ? raw as Array<{ id: string }> : [];
        for (const account of accounts) {
          const status = await window.trading.invoke({ type: 'marketplace.status', accountId: account.id, venue: 'csfloat' })
            .catch(() => null) as { restriction?: { state: string } | null; stall?: { away: boolean | null } } | null;
          if (cancelled) return;
          const state = status?.restriction?.state ?? null;
          if (state === 'suspended' || state === 'stale') assert('csfloat.suspended', { accountId: account.id });
          else resolve('csfloat.suspended', account.id);
          if (state === 'ended' && status?.stall?.away === true) assert('csfloat.stall-away', { accountId: account.id });
          else resolve('csfloat.stall-away', account.id);
        }
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('csfloat-account-status') || notice.surfaces.includes('marketplace')) read();
    });
    const timer = setInterval(read, 30_000);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); };
  }, [assert, resolve]);
}
