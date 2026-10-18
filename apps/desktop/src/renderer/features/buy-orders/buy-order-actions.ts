import { useState } from 'react';
import type { CsfloatItemClass } from '@cslytics/catalogue';
import type { BuyOrderBookRow, BuyOrderVenue } from '@cslytics/engine';
import type { IconName } from '../../components/Icon.js';
import { formatAmount } from '../../lib/money.js';
import { formatRelative, humanize, type Tone } from '../../lib/labels.js';
import { VENUE_LABEL } from '../../lib/marketplaces.js';
import type { NamedBuyOrderFilter } from './buy-order-filters.js';
import type { BuyOrderConstraintsInput } from './buy-order-filter-draft.js';

/**
 * What can be done to an open buy order, and how the page says where a cancel or a change has
 * got to.
 *
 * The same rule as `listing-actions.ts`: **the engine is the gate; this is a courtesy.** The page
 * withholds a control only where the row already proves work is on its way, and whatever the
 * engine refuses anyway comes back in its own words. Two venues, one vocabulary: a Steam order is
 * cancelled through its action and a CSFloat order through its operation, and the row reads the
 * same either way, with the venue named where the words differ.
 */

/** A row after the main process has attached what the catalogue knows: a picture by name, or none. */
export type NamedBuyOrder = Omit<BuyOrderBookRow, 'filters'> & {
  imageUrl: string | null;
  filters: NamedBuyOrderFilter[] | null;
  /** What the order is for, in CSFloat's classes, as main placed it by name; `null` when it could not. */
  csfloatItem?: CsfloatItemClass | null | undefined;
  /** Whether the page's filter bar keeps this order, as main answered it; absent when the bar is empty. */
  matches?: boolean | undefined;
};

/** Account- and venue-scoped, because an order id is only unique inside one venue's book for one account. */
export function buyOrderKey(row: Pick<BuyOrderBookRow, 'accountId' | 'venue' | 'buyOrderId'>): string {
  return `${row.accountId}:${row.venue}:${row.buyOrderId}`;
}

/** What each venue calls the read that settles a cancel or a change. */
export const VENUE_READ: Readonly<Record<BuyOrderVenue, string>> = { STEAM: 'market read', CSFLOAT: 'CSFloat read' };

/** Which venues can change an order's terms from here. Steam offers no edit: an order is cancelled and placed again. */
export const VENUE_SUPPORT: Readonly<Record<BuyOrderVenue, { edit: boolean; cancel: boolean }>> = {
  STEAM: { edit: false, cancel: true },
  CSFLOAT: { edit: true, cancel: true }
};

/**
 * Why a cancel did not go through, in words.
 *
 * Steam answers `success: 29` both for an order it never had and for one that has just filled, so
 * the words say it may have filled rather than that it was not there. Each marketplace adapter
 * spells that reason its own way (`unknown-or-completed-order` live, `unknown-or-filled-order` in
 * the Oracle); a reason nobody has met yet is still shown, as words rather than as a code. A
 * CSFloat reason arrives as a sentence already — the venue's own code and words first, then what
 * they mean — and is shown as it is.
 */
const CANCEL_FAILURE: Readonly<Record<string, string>> = {
  superseded: 'Replaced by a later cancel.',
  'complete-observation-proved-not-applied': 'A market read after it still showed the order open, so nothing was cancelled.',
  'unknown-or-completed-order': 'Steam did not find it open. It may just have filled; the next market read will say.',
  'unknown-or-filled-order': 'Steam did not find it open. It may just have filled; the next market read will say.'
};

export function cancelFailureText(reason: string): string {
  const known = CANCEL_FAILURE[reason];
  if (known) return known;
  // A sentence is shown as one; only a bare code is turned into words.
  if (/\s/.test(reason.trim())) return /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  return `${humanize(reason)}.`;
}

export type BuyOrderStatus = {
  label: string;
  tone: Tone;
  icon: IconName;
  /** A sentence under the badge, when there is more to say than its word. */
  detail: string | null;
  canCancel: boolean;
  /** Whether the row offers a change of terms: CSFloat only, and only an order whose constraints an edit can carry through. */
  canEdit: boolean;
};

