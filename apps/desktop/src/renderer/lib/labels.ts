import { currencyById } from '@cslytics/market-data';
import { CSFLOAT_CURRENCY } from '@cslytics/ports';
import type { IconName } from '../components/Icon.js';
import { COOLDOWN_CAUSE, isHeldForCooldown, isUnsent, isWaitingPriceChange } from '../features/work/work-busy.js';
import { currencyOf, formatAmount, type CurrencyRef } from './money.js';
import { formatClock, formatDateTime } from './time.js';

/**
 * Words for codes.
 *
 * The engine speaks in enums, kinds and keys because those are what it can prove; a person
 * reading the window should never have to. Every dictionary here maps one of the engine's
 * vocabularies to a label, and `humanize` is the fallback for a code nobody has written a
 * label for yet — it turns `PENDING_CONFIRMATION` into "Pending confirmation" rather than
 * showing the raw token, so an unlabelled value degrades to readable rather than to cryptic.
 *
 * Nothing here is used to *decide* anything. A label is presentation; the code behind it is
 * still what a command carries. Tests that assert on a state assert on the code.
 */

export type Tone = 'neutral' | 'quiet' | 'accent' | 'positive' | 'warn' | 'negative';

export type StateLabel = { label: string; tone: Tone; icon?: IconName };

export function humanize(code: string | null | undefined): string {
  if (!code) return '';
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Stable two-letter initials: the first letters of the first two words, or the first two characters. */
export function initials(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _.-]/g, '').trim();
  const words = cleaned.split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || '?';
}

/** A hue in degrees, decided by the name alone so every screen agrees. */
export function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

// ---------------------------------------------------------------------------- inventory

export const LOCATION: Readonly<Record<string, StateLabel>> = {
  MAIN: { label: 'In inventory', tone: 'neutral', icon: 'package' },
  CASKET: { label: 'In storage', tone: 'quiet', icon: 'archive' },
  MISSING: { label: 'Missing', tone: 'warn', icon: 'alert-circle' }
};

/**
 * Listed on the Steam market. Not a location: the Game Coordinator keeps a listed item in main
 * inventory, so a listed row is `MAIN` and this at once.
 */
export const LISTED: StateLabel = { label: 'Listed', tone: 'accent', icon: 'tag' };

export function locationLabel(location: string | null | undefined): StateLabel {
  return LOCATION[location ?? ''] ?? { label: humanize(location), tone: 'neutral' };
}

export const UNRESOLVED_REASON: Readonly<Record<string, string>> = {
  'not-in-revision': 'Not in the current catalogue. It may be newer than the last update.',
  'never-fetched': 'The catalogue has not been downloaded yet',
  'lookup-failed': 'The catalogue could not be reached for this item',
  'no-identity': 'Steam named no item for this line, and no walk matched it to one'
};

// ---------------------------------------------------------------------------- market

export const LISTING_STATUS: Readonly<Record<string, StateLabel>> = {
  ACTIVE: { label: 'Live', tone: 'positive', icon: 'check-circle' },
  ON_HOLD: { label: 'On hold', tone: 'quiet', icon: 'clock' },
  PENDING_CONFIRMATION: { label: 'Confirm on phone', tone: 'accent', icon: 'smartphone' },
  ABSENT: { label: 'Gone', tone: 'quiet', icon: 'x-circle' }
};

/**
 * How Steam changes a listing's price, in the words every place that offers a reprice uses: the
 * chip on a staged row, and the caption under Reprice in the item inspector.
 *
 * Steam asks for a lower price to be confirmed in the Steam Mobile app on most accounts and by a
 * link it e-mails on others, and nothing here knows which until Steam has answered a change, so
 * these words are true of both. Once a lower price waits, the listing and the waiting list say
 * which (`pendingTitle`, `waitingBadge`).
 */
export const STEAM_PRICE_CHANGE = {
  /** A chip's worth: the one step a person may be asked for. */
  short: 'Lowering needs confirming',
  /** A caption's worth: where the price changes, and what a lower one waits for. */
  caption: 'The price changes on the same listing. A lower price waits for you to confirm it.',
  /** All of it, for a tip. */
  text: 'The price changes on the same listing. A higher price applies at once. A lower price waits for you to confirm it, in the Steam Mobile app or with a link Steam e-mails you, and the listing stays at its current price until then. Steam allows one price change every 5 minutes per listing.'
} as const;

/** Why a change staged inside the cooldown is not sent at once: the tip on the row's countdown. */
export const STEAM_PRICE_CHANGE_HELD = 'Steam allows one price change per listing every 5 minutes. A change sent now is held, and sent when the wait ends.';

/** The order alphabet of `venue_order` (engine `db/alphabets.ts`), in a person's words. */
export const ORDER_STATE: Readonly<Record<string, StateLabel>> = {
  SUBMITTED: { label: 'Sent, not yet seen', tone: 'accent', icon: 'upload' },
  OPEN: { label: 'Open', tone: 'positive', icon: 'circle-dot' },
  OPEN_UNTRANSACTABLE: { label: 'Open, cannot transact', tone: 'warn', icon: 'alert-circle' },
  PENDING_EXTERNAL: { label: 'Waiting on the venue', tone: 'accent', icon: 'hourglass' },
  UNEXPLAINED: { label: 'Unexplained', tone: 'warn', icon: 'alert-triangle' },
  QUARANTINED: { label: 'Quarantined', tone: 'warn', icon: 'ban' },
  ENDED_FILLED: { label: 'Sold', tone: 'positive', icon: 'coins' },
  ENDED_CANCELLED_BY_US: { label: 'Cancelled here', tone: 'quiet', icon: 'x-circle' },
  ENDED_CANCELLED_EXTERNALLY: { label: 'Cancelled at the venue', tone: 'quiet', icon: 'x-circle' },
  ENDED_LAPSED: { label: 'Never confirmed', tone: 'quiet', icon: 'x-circle' },
  ENDED_EXPIRED: { label: 'Expired', tone: 'quiet', icon: 'x-circle' },
  ENDED_VOIDED_BY_VENUE: { label: 'Voided by the venue', tone: 'warn', icon: 'ban' },
  ENDED_LOST: { label: 'Lost', tone: 'warn', icon: 'alert-triangle' },
  ENDED_NOT_APPLIED: { label: 'Never placed', tone: 'quiet', icon: 'x-circle' }
};

