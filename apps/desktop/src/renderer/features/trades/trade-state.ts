import type { CsfloatCheck, TradeCsfloatLink, TradeEntry, TradeFlow, TradeItemGroup, TradeItemRow, TradeListRow, TradeOriginClass, TradeOriginKind, TradePreview, TradeStage } from '@cslytics/engine';
import type { IconName } from '../../components/Icon.js';
import { TRADE_STATUS, formatDateTime, formatUsd, plural, stateLabel, type StateLabel, type Tone } from '../../lib/labels.js';
export { steamProfileUrl as profileUrl } from '@cslytics/catalogue';

/**
 * What the trades page says about a trade, in words.
 *
 * Every sentence here is a reading of an observed code, and the rule that governs them is rule 1:
 * Steam accepting an offer is not the items moving, and a trade that moved is not final while Steam
 * can still reverse it. A trade-protected trade is listed by Steam at once with its settlement date
 * seven days on; until that date it is in its *reversal period*, and only after it is it *finalized*.
 * A state the app does not recognise is said to be unrecognised, with its code, never guessed at.
 *
 * Nothing here decides anything. The engine has already decided the stage and the origin; these
 * functions only word them.
 */

/** The catalogue's additions to an engine row (`main/catalogue/mediator.ts`). */
export type Named = {
  name: string;
  imageUrl: string | null;
  rarity: { name: string; colour: string } | null;
  collection: { id: string; name: string } | null;
  unresolved: string | null;
  marketHashName: string | null;
  minFloat: number | null;
  maxFloat: number | null;
};
export type NamedPreview = TradePreview & Named;
export type NamedTradeRow = Omit<TradeListRow, 'second'> & Named & { second: NamedPreview | null };
export type NamedTradeItem = TradeItemRow & Named;
export type NamedTradeGroup = TradeItemGroup & Named;
export type NamedCsfloatLink = TradeCsfloatLink & Named;
export type NamedTradeEntry = Omit<TradeEntry, 'groups' | 'csfloat'> & Named & { groups: NamedTradeGroup[]; csfloat: NamedCsfloatLink[] };

export type TradeItemView = 'grouped' | 'tiles';

/** Above this many items a trade opens grouped: past it, a wall of tiles stops being readable. */
export const GROUPED_THRESHOLD = 15;

/** Grouped for more than fifteen items, counted in units — a line of twelve cases is twelve. */
export function defaultItemView(totalQuantity: number): TradeItemView {
  return totalQuantity > GROUPED_THRESHOLD ? 'grouped' : 'tiles';
}

/**
 * The pictures a list row shows: its first item, a second beside it when the trade holds more than one
 * — the engine's choice, or for a stack of one kind the same picture again — and whether more lie
 * behind those two.
 */
export function rowPreviews(row: Pick<NamedTradeRow, 'name' | 'imageUrl' | 'identitySource' | 'second' | 'giveQuantity' | 'receiveQuantity'>):
  { pictures: Array<{ name: string; imageUrl: string | null }>; more: boolean } {
  const quantity = row.giveQuantity + row.receiveQuantity;
  const first = { name: row.identitySource === null ? 'No items' : row.name, imageUrl: row.imageUrl };
  const second = row.second ? { name: row.second.name, imageUrl: row.second.imageUrl } : quantity > 1 ? first : null;
  return { pictures: second ? [first, second] : [first], more: quantity > 2 };
}

/** `trade-protected` is Steam's own shield-and-arrows badge, drawn from a picture rather than a stroke. */
export type StageIconName = IconName | 'trade-protected';

export type StageLabel = { label: string; tone: Tone; icon: StageIconName; hint: string };

