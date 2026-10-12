import type { AccountId, CsfloatBuyOrder, CsfloatReadResult } from '@cslytics/ports';
import { CSFLOAT_VENUE, MarketplaceStore } from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage } from '../kernel/support.js';

export const CSFLOAT_BUY_ORDER_SURFACE = 'csfloat-buy-orders';
/** Rows asked for per page. The route's default is 50; a smaller page is a slower walk, not a different book. */
export const BUY_ORDER_PAGE_LIMIT = 50;
/** A walk that has not finished in this many pages has not established anything (CSF-38). */
export const MAX_BUY_ORDER_PAGES = 40;

export type BuyOrderBookSyncResult = {
  observationId: number;
  complete: boolean;
  pagesWalked: number;
  collected: number;
  /** What the venue said the book holds. Null when it did not say. */
  count: number | null;
  reason?: string;
};

/**
 * The account's own CSFloat buy-order book.
 *
 * The same question the stall walk answers, for the buy side: *are these all of them?* A cancel
 * is proved by an order's absence from this book and an edit by its presence with the new terms
 * (`orchestrate/csfloat-buying`), so a walk that stops early and calls itself finished would
 * prove cancels that never landed.
 *
 * The route pages by number rather than by cursor, which changes what "the pages ran out" means:
 * a page shorter than the limit is not the end of the book, because the venue is free to return
 * short pages, and a book that changes underneath the walk can hand out the same row twice or
 * skip one. So completeness needs, together:
 *
 *  1. the venue's own `count`, present and unchanged from page to page;
 *  2. every page parsed, including the rows inside it;
 *  3. exactly `count` distinct orders collected, with the walk stopping on an empty page or once
 *     it holds that many — never on a short page, and never on a page it has already seen.
 *
 * Any one missing leaves the observation incomplete while previously published rows stay
 * exactly as they were. Only a complete walk may delete a row (rule 5).
 */
export class CsfloatBuyOrderService {
  protected readonly store: MarketplaceStore;

  constructor(protected readonly context: EngineContext) {
    this.store = new MarketplaceStore(context.database);
  }

  sync(accountId: AccountId): Promise<BuyOrderBookSyncResult> {
    return this.context.reads.run(`${accountId}:${CSFLOAT_BUY_ORDER_SURFACE}`, () => this.walk(accountId));
  }

  protected async walk(accountId: AccountId): Promise<BuyOrderBookSyncResult> {
    const startedAt = this.context.now();
    const connection = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!connection?.credential_ref || connection.status === 'DISCONNECTED') {
      // Not a failed read: nothing was asked. An unlinked venue is not an empty book.
      return this.incomplete(accountId, startedAt, 0, 0, null, 'not-connected');
    }
    const ports = this.context.ports.csfloat;
    if (!ports) return this.incomplete(accountId, startedAt, 0, 0, null, 'no-csfloat-ports');

    const collected: CsfloatBuyOrder[] = [];
    const seen = new Set<string>();
    let count: number | null = null;
    let pages = 0;

