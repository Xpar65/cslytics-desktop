import type { OrderVenue } from '../db/alphabets.js';

/**
 * How often one listing's price may change, per venue.
 *
 * A price change is never free. On Steam a reprice is a cancel, a new listing and a phone
 * confirmation, and the item is off the market in between; the confirmation comes out of the same
 * per-account budget every other confirmation needs, and Steam holds at most three unconfirmed
 * listings at once (corpus `steamcommunity.market.sellitem`). On CSFloat the edit is one call, but
 * every change is proved by that listing's own read (CSF-45), and a listing whose price moves every
 * few minutes reads as churn to a buyer. Nothing in the engine bounded any of this before: the
 * listing goal had a budget of attempts, not a cadence, and a CSFloat reprice had no bound at all.
 *
 * The rule is per listing and per venue: at most one change in `minIntervalMs`, and one in
 * `forceIntervalMs` when the asked price is at least `forceDriftPct` away from the current one,
 * because a price that is a tenth off is worth a confirmation and a cent is not. Admission refuses
 * an earlier ask with the time of the next allowed one, and the listing reads carry that time as
 * `nextPriceChangeAt`, so a caller can see it before asking. A person's command may carry `force`,
 * which passes once and is recorded on the work it admitted: a person pressing twice is a decision,
 * and the rule exists for whatever repeats itself.
 *
 * The engine refuses only what it can date. A listing it did not create has no attempt to date the
 * last change by, and `null` there admits the change rather than inventing a time.
 */
export type PriceChangeRule = {
  /** The shortest gap between two changes of one listing's price. */
  minIntervalMs: number;
  /** The drift, in percent of the current price, from which `forceIntervalMs` applies instead. */
  forceDriftPct: number;
  /** The shortest gap when the drift is at least `forceDriftPct`. */
  forceIntervalMs: number;
};

const HOUR_MS = 3_600_000;

/** Defaults; every number is a knob the host composes, never a setting in the record (schema rule 6). */
export const PRICE_CHANGE: Readonly<Record<OrderVenue, PriceChangeRule>> = {
  steam: { minIntervalMs: 24 * HOUR_MS, forceDriftPct: 10, forceIntervalMs: 6 * HOUR_MS },
  csfloat: { minIntervalMs: 6 * HOUR_MS, forceDriftPct: 5, forceIntervalMs: HOUR_MS }
};

/** How far an asked price is from the current one, in percent of the current one. A zero current price is any distance. */
export function priceDriftPct(currentCents: number, requestedCents: number): number {
  if (!(currentCents > 0)) return Number.POSITIVE_INFINITY;
  return Math.abs(requestedCents - currentCents) / currentCents * 100;
}

/**
 * When the next change of a listing's price is allowed, given when it last changed. With no drift
 * given, the plain interval: what a read reports, since it does not know the price to come.
 */
export function nextPriceChangeAt(lastChangedAt: string, rule: PriceChangeRule, driftPct?: number): string {
  const interval = driftPct !== undefined && driftPct >= rule.forceDriftPct ? rule.forceIntervalMs : rule.minIntervalMs;
  return new Date(Date.parse(lastChangedAt) + interval).toISOString();
}

export type PriceChangeAsk = {
  venue: OrderVenue;
  /** When the listing's price last changed, or `null` when the record cannot say. */
  lastChangedAt: string | null;
  currentCents: number;
  requestedCents: number;
  /** The engine's clock, ISO. */
  now: string;
  /** A person's decision to change the price anyway. */
  force?: boolean | undefined;
};

/** Why the price may not change now, in the words admission refuses with, or `null` when it may. */
export function priceChangeRefusal(ask: PriceChangeAsk): string | null {
  if (ask.force || ask.lastChangedAt === null) return null;
  const next = nextPriceChangeAt(ask.lastChangedAt, PRICE_CHANGE[ask.venue], priceDriftPct(ask.currentCents, ask.requestedCents));
  if (Date.parse(next) <= Date.parse(ask.now)) return null;
  return `The price of this listing last changed at ${ask.lastChangedAt}; the next change is allowed at ${next}`;
}
