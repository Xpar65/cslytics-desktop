import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortfolioValuation } from '../../../shared/market.js';
import { engine } from '../../lib/engine.js';

/**
 * The portfolio's priced figures, read from main and re-read when prices, an inventory or the
 * catalogue move (portfolio and pricing plan §3). Main coalesces price notices to one per 1.5 s;
 * this waits another moment so a burst of surfaces becomes one read, and never overlaps reads.
 */
export type ValuationState = {
  valuation: PortfolioValuation | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const SETTLE_MS = 400;

/**
 * The engine's observation surfaces behind the page's figures, by the names the engine emits:
 * inventory and storage for the positions, the market walk and wallet read for Steam's money, the
 * CSFloat status read for its balance, and `marketplace` for a key connected or disconnected.
 */
const WATCHED = ['gc-inventory', 'gc-storage-units', 'gc-casket', 'steam-market', 'steam-wallet', 'csfloat-account-status', 'marketplace'];

export function useValuation(accountIds: readonly string[]): ValuationState {
  const [valuation, setValuation] = useState<PortfolioValuation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = accountIds.join('\0');
  const inFlight = useRef(false);
  const again = useRef(false);

  const read = useCallback(async (): Promise<void> => {
    const ids = key === '' ? [] : key.split('\0');
    if (ids.length === 0) { setValuation(null); return; }
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    setLoading(true);
    try {
      setValuation(await engine.readValuation(ids));
      setError(null);
    } catch (failure) {
      // Electron's wrapper names the IPC channel, which says nothing to a reader; the cause follows it.
      const message = (failure instanceof Error ? failure.message : String(failure))
        .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim();
      setError(`The portfolio could not be valued: ${message}`);
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (again.current) { again.current = false; void read(); }
    }
  }, [key]);

  useEffect(() => { void read(); }, [read]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribeToChanges((notice) => {
      const relevant = notice.accountId === 'market' || notice.accountId === 'catalogue'
        || (key.split('\0').includes(notice.accountId) && notice.surfaces.some((surface) => WATCHED.includes(surface)));
      if (!relevant) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void read(); }, SETTLE_MS);
    });
    return () => { unsubscribe(); if (timer !== null) clearTimeout(timer); };
  }, [key, read]);

  return { valuation, loading, error, refresh: () => void read() };
}
