import { useEffect } from 'react';
import type { NotificationApi } from '../NotificationProvider.js';

type Cursor = { at: string; id: string };
type FactRow = { id: string; kind: string; at: string; payload: Record<string, unknown> };
type FactsPage = { rows: FactRow[]; cursor: Cursor | null; more: boolean };
type NotificationsState = { accounts: Record<string, { watermark: Cursor | null } | undefined> };

/** The notification each fact kind raises. A kind the engine writes that is not here is a fact the bell does not carry yet. */
export const NOTIFICATION_OF_FACT: Readonly<Record<string, 'trade.reversed' | 'market.buy-order-filled'>> = {
  'trade-reversed': 'trade.reversed',
  BUY_ORDER_FILL: 'market.buy-order-filled'
};

/** The walks that write a fact the bell carries: a reversal from the trade history, a fill from the market history. */
const FACT_SURFACES = ['steam-trade-history', 'steam-market-history'];

/**
 * Facts the engine observed and wrote as `event` rows (notifications plan §7.2): a sale Steam
 * reversed, a buy order filled. The record keeps the fact; this desktop keeps what it told you, as a
 * watermark per account in `notifications-state.json`, so a fact is raised once per profile and never
 * again after a relaunch. A profile never looked at treats what the record already holds as history
 * rather than news: its watermark moves past every fact and none is raised. Read on mount and
 * whenever a walk that writes such a fact lands; one read at a time, in order.
 */
export function useEngineFactsProducer({ raise }: Pick<NotificationApi, 'raise'>): void {
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let again = false;
    const read = async (): Promise<void> => {
      if (running) { again = true; return; }
      running = true;
      try {
        const accounts = await window.trading.invoke({ type: 'accounts.list' }) as Array<{ id: string }>;
        const state = await window.trading.invoke({ type: 'notifications.state' }) as NotificationsState;
        for (const account of Array.isArray(accounts) ? accounts : []) {
          const entry = state.accounts[account.id];
          const news = entry !== undefined;
          let after = entry?.watermark ?? null;
          let more = true;
          while (more && !cancelled) {
            const page = await window.trading.invoke({ type: 'facts.since', accountId: account.id, after }) as FactsPage;
            if (news) {
              for (const row of page.rows) {
                const kind = NOTIFICATION_OF_FACT[row.kind];
                if (kind) raise(kind, { accountId: account.id });
              }
            }
            if (page.cursor !== after || !news) {
              after = page.cursor;
              await window.trading.invoke({ type: 'notifications.seen', accountId: account.id, watermark: after });
            }
            more = page.more;
          }
        }
      } catch {
        // A read that fails is read again on the next walk; the watermark only ever moves past what was raised.
      } finally {
        running = false;
        if (again && !cancelled) { again = false; void read(); }
      }
    };
    void read();
    const unsubscribe = window.trading.subscribe((notice) => {
      if (FACT_SURFACES.some((surface) => notice.surfaces.includes(surface))) void read();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [raise]);
}