/**
 * Where one order stands, from the row alone.
 *
 * A cancel that was sent reads *Cancelling* until a read of the venue's book no longer shows the
 * order — the row leaves the book then, and not before (rule 1). The venue answering the cancel is
 * not that moment: an order can fill in the gap, and then it was bought, not cancelled. A change
 * that was sent reads *Changing*, with what was asked for, while the row keeps the terms the venue
 * last showed. A cancel or change that failed hands the controls back with the reason, because
 * pressing again is the only way forward.
 */
export function buyOrderStatus(row: BuyOrderBookRow, now = new Date()): BuyOrderStatus {
  const read = VENUE_READ[row.venue];
  const canEdit = VENUE_SUPPORT[row.venue].edit && row.editable;
  if (row.cancelSentAt) {
    return {
      label: 'Cancelling',
      tone: 'warn',
      icon: 'hourglass',
      detail: `Sent ${formatRelative(row.cancelSentAt, now)}. It leaves this list once a ${read} shows it gone.`,
      canCancel: false,
      canEdit: false
    };
  }
  if (row.editPending) {
    return {
      label: 'Changing',
      tone: 'warn',
      icon: 'pencil',
      detail: `Asked ${formatRelative(row.editPending.sentAt, now)} for ${formatAmount(row.editPending.priceCents, row.currency)} each, ${row.editPending.quantity.toLocaleString()} wanted${row.editPending.filters ? ', with new filters' : ''}. The terms shown stay until a ${read} shows the new ones.`,
      canCancel: false,
      canEdit: false
    };
  }
  if (row.cancelFailure) {
    return { label: 'Cancel failed', tone: 'negative', icon: 'alert-triangle', detail: cancelFailureText(row.cancelFailure), canCancel: true, canEdit };
  }
  if (row.editFailure) {
    return { label: 'Change failed', tone: 'negative', icon: 'alert-triangle', detail: cancelFailureText(row.editFailure), canCancel: true, canEdit };
  }
  return (row.purchased ?? 0) > 0
    ? { label: 'Part filled', tone: 'accent', icon: 'shopping-cart', detail: null, canCancel: true, canEdit }
    : { label: 'Open', tone: 'positive', icon: 'circle-dot', detail: null, canCancel: true, canEdit };
}

/** Where one order's cancel is, as far as this window is concerned. Only `idle` offers the control. */
export type CancelPhase = 'idle' | 'asking' | 'sending';

export type BuyOrderCancelling = {
  phase: (row: BuyOrderBookRow) => CancelPhase;
  /** Cancel was pressed. Nothing is sent until the question is answered. */
  ask: (row: BuyOrderBookRow) => void;
  answer: (row: BuyOrderBookRow, yes: boolean) => void;
};

export type BuyOrderMessage = { tone: 'success' | 'error' | 'info' | 'unknown'; title: string; detail?: string };

type Outcome = { kind?: unknown; reason?: unknown };

/**
 * Cancelling, asked first.
 *
 * One order is asked about at a time, so a second press moves the question rather than stacking
 * it. Once sent, this keeps nothing: the engine's row says the cancel is on its way, and `settled`
 * is the page reading the book again so it can. A Steam cancel is sent by the request itself and
 * answers with the venue's reply; a CSFloat cancel is admitted by the request and sent by the
 * engine behind it, so its reply is the admission, and both are reported as no more than that.
 *
 * The cancel is open work like any other, so the work panel reports how far it has got
 * (N-WORK-08). Work appearing raises no observation notice, so `refreshWork` asks the panel to
 * read again rather than leaving it to its next poll, as a delist does.
 */