/** Steam's `market_history` event types, as the market walk records them. */
export const HISTORY_EVENT: Readonly<Record<number, StateLabel>> = {
  1: { label: 'Listing created', tone: 'neutral', icon: 'tag' },
  2: { label: 'Listing cancelled', tone: 'quiet', icon: 'x-circle' },
  3: { label: 'Sold', tone: 'positive', icon: 'coins' },
  4: { label: 'Purchased', tone: 'accent', icon: 'shopping-cart' }
};

export const ORDER_SIDE: Readonly<Record<string, string>> = {
  SELL: 'Sell listing',
  BUY: 'Buy order'
};

// ---------------------------------------------------------------------------- trades

export const TRADE_STATUS: Readonly<Record<string, StateLabel>> = {
  ACTIVE: { label: 'Active', tone: 'accent', icon: 'hourglass' },
  ACCEPTED: { label: 'Accepted', tone: 'positive', icon: 'check-circle' },
  COUNTERED: { label: 'Countered', tone: 'neutral', icon: 'arrow-left-right' },
  ESCROW: { label: 'In escrow', tone: 'accent', icon: 'lock' },
  COMPLETE: { label: 'Complete', tone: 'positive', icon: 'check-circle' },
  PENDING: { label: 'Pending', tone: 'accent', icon: 'hourglass' },
  PENDING_CONFIRMATION: { label: 'Confirm on phone', tone: 'accent', icon: 'smartphone' },
  CANCELLED: { label: 'Cancelled', tone: 'quiet', icon: 'x-circle' },
  CANCELLED_BY_SECOND_FACTOR: { label: 'Cancelled on phone', tone: 'quiet', icon: 'x-circle' },
  DECLINED: { label: 'Declined', tone: 'quiet', icon: 'ban' },
  EXPIRED: { label: 'Expired', tone: 'quiet', icon: 'clock' },
  INVALID: { label: 'Invalid', tone: 'warn', icon: 'alert-circle' },
  INVALID_ITEMS: { label: 'Items changed', tone: 'warn', icon: 'alert-circle' },
  FAILED: { label: 'Failed', tone: 'negative', icon: 'x-circle' },
  ROLLED_BACK: { label: 'Rolled back', tone: 'negative', icon: 'undo' },
  REVERSED: { label: 'Reversed', tone: 'negative', icon: 'undo' },
  UNKNOWN: { label: 'Unknown', tone: 'warn', icon: 'alert-circle' }
};

// ---------------------------------------------------------------------------- ledger

export const LEDGER_KIND: Readonly<Record<string, StateLabel>> = {
  MARKET_SALE: { label: 'Market sale', tone: 'positive', icon: 'coins' },
  BUY_ORDER_FILL: { label: 'Buy order filled', tone: 'accent', icon: 'shopping-cart' },
  EXTERNAL_PURCHASE: { label: 'Purchase', tone: 'neutral', icon: 'shopping-cart' },
  TRADE_RECEIPT: { label: 'Received in trade', tone: 'neutral', icon: 'arrow-down-left' },
  TRADE_DISPOSAL: { label: 'Sent in trade', tone: 'neutral', icon: 'arrow-up-right' },
  UNEXPLAINED_MOVEMENT: { label: 'Unexplained movement', tone: 'warn', icon: 'alert-triangle' },
  CORRECTION: { label: 'Correction', tone: 'quiet', icon: 'undo' }
};

// ---------------------------------------------------------------------------- commands and transfers

/** The kinds a command can be, as a verb a person would use. */
export const COMMAND_KIND: Readonly<Record<string, { label: string; icon: IconName; progressive: string }>> = {
  STORE: { label: 'Store', icon: 'archive', progressive: 'Storing' },
  RETRIEVE: { label: 'Retrieve', icon: 'download', progressive: 'Retrieving' },
  TRANSFER: { label: 'Transfer', icon: 'send', progressive: 'Transferring' },
  LIST: { label: 'List for sale', icon: 'tag', progressive: 'Listing' },
  REPRICE: { label: 'Reprice', icon: 'pencil', progressive: 'Repricing' },
  DELIST_TO_STORE: { label: 'Delist to storage', icon: 'undo', progressive: 'Delisting' }
};

// ---------------------------------------------------------------------------- work

/**
 * What is happening to an item, in observation-honest words.
 *
 * "Sent, waiting for Steam to show it" is the whole point of this table. A mutation receipt is
 * evidence about an attempt, never proof that the requested state exists, and the one place a
 * user could be told otherwise is a progress label that says "Done" the moment a call returned.
 * `Completed` appears only for a member whose action reached `DONE`, which means an observation
 * proved it. The word is not "Done": that would read as the call having returned.
 */
