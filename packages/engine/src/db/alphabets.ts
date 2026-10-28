/**
 * Every state alphabet the trading record declares, declared once (consolidation plan D2, schema
 * rule 2). A CHECK in `schema.ts` and a TypeScript union both read from here, so a word cannot
 * exist in one and not the other, and `check:schema-design` names a state column whose CHECK is not
 * one of these.
 *
 * Widening an alphabet is a migration that rebuilds the table (migration 17 is the pattern), so a
 * word is added here only with the migration that lets a record in the field accept it.
 */

/**
 * The hops a command is made of: one row of `work_step` each. `CONFIRM` is the engine's own phone
 * tap for a listing or an offer one of its hops made, only where a host composed a confirmation port
 * (strategy authority and confirmations plan D9).
 */
export const WORK_STEP_KINDS = [
  'DELIST', 'LIST', 'RETRIEVE', 'STORE',
  'BUY_ORDER_CREATE', 'BUY_ORDER_CANCEL',
  'SEND', 'ACCEPT', 'CANCEL',
  'CSFLOAT_CREATE', 'CSFLOAT_AWAIT_VENUE', 'CSFLOAT_REPRICE', 'CSFLOAT_CANCEL',
  'CSFLOAT_ACCEPT', 'CSFLOAT_SEND', 'CSFLOAT_NOTIFY', 'CSFLOAT_CANNOT_DELIVER',
  'CSFLOAT_BUY_ORDER_EDIT', 'CSFLOAT_BUY_ORDER_CANCEL',
  'STORE_INIT', 'STORE_APPROVE', 'STORE_FINALIZE', 'STORE_CANCEL',
  'CONFIRM'
] as const;
export type WorkStepKind = (typeof WORK_STEP_KINDS)[number];

/**
 * One alphabet for work in progress. `QUEUED` is admitted and not yet sent; `SENT` is the request
 * in flight; `AWAITING_OBSERVATION` is a request that returned, proven by nothing yet; `RETRYING`
 * is a request a complete observation proved absent, with another send due; `DONE` is an observed
 * effect; `FAILED` is a refusal or a proof of no effect with no send left; `STOPPED` is the person's
 * word. What a hop is waiting for is its `reason`, and what the venue shows meanwhile is read from
 * the venue's own rows, never stored here.
 */
export const WORK_STEP_STATES = ['QUEUED', 'SENT', 'AWAITING_OBSERVATION', 'RETRYING', 'DONE', 'FAILED', 'STOPPED'] as const;
export type WorkStepState = (typeof WORK_STEP_STATES)[number];

/** The states a step leaves for good. */
export const SETTLED_STEP_STATES: readonly WorkStepState[] = ['DONE', 'FAILED', 'STOPPED'];
export const OPEN_STEP_STATES: readonly WorkStepState[] = ['QUEUED', 'SENT', 'AWAITING_OBSERVATION', 'RETRYING'];