export function useCancelBuyOrder(report: (message: BuyOrderMessage | null) => void, settled: () => void, refreshWork: () => void): BuyOrderCancelling {
  const [asking, setAsking] = useState<string | null>(null);
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());

  async function send(row: BuyOrderBookRow, name: string): Promise<void> {
    const key = buyOrderKey(row);
    setSending((current) => new Set(current).add(key));
    report(null);
    try {
      if (row.venue === 'CSFLOAT') {
        await window.trading.invoke({ type: 'csfloat.buyOrderCancel', commandId: crypto.randomUUID(), accountId: row.accountId, orderId: row.buyOrderId });
        report(describeAdmission('cancel', name));
      } else {
        const outcome = await window.trading.invoke({ type: 'buyOrder.cancel', accountId: row.accountId, buyOrderId: row.buyOrderId }) as Outcome;
        report(describeOutcome(outcome, name));
      }
    } catch (error) {
      // The engine's own words, verbatim.
      report({ tone: 'error', title: 'The cancel was not sent', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending((current) => { const next = new Set(current); next.delete(key); return next; });
      settled();
      refreshWork();
    }
  }

  return {
    phase: (row) => (sending.has(buyOrderKey(row)) ? 'sending' : asking === buyOrderKey(row) ? 'asking' : 'idle'),
    ask: (row) => setAsking(buyOrderKey(row)),
    answer: (row, yes) => {
      setAsking(null);
      if (yes) void send(row, row.hashName);
    }
  };
}

/** Where one order's change is, as far as this window is concerned. Only `idle` offers the pencil. */
export type EditPhase = 'idle' | 'editing' | 'sending';

/** New terms for a change: price and quantity, and the whole new filter set when the filters change too. */
export type BuyOrderTerms = { maxPriceCents: number; quantity: number; constraints?: BuyOrderConstraintsInput | undefined };

export type BuyOrderEditing = {
  phase: (row: BuyOrderBookRow) => EditPhase;
  /** The pencil was pressed: the row opens its editor. Nothing is sent until Save. */
  open: (row: BuyOrderBookRow) => void;
  close: () => void;
  submit: (row: BuyOrderBookRow, terms: BuyOrderTerms) => void;
};

/**
 * Changing a CSFloat order's price or quantity.
 *
 * One editor open at a time. Save admits the change and nothing more: the engine reads the book
 * again, freezes the order's own constraints beside the new terms and sends behind the reply, and
 * the row reads *Changing* from its operation until a CSFloat read shows the new terms. The work
 * panel reports it too, and is asked to read again, as for a cancel.
 */
export function useEditBuyOrder(report: (message: BuyOrderMessage | null) => void, settled: () => void, refreshWork: () => void): BuyOrderEditing {
  const [editing, setEditing] = useState<string | null>(null);
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());

  async function send(row: BuyOrderBookRow, terms: BuyOrderTerms): Promise<void> {
    const key = buyOrderKey(row);
    setSending((current) => new Set(current).add(key));
    report(null);
    try {
      await window.trading.invoke({ type: 'csfloat.buyOrderEdit', commandId: crypto.randomUUID(), accountId: row.accountId, orderId: row.buyOrderId,
        maxPriceCents: terms.maxPriceCents, quantity: terms.quantity, ...(terms.constraints ? { constraints: terms.constraints } : {}) });
      report(describeAdmission('edit', row.hashName));
      setEditing((current) => (current === key ? null : current));
    } catch (error) {
      report({ tone: 'error', title: 'The change was not sent', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending((current) => { const next = new Set(current); next.delete(key); return next; });
      settled();
      refreshWork();
    }
  }

  return {
    phase: (row) => (sending.has(buyOrderKey(row)) ? 'sending' : editing === buyOrderKey(row) ? 'editing' : 'idle'),
    open: (row) => setEditing(buyOrderKey(row)),
    close: () => setEditing(null),
    submit: (row, terms) => { void send(row, terms); }
  };
}

/**
 * What the reply to a Steam cancel means, and no more than that.
 *
 * `SUBMITTED` is Steam saying it took the request; `AMBIGUOUS` is not knowing whether it did. Both
 * wait on the same market read, so neither is reported as a cancelled order.
 */
export function describeOutcome(outcome: Outcome | null | undefined, name: string): BuyOrderMessage {
  if (outcome?.kind === 'DEFINITIVELY_REJECTED') {
    return { tone: 'error', title: `Steam refused to cancel ${name}`, detail: typeof outcome.reason === 'string' ? cancelFailureText(outcome.reason) : 'No reason was given.' };
  }
  if (outcome?.kind === 'AMBIGUOUS') {
    return { tone: 'unknown', title: `Not yet known whether ${name} was cancelled`, detail: 'Steam did not answer clearly. The next market read shows whether the order is still open, and the work panel says which; nothing is sent again.' };
  }
  return { tone: 'success', title: `Cancelling ${name}`, detail: 'Sent; the work panel shows how far it has got. The order stays listed until a market read shows it gone, and what it has already bought stays bought.' };
}

/**
 * What the reply to a CSFloat cancel or change means: it was admitted. The engine sends it, and
 * the row keeps what CSFloat last showed until a CSFloat read proves the effect (rule 1).
 */
export function describeAdmission(kind: 'cancel' | 'edit', name: string): BuyOrderMessage {
  return kind === 'cancel'
    ? { tone: 'success', title: `Cancelling ${name}`, detail: 'Queued; the work panel shows how far it has got. The order stays listed until a CSFloat read shows it gone, and what it has already bought stays bought.' }
    : { tone: 'success', title: `Changing ${name}`, detail: 'Queued, with the order\'s own constraints carried through; the work panel shows how far it has got. The terms shown stay until a CSFloat read shows the new ones.' };
}

/**
 * The least CSFloat takes for one item, USD cents: `minimum allowed price is $0.03 USD`. The
 * engine refuses below it too (`BUY_ORDER_MIN_PRICE_CENTS`); the window imports the engine for
 * types only, so the figure is repeated and `tests/unit/buy-order-status.test.ts` pins the two.
 */
export const CSFLOAT_MIN_PRICE_CENTS = 3;

/**
 * How many open buy orders CSFloat lets one account hold, as the account holder reports it
 * (2026-09-24). Not measured here: an account past it is warned, never stopped.
 */
export const CSFLOAT_BUY_ORDER_CAP = 150;

/** What the page knows about one CSFloat account when a change is typed. */
export type CsfloatAccountFacts = {
  /** Available balance, USD cents, as `/me` last showed it; `null` when it has not been read on this connection. */
  availableCents: number | null;
  balanceObservedAt: string | null;
  /** The account's open CSFloat buy orders, from its book. */
  openOrders: number;
  /** What the account's other open CSFloat orders still commit, USD cents. */
  otherOrdersCents: number;
};

/** A change judged before it is sent: `blocking` withholds Save, `warnings` only say what may go wrong. */
export type EditCheck = { blocking: string | null; warnings: string[] };

/**
 * What the window can say about new terms before CSFloat does.
 *
 * A courtesy, never the gate: the engine and the venue decide. Below the price floor is certain,
 * so Save is withheld — sending it would only spend one of the two edits a minute. The balance is
 * the venue's own figure from `/me`, and it may have moved since it was read, so falling short of
 * it warns and does not stop anything. CSFloat has refused an edit whose total the balance did not
 * cover (the trading record, 2026-09-24); whether it also counts the account's other orders has
 * not been seen either way, so that case says *may*. The order cap is the account holder's figure.
 */
export function checkEdit(terms: BuyOrderTerms, facts: CsfloatAccountFacts | null, now = new Date()): EditCheck {
  if (terms.maxPriceCents < CSFLOAT_MIN_PRICE_CENTS) return { blocking: 'CSFloat takes no buy order under $0.03 each.', warnings: [] };
  const warnings: string[] = [];
  const usd = (cents: number): string => formatAmount(cents, 1);
  const total = terms.maxPriceCents * terms.quantity;
  if (facts && facts.availableCents !== null) {
    const read = facts.balanceObservedAt ? ` when last read ${formatRelative(facts.balanceObservedAt, now)}` : '';
    if (total > facts.availableCents) {
      warnings.push(`Not enough CSFloat balance: this needs up to ${usd(total)}, and the account had ${usd(facts.availableCents)} available${read}. CSFloat refuses a change its balance does not cover.`);
    } else if (total + facts.otherOrdersCents > facts.availableCents) {
      warnings.push(`With this account's other CSFloat buy orders (${usd(facts.otherOrdersCents)}), that is more than the ${usd(facts.availableCents)} it had available${read}. CSFloat may count them together and refuse it.`);
    }
  }
  if (facts && facts.openOrders > CSFLOAT_BUY_ORDER_CAP) {
    warnings.push(`This account has ${facts.openOrders.toLocaleString()} open CSFloat buy orders, more than the ${CSFLOAT_BUY_ORDER_CAP} CSFloat allows. It may refuse the change.`);
  }
  return { blocking: null, warnings };
}

/** Dollars typed by a person → integer cents, or null when it is not a price. */
export function parsePriceCents(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(cents) && cents >= 1 ? cents : null;
}

/** A whole number of items, or null. */
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null;
}

/**
 * Which rows show their details.
 *
 * Every row starts with its details hidden behind *Show buy order details* — the picture, the
 * name, the venue and where the order stands are the row — and *Show all details* opens every one,
 * after which a row can be closed on its own. `overrides` holds only the rows that differ from the
 * default, so showing or hiding all is one change that forgets the exceptions, and a row toggled
 * back to the default leaves no trace.
 */
export type RowLayout = { open: boolean; overrides: ReadonlyMap<string, boolean> };

export const ALL_ROWS_OPEN: RowLayout = { open: true, overrides: new Map() };
/** Where a window starts: every row's details hidden. */
export const ALL_DETAILS_HIDDEN: RowLayout = { open: false, overrides: new Map() };

export function rowOpen(layout: RowLayout, key: string): boolean {
  return layout.overrides.get(key) ?? layout.open;
}

export function toggleRow(layout: RowLayout, key: string): RowLayout {
  const overrides = new Map(layout.overrides);
  const open = !rowOpen(layout, key);
  if (open === layout.open) overrides.delete(key); else overrides.set(key, open);
  return { open: layout.open, overrides };
}

export function setAllRows(open: boolean): RowLayout {
  return { open, overrides: new Map() };
}

/** Whether any of these rows is open: what decides if the header button folds or unfolds. */
export function anyRowOpen(layout: RowLayout, keys: Iterable<string>): boolean {
  for (const key of keys) if (rowOpen(layout, key)) return true;
  return false;
}

/**
 * The window's memory of whether every row's details were shown. A per-window convenience, like
 * the sidebar's, and nothing the trading record knows: storage that is absent, full or blocked
 * leaves the default, hidden. A key of its own, so a window that remembered the rows as open under
 * the earlier layout starts from the new default rather than with every order unfolded.
 */
const DETAILS_KEY = 'cslytics.buy-orders.details';

export function rememberedRowLayout(): RowLayout {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DETAILS_KEY) === 'shown' ? ALL_ROWS_OPEN : ALL_DETAILS_HIDDEN;
  } catch {
    return ALL_DETAILS_HIDDEN;
  }
}