export const WORK_STATE: Readonly<Record<string, StateLabel>> = {
  // The window's own states for a send the engine has not answered yet (`outbox.ts`). Pressed
  // after another send and waiting its turn; then out, and not yet accepted; then turned down.
  UNSUBMITTED: { label: 'Waiting to submit', tone: 'quiet', icon: 'hourglass' },
  SUBMITTING: { label: 'Submitting', tone: 'accent', icon: 'loader' },
  REFUSED: { label: 'Refused', tone: 'negative', icon: 'ban' },
  QUEUED: { label: 'Queued', tone: 'quiet', icon: 'hourglass' },
  RUNNING: { label: 'Sending', tone: 'accent', icon: 'loader' },
  AWAITING_OBSERVATION: { label: 'Sent, waiting for Steam to show it', tone: 'accent', icon: 'eye' },
  // A complete walk showed the listing in `listings_to_confirm`: Steam has it, and waits on the
  // phone tap this app never makes. Still not confirmed, and the person is who it waits for.
  AWAITING_CONFIRMATION: { label: 'On Steam, waiting for your phone confirmation', tone: 'accent', icon: 'smartphone' },
  // A transfer batch retrieving a crated item before its offer goes: the hop is a casket move,
  // proved by a later complete walk, and the send waits on it.
  RETRIEVING: { label: 'Retrieving from storage', tone: 'accent', icon: 'archive' },
  // A CSFloat listing CSFloat refused because its copy of the inventory does not hold the item
  // yet: it is sent again on a schedule until CSFloat shows it, or gives up after an hour (CSF-58).
  // `inventoryWaitPhrase` says when.
  AWAITING_VENUE: { label: 'Waiting for CSFloat to show the item in its inventory', tone: 'accent', icon: 'eye' },
  // An offer this app sent, by what Steam shows of it: live and waiting on the other account,
  // accepted and held by Steam, accepted and waiting for both inventories to prove the move.
  ACTIVE: { label: 'On Steam, waiting for the other account', tone: 'accent', icon: 'send' },
  ESCROW: { label: 'Accepted, held by Steam', tone: 'accent', icon: 'lock' },
  AWAITING_DELIVERY: { label: 'Accepted, waiting for both inventories', tone: 'accent', icon: 'eye' },
  // A CSFloat sale's offer, by what Steam shows of it: with the buyer, or accepted and waiting on
  // CSFloat's own verification.
  AWAITING_BUYER: { label: 'On Steam, waiting for the buyer', tone: 'accent', icon: 'send' },
  AWAITING_VERIFICATION: { label: 'Accepted, waiting for CSFloat to verify', tone: 'accent', icon: 'eye' },
  COMPLETE: { label: 'Completed', tone: 'positive', icon: 'check-circle' },
  DONE: { label: 'Completed', tone: 'positive', icon: 'check-circle' },
  REJECTED: { label: 'Refused', tone: 'negative', icon: 'ban' },
  FAILED: { label: 'Failed', tone: 'negative', icon: 'x-circle' },
  BLOCKED: { label: 'Blocked', tone: 'negative', icon: 'ban' },
  STOPPED: { label: 'Stopped', tone: 'quiet', icon: 'pause' },
  SOLD: { label: 'Sold meanwhile', tone: 'warn', icon: 'coins' },
  // A complete walk after the send still showed the old state, so the engine will send again on
  // its schedule (`kernel/retry-policy.ts`). The badge says so; `retryPhrase` says when, and which try.
  RETRYING: { label: 'Trying again', tone: 'warn', icon: 'refresh' }
};

/**
 * What a `RETRYING` member is doing, with the countdown: "Steam still shows it · trying again in
 * 0:27 · attempt 2 of 4", then "sending again" once the moment has passed and the resend is the
 * engine's next turn. When the marketplace refused the send for its pace (`retryCause: 'rate-limit'`,
 * a 429) it says so instead: "CSFloat asked to slow down · trying again in 0:27". The marketplace is
 * the row's, as `workStateLabel` names it. Written here rather than in the panel so the indicator's
 * sentence and the panel's caption cannot drift.
 */
export function retryPhrase(
  row: { retryAt: string | null; attempt: number | null; attemptLimit: number | null; retryCause?: string | null | undefined },
  venue: 'steam' | 'csfloat' | undefined,
  now = Date.now()
): string {
  // Not a retry: nothing was refused or proved absent. The change has not been sent, and waits on Steam's own clock.
  if (row.retryCause === COOLDOWN_CAUSE) return cooldownPhrase(row, now);
  const leftMs = row.retryAt ? Date.parse(row.retryAt) - now : 0;
  const when = leftMs > 0 ? `trying again in ${formatCountdown(leftMs)}` : 'sending again';
  const count = row.attempt !== null && row.attemptLimit !== null ? ` · attempt ${row.attempt} of ${row.attemptLimit}` : '';
  const why = row.retryCause === 'rate-limit' ? 'asked to slow down' : 'still shows it';
  return `${VENUE_NAME[venue ?? 'steam']} ${why} · ${when}${count}`;
}

/**
 * What a price change held for the cooldown (`isHeldForCooldown`) is doing, with the countdown:
 * "Steam's 5-minute price-change cooldown · 3:41", then "sending now" once the moment has passed
 * and the send is the engine's next turn.
 */
export function cooldownPhrase(row: { retryAt: string | null }, now = Date.now()): string {
  const leftMs = row.retryAt ? Date.parse(row.retryAt) - now : 0;
  return `Steam's 5-minute price-change cooldown · ${leftMs > 0 ? formatCountdown(leftMs) : 'sending now'}`;
}

/**
 * When a lower Steam price waiting for its confirmation is dropped, as the engine gives it (the
 * work read's `waitDeadline`, the waiting read's `expiresAt`): "dropped at 14:05 if not
 * confirmed". The listing keeps the price it has after that. `null` when there is no deadline to
 * say, or it is not an instant.
 */
export function priceChangeDeadlinePhrase(deadline: string | null | undefined): string | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  return Number.isFinite(at) ? `dropped at ${formatClock(at)} if not confirmed` : null;
}

/**
 * What an `AWAITING_VENUE` member is doing: a CSFloat listing waiting for CSFloat's copy of the
 * inventory to show its item (CSF-58). "Trying again in 0:47 · gives up at 14:32", then "trying
 * again now" once the moment has passed and the send is the engine's next turn; and, while the
 * account's reads of that copy are paused for the day, that the listing is still being sent.
 */
export function inventoryWaitPhrase(
  row: { retryAt: string | null; waitDeadline?: string | null | undefined; readsPausedUntil?: string | null | undefined },
  now = Date.now()
): string {
  const leftMs = row.retryAt ? Date.parse(row.retryAt) - now : 0;
  const parts = [leftMs > 0 ? `Trying again in ${formatCountdown(leftMs)}` : 'Trying again now'];
  if (row.waitDeadline) parts.push(`gives up at ${formatClock(row.waitDeadline)}`);
  if (row.readsPausedUntil) parts.push(`CSFloat inventory reads paused until ${formatClock(row.readsPausedUntil)} (daily limit); still trying`);
  return parts.join(' · ');
}

