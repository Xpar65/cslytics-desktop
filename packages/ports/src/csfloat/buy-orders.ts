import type { AccountId, MutationOutcome } from '../kernel.js';
import type { CsfloatCredentialRef, CsfloatReadResult } from './account.js';

/**
 * One of the account's own standing buy orders, as `GET /me/buy-orders` returns it.
 *
 * Shaped from this repository's 2026-09-11 capture of the route (`fixtures/csfloat/INDEX.md`:
 * enveloped `{count, orders}`, every account empty) and a 2026-09-23 capture of a
 * populated row through `PATCH /buy-orders/{id}`: `{id, created_at, qty, price,
 * market_hash_name, hybrid_properties, bought_item_count}`. Two readings in here are load-bearing:
 *
 * `priceCents` is what the buyer will pay for **one**, in integer USD cents. The venue calls it
 * `price` on a row and `max_price` on a create or an edit; both are the same figure.
 *
 * `quantity` is `qty`, read as the number the order asks for in all, with `bought` counting
 * against it. No fill has been observed yet, so whether `qty` shrinks as items are bought is not
 * known; the engine derives what is left as `quantity - bought` and says so in DATA-INDEX.
 *
 * `properties` is `hybrid_properties` exactly as sent, or `null` when the row carried none. It
 * is never interpreted here: `kernel/csfloat-buy-orders` reads it by allowlist, so an order that
 * restricts something this app cannot describe is *unknown*, never *plain* (CSF-ORDER-02).
 */
export type CsfloatBuyOrder = {
  orderId: string;
  createdAt: string;
  marketHashName: string;
  priceCents: number;
  quantity: number;
  /** `bought_item_count`. `null` when the row did not carry it: unknown is not zero. */
  bought: number | null;
  properties: Record<string, unknown> | null;
  raw: unknown;
};

/**
 * One page of the account's own book.
 *
 * `count` is the venue's own claim about the whole book and the only completeness signal the
 * route offers: paging is by page number, so a walk that collected fewer rows than `count` is
 * incomplete however many pages it read, and one that collected more has read a book that
 * changed underneath it.
 */
export type CsfloatBuyOrderPage = { orders: CsfloatBuyOrder[]; count: number | null; raw: unknown };

/**
 * An order's item constraints, in the flat shape `PATCH /buy-orders/{id}` takes.
 *
 * Every field is sent on every edit, `null` meaning "none": the route treats the constraints as
 * absolute rather than as a patch, so a field left out is not preserved (csfloatapi.com, and a live
 * capture, which sent all seven as `null` beside a new price and quantity). The engine
 * fills these from the order's last observed `properties`, and refuses to edit an order whose
 * properties it cannot express here.
 */
export type CsfloatBuyOrderConstraints = {
  minFloat: number | null;
  maxFloat: number | null;
  paintSeeds: readonly number[] | null;
  minKeychainPattern: number | null;
  maxKeychainPattern: number | null;
  appliedStickers: readonly unknown[] | null;
  appliedKeychains: readonly unknown[] | null;
};

export type CsfloatBuyOrderEdit = {
  /** The new limit per item, buyer side, in integer USD cents. */
  maxPriceCents: number;
  quantity: number;
  constraints: CsfloatBuyOrderConstraints;
};

export interface CsfloatBuyOrderPort {
  /** One page of the account's own book. `page` counts from zero; `limit` is rows per page. */
  getPage(accountId: AccountId, credential: CsfloatCredentialRef, page: number, limit: number): Promise<CsfloatReadResult<CsfloatBuyOrderPage>>;
  /** `PATCH /buy-orders/{id}`: price, quantity and every constraint, absolutely. */
  update(accountId: AccountId, credential: CsfloatCredentialRef, orderId: string, edit: CsfloatBuyOrderEdit): Promise<MutationOutcome>;
  /** `DELETE /buy-orders/{id}`. Quantity already matched into a trade is unaffected. */
  remove(accountId: AccountId, credential: CsfloatCredentialRef, orderId: string): Promise<MutationOutcome>;
}
