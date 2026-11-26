import { LISTING_PRICE_COOLDOWN_MS, listingPriceChangeAnswer, type MutationOutcome } from '@cslytics/ports';

/**
 * The words of a Steam listing's price change in place, in one file: the action kinds it is sent
 * as, the reasons it fails with that a caller reads as a word, and how many refusals for Steam's
 * cooldown end it. `surfaces/market.ts` sends and settles the change, `orchestrate/command.ts`
 * admits and holds it, and the reads report it; all three read these.
 *
 * The contract of the venue's call is on the port (`SteamMarketPort.updateListingPrice`) and in
 * the corpus page it cites. What this app decided about it is
 * `cslytics-app-docs/plans/steam-in-place-reprice-plan.md`.
 */

/** The action a price change in place is sent as. */
export const UPDATE_SELL_LISTING_PRICE = 'UPDATE_SELL_LISTING_PRICE';
/** The action that drops a lower price still waiting for its confirmation. */
export const DISCARD_SELL_LISTING_PRICE_CHANGE = 'DISCARD_SELL_LISTING_PRICE_CHANGE';

/**
 * The resolution of a price change whose lower price is being withdrawn: the discard is queued or
 * out, and a complete walk begun after it returns decides how the change ends. Until then the
 * change is no longer waiting on a person, and nothing presses it.
 */
export const PRICE_CHANGE_DISCARD_SENT = 'DISCARD_SENT';

/**
 * Why a waiting lower price is withdrawn: it passed its deadline unconfirmed, a person stopped the
 * command, or its answer never came and the walk after it showed the old price.
 */
export type PriceDiscardReason = 'deadline' | 'stopped' | 'unanswered';

/**
 * The frozen terms of a discard: the listing, why it was sent, and for a lower price whose answer
 * never came, the walk that showed the old price, which is what that change is failed on.
 */
export type PriceDiscardParams = { listingId: string; why: PriceDiscardReason; provedBy?: number };

/**
 * How many times one discard may be sent: once, and again while Steam never heard it (`discardHeard`),
 * each time after the wait `policy/price-change.ts` names (`PRICE_DISCARD_BACKOFF_MS`, one fewer
 * than this). A discard of a change Steam no longer holds changes nothing, so sending it again is
 * safe; four sends bound it. When the last goes unheard too, the discard fails with
 * `PRICE_DISCARD_UNHEARD` and the change, unless a walk shows it confirmed or sold, with
 * `PRICE_WITHDRAWAL_UNHEARD`.
 */
export const PRICE_DISCARD_SENDS = 4;

/**
 * A lower price whose withdrawal Steam never heard: every send of its discard went unanswered, so
 * the lower price may still be waiting there for its confirmation, and a person who confirms it in
 * the Steam app sells at it. The whole reason, whatever asked for the withdrawal (its deadline, a
 * Stop, or a lost answer).
 */
export const PRICE_WITHDRAWAL_UNHEARD = 'withdrawal-unheard';

/** The reason on a discard none of whose sends Steam answered. */
export const PRICE_DISCARD_UNHEARD = `Steam answered none of the ${PRICE_DISCARD_SENDS} sends of this discard; the lower price may still be waiting for its confirmation`;

/**
 * Whether Steam heard a discard: the venue accepted it, or the outcome carries Steam's own answer
 * from the market's action route (`MarketActionAnswer`): HTTP 200 with the route's JSON body, which
 * carries `data`, whatever code that holds. Anything else is unheard, whatever its cause says: no
 * answer in time, a failed connection, a redirect (a session that has lapsed), another status (a
 * rate limit, a server error), a page that is not the route's answer, or a failure before any request
 * left this machine, such as a web session that could not be made, which is a plain error and so
 * `unclassified`. Taking an unheard discard for heard can leave a lower price waiting on Steam;
 * taking a heard one for unheard only sends it again, which changes nothing.
 */
export function discardHeard(outcome: Pick<MutationOutcome, 'kind' | 'raw'>): boolean {
  if (outcome.kind === 'SUBMITTED') return true;
  const raw = outcome.raw as { status?: unknown; body?: unknown } | null;
  if (raw === null || typeof raw !== 'object' || raw.status !== 200) return false;
  return raw.body !== null && typeof raw.body === 'object' && 'data' in raw.body;
}

/** `discardHeard` of an attempt as the record stores it: its outcome's kind, and its `raw` as JSON. An attempt with no outcome was never answered. */
export function discardAttemptHeard(attempt: { outcome: string | null; response_ref: string | null }): boolean {
  if (attempt.outcome === null) return false;
  let raw: unknown = null;
  try { raw = JSON.parse(attempt.response_ref ?? 'null') as unknown; } catch { raw = null; }
  return discardHeard({ kind: attempt.outcome as MutationOutcome['kind'], raw });
}

/** The reason on a discard the composed market has no call for: refused, and nothing sent. */
export const PRICE_DISCARD_UNAVAILABLE = 'This market has no way to discard a price change';

/** The id of the one discard a price change may send: one per change, so a second can never be queued beside it. */
export function priceDiscardId(changeActionId: string): string {
  return `${changeActionId}:discard`;
}

/**
 * Steam would not change this listing's price in place, or the composed market has no such call:
 * the way left is to remove the listing and list the item again. The whole reason, and nothing
 * beside it, so a caller can read it as a word.
 */
export const PRICE_EDIT_UNAVAILABLE = 'price-edit-unavailable';
/**
 * A lower price whose answer never came and which no walk shows applied. Steam may be holding it
 * for a confirmation, and the book would look the same, so it is never sent again. The whole reason.
 */