/** How a command's members stand, counted in items, and the one reason its failures share when they share one. */
export type CommandTally = { total: number; confirmed: number; open: number; failed: number; stopped: number; sold: number; sharedReason: string | null };

const CONFIRMED_STATES: ReadonlySet<string> = new Set(['COMPLETE', 'DONE']);
const FAILED_STATES: ReadonlySet<string> = new Set(['FAILED', 'REJECTED', 'REFUSED', 'BLOCKED']);

export function tallyCommand(members: ReadonlyArray<{ memberState: string; quantity: number; reason: string | null }>): CommandTally {
  const tally: CommandTally = { total: 0, confirmed: 0, open: 0, failed: 0, stopped: 0, sold: 0, sharedReason: null };
  const reasons = new Set<string>();
  for (const member of members) {
    tally.total += member.quantity;
    if (CONFIRMED_STATES.has(member.memberState)) tally.confirmed += member.quantity;
    else if (FAILED_STATES.has(member.memberState)) { tally.failed += member.quantity; reasons.add(member.reason ?? ''); }
    else if (member.memberState === 'STOPPED') tally.stopped += member.quantity;
    else if (member.memberState === 'SOLD') tally.sold += member.quantity;
    else tally.open += member.quantity;
  }
  const [only] = [...reasons];
  tally.sharedReason = reasons.size === 1 && only ? only : null;
  return tally;
}

/**
 * A command's headline. While nothing is confirmed it says what is happening, "Storing 968 items";
 * once an observation has confirmed some of it, how much, "Stored 567 of 968 items"; and when all
 * of it is, "Stored 968 items". A command whose work has all settled never reads as still going:
 * "Storing 968 items" over a batch that has stopped for good would say it is still going.
 */
export function commandHeadline(kind: Destination, tally: CommandTally): string {
  const noun = kind.noun ?? 'item';
  const done = kind.done ?? kind.verb;
  if (tally.total > 0 && tally.confirmed === tally.total) return `${done} ${plural(tally.total, noun)}`;
  if (tally.confirmed === 0 && tally.open > 0) return `${kind.verb} ${plural(tally.total, noun)}`;
  return `${done} ${tally.confirmed.toLocaleString()} of ${plural(tally.total, noun)}`;
}

/** The counts beside the headline, the ones that are not zero: "3 in progress · 401 failed". */
export function commandCounts(tally: CommandTally): string[] {
  const parts: string[] = [];
  if (tally.open > 0 && tally.confirmed > 0) parts.push(`${tally.open.toLocaleString()} in progress`);
  if (tally.failed > 0) parts.push(`${tally.failed.toLocaleString()} failed`);
  if (tally.stopped > 0) parts.push(`${tally.stopped.toLocaleString()} stopped`);
  if (tally.sold > 0) parts.push(`${tally.sold.toLocaleString()} sold meanwhile`);
  return parts;
}

/** m:ss, rounded up, so a countdown never reads 0:00 while there is still a wait. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Where a piece of work is taking an item.
 *
 * The verb never names the marketplace. Work that happens on one carries its `venue`, and whoever
 * prints the verb prints the venue beside it (`venuePhrase`), so "Listing" and "Delisting" read
 * the same whichever marketplace they are on and a third one needs no new words. `joiner` is the
 * word between them when it is not *on*: an item is listed on a marketplace and delisted *from* it.
 * `noun` is what the work is counted in when it is not items: "Cancelling 1 buy order on Steam".
 * `done` is the verb once an observation has confirmed some of it: "Stored 567 of 968 items".
 */
export type Destination = { icon: IconName; verb: string; done?: string; venue?: 'steam' | 'csfloat'; joiner?: string; noun?: string };

/** By command kind: the glyph the indicator travels toward. */
export const DESTINATION: Readonly<Record<string, Destination>> = {
  STORE: { icon: 'archive', verb: 'Storing', done: 'Stored' },
  RETRIEVE: { icon: 'download', verb: 'Retrieving', done: 'Retrieved' },
  TRANSFER: { icon: 'send', verb: 'Transferring', done: 'Transferred' },
  // A send to another owned account: its members are read from the send hop of each source.
  ACCOUNT_TRANSFER: { icon: 'send', verb: 'Transferring', done: 'Transferred' },
  LIST: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'steam' },
  REPRICE: { icon: 'pencil', verb: 'Repricing', done: 'Repriced', venue: 'steam' },
  // A new price by the older route: the listing is removed and the item listed again. The desktop
  // never asks for it; this row is for a window over an engine host that does.
  RELIST: { icon: 'refresh', verb: 'Relisting', done: 'Relisted', venue: 'steam' },
  // A delist asked for by hand. The engine has no such command: the work read names it.
  DELIST: { icon: 'trash', verb: 'Delisting', done: 'Delisted', venue: 'steam', joiner: 'from' },
  DELIST_TO_STORE: { icon: 'undo', verb: 'Delisting', done: 'Delisted', venue: 'steam', joiner: 'from' },
  CSFLOAT_LIST: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'csfloat' },
  // The engine's own name for the same work: `work.open` reports a CSFloat operation as
  // `CSFLOAT_<kind>`, and a create is what the outbox called `CSFLOAT_LIST`. Without this row the
  // listing read "Working on" and named no marketplace from the moment the engine admitted it.
  CSFLOAT_CREATE: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'csfloat' },
  CSFLOAT_REPRICE: { icon: 'pencil', verb: 'Repricing', done: 'Repriced', venue: 'csfloat' },
  CSFLOAT_CANCEL: { icon: 'trash', verb: 'Delisting', done: 'Delisted', venue: 'csfloat', joiner: 'from' },
  CSFLOAT_DELIVER: { icon: 'send', verb: 'Delivering', done: 'Delivered', venue: 'csfloat', joiner: 'sold on' },
  // The engine's own confirmation of a listing or an offer its work made. Only a host that composed a
  // confirmation port does this; the desktop never does, and this row is for a window over such a host.
  CONFIRM: { icon: 'smartphone', verb: 'Confirming', done: 'Confirmed', venue: 'steam', noun: 'confirmation' },
  // An in-game store purchase: its hops name the entries bought, not an item this app holds.
  STORE_PURCHASE: { icon: 'shopping-cart', verb: 'Buying', done: 'Bought', venue: 'steam', joiner: 'from the store on', noun: 'store purchase' },
  // Work about a buy order, which names no item. The engine calls a Steam one by its action's
  // kind and a CSFloat one `CSFLOAT_<operation kind>`, as for a listing.
  BUY_ORDER_CREATE: { icon: 'shopping-cart', verb: 'Placing', done: 'Placed', venue: 'steam', noun: 'buy order' },
  BUY_ORDER_CANCEL: { icon: 'trash', verb: 'Cancelling', done: 'Cancelled', venue: 'steam', noun: 'buy order' },
  CSFLOAT_BUY_ORDER_CREATE: { icon: 'shopping-cart', verb: 'Placing', done: 'Placed', venue: 'csfloat', noun: 'buy order' },
  CSFLOAT_BUY_ORDER_EDIT: { icon: 'pencil', verb: 'Changing', done: 'Changed', venue: 'csfloat', noun: 'buy order' },
  CSFLOAT_BUY_ORDER_CANCEL: { icon: 'trash', verb: 'Cancelling', done: 'Cancelled', venue: 'csfloat', noun: 'buy order' },
  // A row of the listing workspace handed to a listing strategy a build offers, or let go by one
  // (`LISTING_STRATEGY_KIND`). The engine has no such command: only the window's outbox names it.
  LISTING_STRATEGY: { icon: 'route', verb: 'Handing over', done: 'Handed over' }
};

