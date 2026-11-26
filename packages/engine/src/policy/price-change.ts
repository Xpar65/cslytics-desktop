import { MARKET_ACTION_TIMEOUT_MS } from '@cslytics/ports';

/**
 * How long a lower listing price may wait for its confirmation before the engine withdraws it.
 *
 * Steam accepts a price below the one a listing is on sale at and holds it until someone confirms
 * it, in the Steam mobile app or by a link sent by e-mail; until then the listing stays on sale at
 * its old price, and no further change can be made to it. Nothing the engine reads says that a
 * person declined the confirmation or will never get to it, so without an end a waiting lower price
 * would hold its listing for ever. After this long with no walk showing the new price, the engine
 * asks Steam to drop the change, reads the listings once more, and ends the change on what that read
 * shows: the old price, and it was not confirmed; the new price, and it was confirmed just in time.
 *
 * An hour is long enough for a person who was asked to confirm to have done so, and short enough
 * that a listing whose price someone meant to lower is free to take another change the same session.
 */
export const PRICE_CHANGE_CONFIRM_DEADLINE_MS = 60 * 60_000;

/** When a lower price that Steam began holding at `heldAt` (an ISO-8601 instant) stops waiting for its confirmation. */
export function priceChangeDeadline(heldAt: string): string {
  return new Date(Date.parse(heldAt) + PRICE_CHANGE_CONFIRM_DEADLINE_MS).toISOString();
}

/**
 * How long the engine waits before it sends a discard again that Steam never heard: 30 seconds
 * after the first unheard send, two minutes after the second, ten minutes after the third, and
 * then no more (`PRICE_DISCARD_SENDS`, four sends in all).
 *
 * A discard goes unheard when Steam cannot be reached: a session that has lapsed, a rate limit, a
 * server error, a connection that fails or a request that times out. Each of those tends to last a
 * while, so a discard sent again at once is answered the same way, and three sends in a row spent
 * the whole allowance inside a second and left the lower price waiting on Steam. Spread out, the
 * four sends cover about a quarter of an hour, which is long enough for a short outage or a rate
 * limit to pass, and short enough that a listing is not held for long. Nothing is lost by waiting:
 * the listing stays on sale at its old price meanwhile.
 */
export const PRICE_DISCARD_BACKOFF_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];

/** How long after the last of `unheard` unheard sends of one discard the next may go. */
export function priceDiscardBackoffMs(unheard: number): number {
  const index = Math.min(Math.max(unheard, 1), PRICE_DISCARD_BACKOFF_MS.length) - 1;
  return PRICE_DISCARD_BACKOFF_MS[index]!;
}

/**
 * How long Steam may still be processing a discard request after this app stopped waiting for its
 * answer: half a minute.
 */
export const PRICE_DISCARD_LANDING_MARGIN_MS = 30_000;

/**
 * How long after an unheard discard began a walk must begin before it may decide the change the
 * discard withdraws: the longest the request may wait for its answer (`MARKET_ACTION_TIMEOUT_MS`,
 * which the port promises), and `PRICE_DISCARD_LANDING_MARGIN_MS` more for a request Steam received
 * just before it was given up on. Never sooner than that margin after the send came back either,
 * for a send that began late (a web session slow to be made) or whose process died.
 *
 * A request given up on can still land. Ended any sooner, the change would free its listing for a
 * new price change while a discard of ours could still arrive, and drop the new lower price instead.
 * Until this has passed, the change stays open, and a new price change on the listing is refused.
 */
export const PRICE_DISCARD_LATE_LANDING_MS = MARKET_ACTION_TIMEOUT_MS + PRICE_DISCARD_LANDING_MARGIN_MS;
