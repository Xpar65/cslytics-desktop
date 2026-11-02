import { useEffect, useState } from 'react';
import type { CslyticsStatus } from '@cslytics/cslytics-account';
import { lockReason, type Feature, type LockReason } from '../../shared/command-access.js';
import { engine } from './engine.js';

/**
 * The CSlytics sign-in as main last reported it, read again on every `cslytics-account` change;
 * `null` until the first answer. The window holds this status and nothing else of the account: no
 * token, no code, no URL (CSlytics account sign-in plan §6.4).
 */
export function useCslytics(): CslyticsStatus | null {
  const [status, setStatus] = useState<CslyticsStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void engine.cslyticsStatus().then((next) => { if (live) setStatus(next); }).catch(() => undefined);
    };
    read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('cslytics-account')) read();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return status;
}

/**
 * Why a feature is locked for this desktop now (pricing behind sign-in plan §7.6): `null` when it is
 * not, `undefined` while the status has not arrived. A surface that carries a price draws nothing
 * until it knows, and never sends the command behind it while it is locked: main would refuse it.
 */
export function useLock(feature: Feature): LockReason | null | undefined {
  const status = useCslytics();
  return status === null ? undefined : lockReason(status, feature);
}
