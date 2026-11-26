import type { CommandAuthority, OrderVenue } from '../db/alphabets.js';

/**
 * How often one listing's price may change, per venue.
 *
 * A price change is never free. On Steam a relist is a cancel, a new listing and a phone
 * confirmation, and the item is off the market in between; the confirmation comes out of the same
 * per-account budget every other confirmation needs, and Steam holds at most three unconfirmed
 * listings at once (corpus `steamcommunity.market.sellitem`). A change in place keeps the listing,
 * but a lower price still costs a confirmation, and a price that moves every few minutes reads as
 * churn to a buyer. On CSFloat the edit is one call, settled on its own answer when that answer
 * returns the listing at the price sent, and on that listing's own read when it does not (CSF-70,
 * CSF-72). Nothing in the engine bounded any of this before: the listing goal had a budget of
 * attempts, not a cadence, and a CSFloat reprice had no bound at all.
 *
 * The rule is per listing and per venue: at most one change in `minIntervalMs`, and one in
 * `forceIntervalMs` when the asked price is at least `forceDriftPct` away from the current one,
 * because a price that is a tenth off is worth a confirmation and a cent is not. Admission refuses
 * an earlier ask with the time of the next allowed one, and the listing reads carry that time as
 * `nextPriceChangeAt`, so a caller can see it before asking. A person's command may carry `force`,
 * which passes once and is recorded on the work it admitted: a person pressing twice is a decision,
 * and the rule exists for whatever repeats itself.
 *
 * **A change in place on Steam is not bound by this rule at all**, whoever asks, forced or not.
 * Steam itself takes one change per listing every five minutes (`LISTING_PRICE_COOLDOWN_MS`),
 * which the engine waits out, and that is the only limit there. The interval was written for the
 * relist; a change in place costs nothing for a raise and one confirmation for a lower price, and
 * the listing stays on sale throughout. Until 2026-11-25 a strategy's change in place kept the
 * relist's interval (in-place reprice plan D10); a listing that could follow its market once a day
 * fell behind it. How often a strategy asks is the caller's own rule to keep. A relist obeys the
 * interval whoever asks.
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
  /** Whose the change is: a person's unless it says otherwise. */
  authority?: CommandAuthority | undefined;
  /** The price changes on the same listing, where the alternative is a cancel and a new listing. */
  inPlace?: boolean | undefined;
};

/**
 * Whether the venue's own limit is the only one on this change: a change in place on Steam, a
 * person's or a strategy's, which Steam's five-minute cooldown bounds and this rule does not.
 */
export function boundByVenueAlone(ask: Pick<PriceChangeAsk, 'venue' | 'authority' | 'inPlace'>): boolean {
  return ask.venue === 'steam' && ask.inPlace === true;
}

/** Why the price may not change now, in the words admission refuses with, or `null` when it may. */
export function priceChangeRefusal(ask: PriceChangeAsk): string | null {
  if (ask.force || ask.lastChangedAt === null || boundByVenueAlone(ask)) return null;
  const next = nextPriceChangeAt(ask.lastChangedAt, PRICE_CHANGE[ask.venue], priceDriftPct(ask.currentCents, ask.requestedCents));
  if (Date.parse(next) <= Date.parse(ask.now)) return null;
  return `The price of this listing last changed at ${ask.lastChangedAt}; the next change is allowed at ${next}`;
}