export const PRICE_CHANGE_UNANSWERED = 'unanswered';
/** A lower price nobody confirmed in time. The whole reason. */
export const PRICE_CHANGE_NOT_CONFIRMED = 'not-confirmed';

/*
 * The sentences a price change is refused or failed with, where a caller needs to know which one
 * it is. A person reads each as it stands, so each stays a sentence; what a caller matches is the
 * exported constant, or the predicate for a sentence that names an item or a price, and the
 * sentence is built from the same parts, so the two cannot drift apart.
 */

/** How a sentence about one item's listing begins; the item's local id follows. */
const LISTING_OF_ITEM = 'The listing of item ';
const ALREADY_THERE = ' is already at that price';
const NEITHER_PRICE_LEAD = 'Steam shows the listing at a seller price of ';
const NEITHER_PRICE_TAIL = ' cents, neither the price it had nor the price asked for';
const MOVED_TAIL = ' cents before this automated price change was sent, so nothing was sent; the strategy asks again against the new price';

function isItemSentence(reason: string | null | undefined, tail: string): boolean {
  return typeof reason === 'string' && reason.startsWith(LISTING_OF_ITEM) && reason.endsWith(tail);
}

/**
 * A price change refused at admission, or failed at its send, because its listing is already at
 * the price asked for: nothing needs to be sent.
 */
export function priceAlreadyThere(localId: string): string {
  return `${LISTING_OF_ITEM}${localId}${ALREADY_THERE}`;
}

/** Whether a reason is `priceAlreadyThere`'s sentence, for any item. */
export function isPriceAlreadyThere(reason: string | null | undefined): boolean {
  return isItemSentence(reason, ALREADY_THERE);
}

/** A walk shows the listing at a third price: neither the price it had nor the price asked for. */
export function neitherPrice(shownCents: number): string {
  return `${NEITHER_PRICE_LEAD}${shownCents}${NEITHER_PRICE_TAIL}`;
}

/** Whether a reason is `neitherPrice`'s sentence, for any price. */
export function isNeitherPrice(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(NEITHER_PRICE_LEAD) && reason.endsWith(NEITHER_PRICE_TAIL);
}

/**
 * An automated price change whose listing moved off the price it was admitted at before it was
 * sent: nothing is sent, and the strategy asks again against the price the listing has now.
 */
export function strategyPriceMoved(localId: string, admittedAtCents: number, nowCents: number): string {
  return `${LISTING_OF_ITEM}${localId} moved from ${admittedAtCents} to ${nowCents}${MOVED_TAIL}`;
}

/** Whether a reason is `strategyPriceMoved`'s sentence, for any item and prices. */
export function isPriceMovedSinceAdmission(reason: string | null | undefined): boolean {
  return isItemSentence(reason, MOVED_TAIL);
}

/** A price change refused at its send because its listing is no longer on the book. The whole reason. */
export const PRICE_CHANGE_LISTING_OFF_MARKET = 'The listing is no longer on the market';
/** A price change refused at its send because its listing is not live: waiting for its own confirmation, or on hold. The whole reason. */
export const PRICE_CHANGE_LISTING_NOT_LIVE = 'The listing is not live on the market';
/** The reason on a price change whose listing a walk showed gone, and not sold. The whole reason. */
export const PRICE_CHANGE_LISTING_GONE = 'The listing left the market before its price changed';

/**
 * The reason on a price change whose listing sold while the change was open. It claims neither
 * that the change took nor that it did not: a confirmed lower price can fill a resting buy order
 * at once, and then the listing sold because of it, at the new price.
 */
export const SOLD_DURING_PRICE_CHANGE = 'The listing sold while its price change was open';

/**
 * How many times one price change may be refused for Steam's cooldown before it fails. The first
 * refusal teaches when the cooldown ends, and the change is sent once more then; a second means
 * the listing changed again under it, and the person decides what to ask next.
 */
export const PRICE_COOLDOWN_REFUSALS = 2;
/** The reason on a price change refused for the cooldown that many times. */
export const PRICE_COOLDOWN_REFUSED = 'Steam refused the price change twice for its price-change cooldown';

/**
 * When a wait that began at `at` ends, as the record keeps every instant: ISO-8601 on the engine's
 * clock. With no length given, Steam's cooldown on a listing's price.
 */
export function cooldownEnd(at: string, ms: number = LISTING_PRICE_COOLDOWN_MS): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

/** The venue's code for a listing whose price it will not change in place. */
export const VENUE_CODE_PRICE_NOT_EDITABLE = 11;

/** The venue's own code in a stored answer to a price change, when the answer carried one. */
export function priceChangeVenueCode(response: string | null | undefined): number | null {
  if (!response) return null;
  try {
    return listingPriceChangeAnswer(JSON.parse(response) as unknown).venueCode;
  } catch {
    return null;
  }
}

/**
 * The seller price the venue stated the listing is at as it answered, read from a stored answer: on
 * a lower price held for its confirmation, the price still current, which is the old price a walk
 * shows while it waits. `null` when the answer named none.
 */
export function priceChangeInEffect(response: string | null | undefined): number | null {
  if (!response) return null;
  try {
    return listingPriceChangeAnswer(JSON.parse(response) as unknown).priceReceiveCents;
  } catch {
    return null;
  }
}

/** Who must confirm a lower price the venue holds, read from the stored answer that said so; `null` when it asked for no confirmation. */
export function priceChangeConfirmer(response: string | null | undefined): 'phone' | 'email' | null {
  if (!response) return null;
  try {
    return listingPriceChangeAnswer(JSON.parse(response) as unknown).confirmation;
  } catch {
    return null;
  }
}
