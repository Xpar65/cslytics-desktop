/**
 * What a raw Steam trade code means, and what it is still not allowed to prove.
 *
 * Two separate alphabets share this file because they are constantly confused. `trade_offer_state`
 * describes an **offer** — a proposal, which may sit in escrow for a week or be rolled back after
 * acceptance. `status` on a history row describes an **executed trade**. Neither is a delivery
 * receipt on its own: requirements TRD-04 says "offer acceptance alone does not establish settled
 * delivery", and `settlesDelivery` is the single place that judgement is made.
 *
 * Codes are mapped, never assumed: the live capture on 2026-09-09 saw only history `status=3`
 * on the page it read (`cslytics-app-docs/steam/trades.md`), so every
 * other row here is Valve's published enum applied to captured field names. An unmapped code is
 * `UNKNOWN`, which is a value the ledger can carry, not a reason to guess.
 */

import { EXECUTED_TRADE_STATUSES, TRADE_OFFER_STATUSES } from '../db/alphabets.js';

/** The offer words: one alphabet with the record's CHECK (`db/alphabets.ts`). */
export type OfferStatus = (typeof TRADE_OFFER_STATUSES)[number];
/** The executed-trade words, likewise. */
export type TradeStatus = (typeof EXECUTED_TRADE_STATUSES)[number];

/** Valve's `ETradeOfferState`, applied to the captured `trade_offer_state` field. */
const OFFER_STATES: Readonly<Record<number, OfferStatus>> = {
  1: 'INVALID',
  2: 'ACTIVE',
  3: 'ACCEPTED',
  4: 'COUNTERED',
  5: 'EXPIRED',
  6: 'CANCELLED',
  7: 'DECLINED',
  8: 'INVALID_ITEMS',
  9: 'PENDING_CONFIRMATION',
  10: 'CANCELLED_BY_SECOND_FACTOR',
  11: 'ESCROW'
};

/** Valve's `ETradeStatus`, applied to the captured history `status` field. */
const TRADE_STATES: Readonly<Record<number, TradeStatus>> = {
  0: 'PENDING',
  1: 'PENDING',
  2: 'PENDING',
  3: 'COMPLETE',
  4: 'FAILED',
  5: 'ROLLED_BACK',
  6: 'ROLLED_BACK',
  7: 'ROLLED_BACK',
  8: 'FAILED',
  9: 'FAILED',
  10: 'ESCROW',
  11: 'ROLLED_BACK',
  // TradeProtectionRollback, which Valve does not document: the CSFloat extension's constants name it
  // (csgomarketv3 trade-offer-state-endpoints.md). Steam marks the original trade 12 and returns the
  // items in a *new* complete trade, so the reversal's economics are that second trade's postings —
  // which is why this is not ROLLED_BACK, whose correction would count the return twice.
  12: 'REVERSED'
};

export function offerStatus(raw: number): OfferStatus {
  return OFFER_STATES[raw] ?? 'UNKNOWN';
}

export function tradeStatus(raw: number): TradeStatus {
  return TRADE_STATES[raw] ?? 'UNKNOWN';
}

/**
 * Whether an executed trade's status means the items actually moved.
 *
 * Only `COMPLETE`. An escrowed or pending trade has not delivered; a rolled-back one delivered
 * and then un-delivered, which is a *later linked* event rather than a reason to erase the first
 * (DATA-03, TRD-07). `UNKNOWN` is deliberately not settlement: an unmapped future code must not
 * silently start posting item movements.
 */
export function settlesDelivery(status: TradeStatus): boolean {
  return status === 'COMPLETE';
}

/** A rollback status: later evidence that reverses a delivery this app already recorded. */
export function reversesDelivery(status: TradeStatus): boolean {
  return status === 'ROLLED_BACK';
}

/** The same set as a list, for the one SQL query that has to name them. */
export const COMMITTING_STATUSES: readonly OfferStatus[] = [
  'ACTIVE', 'PENDING_CONFIRMATION', 'ESCROW', 'ACCEPTED', 'COUNTERED', 'UNKNOWN'
];