export const TRADE_STAGE: Readonly<Record<TradeStage, StageLabel>> = {
  'to-be-confirmed': { label: 'To be confirmed', tone: 'accent', icon: 'hourglass', hint: 'Nothing has moved yet, or nothing Steam has said proves it did' },
  'reversal-period': { label: 'Reversal period', tone: 'warn', icon: 'trade-protected', hint: 'The trade happened, and Steam can still reverse it until its settlement date' },
  finalized: { label: 'Finalized', tone: 'positive', icon: 'check-circle', hint: 'Complete, and past the reversal period: Steam can no longer reverse it' },
  reversed: { label: 'Reversed', tone: 'negative', icon: 'undo', hint: 'Steam rolled the trade back' },
  ended: { label: 'Didn\'t go through', tone: 'quiet', icon: 'x-circle', hint: 'Declined, cancelled, expired, failed or no longer listed' }
};

/**
 * Which way a trade's items went, as the row's arrow and the Sent and Received filter say it. Read
 * from the items rather than from who proposed the offer, so a trade Steam's history shows without
 * one has a direction too. A trade with no recorded items has none.
 */
export const TRADE_FLOW: Readonly<Record<TradeFlow, { label: string; icon: IconName; hint: string } | null>> = {
  out: { label: 'Sent', icon: 'arrow-up-right', hint: 'Items go out of this account' },
  in: { label: 'Received', icon: 'arrow-down-left', hint: 'Items come into this account' },
  both: { label: 'Swap', icon: 'arrow-left-right', hint: 'Items go both ways' },
  none: null
};

export const TRADE_ORIGIN_CLASS: Readonly<Record<TradeOriginClass, { label: string; icon: IconName | 'csfloat' }>> = {
  marketplace: { label: 'Marketplace', icon: 'csfloat' },
  transfers: { label: 'Transfers', icon: 'arrow-left-right' },
  other: { label: 'Other', icon: 'globe' }
};

/** The stages and the kinds in the order the filters offer them. */
export const STAGE_ORDER = Object.keys(TRADE_STAGE) as TradeStage[];
export const KIND_ORDER = Object.keys(TRADE_ORIGIN_CLASS) as TradeOriginClass[];

/**
 * The short state a trade's row and badge carry: the stage, except where the stage is a family and
 * Steam's own word is more useful — which confirmation an open offer waits on, why one ended.
 */
export function stageBadge(row: Pick<TradeListRow, 'stage' | 'offerStatus' | 'tradeStatus' | 'listed'>): StageLabel {
  const stage = TRADE_STAGE[row.stage];
  if (row.stage === 'to-be-confirmed' || row.stage === 'ended') {
    if (row.stage === 'ended' && row.listed === 0 && !row.tradeStatus) return { ...stage, label: 'No longer listed' };
    const code = row.tradeStatus && row.tradeStatus !== 'COMPLETE' ? row.tradeStatus : row.offerStatus;
    const specific: StateLabel = stateLabel(TRADE_STATUS, code);
    if (code) return { ...stage, label: specific.label, icon: specific.icon ?? stage.icon };
  }
  return stage;
}

export type TradeStateText = { headline: string; detail: string | null; tone: Tone; icon: StageIconName };