/** The hop an item is on now, so a chained command reads as two steps rather than one jump. */
export const ACTION_DESTINATION: Readonly<Record<string, Destination>> = {
  STORE_IN_CASKET: { icon: 'archive', verb: 'Storing', done: 'Stored' },
  RETRIEVE_FROM_CASKET: { icon: 'download', verb: 'Retrieving', done: 'Retrieved' },
  CREATE_SELL_LISTING: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'steam' },
  REMOVE_SELL_LISTING: { icon: 'undo', verb: 'Delisting', done: 'Delisted', venue: 'steam', joiner: 'from' },
  // A Steam reprice's one hop: the price is changed on the listing that is there.
  UPDATE_SELL_LISTING_PRICE: { icon: 'pencil', verb: 'Repricing', done: 'Repriced', venue: 'steam' },
  // A lower price that was waiting for its confirmation being withdrawn: the listing keeps the price it has.
  DISCARD_SELL_LISTING_PRICE_CHANGE: { icon: 'undo', verb: 'Cancelling the price change', done: 'Cancelled the price change', venue: 'steam' },
  SEND_TRADE_OFFER: { icon: 'send', verb: 'Sending', done: 'Sent' },
  ACCEPT_TRADE_OFFER: { icon: 'check', verb: 'Accepting', done: 'Accepted' },
  // The hops of a transfer between owned accounts, by the kind of the action that carries each.
  'trade.send': { icon: 'send', verb: 'Sending', done: 'Sent' },
  'trade.accept': { icon: 'check', verb: 'Accepting', done: 'Accepted' },
  'trade.cancel': { icon: 'undo', verb: 'Cancelling', done: 'Cancelled' },
  // A CSFloat operation's action. The second hop of a listing from a unit, and the only one of any
  // other CSFloat work.
  CSFLOAT_CREATE: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'csfloat' },
  CSFLOAT_REPRICE: { icon: 'pencil', verb: 'Repricing', done: 'Repriced', venue: 'csfloat' },
  CSFLOAT_CANCEL: { icon: 'trash', verb: 'Delisting', done: 'Delisted', venue: 'csfloat', joiner: 'from' }
};

/** What a marketplace is called in a sentence. */
export const VENUE_NAME: Readonly<Record<'steam' | 'csfloat', string>> = { steam: 'Steam', csfloat: 'CSFloat' };

/** "on Steam", "from CSFloat" — or nothing, for work that is not on a marketplace. */
export function venuePhrase(destination: Destination): string {
  return destination.venue ? `${destination.joiner ?? 'on'} ${VENUE_NAME[destination.venue]}` : '';
}

/**
 * Where a piece of work is going *right now*.
 *
 * The command kind says where it will end up; the action says which hop it is on. A crated item
 * being listed is a retrieve first and a listing second, and showing the Steam mark while it is
 * still being taken out of the unit would claim the later hop had started. The current hop wins
 * whenever there is one.
 */
export function destinationOf(commandKind: string, actionKind?: string | null): Destination {
  const hop = actionKind ? ACTION_DESTINATION[actionKind] : undefined;
  return hop ?? DESTINATION[commandKind] ?? { icon: 'package', verb: 'Working on' };
}

/** One step of a chain: the action kind it is, and how `ACTION_DESTINATION` says it. */
export type Hop = Destination & { kind: string };

/** The two hops of a price change by the older route: the listing is removed, then the item listed again. */
const RELIST_CHAIN: readonly string[] = ['REMOVE_SELL_LISTING', 'CREATE_SELL_LISTING'];

/**
 * The hops a member passes through.
 *
 * Derived from the command kind rather than read from the plan, because the plan is the engine's
 * and this is a caption. A LIST member carrying a retrieve action is the chained case: it is being
 * taken out of a unit first, and the glyph must not show the Steam mark until that is observed.
 *
 * A Steam reprice is one hop, the price changed on the listing that is there, so its row reads as
 * one step. The older route, `RELIST`, is two. An engine from before the price edit ran that same
 * chain under the name `REPRICE`: its member is carried by one of the chain's two actions, and is
 * shown as the chain it is.
 *
 * Fewer than two hops is no chain to draw: the row says its one step on a single line.
 */