export function rememberRowLayout(layout: RowLayout): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DETAILS_KEY, layout.open ? 'shown' : 'hidden');
  } catch {
    // Not remembered, and still as chosen for as long as this window is open.
  }
}

export type BuyOrderRefresh = {
  busy: boolean;
  /** Reads the chosen venue's book again now, or both venues' when none is chosen. */
  run: (accountIds: readonly string[], venue: BuyOrderVenue | '') => void;
};

/**
 * The page's refresh. The engine reads the venue's book through its own read budget, so the
 * press is a request and not a guarantee: when no read was made at all — every account in view
 * is off that venue, or the venue's reads are held back after failures — the page says so
 * rather than looking as if it had read and found nothing new.
 */
export function useRefreshBuyOrders(report: (message: BuyOrderMessage | null) => void, settled: () => void): BuyOrderRefresh {
  const [busy, setBusy] = useState(false);

  async function run(accountIds: readonly string[], venue: BuyOrderVenue | ''): Promise<void> {
    setBusy(true);
    report(null);
    const where = venue ? VENUE_LABEL[venue] : 'either venue';
    try {
      const read = await window.trading.invoke({ type: 'buyOrders.refresh', accountIds: [...accountIds], venue: venue || null }) as Record<string, Partial<Record<BuyOrderVenue, boolean>>>;
      if (!Object.values(read).some((venues) => Object.values(venues).some(Boolean))) {
        report({ tone: 'info', title: `${where === 'either venue' ? 'Neither venue' : where} was read`, detail: `No account in view is connected to ${where}, or its reads are held back after failures. The list is as the last read left it.` });
      }
    } catch (error) {
      report({ tone: 'error', title: `${where === 'either venue' ? 'The' : where} buy orders could not be read`, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      settled();
    }
  }

  return { busy, run: (accountIds, venue) => void run(accountIds, venue) };
}
