import type {
  AccountId,
  CredentialVault,
  CsfloatBuyOrder,
  CsfloatBuyOrderEdit,
  CsfloatBuyOrderPage,
  CsfloatBuyOrderPort,
  CsfloatCredentialRef,
  CsfloatReadResult,
  MutationOutcome
} from '@cslytics/ports';
import { CsfloatTransport, requireKey } from './transport.js';
import { id as digits, mutationResult, readResult, record, timestamp } from './outcome.js';

/**
 * The account's own buy orders: the book, an edit, a removal.
 *
 * Three routes, each pinned to a capture rather than to the unofficial reference alone:
 *
 *  - `GET /me/buy-orders?page=&limit=&order=desc` answers `{count, orders}` with the developer
 *    key and no cookie (this repository, 2026-09-11, on two empty books). Paging is by page
 *    number, so `count` is the only thing that says whether a walk has the whole book, and the
 *    engine compares the two before it calls anything complete.
 *  - `PATCH /buy-orders/{id}` takes `max_price`, `quantity` and **every** constraint field, `null`
 *    for none, and answers the order as it now stands (captured 2026-09-23: `{"id","created_at",
 *    "qty","price","market_hash_name","hybrid_properties","bought_item_count"}`). Its budget is two
 *    a minute, which is why an edit is admitted once and sent once.
 *  - `DELETE /buy-orders/{id}` answers a `{message}` body on the same 50,000-a-day family as the
 *    reads. The venue says quantity already matched into a trade is unaffected, so a removal is
 *    never read as undoing a fill.
 */
export class CsfloatBuyOrderAdapter implements CsfloatBuyOrderPort {
  constructor(
    private readonly vault: CredentialVault,
    private readonly transport: CsfloatTransport = new CsfloatTransport()
  ) {}

  async getPage(accountId: AccountId, credential: CsfloatCredentialRef, page: number, limit: number): Promise<CsfloatReadResult<CsfloatBuyOrderPage>> {
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('Buy-order page must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Buy-order page limit must be a positive integer');
    const query = new URLSearchParams({ page: String(page), limit: String(limit), order: 'desc' });
    return readResult(await this.transport.send({ accountId, method: 'GET', path: `/me/buy-orders?${query.toString()}`,
      key: await requireKey(this.vault, credential) }), readBuyOrderPage);
  }

  async update(accountId: AccountId, credential: CsfloatCredentialRef, orderId: string, edit: CsfloatBuyOrderEdit): Promise<MutationOutcome> {
    return mutationResult(await this.transport.send({ accountId, method: 'PATCH', path: `/buy-orders/${encodeURIComponent(orderId)}`,
      key: await requireKey(this.vault, credential), body: buyOrderUpdateBody(edit) }),
    (body) => {
      // The reply is the order as the venue now holds it; anything short of the terms asked for
      // is not an acknowledgement of them.
      const row = readBuyOrder(body);
      return row !== null && row.orderId === orderId && row.priceCents === edit.maxPriceCents && row.quantity === edit.quantity;
    });
  }

  async remove(accountId: AccountId, credential: CsfloatCredentialRef, orderId: string): Promise<MutationOutcome> {
    return mutationResult(await this.transport.send({ accountId, method: 'DELETE', path: `/buy-orders/${encodeURIComponent(orderId)}`,
      key: await requireKey(this.vault, credential) }), (body) => typeof record(body)?.['message'] === 'string');
  }
}

/**
 * The wire shape of an edit. Every constraint travels, `null` for none, because the route keeps
 * only what it is sent: a field left out is cleared, not preserved (csfloatapi.com; a live
 * capture sent all seven as `null` beside a price and a quantity).
 */
export function buyOrderUpdateBody(edit: CsfloatBuyOrderEdit): Record<string, unknown> {
  const c = edit.constraints;
  return {
    max_price: edit.maxPriceCents,
    quantity: edit.quantity,
    min_float: c.minFloat,
    max_float: c.maxFloat,
    paint_seeds: c.paintSeeds === null ? null : [...c.paintSeeds],
    min_keychain_pattern: c.minKeychainPattern,
    max_keychain_pattern: c.maxKeychainPattern,
    applied_stickers: c.appliedStickers === null ? null : [...c.appliedStickers],
    applied_keychains: c.appliedKeychains === null ? null : [...c.appliedKeychains]
  };
}

/**
 * A page of the own book, or null when the body is not one.
 *
 * An empty `orders` array is the ordinary case — both accounts probed on 2026-09-11 had one —
 * and must parse, or "no orders" would be indistinguishable from "could not read". A body with
 * no `orders` array at all is a suspicious success, and the caller records an incomplete
 * observation rather than an empty book.
 */
export function readBuyOrderPage(body: unknown): CsfloatBuyOrderPage | null {
  const envelope = record(body);
  if (!envelope || !Array.isArray(envelope['orders'])) return null;
  const orders: CsfloatBuyOrder[] = [];
  for (const entry of envelope['orders']) {
    const order = readBuyOrder(entry);
    // One unreadable row must not silently shrink the book; it fails the page instead.
    if (!order) return null;
    orders.push(order);
  }
  return { orders, count: nonNegativeInteger(envelope['count']), raw: body };
}

export function readBuyOrder(value: unknown): CsfloatBuyOrder | null {
  const row = record(value);
  if (!row) return null;
  const orderId = digits(row['id']);
  const price = nonNegativeInteger(row['price']);
  const quantity = nonNegativeInteger(row['qty']);
  const name = typeof row['market_hash_name'] === 'string' && row['market_hash_name'].trim() ? row['market_hash_name'] : null;
  if (!orderId || price === null || quantity === null || !name) return null;
  const properties = row['hybrid_properties'];
  return {
    orderId,
    createdAt: timestamp(row['created_at']) ?? '',
    marketHashName: name,
    priceCents: price,
    quantity,
    bought: nonNegativeInteger(row['bought_item_count']),
    // Kept exactly as sent, and only when it was: an absent object is "not reported", which the
    // engine's allowlist reads as unknown rather than as a plain order.
    properties: record(properties) ? structuredClone(properties as Record<string, unknown>) : null,
    raw: value
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
