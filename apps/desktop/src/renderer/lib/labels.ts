import { currencyById } from '@cslytics/market-data';
import type { IconName } from '../components/Icon.js';
import { formatAmount } from './money.js';

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
  'not-in-revision': 'Not in the current catalogue — it may have been released since the last update',
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
  // A listing from a unit whose retrieve was observed: the item is loose, and the listing waits
  // for the marketplace's own copy of the inventory to show it (CSF-32). `workStateLabel` names
  // the marketplace.
  AWAITING_VENUE: { label: 'Retrieved, waiting for Steam to see it', tone: 'accent', icon: 'eye' },
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
 * engine's next turn. The marketplace is the row's, as `workStateLabel` names it. Written here
 * rather than in the panel so the indicator's sentence and the panel's caption cannot drift.
 */
export function retryPhrase(
  row: { retryAt: string | null; attempt: number | null; attemptLimit: number | null },
  venue: 'steam' | 'csfloat' | undefined,
  now = Date.now()
): string {
  const leftMs = row.retryAt ? Date.parse(row.retryAt) - now : 0;
  const when = leftMs > 0 ? `trying again in ${formatCountdown(leftMs)}` : 'sending again';
  const count = row.attempt !== null && row.attemptLimit !== null ? ` · attempt ${row.attempt} of ${row.attemptLimit}` : '';
  return `${VENUE_NAME[venue ?? 'steam']} still shows it · ${when}${count}`;
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
  CSFLOAT_BUY_ORDER_EDIT: { icon: 'pencil', verb: 'Changing', done: 'Changed', venue: 'csfloat', noun: 'buy order' },
  CSFLOAT_BUY_ORDER_CANCEL: { icon: 'trash', verb: 'Cancelling', done: 'Cancelled', venue: 'csfloat', noun: 'buy order' }
};

/** The hop an item is on now, so a chained command reads as two steps rather than one jump. */
export const ACTION_DESTINATION: Readonly<Record<string, Destination>> = {
  STORE_IN_CASKET: { icon: 'archive', verb: 'Storing', done: 'Stored' },
  RETRIEVE_FROM_CASKET: { icon: 'download', verb: 'Retrieving', done: 'Retrieved' },
  CREATE_SELL_LISTING: { icon: 'tag', verb: 'Listing', done: 'Listed', venue: 'steam' },
  REMOVE_SELL_LISTING: { icon: 'undo', verb: 'Delisting', done: 'Delisted', venue: 'steam', joiner: 'from' },
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

/**
 * A lock, in words and with its consequence.
 *
 * Never a bare ISO string: the date is what a person needs, formatted the way they read dates.
 * A caption is only ever produced for a lock that is still in the future — `lockOf` returns
 * nothing once the date has passed — so this never has to hedge about whether a lock is live.
 */
export function lockLabel(kind: 'market' | 'trade', until: string): string {
  const when = formatDateTime(until);
  return kind === 'market'
    ? `Market-locked until ${when} — can be stored, not listed`
    : `Trade-protected until ${when} — cannot be stored or listed`;
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
    case 'tradable': return 'Tradable only';
    case 'lock': return chip.lock === 'market' ? 'Market-locked' : 'Trade-protected';
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
 */
export function workStateLabel(code: string | null | undefined, venue: 'steam' | 'csfloat' | undefined): StateLabel {
  const base = stateLabel(WORK_STATE, code);
  if (!venue || venue === 'steam') return base;
  return { ...base, label: base.label.replace(VENUE_NAME.steam, VENUE_NAME[venue]) };
}

// ---------------------------------------------------------------------------- dates and money

const DATE_TIME = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_ONLY.format(date);
}

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

/**
 * Steam `ECurrencyCode` → its ISO code.
 *
 * A symbol is not enough once two venues are on one screen: `$` is US dollars on a CSFloat row
 * and Australian dollars on a Steam row for an AUD wallet, and a page that shows both without
 * saying which is exactly the screen that makes someone act on the wrong number.
 *
 * The same 37 labels the engine captured from a live price sheet (`STORE_CURRENCY_LABEL` in
 * `surfaces/in-game-store.ts`). Copied rather than imported because the renderer takes only *types* from
 * `@cslytics/engine` — importing a value would pull the engine into the window bundle — and
 * `tests/unit/currency-labels.test.ts` fails the build if the two ever disagree.
 */
export const CURRENCY_CODE: Readonly<Record<number, string>> = {
  1: 'USD', 2: 'GBP', 3: 'EUR', 4: 'CHF', 5: 'RUB', 6: 'PLN', 7: 'BRL', 8: 'JPY', 9: 'NOK', 10: 'IDR',
  11: 'MYR', 12: 'PHP', 13: 'SGD', 14: 'THB', 15: 'VND', 16: 'KRW', 17: 'TRY', 18: 'UAH', 19: 'MXN', 20: 'CAD',
  21: 'AUD', 22: 'NZD', 23: 'CNY', 24: 'INR', 25: 'CLP', 26: 'PEN', 27: 'COP', 28: 'ZAR', 29: 'HKD', 30: 'TWD',
  31: 'SAR', 32: 'AED', 35: 'ILS', 37: 'KZT', 38: 'KWD', 39: 'QAR', 40: 'CRC', 41: 'UYU'
};

/**
 * The ISO code for a currency, or the honest absence of one.
 *
 * `null` is a currency nothing has observed — an account whose wallet has never been read — and
 * it must not fall back to a default, because "A$" on an unobserved wallet is a claim.
 */
export function currencyCode(currency: number | null | undefined): string {
  return currency === null || currency === undefined ? '' : CURRENCY_CODE[currency] ?? `code ${currency}`;
}

/** A CSFloat figure: USD on every account, printed with its code like every other. */
export function formatUsd(cents: number | null | undefined): string {
  return formatAmount(cents, 'USD');
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
