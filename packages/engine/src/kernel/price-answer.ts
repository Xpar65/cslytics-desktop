/**
 * The rules a venue answer that states a listing's price shares with the reads around it, on every
 * venue that has one: a CSFloat reprice answers with the listing as it now is, and a Steam price
 * change in place names the listing's price. `db/csfloat.ts` and `db/orders.ts` both hold a read to
 * these rules, and neither venue's module is the other's to import.
 */

/**
 * How long before a price answer a read may have begun and still be held back by that answer: a
 * read that began at or before the answer may have read the listing before the change, and must not
 * put the old price back. The two moments are read off this machine's clock, so a clock set back
 * after an answer would make every later read look as if it began before it, and without a bound
 * each of them would be held back until the clock passed the answer again, however long that took.
 *
 * Fifteen minutes is far longer than a listing read is in flight: a CSFloat listing read is one
 * request, a stall walk or a Steam book walk one request a page, each answered in about a second and
 * given up after thirty. A read the bound lets through is taken as any read is: it restates the
 * listing, and a disagreement with the answer is counted. For a clock set back that is right; for a
 * read that really was in flight so long, it is what every read did before an answer was trusted,
 * and the next read corrects it.
 *
 * CSFloat's reads are bounded from when they began (`CsfloatStore.publishContract`). A Steam book
 * walk is bounded from when it was written (`begunBeforeAnswer` in `db/orders.ts`): it reads each
 * buy order that left the book after its pages, at the read budget's pace, so it can stay open far
 * longer than its pages, and on a clock that only moves forward it is still written after every
 * answer it is compared with.
 */
export const PRICE_ANSWER_GUARD_MS = 15 * 60_000;

/** The same bound, under the name the CSFloat reprice's code and tests have always used. */
export const CSFLOAT_ANSWER_GUARD_MS = PRICE_ANSWER_GUARD_MS;

/**
 * The event written when the first read after a price answer shows the listing at another price
 * than the answer stated, or, on CSFloat, up at all after an answer that called it sold, and nothing
 * this app sent since explains it. One kind for both venues, with the same `venue`, `listingId`,
 * `statedCents`, `observedCents` and `observationId` fields, so one reader counts both: a CSFloat
 * reprice writes it in `CsfloatStore.publishContract`, a Steam price change in place in
 * `MarketService.priceAnswerContradicted`.
 */
export const PRICE_ANSWER_CONTRADICTED = 'price-answer-contradicted';