/** The fields `describeTradeState` reads. A list row has most; an entry has them all. */
export type TradeStateInput = Pick<TradeListRow, 'stage' | 'direction' | 'offerStatus' | 'tradeStatus' | 'listed' | 'origin' | 'sortAt' | 'settlesAt' | 'acceptedAt'> & {
  expiresAt?: string | null | undefined;
  escrowUntil?: string | null | undefined;
  rawOfferState?: number | null | undefined;
  rawTradeStatus?: number | null | undefined;
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A trade Steam settled later than it was accepted had a reversal period. One settled the moment it
 * was accepted, from before Steam's trade protection, had none, and is only ever said to be completed.
 */
export function hadReversalPeriod(entry: Pick<TradeListRow, 'acceptedAt' | 'settlesAt'>): entry is Pick<TradeListRow, 'acceptedAt'> & { settlesAt: string } {
  return entry.settlesAt !== null && (entry.acceptedAt === null || Date.parse(entry.settlesAt) > Date.parse(entry.acceptedAt));
}

function accepted(entry: Pick<TradeListRow, 'acceptedAt'>): string {
  return entry.acceptedAt ? ` Accepted ${formatDateTime(entry.acceptedAt)}.` : '';
}

/**
 * The trade's state as one sentence and an optional second line.
 *
 * `other` is how the other party is called: an owned account's name, or "the other party".
 */
export function describeTradeState(entry: TradeStateInput, other: string): TradeStateText {
  const sent = entry.direction === 'SENT';
  switch (entry.stage) {
    case 'reversal-period':
      return {
        headline: `In the reversal period until ${formatDateTime(entry.settlesAt)}`,
        detail: `Steam can still reverse this trade until then.${accepted(entry)}`,
        tone: 'warn',
        icon: 'trade-protected'
      };
    case 'finalized':
      return hadReversalPeriod(entry)
        ? { headline: `Finalized ${formatDateTime(entry.settlesAt)}`, detail: `The reversal period is over: Steam can no longer reverse this trade.${accepted(entry)}`, tone: 'positive', icon: 'check-circle' }
        : { headline: `Completed ${formatDateTime(entry.acceptedAt ?? entry.sortAt)}`, detail: 'Steam\'s trade history shows the items moved.', tone: 'positive', icon: 'check-circle' };
    case 'reversed':
      return entry.tradeStatus === 'REVERSED'
        ? { headline: 'Steam reversed this trade in its reversal period', detail: 'The items went back in a separate trade.', tone: 'negative', icon: 'undo' }
        : { headline: 'Steam reversed this trade', detail: 'Items that moved were moved back.', tone: 'negative', icon: 'undo' };
    default:
      return describeOpenOrEnded(entry, other, sent);
  }
}

/** Every state that is not yet a trade, or never became one. */
function describeOpenOrEnded(entry: TradeStateInput, other: string, sent: boolean): TradeStateText {
  if (entry.tradeStatus === 'COMPLETE' && entry.origin === 'own-transfer') {
    return { headline: 'Steam shows it complete — waiting for both inventories to show the items', detail: null, tone: 'accent', icon: 'hourglass' };
  }
  switch (entry.tradeStatus) {
    case 'PENDING':
      return { headline: 'Steam is still processing this trade', detail: `As of ${formatDateTime(entry.sortAt)}, Steam had not finished it.`, tone: 'accent', icon: 'hourglass' };
    case 'ESCROW':
      return { headline: 'Accepted — Steam is holding the items', detail: entry.escrowUntil ? `They are released ${formatDateTime(entry.escrowUntil)}.` : null, tone: 'accent', icon: 'lock' };
    case 'FAILED':
      return { headline: 'Steam reports this trade failed', detail: null, tone: 'negative', icon: 'x-circle' };
    case 'UNKNOWN':
      return {
        headline: `Steam reported a state this app doesn't recognise${entry.rawTradeStatus === null || entry.rawTradeStatus === undefined ? '' : ` (code ${entry.rawTradeStatus})`}`,
        detail: 'It stays under Current until Steam reports something this app can read.',
        tone: 'warn',
        icon: 'alert-circle'
      };
    default:
      break;
  }
  if (entry.listed === 0 && entry.stage === 'ended' && !entry.tradeStatus) {
    return { headline: 'Steam no longer lists this offer; its outcome wasn\'t observed', detail: null, tone: 'warn', icon: 'alert-circle' };
  }
  switch (entry.offerStatus) {
    case 'ACTIVE':
      return sent
        ? { headline: `Waiting for ${other} to accept`, detail: entry.expiresAt ? `Expires ${formatDateTime(entry.expiresAt)}.` : null, tone: 'accent', icon: 'hourglass' }
        : { headline: 'Waiting for you to accept or decline it in Steam', detail: entry.expiresAt ? `Expires ${formatDateTime(entry.expiresAt)}.` : null, tone: 'accent', icon: 'hourglass' };
    case 'PENDING_CONFIRMATION':
      return sent
        ? { headline: 'Waiting for you to confirm on the Steam mobile app', detail: 'Nothing leaves the account until you do.', tone: 'accent', icon: 'smartphone' }
        : { headline: `Waiting for ${other} to confirm it`, detail: null, tone: 'accent', icon: 'smartphone' };
    case 'ACCEPTED':
      return { headline: 'Accepted — waiting for Steam\'s trade history to show the trade', detail: `An accepted offer is not a delivery until the history lists the trade.${accepted(entry)}`, tone: 'accent', icon: 'hourglass' };
    case 'ESCROW':
      return { headline: 'Accepted — Steam is holding the items', detail: entry.escrowUntil ? `They are released ${formatDateTime(entry.escrowUntil)}.` : null, tone: 'accent', icon: 'lock' };
    case 'DECLINED':
      return { headline: sent ? `${capitalise(other)} declined it` : 'You declined it', detail: null, tone: 'quiet', icon: 'ban' };
    case 'CANCELLED':
      return { headline: sent ? 'Cancelled before it was accepted' : `${capitalise(other)} cancelled it`, detail: null, tone: 'quiet', icon: 'x-circle' };
    case 'CANCELLED_BY_SECOND_FACTOR':
      return { headline: 'Cancelled because the mobile confirmation was declined or timed out', detail: null, tone: 'quiet', icon: 'x-circle' };
    case 'EXPIRED':
      return { headline: 'Expired before it was accepted', detail: null, tone: 'quiet', icon: 'clock' };
    case 'INVALID_ITEMS':
      return { headline: 'Steam ended it because an item in it was no longer available', detail: null, tone: 'warn', icon: 'alert-circle' };
    case 'INVALID':
      return { headline: 'Steam marked this offer invalid', detail: null, tone: 'warn', icon: 'alert-circle' };
    case 'COUNTERED':
      return { headline: sent ? `${capitalise(other)} replied with a counter-offer` : 'You replied with a counter-offer', detail: null, tone: 'quiet', icon: 'arrow-left-right' };
    default:
      return {
        headline: `Steam reported a state this app doesn't recognise${entry.rawOfferState === null || entry.rawOfferState === undefined ? '' : ` (code ${entry.rawOfferState})`}`,
        detail: 'It stays under Current until Steam reports something this app can read.',
        tone: 'warn',
        icon: 'alert-circle'
      };
  }
}

/** The heading over each side of a trade, in the tense the trade is in. */
export function sideHeading(side: 'GIVE' | 'RECEIVE', entry: Pick<TradeListRow, 'stage'>): string {
  switch (entry.stage) {
    case 'reversal-period':
    case 'finalized':
      return side === 'GIVE' ? 'You gave' : 'You received';
    case 'reversed':
      return side === 'GIVE' ? 'You gave, then got back' : 'You received, then gave back';
    case 'ended':
      return side === 'GIVE' ? 'You would have given' : 'You would have received';
    default:
      return side === 'GIVE' ? 'You give' : 'You receive';
  }
}

/**
 * Why one side of a trade is empty, said plainly: a sale takes nothing back on Steam because the
 * venue pays, a transfer takes nothing back because it is the person's own items moving, and a
 * purchase gives nothing on Steam because it was paid for on the venue.
 */
export function emptySideText(side: 'GIVE' | 'RECEIVE', row: Pick<TradeListRow, 'origin'>, peer: string | null): string {
  const where = peer ?? 'your other account';
  if (side === 'RECEIVE') {
    if (row.origin === 'csfloat-sale') return 'Nothing comes back in Steam: CSFloat pays you for the sale.';
    if (row.origin === 'own-transfer' || row.origin === 'own-accounts') return `Nothing comes back: the items go to ${where}.`;
    return 'Nothing comes back in this trade.';
  }
  if (row.origin === 'csfloat-purchase') return 'Nothing goes out in Steam: the purchase was paid for on CSFloat.';
  if (row.origin === 'own-transfer' || row.origin === 'own-accounts') return `Nothing goes out: the items come from ${where}.`;
  return 'Nothing goes out in this trade.';
}

export type OriginText = { title: string; detail: string | null; icon: IconName; venue: 'csfloat' | null };

const CSFLOAT_CHECK: Readonly<Record<CsfloatCheck, string>> = {
  unmatched: 'Not matched to a CSFloat trade or a transfer between your accounts',
  'not-connected': 'CSFloat isn\'t connected for this account, so a CSFloat purchase can\'t be checked',
  incomplete: 'CSFloat\'s list of trades couldn\'t be fully read, so a CSFloat purchase can\'t be ruled out',
  'not-yet-covered': 'CSFloat hasn\'t been checked since this trade started'
};

const CSFLOAT_TITLE: Readonly<Record<'csfloat-purchase' | 'csfloat-sale' | 'csfloat-mixed', string>> = {
  'csfloat-purchase': 'CSFloat purchase',
  'csfloat-sale': 'CSFloat sale',
  'csfloat-mixed': 'CSFloat trades'
};

/**
 * What the trade was for, as a title and one line.
 *
 * `account` and `peer` are the names of this side's account and of the owned account on the other
 * side, when there is one. `itemName` names the first item, for a CSFloat trade of one item.
 */
export function describeOrigin(row: Pick<TradeListRow, 'origin' | 'csfloatCheck' | 'csfloatTrades' | 'csfloatPriceCents' | 'direction'>,
  names: { account: string; peer: string | null; itemName: string | null }): OriginText {
  switch (row.origin) {
    case 'csfloat-purchase':
    case 'csfloat-sale':
    case 'csfloat-mixed': {
      const what = row.csfloatTrades > 1 ? plural(row.csfloatTrades, 'item') : names.itemName;
      const price = row.csfloatPriceCents === null ? null : formatUsd(row.csfloatPriceCents);
      const owned = names.peer ? (row.origin === 'csfloat-purchase' ? `from ${names.peer}` : row.origin === 'csfloat-sale' ? `to ${names.peer}` : `with ${names.peer}`) : null;
      return { title: CSFLOAT_TITLE[row.origin], detail: [what, price, owned].filter(Boolean).join(' · ') || null, icon: 'shopping-cart', venue: 'csfloat' };
    }
    case 'own-transfer': {
      const from = row.direction === 'RECEIVED' ? names.peer ?? 'another of your accounts' : names.account;
      const to = row.direction === 'RECEIVED' ? names.account : names.peer ?? 'another of your accounts';
      return { title: 'Transfer by CSlytics', detail: `${from} → ${to}`, icon: 'arrow-left-right', venue: null };
    }
    case 'own-accounts':
      return { title: 'Between your accounts', detail: `With ${names.peer ?? 'another of your accounts'} · not sent by CSlytics`, icon: 'users', venue: null };
    default:
      return { title: 'Other', detail: row.csfloatCheck ? CSFLOAT_CHECK[row.csfloatCheck] : null, icon: 'globe', venue: null };
  }
}

/** The short title a trade has in the list. */
export function tradeTitle(row: Pick<TradeListRow, 'origin' | 'direction'>, peer: string | null): string {
  const origin: TradeOriginKind = row.origin;
  if (origin === 'csfloat-purchase' || origin === 'csfloat-sale' || origin === 'csfloat-mixed') return CSFLOAT_TITLE[origin];
  const who = peer ?? 'another user';
  if (origin === 'own-transfer') return row.direction === 'RECEIVED' ? `Transfer from ${who}` : `Transfer to ${who}`;
  if (row.direction === 'SENT') return `Offer to ${who}`;
  if (row.direction === 'RECEIVED') return `Offer from ${who}`;
  return `Trade with ${who}`;
}

/** How many items a trade moves, both sides, in units. */
export function tradeQuantity(row: Pick<TradeListRow, 'giveQuantity' | 'receiveQuantity'>): number {
  return row.giveQuantity + row.receiveQuantity;
}

/** "20 items": how much a trade moves, both sides together, in units. */
export function quantityLine(row: Pick<TradeListRow, 'giveQuantity' | 'receiveQuantity'>): string {
  const total = tradeQuantity(row);
  return total > 0 ? plural(total, 'item') : 'No items recorded';
}

/** The key a trade is selected and remembered by: the account and the engine's entry key. */
export function tradeKey(row: Pick<TradeListRow, 'accountId' | 'entryKey'>): string {
  return `${row.accountId}:${row.entryKey}`;
}