export const ACTION_STATES = ['READY', 'RUNNING', 'AWAITING_OBSERVATION', 'DONE', 'FAILED'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/**
 * Whose a command is (strategy authority plan D1). `HUMAN` is a person's press, the default and the
 * only word the desktop sends; `STRATEGY` is a rule a person set up, acting for them. A person's
 * word on a holding stands against a strategy's until the person hands the holding over (D3, D4).
 */
export const COMMAND_AUTHORITIES = ['HUMAN', 'STRATEGY'] as const;
export type CommandAuthority = (typeof COMMAND_AUTHORITIES)[number];

/** `DRAFT` is a captured selection no kind has been chosen for yet (consolidation plan §4.4). */
export const COMMAND_STATES = ['DRAFT', 'REJECTED', 'ADMITTED', 'RUNNING', 'PARTIAL', 'COMPLETE', 'STOPPED'] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/**
 * A command member's own words. `DRAFT` and `PREPARED` precede its hops; `QUEUED` is a member
 * whose hops exist, and what it is doing is read from them (`db/member-state.ts`); `REJECTED`,
 * `STOPPED` and `SOLD` are the words no hop can say for it: refused before any hop existed,
 * stopped before any was sent, or sold out from under its chain.
 */
export const COMMAND_MEMBER_STATES = ['DRAFT', 'PREPARED', 'QUEUED', 'REJECTED', 'STOPPED', 'SOLD'] as const;
export type CommandMemberState = (typeof COMMAND_MEMBER_STATES)[number];

export const RESERVATION_STATES = ['ACTIVE', 'SUBMITTED_UNOBSERVED', 'RELEASED', 'CONSUMED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const STORAGE_UNIT_STATES = ['ACTIVE', 'FULL', 'DISABLED'] as const;
export type StorageUnitState = (typeof STORAGE_UNIT_STATES)[number];

export const STORE_SHEET_PARSE_STATES = ['PARSED', 'UNPARSEABLE'] as const;
export type StoreSheetParseState = (typeof STORE_SHEET_PARSE_STATES)[number];

/** The venues an order can be on. A new venue is a word here and a satellite table, never a new parent (consolidation plan D4). */
export const ORDER_VENUES = ['steam', 'csfloat'] as const;
export type OrderVenue = (typeof ORDER_VENUES)[number];

export const ORDER_SIDES = ['SELL', 'BUY'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

/**
 * One alphabet for an order on every venue and either side (engine/order-lifecycle.md §3.2).
 * `SUBMITTED` is a request of ours no walk has shown yet; the three open words are what the
 * venue shows; `UNEXPLAINED` is gone with nothing to say why, a real state carrying an age;
 * `QUARANTINED` is the world contradicting itself; the `ENDED_` words are decided endings.
 */
export const ORDER_STATES = [
  'SUBMITTED', 'OPEN', 'OPEN_UNTRANSACTABLE', 'PENDING_EXTERNAL', 'UNEXPLAINED', 'QUARANTINED',
  'ENDED_FILLED', 'ENDED_CANCELLED_BY_US', 'ENDED_CANCELLED_EXTERNALLY', 'ENDED_LAPSED', 'ENDED_EXPIRED',
  'ENDED_VOIDED_BY_VENUE', 'ENDED_LOST', 'ENDED_NOT_APPLIED'
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** How sure the record is of an order's state: proven by the venue, inferred, asserted by a person (D7), or not known. */
export const ORDER_CONFIDENCES = ['proven', 'probable', 'asserted', 'unknown'] as const;
export type OrderConfidence = (typeof ORDER_CONFIDENCES)[number];

/** The three buckets of Steam's `mylistings`, the venue's own word for an open listing. */
export const STEAM_LISTING_BUCKETS = ['ACTIVE', 'ON_HOLD', 'PENDING_CONFIRMATION'] as const;
export type SteamListingBucket = (typeof STEAM_LISTING_BUCKETS)[number];

/** Who said it: a source other than the Game Coordinator with a word on an asset (`asset_evidence`, consolidation plan D11). */
export const EVIDENCE_SOURCES = ['community', 'csfloat'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Steam's `ETradeOfferState`, in the words the trades surface keeps beside the code (`policy/trade-status.ts`). */
export const TRADE_OFFER_STATUSES = [
  'INVALID', 'ACTIVE', 'ACCEPTED', 'COUNTERED', 'EXPIRED', 'CANCELLED', 'DECLINED',
  'INVALID_ITEMS', 'PENDING_CONFIRMATION', 'CANCELLED_BY_SECOND_FACTOR', 'ESCROW', 'UNKNOWN'
] as const;
/** Steam's `ETradeStatus` on an executed trade, likewise. */
export const EXECUTED_TRADE_STATUSES = ['PENDING', 'COMPLETE', 'FAILED', 'ROLLED_BACK', 'REVERSED', 'ESCROW', 'UNKNOWN'] as const;
/** A status event records either word: an offer's or an executed trade's. */
export const TRADE_STATUS_EVENT_STATUSES: readonly string[] = [...new Set<string>([...TRADE_OFFER_STATUSES, ...EXECUTED_TRADE_STATUSES])];
/** A venue connection's state (`db/marketplace.ts`). */
export const VENUE_CONNECTION_STATUSES = ['CONNECTED', 'CHECKING', 'INVALID_KEY', 'RESTRICTED', 'THROTTLED', 'UNAVAILABLE', 'DISCONNECTED'] as const;

/** The words inside a `CHECK(column IN (...))`, spelled the way the record stores them. */
export function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}