export function chainFor(member: { commandKind: string; actionKind: string | null }): Hop[] {
  const hops = (...kinds: string[]): Hop[] => kinds.map((kind) => ({ kind, ...ACTION_DESTINATION[kind]! }));
  if (member.commandKind === 'LIST' && member.actionKind === 'RETRIEVE_FROM_CASKET') return hops('RETRIEVE_FROM_CASKET', 'CREATE_SELL_LISTING');
  // The engine's name for a CSFloat list; `CSFLOAT_LIST` is only the outbox's word for it.
  if (member.commandKind === 'CSFLOAT_CREATE' && member.actionKind === 'RETRIEVE_FROM_CASKET') return hops('RETRIEVE_FROM_CASKET', 'CSFLOAT_CREATE');
  if (member.commandKind === 'DELIST_TO_STORE') return hops('REMOVE_SELL_LISTING', 'STORE_IN_CASKET');
  if (member.commandKind === 'RELIST') return hops(...RELIST_CHAIN);
  if (member.commandKind === 'REPRICE') {
    const older = member.actionKind !== null && RELIST_CHAIN.includes(member.actionKind);
    return older ? hops(...RELIST_CHAIN) : hops('UPDATE_SELL_LISTING_PRICE');
  }
  return [];
}

/**
 * The hop a member is on.
 *
 * The engine reports the newest action carrying the member. When that action is `DONE` and the
 * chain has another hop, the member is waiting for the next one to be sent — a crated item whose
 * retrieve was observed is queued for listing, not still retrieving — so the highlight moves on.
 */
export function currentHop(member: { actionKind: string | null; actionState: string | null }, hops: readonly Hop[]): string | null {
  if (member.actionState !== 'DONE') return member.actionKind;
  const index = hops.findIndex((hop) => hop.kind === member.actionKind);
  return index >= 0 ? hops[index + 1]?.kind ?? member.actionKind : member.actionKind;
}

/**
 * Why a Steam price change failed, by the engine's code for it. Each says what became of the
 * listing, because that is what a person needs to know before doing anything else: its price
 * was not changed.
 */
const PRICE_CHANGE_FAILURE: ReadonlyMap<string, string> = new Map([
  ['price-edit-unavailable', "Steam would not change this listing's price. Remove the listing and list the item again."],
  ['not-confirmed', 'The lower price was not confirmed in time. Nothing changed.'],
  ['unanswered', 'Steam did not answer. Nothing changed; try again.'],
  ['withdrawal-unheard', 'Steam did not answer the cancel. The lower price may still be waiting for your confirmation in the Steam app: decline it there.']
]);

/** The action kinds that carry a Steam price change: the change itself, and a waiting lower price being withdrawn. */
const PRICE_CHANGE_ACTIONS: ReadonlySet<string> = new Set(['UPDATE_SELL_LISTING_PRICE', 'DISCARD_SELL_LISTING_PRICE_CHANGE']);

/**
 * Why a piece of work failed or was refused, for a person.
 *
 * The engine's reason is shown as it wrote it, with one exception: a Steam price change fails with
 * a short code, and a code is not a reason anybody can act on, so those are put in plain words.
 * The codes are read only on a price change. On any other work the same word would mean something
 * else, and is left as the engine wrote it.
 */
export function failureReason(reason: string, work: { commandKind: string; actionKind?: string | null | undefined }): string {
  const priceChange = work.commandKind === 'REPRICE' || (work.actionKind != null && PRICE_CHANGE_ACTIONS.has(work.actionKind));
  // A map, not an object: a reason is free text, and an object would answer `toString` with a function.
  return (priceChange ? PRICE_CHANGE_FAILURE.get(reason) : undefined) ?? reason;
}

/**
 * What a command's Stop button does, in its own words, or `null` when it would do nothing.
 *
 * `command.stop` halts every hop of the command not yet sent, a price change held for its
 * listing's cooldown included (`isUnsent`), and withdraws every lower Steam price of the command
 * still waiting for its confirmation (`isWaitingPriceChange`): the engine sends Steam a discard
 * and the listing keeps the price it has. Everything else that was sent is left to finish. One
 * press reaches the whole command, and the listing workspace sends its Steam rows as one command,
 * so the words count the lower prices it cancels. Whether the command is one Stop can reach at all
 * (a CSFloat operation, a hand delist and a send still in the outbox are not) is the panel's.
 */
export function stopOffer(members: ReadonlyArray<{ memberState: string; retryCause?: string | null | undefined; actionKind?: string | null | undefined }>): { label: string; title: string } | null {
  const unsent = members.some(isUnsent);
  const withdraws = members.filter(isWaitingPriceChange).length;
  if (!unsent && withdraws === 0) return null;
  const rest = 'Anything else already sent is left to finish.';
  if (withdraws === 0) return { label: 'Remove all queued', title: `Remove everything here that has not been sent yet. ${rest}` };
  const prices = withdraws === 1 ? 'the lower price' : `${withdraws} lower prices`;
  const waiting = `${withdraws === 1 ? 'the lower price' : `the ${withdraws} lower prices`} waiting for you to confirm`;
  const stays = withdraws === 1 ? 'Its listing stays at the price it has.' : 'Their listings stay at the prices they have.';
  return unsent
    ? { label: `Remove queued and cancel ${prices}`, title: `Remove everything here that has not been sent yet, and withdraw ${waiting}. ${stays} ${rest}` }
    : { label: `Cancel ${prices}`, title: `Withdraw ${waiting}. ${stays} ${rest}` };
}

/**
 * The price on a work row, saying which figure it is and in its currency: "you receive A$ 9.00
 * AUD", "buyer pays $42.00 USD", "up to $3.00 USD". `null` when the row has no price, or when the
 * currency the figure is in is not known: a figure printed in a currency it was not sent in, or
 * with none, states a price nobody asked for.
 *
 * Which figure is the row's kind. A Steam command's member carries what the seller receives (rule
 * 4); a CSFloat listing or reprice carries what the buyer pays, and a buy order its limit. A send
 * still in the window's outbox carries what the seller receives and the currency it was priced
 * in, because it may have no marketplace of its own (a row handed to a listing strategy). Any
 * other row's currency is its marketplace's: US dollars on CSFloat, the account's wallet on Steam
 * (`wallet`, `null` until a read has named it); a row on no marketplace prints no figure.
 */