    while (pages < MAX_BUY_ORDER_PAGES) {
      let result: Awaited<ReturnType<typeof ports.buyOrders.getPage>>;
      try {
        result = await ports.buyOrders.getPage(accountId, connection.credential_ref, pages, BUY_ORDER_PAGE_LIMIT);
      } catch (error) {
        return this.incomplete(accountId, startedAt, pages, collected.length, count, errorMessage(error));
      }
      pages += 1;
      if (result.kind !== 'ok') return this.incomplete(accountId, startedAt, pages, collected.length, count, describe(result));
      if (this.store.connection(accountId, CSFLOAT_VENUE)?.generation !== connection.generation) {
        return this.incomplete(accountId, startedAt, pages, collected.length, count, 'connection-changed');
      }
      const page = result.value;
      if (page.count === null || (count !== null && page.count !== count)) {
        return this.incomplete(accountId, startedAt, pages, collected.length, count, 'count-missing-or-changed');
      }
      count = page.count;
      let fresh = 0;
      for (const order of page.orders) {
        // Deduplicate by remote id: overlapping pages are a paging artefact, never two orders.
        if (seen.has(order.orderId)) continue;
        seen.add(order.orderId);
        collected.push(order);
        fresh += 1;
      }
      if (page.orders.length > 0 && fresh === 0) {
        // A page of nothing but rows already seen is a walk that cannot progress, not one that finished.
        return this.incomplete(accountId, startedAt, pages, collected.length, count, 'repeated-page');
      }
      if (collected.length > count) return this.incomplete(accountId, startedAt, pages, collected.length, count, 'count-mismatch');
      if (page.orders.length === 0 || collected.length === count) {
        if (collected.length !== count) return this.incomplete(accountId, startedAt, pages, collected.length, count, 'count-mismatch');
        return this.publish(accountId, startedAt, pages, collected, count, connection.generation);
      }
    }
    return this.incomplete(accountId, startedAt, pages, collected.length, count, 'page-budget-exhausted');
  }

  /** Publishes a complete book: the rows, and the absence of everything not in it. */
  private publish(
    accountId: AccountId,
    startedAt: string,
    pages: number,
    orders: readonly CsfloatBuyOrder[],
    count: number,
    generation: number
  ): BuyOrderBookSyncResult {
    const { database } = this.context;
    const observationId = database.transaction(() => {
      const id = database.insertObservation({
        accountId, surface: CSFLOAT_BUY_ORDER_SURFACE, generation, startedAt,
        finishedAt: this.context.now(), complete: true, pagesWalked: pages, totalExpected: count
      });
      const upsert = database.raw().prepare(`
        INSERT INTO csfloat_buy_order(account_id, order_id, generation, hash_name, price_cents, quantity, bought,
          properties_json, created_at, first_seen_obs, last_seen_obs)
        VALUES (@account, @order, @generation, @hash, @price, @quantity, @bought, @properties, @createdAt, @obs, @obs)
        ON CONFLICT(account_id, order_id) DO UPDATE SET generation=excluded.generation, hash_name=excluded.hash_name,
          price_cents=excluded.price_cents, quantity=excluded.quantity, bought=excluded.bought,
          properties_json=excluded.properties_json, created_at=excluded.created_at, last_seen_obs=excluded.last_seen_obs
      `);
      for (const order of orders) {
        upsert.run({
          account: accountId, order: order.orderId, generation, hash: order.marketHashName, price: order.priceCents,
          quantity: order.quantity, bought: order.bought, properties: order.properties === null ? null : JSON.stringify(order.properties),
          createdAt: order.createdAt || null, obs: id
        });
      }
      // Only a complete walk may conclude absence, and this one statement is how it does.
      database.raw().prepare('DELETE FROM csfloat_buy_order WHERE account_id=? AND last_seen_obs<>?').run(accountId, id);
      return id;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: CSFLOAT_BUY_ORDER_SURFACE, complete: true, observationId });
    return { observationId, complete: true, pagesWalked: pages, collected: orders.length, count };
  }

  /** Records what was seen and why it proves nothing. Published rows are left untouched. */
  private incomplete(
    accountId: AccountId,
    startedAt: string,
    pages: number,
    collected: number,
    count: number | null,
    reason: string
  ): BuyOrderBookSyncResult {
    const observationId = this.context.database.insertObservation({
      accountId, surface: CSFLOAT_BUY_ORDER_SURFACE, startedAt, finishedAt: this.context.now(),
      complete: false, pagesWalked: pages, ...(count === null ? {} : { totalExpected: count }), error: reason
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: CSFLOAT_BUY_ORDER_SURFACE, complete: false, observationId });
    return { observationId, complete: false, pagesWalked: pages, collected, count, reason };
  }
}

function describe(result: Exclude<CsfloatReadResult<unknown>, { kind: 'ok' }>): string {
  if (result.kind === 'rejected') return `csfloat-${result.reason}`;
  if (result.kind === 'throttled') return 'csfloat-throttled';
  return `csfloat-${result.cause}`;
}
