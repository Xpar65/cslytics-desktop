import { useEffect } from 'react';
import type { ReleaseStatus } from '../../../../shared/release.js';
import type { NotificationApi } from '../NotificationProvider.js';

/**
 * This build's three conditions: an update waiting to install, a retired version, a paused action.
 *
 * All three are facts main already holds and answers in `release.status`; this producer reads that
 * at mount and again on every `release` change notice, which main raises when an update moves or a
 * new stop-switch file is applied. Nothing is raised for a feed or a policy that cannot be reached:
 * that is the ordinary state of a machine that has not been told anything, not news.
 */
export function useReleaseProducer({ assert, resolve }: Pick<NotificationApi, 'assert' | 'resolve'>): void {
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.trading.invoke({ type: 'release.status' }).then((raw) => {
        if (cancelled) return;
        const status = raw as ReleaseStatus;
        if (status.update.phase === 'ready') assert('release.update-ready');
        else resolve('release.update-ready');
        if (status.policy.retired) assert('release.retired');
        else resolve('release.retired');
        // A retirement already refuses everything a pause could, so it is the one said.
        if (status.policy.paused.length > 0 && !status.policy.retired) assert('release.paused');
        else resolve('release.paused');
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('release')) read();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [assert, resolve]);
}