export function workFigure(
  row: { commandKind: string; priceReceiveCents: number | null; outbox?: true | undefined; currency?: CurrencyRef },
  venue: 'steam' | 'csfloat' | undefined,
  wallet: number | null | undefined
): string | null {
  if (row.priceReceiveCents === null) return null;
  const currency: CurrencyRef = row.outbox ? row.currency : venue === 'csfloat' ? CSFLOAT_CURRENCY : venue === 'steam' ? wallet : null;
  if (currencyOf(currency) === undefined) return null;
  const amount = formatAmount(row.priceReceiveCents, currency);
  if (row.outbox) return `you receive ${amount}`;
  if (row.commandKind.includes('BUY_ORDER')) return `up to ${amount}`;
  return row.commandKind.startsWith('CSFLOAT_') ? `buyer pays ${amount}` : `you receive ${amount}`;
}

/**
 * A lock in words: "Market-locked until 29 Nov 2026, 19:00", in the time zone chosen in Settings.
 *
 * Never a bare ISO string: the date is what a person needs, formatted the way they read dates.
 * What the lock permits is not repeated here; the buttons it disables say so in their own reason.
 * A caption is only ever produced for a lock that is still in the future — `lockOf` returns
 * nothing once the date has passed — so this never has to hedge about whether a lock is live.
 */
export function lockLabel(kind: 'market' | 'trade', until: string): string {
  const when = formatDateTime(until);
  return kind === 'market' ? `Market-locked until ${when}` : `Trade-protected until ${when}`;
}

// ---------------------------------------------------------------------------- filter chips

/**
 * A chip in words, with its resolved meaning rather than the token that produced it.
 *
 * `nf<0.01` reads as "Top 1 % of its range" because that is the question that was asked; showing
 * `nf<0.01` back would make the user parse their own shorthand to check it was understood.
 */
export function chipLabel(chip: {
  kind: string; text: string; minWear?: number | undefined; maxWear?: number | undefined;
  op?: string | undefined; value?: number | undefined; quality?: string | undefined;
  location?: string | undefined; listed?: boolean | undefined; lock?: string | undefined;
  accessory?: string | undefined;
}): string {
  const number = (value: number): string => String(Number(value.toFixed(4)));
  switch (chip.kind) {
    case 'wear': {
      const tier = WEAR_LABEL[chip.text] ?? chip.text.toUpperCase();
      return chip.minWear !== undefined && chip.maxWear !== undefined
        ? `${tier} ${number(chip.minWear)}–${number(chip.maxWear)}`
        : tier;
    }
    case 'float': {
      if (chip.op === undefined && chip.minWear !== undefined && chip.maxWear !== undefined) {
        return `Float ${number(chip.minWear)}–${number(chip.maxWear)}`;
      }
      if (chip.value === undefined) return 'Float';
      if (chip.op === '>' || chip.op === '>=') return `Float above ${number(chip.value)}`;
      if (chip.op === '<' || chip.op === '<=') return `Float below ${number(chip.value)}`;
      return `Float about ${number(chip.value)}`;
    }
    case 'norm': {
      if (chip.value === undefined) return 'Norm float';
      const percent = Math.round(chip.value * 1000) / 10;
      // The extremes are what people actually ask for, and "top 1 %" is how they say it.
      if (chip.op === '<' || chip.op === '<=') return `Top ${trimPercent(percent)} % of its range`;
      if (chip.op === '>' || chip.op === '>=') return `Bottom ${trimPercent(100 - percent)} % of its range`;
      return `About ${trimPercent(percent)} % into its range`;
    }
    case 'seed': return `Pattern ${chip.text}`;
    case 'category': return chip.quality === 'stattrak' ? 'StatTrak™' : chip.quality === 'souvenir' ? 'Souvenir' : 'Normal';
    case 'rarity': return chip.text;
    case 'collection': return `Collection: ${chip.text}`;
    case 'unit': return `Storage unit: ${chip.text}`;
    case 'account': return `Account: ${chip.text}`;
    case 'where': return chip.listed ? LISTED.label : chip.location ? LOCATION[chip.location]?.label ?? chip.text : chip.text;
    case 'tradable': return 'Tradable';
    case 'lock': return chip.lock === 'market' ? 'Market-locked' : 'Trade-protected';
    // What is applied to the item: anything in a kind of slot, or one sticker, patch or charm by name.
    case 'applied': return chip.accessory === 'sticker' ? 'With stickers' : chip.accessory === 'charm' ? 'With a charm' : `With ${chip.text}`;
    case 'item': return chip.text;
    default: return chip.text;
  }
}

const WEAR_LABEL: Readonly<Record<string, string>> = {
  fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred'
};

function trimPercent(value: number): string {
  return String(Number(value.toFixed(2)));
}

// ---------------------------------------------------------------------------- CSFloat

export const CSFLOAT_STATE: Readonly<Record<string, StateLabel>> = {
  inventory: { label: 'Available', tone: 'neutral', icon: 'package' },
  listed: { label: 'Listed', tone: 'positive', icon: 'tag' },
  sold: { label: 'Sold', tone: 'positive', icon: 'coins' },
  delisted: { label: 'Delisted', tone: 'quiet', icon: 'x-circle' },
  cancelled: { label: 'Cancelled', tone: 'quiet', icon: 'x-circle' },
  queued: { label: 'Queued', tone: 'accent', icon: 'hourglass' },
  pending: { label: 'Awaiting delivery', tone: 'accent', icon: 'send' },
  verified: { label: 'Delivered', tone: 'positive', icon: 'check-circle' },
  failed: { label: 'Failed', tone: 'negative', icon: 'x-circle' },
  // A `failed` sale whose buyer had taken the item: Steam reversed the trade and CSFloat refunded the buyer (`TradeCsfloatLink.ending`).
  reversed: { label: 'Reversed', tone: 'negative', icon: 'undo' },
  QUEUED: { label: 'Queued', tone: 'accent', icon: 'hourglass' },
  RUNNING: { label: 'In progress', tone: 'accent', icon: 'loader' },
  AWAITING_OBSERVATION: { label: 'Awaiting observation', tone: 'accent', icon: 'eye' },
  DONE: { label: 'Done', tone: 'positive', icon: 'check-circle' },
  FAILED: { label: 'Failed', tone: 'negative', icon: 'x-circle' },
  CANCELLED: { label: 'Cancelled', tone: 'quiet', icon: 'x-circle' }
};

