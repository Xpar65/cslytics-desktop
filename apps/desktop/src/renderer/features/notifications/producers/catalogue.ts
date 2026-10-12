import { useEffect } from 'react';
import type { NotificationApi } from '../NotificationProvider.js';

/**
 * The first producer: "Cannot connect to the CSlytics API".
 *
 * Main syncs the catalogue at launch and answers `catalogue.status`, whose `stale` is true from a
 * failed sync until the next success — exactly the lifetime of the condition. The read repeats on
 * the `catalogue` change notice, which main raises after every sync attempt, and every two seconds
 * until the first attempt has been decided either way, because the window can mount before the
 * launch sync has finished. The body says whether names are already on screen from an earlier
 * download, which is what `revision` being set means.
 *
 * A producer raises and resolves; it never decides what a toast looks like or how long it stays.
 */
export function useCatalogueProducer({ assert, resolve }: Pick<NotificationApi, 'assert' | 'resolve'>): void {
  useEffect(() => {
    let cancelled = false;
    let decided = false;
    const read = (): void => {
      void window.trading.invoke({ type: 'catalogue.status' }).then((raw) => {
        if (cancelled) return;
        const status = raw as { revision?: string | null; stale?: boolean };
        if (status.stale) {
          decided = true;
          assert('catalogue.unreachable', { variant: status.revision ? 'withRevision' : 'withoutRevision' });
          return;
        }
        if (status.revision) decided = true;
        resolve('catalogue.unreachable');
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue')) read();
    });
    const timer = setInterval(() => { if (!decided) read(); }, 2_000);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); };
  }, [assert, resolve]);
}
