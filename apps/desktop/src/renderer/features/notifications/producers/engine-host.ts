import { useEffect } from 'react';
import { ENGINE_HOST_SURFACE, type EngineStatus } from '../../../../shared/api.js';
import type { NotificationApi } from '../NotificationProvider.js';

/**
 * "Cannot reach the engine host" (remote engine host plan D7).
 *
 * Main's `engine.status` says which engine this desktop drives and, for a host, whether its event
 * stream is open; the state holds exactly as long as the condition does. The read repeats on the
 * `engine-host` change notice, which main raises on every change of that state. A local engine
 * never raises it, and a host that is `connecting` for the first time is not yet unreachable.
 */
export function useEngineHostProducer({ assert, resolve }: Pick<NotificationApi, 'assert' | 'resolve'>): void {
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void window.trading.invoke({ type: 'engine.status' }).then((raw) => {
        if (cancelled) return;
        const status = raw as EngineStatus;
        if (status.kind === 'remote' && (status.state === 'unreachable' || status.state === 'refused')) {
          assert('engine-host.unreachable', { variant: status.state });
          return;
        }
        resolve('engine-host.unreachable');
      }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes(ENGINE_HOST_SURFACE)) read();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [assert, resolve]);
}