// ---------------------------------------------------------------------------- lookups

/**
 * Observation surfaces, in English, for the two the waiting list rests on.
 *
 * A surface name is an engine identifier and identifiers never reach the screen. Naming the walk
 * matters here in a way it does not elsewhere: a caption saying a walk did not finish is only
 * actionable if the reader can tell *which* walk, and `steam-trade-offers` is not a phrase any
 * seller has met. Lowercase because every use is mid-sentence.
 */
export const OBSERVATION_SURFACE: Readonly<Record<string, string>> = {
  'steam-market': 'the Steam market walk',
  'steam-trade-offers': 'the Steam trade-offer walk'
};

export function surfaceLabel(surface: string): string {
  return OBSERVATION_SURFACE[surface] ?? `the ${humanize(surface).toLowerCase()} walk`;
}

export function stateLabel(table: Readonly<Record<string, StateLabel>>, code: string | null | undefined): StateLabel {
  if (!code) return { label: 'Unknown', tone: 'quiet' };
  return table[code] ?? { label: humanize(code), tone: 'neutral' };
}

/**
 * A member's state, naming the marketplace the work is on.
 *
 * `WORK_STATE` is written for Steam, where the wait is for a market walk or a phone. A CSFloat
 * operation passes through the same states — sent, waiting to be shown — and waits on a stall
 * walk instead, so the venue in the sentence is the row's `destinationOf`, not a fixed word. The
 * listing workspace used to say "waiting for CSFloat to show it" on its own row; now that a sent
 * row lives only on the work panel, this is where the venue has to be right.
 *
 * `work` is what else the row says about itself, for the two states whose words depend on it: why
 * it waits (`retryCause`), and the action that carries it (`actionKind`).
 */
export function workStateLabel(
  code: string | null | undefined,
  venue: 'steam' | 'csfloat' | undefined,
  work: { retryCause?: string | null | undefined; actionKind?: string | null | undefined } = {}
): StateLabel {
  // A price change held for Steam's cooldown is reported in the state of work waiting on its
  // venue, whose words are about CSFloat's copy of the inventory. Its cause says what it is.
  if (code !== null && code !== undefined && isHeldForCooldown({ memberState: code, retryCause: work.retryCause })) return COOLDOWN_HELD;
  // A lower price waiting for its confirmation is a listing still on sale at the price it has, not
  // one waiting to go on the market: what is confirmed is the price.
  if (code === 'AWAITING_CONFIRMATION' && work.actionKind === 'UPDATE_SELL_LISTING_PRICE') return PRICE_AWAITING_CONFIRMATION;
  const base = stateLabel(WORK_STATE, code);
  if (!venue || venue === 'steam') return base;
  return { ...base, label: base.label.replace(VENUE_NAME.steam, VENUE_NAME[venue]) };
}

const COOLDOWN_HELD: StateLabel = { label: 'Held until Steam allows a price change', tone: 'accent', icon: 'clock' };
/**
 * A work row does not say how the person confirms (the mobile app, or a link Steam e-mailed), so
 * the words are the ones true of both; the waiting list and the listing say which.
 */
const PRICE_AWAITING_CONFIRMATION: StateLabel = { label: 'On Steam, waiting for you to confirm the new price', tone: 'accent', icon: 'shield-check' };

/**
 * What a row of the waiting list is, by the engine's kind for it. A lower price waiting for its
 * confirmation is a kind of its own: the listing it belongs to is on the market all the while.
 */
export const WAITING_KIND: Readonly<Record<string, string>> = {
  SELL_LISTING: 'Sell listing',
  BUY_ORDER: 'Buy order',
  TRADE_OFFER: 'Trade offer',
  LISTING_PRICE_CHANGE: 'Price change'
};

export function waitingKindLabel(kind: string): string {
  return WAITING_KIND[kind] ?? humanize(kind);
}

// ---------------------------------------------------------------------------- dates and money

// Dates are printed in the time zone chosen in Settings (lib/time.ts); these stay importable from here.
export { formatDate, formatDateTime } from './time.js';

/** "3 minutes ago", "in 2 days", "just now". Past and future both read naturally. */
export function formatRelative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.round((at - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const future = seconds > 0;
  const unit = (value: number, name: string): string => `${value} ${name}${value === 1 ? '' : 's'}`;
  let text: string;
  if (abs < 45) return future ? 'in a moment' : 'just now';
  if (abs < 3600) text = unit(Math.round(abs / 60), 'minute');
  else if (abs < 86_400) text = unit(Math.round(abs / 3600), 'hour');
  else if (abs < 2_592_000) text = unit(Math.round(abs / 86_400), 'day');
  else text = unit(Math.round(abs / 2_592_000), 'month');
  return future ? `in ${text}` : `${text} ago`;
}

/** True when a string parses as an ISO-8601 timestamp; used to render detail rows as dates. */
export function looksLikeDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(new Date(value).getTime());
}

/** Valve's own symbol for a Steam currency id (`@cslytics/market-data`'s table), or nothing for an unknown one. */
export function currencySymbol(currency: number | null | undefined): string {
  return currencyById(currency)?.symbol ?? '';
}

/** A CSFloat figure: USD on every account (`CSFLOAT_CURRENCY`), printed with its code like every other. */
export function formatUsd(cents: number | null | undefined): string {
  return formatAmount(cents, CSFLOAT_CURRENCY);
}

/** Whole dollars and cents as typed in a money field, to integer cents; `null` when it is not a price. */
export function parseMoney(text: string): number | null {
  const trimmed = text.trim().replace(/^[^\d.]+/, '');
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

/** A long identifier shortened for a caption: the first and last few characters. */
export function shortId(id: string | null | undefined, keep = 6): string {
  if (!id) return '';
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
