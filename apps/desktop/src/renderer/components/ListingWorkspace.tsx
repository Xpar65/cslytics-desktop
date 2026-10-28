import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MARKETPLACE_FEES, listPriceOf, quoteFromBuyer, quoteFromReceive, type PriceQuote } from '@cslytics/ports';
import { Button, Caption, IconButton, Thumbnail } from './ui.js';
import { Icon, type IconName } from './Icon.js';
import { Tip } from './Tip.js';
import { VenueMark } from './VenueMark.js';
import { OrderBookLine } from './OrderBookLine.js';
import { useOutbox } from '../features/work/WorkIndicator.js';
import { priceAtFloat } from '../features/items/curve-math.js';
import { formatFloat, wearTier } from '../lib/format.js';
import { convert, type BookLevel, type StoredCurve } from '@cslytics/market-data';
import { parseMoney, plural } from '../lib/labels.js';
import { useCurrency } from '../lib/currency.js';
import { engine } from '../lib/engine.js';
import { bookKey, useOrderBooks } from '../lib/order-books.js';
import { conversionNote, currencyCodeOf, formatAmount, formatConverted, formatTick } from '../lib/money.js';
import {
  EMPTY,
  bulkVenueOf,
  dollars,
  reduce,
  type Applied,
  type PriceBasis,
  type StagedEntry,
  type StagedRow,
  type StrategyId,
  type Venue,
  type WorkspaceAction,
  type WorkspaceIntent,
  type WorkspaceState
} from './listing-workspace-store.js';
import type { OutboxOutcome } from '../features/work/outbox.js';

/** What a venue is called on screen. What it charges is `MARKETPLACE_FEES`, and nowhere else. */
const VENUE: Readonly<Record<Venue, { label: string; short: string }>> = {
  steam: { label: MARKETPLACE_FEES.steam.label, short: 'Steam' },
  csfloat: { label: MARKETPLACE_FEES.csfloat.label, short: 'CSFloat' }
};

/**
 * The least each venue lists at, in the figure its list call takes. CSFloat's is the `csfloat.list`
 * request schema's (`apps/desktop/src/shared/api.ts`); a Steam listing has to pay its seller a cent.
 */
const MINIMUM_LIST_CENTS: Readonly<Record<Venue, number>> = { steam: 1, csfloat: 3 };

/**
 * `csfloat.list` takes at most 100 members (`apps/desktop/src/shared/api.ts`). The bound is shown
 * and enforced here rather than left to the schema, because a refusal from the request validator
 * names no item and gives the person nothing to act on.
 */
const CSFLOAT_BATCH = 100;

/**
 * The ways *Price all rows* prices every row from the market, each a press. The three that read
 * the order book price what the buyer pays, as every figure in a book is a buyer's; the float
 * price reads the venue's curve at the row's float, in the row's currency.
 */
const STRATEGIES: ReadonlyArray<{ id: StrategyId; icon: IconName; label: string; title: string }> = [
  {
    id: 'instant', icon: 'zap', label: 'Sell now',
    title: 'Price every row to sell into the buy orders as they stand: the first unit of a name at the highest bid, the next at the next unit the orders will take, and so on down the book. A row the orders would not take is left as it is.'
  },
  { id: 'bid', icon: 'shopping-cart', label: 'Top bid', title: 'Price every row at the highest buy order on its market, so it sells to that order at once.' },
  { id: 'undercut', icon: 'arrow-down', label: 'Undercut', title: 'Price every row one cent under the cheapest listing on its market.' },
  { id: 'float', icon: 'activity', label: 'Float price', title: "Price every row at its float's point on its marketplace's float curve, in the row's currency." }
];

/** What a strategy decided for one row: a buyer price, or why it left the row alone. */
type Outcome = { cents: number } | { skip: string };

/** The element the shell leaves in the account strip for this workspace's pill (`App.tsx`). */
const SLOT = '[data-slot="listing-workspace"]';

/** Where the panel sits before its pill has been measured — the window's own top right. */
const FALLBACK_ANCHOR = { top: 56, right: 12 };

/**
 * A listing workspace as the shell holds it: its state, and the few things done to it from
 * outside the panel — staging from an inspector, and the outbox's answer to a send.
 */
export type Workspace<E extends StagedEntry> = {
  intent: WorkspaceIntent<E>;
  state: WorkspaceState<E>;
  dispatch: (action: WorkspaceAction<E>) => void;
  /** Entries join the rows already staged, which keep what was typed, and the panel opens. */
  stage: (entries: readonly E[]) => void;
  /** Rows handed to the outbox: off screen until the engine answers. The shell hears which. */
  hand: (keys: readonly string[]) => void;
  /**
   * The outbox's answer for one batch. `true` says a refusal was shown on rows still here, so the
   * outbox forgets it; `false` that the workspace was closed meanwhile and the work panel keeps it.
   */
  settle: (keys: readonly string[], outcome: OutboxOutcome) => boolean | undefined;
};

/**
 * One listing workspace, held by the shell so it outlives the page it was staged from.
 *
 * `onHanded` is told the keys of every row handed to the outbox, in the render of the press, so
 * the inventory selection can let go of exactly those: the item is busy on its tile from then on,
 * and the rows still waiting for a price stay selected.
 */
export function useListingWorkspace<E extends StagedEntry>(intent: WorkspaceIntent<E>, onHanded?: (keys: readonly string[]) => void): Workspace<E> {
  const [state, dispatch] = useReducer((current: WorkspaceState<E>, action: WorkspaceAction<E>) => reduce(current, action), EMPTY as WorkspaceState<E>);
  // The rows as last rendered, read when the engine answers a send: a refusal has somewhere to
  // land only if its rows are still here.
  const latest = useRef(state);
  latest.current = state;
  const handed = useRef(onHanded);
  handed.current = onHanded;
  const stage = useCallback((entries: readonly E[]) => dispatch({ type: 'stage', entries }), []);
  const hand = useCallback((keys: readonly string[]) => {
    dispatch({ type: 'hand', keys });
    handed.current?.(keys);
  }, []);
  const settle = useCallback((keys: readonly string[], outcome: OutboxOutcome): boolean | undefined => {
    if (outcome.accepted) {
      dispatch({ type: 'accept', keys });
      return undefined;
    }
    if (!latest.current.rows.some((row) => keys.includes(row.key))) return false;
    dispatch({ type: 'refuse', keys, reason: outcome.reason });
    return true;
  }, []);
  return useMemo(() => ({ intent, state, dispatch, stage, hand, settle }), [intent, state, stage, hand, settle]);
}

/**
 * The listing workspace: every item staged for sale, priced and routed before anything is sent —
 * and every standing listing staged for a new price, which is the same work with one venue per row.
 * Which of the two it is doing is its `intent`; everything below is true of both.
 *
 * The inspector answers "what can I do with this". This answers the question that follows for
 * exactly one of those verbs, because listing is the only action whose details differ *per item*:
 * a crate and a knife in the same selection do not share a price, and one of them may only be
 * listable on one of the two venues. Store and Transfer each take a single destination for the
 * whole batch and are answered in the inspector itself.
 *
 * **Its state is the shell's, and this renders it** (`listing-workspace-store.ts`). The shell
 * holds one workspace for listing and one for repricing (`useListingWorkspace` in `App.tsx`), so
 * both outlive the page they were staged from and the selection they were staged with: a
 * submitted row leaves the selection, and a person who stages items and then opens one's Items
 * page keeps the pill and the rows where they left them. Staging adds to what is there — a
 * second selection joins the first, each row keeping what was typed into it — and staging a row
 * already here only opens the panel.
 *
 * **It lives in the account strip, not in a window of its own.** A pill left of the work
 * indicator is there whenever the workspace holds a row and gone the moment it does not; the
 * panel opens under it, over everything else. Staging is the step before the work indicator has
 * anything to say, so the two sit side by side. It was a modal drawer once and that was wrong
 * twice over: a scrim blocked the very list a person needs in order to decide a price, and
 * dismissing it was unrecoverable — the inspector would only open it again from a selection with
 * no work in flight, so closing it over a row that had just been sent left no way back to that
 * row at all. It was then a free-floating dock over the work area, which covered the section it
 * was pricing from even when collapsed. Folding the panel into its pill is therefore the ordinary
 * gesture — a press on the page behind it folds it too, because that page is what a price is
 * decided against — the pill is always the way back, and the close button is destructive: it
 * empties the staging.
 *
 * **Every row shows the market it is priced against.** The Steam order book for the row's market
 * name — highest bid, mid, lowest ask — is read live while the panel is open (`useOrderBooks`),
 * and pressing a figure prices the row at it, as what the buyer pays. A wallet the anonymous book
 * is not priced for gets the account's own read, in the wallet's currency, because a figure that
 * is sent is never converted (AGENTS.md rule 9). A price is decided against the book, so the book
 * is on the row rather than a page away. Nothing else on the row repeats
 * what the name already says: the wear tier is in a market name, so the row keeps the float alone.
 *
 * **Price all rows prices from the market in one press.** Under the one price and one marketplace
 * for every row sit four presses: *Sell now* walks each name's buy orders a unit at a time, *Top
 * bid* takes the highest buy order, *Undercut* goes a cent under the cheapest listing, and *Float
 * price* reads the venue's float curve at the row's float. Each writes what the buyer pays into
 * every row it can price and says how many it did and why it left the rest; a book is read the
 * moment a name is staged and kept fresh after, so the figures a press uses are the market's now.
 *
 * Three rules shape what is in it.
 *
 * **One command per venue, and only what that venue's own verdict allows.** The engine rejects a
 * batch atomically, so the Steam rows go in one `command.submit` and the CSFloat rows in one
 * `csfloat.list`, each carrying its own per-member price. A row is never placed in a batch its
 * verdict refuses, which is why the marketplace control on a row offers only the venues that row
 * can actually reach.
 *
 * **Pressing List is the whole gesture.** The rows go to the window's outbox (`features/work/outbox.ts`)
 * and leave the workspace in the same render; the work panel reports them from that moment —
 * waiting to submit, submitting, and then the engine's own states, queued, sending, sent, waiting
 * for a phone. Nothing here waits on the request. It used to: the row sat under a spinner and every
 * other row was locked for as long as the engine took to admit it, which for CSFloat meant the
 * Game Coordinator, the post and a stall read. Sent is still not listed, and nothing here says it
 * is: the work panel is where a listing becomes *Completed*, by observation.
 *
 * **A refusal is the engine's, verbatim, and comes back here.** A batch the engine refuses returns
 * its rows to the workspace, each marked with the message it gave and ready to send again once
 * the cause is fixed. Nothing here paraphrases a refusal into a second, wrong explanation. If the
 * workspace has been closed meanwhile, the refusal stays on the work panel instead.
 *
 * Prices are asked for both ways round. Every row, and the controls for every row, has a *You
 * receive* and a *Buyer pays* field; whichever was typed into is kept as typed and the other is
 * worked out from that row's venue through `MARKETPLACE_FEES`, so switching a row's venue keeps
 * the figure the person chose and moves the other. What is sent is the figure the venue's list
 * call takes — what the seller receives for Steam (rule 4), what the buyer pays for CSFloat.
 *
 * What a row has to say beyond its figures is a chip, a word or two with the sentence in its tip:
 * a retrieve before the listing, a phone confirmation, a listing the typed figure does not exist
 * at. The one thing printed in full is a refusal, because those are the engine's words.
 */
export function ListingWorkspace<E extends StagedEntry>({ workspace, accounts }: {
  workspace: Workspace<E>;
  /** Each account with its wallet currency, which every Steam figure here is in; CSFloat figures are USD. */
  accounts: ReadonlyArray<{ id: string; name: string; currency?: number | null | undefined }>;
}): React.JSX.Element | null {
  const { intent, state, dispatch } = workspace;
  const { rows, open, bulk } = state;
  const bulkVenue = bulkVenueOf(state);
  const bulkId = useId();
  const outbox = useOutbox();

  // What is on screen. A handed row is the outbox's until the engine answers, and a workspace
  // holding nothing else shows nothing — no pill, no panel — while it waits to hear.
  const shown = useMemo(() => rows.filter((row) => row.state !== 'handed'), [rows]);
  const slot = useSlot();
  const pill = useRef<HTMLButtonElement | null>(null);
  const dock = useRef<HTMLElement | null>(null);
  const anchor = usePillAnchor(pill, open && shown.length > 0, slot);
  // The Steam book behind every row, read as each is staged, every five seconds while the panel
  // is open and once a minute while it is folded; by account as well as name, because a wallet
  // the anonymous book is not priced for gets the account's own read (plan D17).
  const keys = useMemo(() => shown.flatMap((row) => (typeof row.entry.marketHashName === 'string' && row.entry.marketHashName !== '' ? [{ accountId: row.entry.accountId, name: row.entry.marketHashName }] : [])), [shown]);
  const books = useOrderBooks(keys, open);
  // The float curves asked for, by venue and name. Only an answer is kept: a read that failed is asked again next press.
  const curves = useRef(new Map<string, StoredCurve | null>());
  const [curving, setCurving] = useState(false);
  const { fx } = useCurrency();

  // A press on the page behind the panel folds it: that page is the list a price is decided
  // against, and a panel that stayed over it had to be folded by hand before the list could be
  // read. The pill is the one control outside the panel that is about it, and takes its own
  // press. A press that stages something folds and then opens in the same gesture, which is open.
  const showing = open && shown.length > 0;
  useEffect(() => {
    if (!showing) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dock.current?.contains(target) || pill.current?.contains(target)) return;
      dispatch({ type: 'fold' });
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showing, dispatch]);

  /**
   * The currency a row's figures are in: USD on CSFloat everywhere, the account's wallet on Steam
   * (portfolio and pricing plan §5.1). A typed price is in this currency and is sent as typed.
   */
  const currencyFor = (venue: Venue, accountId: string): number | null => (venue === 'csfloat' ? 1 : accounts.find((account) => account.id === accountId)?.currency ?? null);
  const rowCurrency = (row: StagedRow<StagedEntry>): number | null => currencyFor(row.venue, row.entry.accountId);
  /** One currency for rows on one venue, or none when accounts with different wallets are mixed in. */
  const currencyOfRows = (venue: Venue, rows: ReadonlyArray<StagedRow<StagedEntry>>): number | null => {
    const codes = new Set(rows.filter((row) => row.venue === venue).map((row) => currencyFor(venue, row.entry.accountId)));
    return codes.size === 1 ? [...codes][0]! : null;
  };
  const sendable = useMemo(() => shown.filter((row) => priceOf(row, rowCurrency(row)) !== null), [shown, accounts]);
  const steamRows = sendable.filter((row) => row.venue === 'steam');
  const csfloatRows = sendable.filter((row) => row.venue === 'csfloat');
  const overCsfloatBatch = csfloatRows.length > CSFLOAT_BATCH;
  const refused = shown.filter((row) => row.state === 'refused');
  const multiAccount = new Set(shown.map((row) => row.entry.accountId)).size > 1;
  // A venue is only a choice when some row has one. A page of standing listings has none.
  const routable = shown.some((row) => row.venues.length > 1);
  const accountName = (accountId: string): string => accounts.find((account) => account.id === accountId)?.name ?? accountId;

  /**
   * What the three book strategies decide for each row, from the book held for its name now.
   *
   * Only a Steam row in the book's own currency can take a figure from it: CSFloat has no order
   * book here, and a book in another currency is not a price this row could be sent, because a
   * figure that is sent is never converted (AGENTS.md rule 9). *Sell now*
   * walks each name's bids best-first, one row per unit, so two rows of one name take the first
   * two units the orders would absorb, at whatever levels those are; a row past the last unit is
   * left alone and counted.
   */
  function bookOutcomes(id: 'instant' | 'bid' | 'undercut'): Map<string, Outcome> {
    const outcomes = new Map<string, Outcome>();
    const taken = new Map<string, number>();
    for (const row of shown) {
      const name = row.entry.marketHashName ?? null;
      if (row.venue === 'csfloat') { outcomes.set(row.key, { skip: 'on CSFloat, which has no order book here' }); continue; }
      const book = name === null ? null : books.get(bookKey(row.entry.accountId, name))?.book ?? null;
      if (book === null) { outcomes.set(row.key, { skip: 'without a Steam book yet' }); continue; }
      const currency = rowCurrency(row);
      if (book.currency !== currency) {
        outcomes.set(row.key, { skip: `with a book in ${currencyCodeOf(book.currency)} and a price in ${currencyCodeOf(currency) || 'an unknown currency'}` });
        continue;
      }
      if (id === 'bid') {
        outcomes.set(row.key, book.highestBidCents === null ? { skip: 'with no buy orders' } : { cents: book.highestBidCents });
      } else if (id === 'undercut') {
        outcomes.set(row.key, book.lowestAskCents === null ? { skip: 'with no listing to undercut' } : { cents: book.lowestAskCents - 1 });
      } else {
        const unit = taken.get(name!) ?? 0;
        taken.set(name!, unit + 1);
        const level = levelForUnit(book.bids, unit);
        outcomes.set(row.key, level === null ? { skip: 'past what the buy orders take' } : { cents: level });
      }
    }
    return outcomes;
  }

  /**
   * The float price for each row: its marketplace's curve at its float, from the free CDN through
   * main (`item.curve`, which records an absence rather than asking again). The curve is in USD;
   * a row in another currency takes the figure through the newest rate, or is left alone when
   * there is none.
   */
  async function floatOutcomes(): Promise<Map<string, Outcome>> {
    const wanted = new Map<string, { venue: Venue; name: string }>();
    for (const row of shown) {
      const name = row.entry.marketHashName;
      if (name) wanted.set(`${row.venue}:${name}`, { venue: row.venue, name });
    }
    await Promise.all([...wanted].map(async ([key, { venue, name }]) => {
      if (curves.current.has(key)) return;
      try {
        curves.current.set(key, await engine.itemCurve(name, venue));
      } catch {
        // Asked again on the next press.
      }
    }));
    const outcomes = new Map<string, Outcome>();
    for (const row of shown) {
      const name = row.entry.marketHashName ?? null;
      const doc = name === null ? null : curves.current.get(`${row.venue}:${name}`)?.doc ?? null;
      if (row.entry.paintWear === null) { outcomes.set(row.key, { skip: 'without a float' }); continue; }
      if (!doc) { outcomes.set(row.key, { skip: `without a ${VENUE[row.venue].short} float curve` }); continue; }
      const price = priceAtFloat(doc.fairPrice?.vertices, row.entry.paintWear);
      if (price === null) { outcomes.set(row.key, { skip: 'with no fair price on its curve' }); continue; }
      const native = Math.round(price * 100);
      const code = currencyCodeOf(rowCurrency(row));
      if (code === doc.currency) { outcomes.set(row.key, { cents: native }); continue; }
      const converted = code ? convert(native, doc.currency, code, fx) : null;
      outcomes.set(row.key, converted === null ? { skip: `with no rate from ${doc.currency} to ${code || 'its currency'}` } : { cents: converted.cents });
    }
    return outcomes;
  }

  /** Write what a strategy decided, and say how many rows took a figure and why the rest did not. */
  function applyStrategy(id: StrategyId, outcomes: ReadonlyMap<string, Outcome>): void {
    const cents = new Map<string, number>();
    const skipped = new Map<string, number>();
    for (const [key, outcome] of outcomes) {
      if ('cents' in outcome) cents.set(key, outcome.cents);
      else skipped.set(outcome.skip, (skipped.get(outcome.skip) ?? 0) + 1);
    }
    const applied: Applied = { id, priced: cents.size, total: outcomes.size, skipped: [...skipped] };
    dispatch({ type: 'priced', applied, cents });
  }

  async function pressStrategy(id: StrategyId): Promise<void> {
    if (id !== 'float') {
      applyStrategy(id, bookOutcomes(id));
      return;
    }
    setCurving(true);
    try {
      applyStrategy(id, await floatOutcomes());
    } finally {
      setCurving(false);
    }
  }

  /**
   * Hand the rows to the outbox and let go of them, in the same render as the press.
   *
   * Each batch is atomic, and what goes in one is the intent's to say. The shell hears which rows
   * went, so the selection lets go of exactly those and the item is busy on its tile from this
   * render on. The engine's answer comes back through `settle`: accepted, the rows are gone for
   * good; refused, they return marked with its words and the panel opens on them.
   */
  function list(targets: ReadonlyArray<StagedRow<E>>): void {
    if (targets.length === 0) return;
    const byKey = new Map(targets.map((row) => [row.key, row]));
    workspace.hand(targets.map((row) => row.key));
    for (const batch of intent.batches(targets.map((row) => ({ entry: row.entry, venue: row.venue, cents: priceOf(row, rowCurrency(row))! })))) {
      outbox.enqueue({
        kind: batch.kind,
        items: batch.keys.map((key) => {
          const row = byKey.get(key)!;
          return {
            key,
            accountId: row.entry.accountId,
            name: row.entry.name,
            imageUrl: row.entry.imageUrl,
            localId: row.entry.localId ?? null,
            receiveCents: pricingOf(row, rowCurrency(row)).quote?.receiveCents ?? null
          };
        }),
        send: batch.send,
        onSettled: (outcome) => workspace.settle(batch.keys, outcome)
      });
    }
  }

  if (shown.length === 0) return null;

  const steamTotal = tally(steamRows, rowCurrency);
  const csfloatTotal = tally(csfloatRows, rowCurrency);
  const steamCurrency = currencyOfRows('steam', steamRows);
  // A standing listing still at its own price is priced, just not worth sending. Only a row with
  // no figure its venue would take is missing something.
  const unchanged = shown.filter((row) => priceOf(row, rowCurrency(row)) === null && pricing(row.venue, rowCurrency(row), row.price, row.basis).listCents !== null).length;
  const unpriced = shown.length - sendable.length - unchanged;
  const bulkCurrency = currencyOfRows(bulkVenue, shown);
  const bulkPriced = pricing(bulkVenue, bulkCurrency, bulk.price, bulk.basis);
  const strategy = bulk.applied ? STRATEGIES.find((entry) => entry.id === bulk.applied!.id) : undefined;
  // What the header says in one line, so the pill still reports the state of the work folded up.
  const summary = [
    `${plural(shown.length, intent.noun)} staged`,
    ...(refused.length > 0 ? [`${refused.length} refused`] : []),
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
    ...(unpriced > 0 ? [`${unpriced} unpriced`] : [])
  ].join(' · ');
  const attention = unpriced > 0 || refused.length > 0 ? 'true' : undefined;

  const launcher = (
    <button
      ref={pill}
      type="button"
      className="listing-pill"
      data-attention={attention}
      // No slot means the shell is not around this view; the pill then pins itself to the
      // window rather than vanishing, because a staging nobody can reach is the one-way door again.
      data-floating={slot ? undefined : 'true'}
      aria-expanded={open}
      aria-label={`Listing workspace: ${summary}`}
      title={`Listing workspace · ${summary}`}
      onClick={() => dispatch({ type: open ? 'fold' : 'reveal' })}
    >
      <span className="listing-pill-glyph"><Icon name={intent.icon} size={14} /></span>
      <span className="listing-pill-count num">{shown.length.toLocaleString()}</span>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} className="listing-pill-chevron" />
    </button>
  );

  return <>
    {createPortal(launcher, slot ?? document.body)}
    {open ? createPortal(
      <aside
        ref={dock}
        className="listing-dock"
        role="region"
        aria-label="Listing workspace"
        data-attention={attention}
        style={{ top: anchor.top, right: anchor.right, maxHeight: `calc(100vh - ${anchor.top + 16}px)` }}
      >
        <header className="listing-dock-head">
          <button
            type="button"
            className="listing-dock-toggle"
            aria-expanded={true}
            title="Fold the listing workspace into its pill. Everything staged stays."
            onClick={() => dispatch({ type: 'fold' })}
          >
            <span className="panel-icon"><Icon name={intent.icon} size={15} /></span>
            <span className="listing-dock-heading">
              <span className="listing-dock-title">Listing workspace</span>
              <span className="listing-dock-sub">{summary}</span>
            </span>
            <Icon name="chevron-up" size={15} className="listing-dock-chevron" />
          </button>
          {/* Closing is the destructive gesture, which is why folding is the whole header wide
              and this is one small button: nothing staged survives it. */}
          <IconButton
            icon="x"
            size="sm"
            label="Close the listing workspace"
            title="Close the listing workspace — unstages everything here. The items stay selected."
            onClick={() => dispatch({ type: 'close' })}
          />
        </header>

        <div className="listing-dock-body">
          {/* One price and one marketplace for everything. Folded by default, and its summary
              says what it would write, so a folded section is never a hidden setting. A row that
              has been given its own price or venue is left alone until Apply to all. */}
          <section className="listing-bulk" data-open={bulk.open || undefined}>
            <button
              type="button"
              className="listing-bulk-toggle"
              aria-expanded={bulk.open}
              aria-controls={bulkId}
              onClick={() => dispatch({ type: 'bulkOpen', open: !bulk.open })}
            >
              <Icon name={bulk.open ? 'chevron-down' : 'chevron-right'} size={13} className="listing-bulk-chevron" />
              <span className="kicker">Price all rows</span>
              {bulk.open ? null : (
                <span className="listing-bulk-summary">
                  {bulkPriced.quote ? (
                    <span className="listing-figures" title={`Every row: you receive ${formatAmount(bulkPriced.quote.receiveCents, bulkCurrency)}, the buyer pays ${formatAmount(bulkPriced.quote.buyerCents, bulkCurrency)}`}>
                      <span className="num">{formatTick(bulkPriced.quote.receiveCents, bulkCurrency)}</span>
                      <Icon name="arrow-right" size={11} />
                      <span className="num">{formatTick(bulkPriced.quote.buyerCents, bulkCurrency)}</span>
                      <span className="listing-code">{currencyCodeOf(bulkCurrency)}</span>
                    </span>
                  ) : strategy ? (
                    <span className="listing-figures" title={strategy.title}>
                      <Icon name={strategy.icon} size={11} />
                      {strategy.label}
                    </span>
                  ) : null}
                  {routable ? <VenueMark venue={bulkVenue} size={13} /> : null}
                </span>
              )}
            </button>
            {bulk.open ? (
              <div className="listing-bulk-body" id={bulkId}>
                {/* From the market, in one press each. The figures land in every row as what the
                    buyer pays, and the line under the strip says how many rows took one and why
                    the rest did not. */}
                <div className="listing-strategies" role="group" aria-label="Price every row from the market">
                  {STRATEGIES.map((entry) => (
                    <Button
                      key={entry.id}
                      size="sm"
                      variant="subtle"
                      icon={entry.icon}
                      title={entry.title}
                      loading={entry.id === 'float' && curving}
                      disabled={curving}
                      onClick={() => { void pressStrategy(entry.id); }}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
                {bulk.applied && strategy ? (
                  <Caption icon={strategy.icon}>
                    {strategy.label}: {bulk.applied.priced} of {bulk.applied.total} priced
                    {bulk.applied.skipped.map(([why, count]) => ` · ${count} ${why}`).join('')}
                  </Caption>
                ) : null}
                <div className="listing-controls" data-bulk="true">
                  <PriceFields subject="every row" venue={bulkVenue} currency={bulkCurrency} priced={bulkPriced} disabled={false} onChange={(price, basis) => dispatch({ type: 'spread', price, basis })} />
                  {routable ? (
                    <VenueChoice label="Marketplace for every row" value={bulkVenue} venues={['steam', 'csfloat']} onChange={(venue) => dispatch({ type: 'route', venue })} />
                  ) : null}
                  <span className="listing-bulk-apply">
                    <IconButton
                      icon="chevrons-right"
                      size="sm"
                      variant="default"
                      label="Apply to all rows"
                      title="Apply to all rows — every row takes this price and marketplace, the ones priced by hand too"
                      onClick={() => dispatch({ type: 'apply' })}
                    />
                    <Tip label="How the controls for every row work" content="Type either figure and the other follows from that marketplace's fees. A row you price or route yourself keeps that until you apply to all." />
                  </span>
                </div>
                <NoteChips note={bulkPriced.note} />
              </div>
            ) : null}
          </section>

          {overCsfloatBatch ? (
            <Caption icon="alert-triangle" tone="warn">
              CSFloat takes {CSFLOAT_BATCH} items per command and {csfloatRows.length} are routed there. List some of
              them first, or move the rest to Steam.
            </Caption>
          ) : null}

          <ul className="listing-rows" aria-label="Staged for pricing">
            {shown.map((row) => {
              const { entry } = row;
              const currency = rowCurrency(row);
              const priced = pricingOf(row, currency);
              const cents = priced.listCents;
              const tier = wearTier(entry.paintWear);
              const caption = entry.venueCaption?.[row.venue] ?? entry.caption;
              const quote = entry.marketHashName ? books.get(bookKey(entry.accountId, entry.marketHashName)) : undefined;
              return (
                <li className="listing-row" key={row.key} data-state={row.state}>
                  <Thumbnail url={entry.imageUrl} name={entry.name} size={34} />
                  <span className="listing-row-text">
                    <span className="listing-row-name" title={entry.name}>{entry.name}</span>
                    <span className="listing-row-line">
                      <span className="listing-row-meta quiet">
                        <Tip content={entry.place.label}><Icon name={entry.place.icon} size={12} /></Tip>
                        {entry.paintWear !== null ? (
                          <Tip content={`Float ${formatFloat(entry.paintWear)}${tier ? ` · ${tier.label}` : ''}`}>
                            <span className="listing-row-float">
                              {tier ? <span className="wear-dot" style={{ background: `var(${tier.variable})` }} /> : null}
                              <span className="num">{formatFloat(entry.paintWear)}</span>
                            </span>
                          </Tip>
                        ) : null}
                        {multiAccount ? <span className="listing-row-account">{accountName(entry.accountId)}</span> : null}
                      </span>
                      {entry.marketHashName ? (
                        <OrderBookLine
                          quote={quote}
                          currency={currency}
                          onPick={(figure) => dispatch({ type: 'price', key: row.key, price: dollars(figure), basis: 'buyer' })}
                        />
                      ) : null}
                    </span>
                    {/* What the row has to say beyond its figures, on a line of its own so the
                        facts and the book above it keep theirs. */}
                    {caption || (priced.note && priced.note.short !== null) ? (
                      <span className="listing-row-chips">
                        {caption ? <Chip icon={caption.icon} text={caption.text}>{caption.short}</Chip> : null}
                        <NoteChips note={priced.note} />
                      </span>
                    ) : null}
                  </span>
                  {/* Taking a row out, and emptying the workspace — pill and all — by taking out
                      the last one. The row stays selected, so the next staging brings it back. */}
                  <IconButton
                    icon="x"
                    size="sm"
                    className="listing-row-drop"
                    label={`Take ${entry.name} off the list`}
                    onClick={() => dispatch({ type: 'drop', key: row.key })}
                  />

                  <div className="listing-controls">
                    <PriceFields
                      currency={currency}
                      subject={entry.name}
                      venue={row.venue}
                      priced={priced}
                      disabled={false}
                      onChange={(price, basis) => dispatch({ type: 'price', key: row.key, price, basis })}
                    />

                    {/* Only the venues this row's own verdict allows can be chosen. A row Steam will
                        take and CSFloat will not is not a row to offer CSFloat on and refuse later —
                        but CSFloat is still shown, disabled, saying why, so its absence is not a
                        question the person has to ask. */}
                    <VenueChoice
                      className="listing-row-venue"
                      label={`Marketplace for ${entry.name}`}
                      value={row.venue}
                      venues={row.venues}
                      unavailable={entry.unavailable}
                      onChange={(venue) => dispatch({ type: 'venue', key: row.key, venue })}
                    />

                    <Button
                      size="sm"
                      className="listing-row-act"
                      icon="tag"
                      disabled={cents === null}
                      onClick={() => list([row])}
                    >
                      {intent.verb}
                    </Button>
                  </div>

                  {row.state === 'refused' && row.detail ? <Caption icon="ban" tone="warn">{row.detail}</Caption> : null}
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="listing-dock-foot">
          <span className="listing-total quiet">
            {steamRows.length > 0 ? <Tally venue="steam" count={steamRows.length} total={steamTotal} currency={steamCurrency} noun={intent.noun} /> : null}
            {csfloatRows.length > 0 ? <Tally venue="csfloat" count={csfloatRows.length} total={csfloatTotal} currency={1} noun={intent.noun} /> : null}
            {unpriced > 0 ? (
              <span className="listing-tally" data-tone="warn" title={`${plural(unpriced, intent.noun)} without a price`}><Icon name="alert-circle" size={12} />{unpriced.toLocaleString()} unpriced</span>
            ) : null}
          </span>
          <Button
            size="sm"
            variant="primary"
            icon="tag"
            disabled={sendable.length === 0 || overCsfloatBatch}
            onClick={() => list(sendable)}
          >
            {intent.verb} all {plural(sendable.length, intent.noun)}
          </Button>
        </footer>
      </aside>,
      document.body
    ) : null}
  </>;
}

/** A word or two on the row, with the sentence behind it in a tip. */
function Chip({ icon, text, tone, children }: { icon: IconName; text: string; tone?: 'warn' | 'info' | undefined; children: React.ReactNode }): React.JSX.Element {
  return (
    <Tip content={text}>
      <span className="listing-chip" data-tone={tone}><Icon name={icon} size={11} />{children}</span>
    </Tip>
  );
}

/** What a typed figure has to say for itself, as a chip; an unparsable figure is the field's own to show. */
function NoteChips({ note }: { note: Pricing['note'] }): React.JSX.Element | null {
  if (!note || note.short === null) return null;
  return <Chip icon={note.tone === 'warn' ? 'alert-circle' : 'info'} tone={note.tone} text={note.text}>{note.short}</Chip>;
}

/** One venue's rows added up: how many, what they would pay, what their buyers would. */
function Tally({ venue, count, total, currency, noun }: { venue: Venue; count: number; total: { receiveCents: number; buyerCents: number }; currency: number | null; noun: string }): React.JSX.Element {
  return (
    <span
      className="listing-tally"
      title={`${plural(count, noun)} to ${VENUE[venue].label}, before anything is listed: you receive ${formatAmount(total.receiveCents, currency)} in all, buyers pay ${formatAmount(total.buyerCents, currency)}`}
    >
      <VenueMark venue={venue} size={12} />
      <span className="num">{count.toLocaleString()}</span>
      <span className="listing-figures">
        <span className="num">{formatTick(total.receiveCents, currency)}</span>
        <Icon name="arrow-right" size={11} />
        <span className="num">{formatTick(total.buyerCents, currency)}</span>
        <span className="listing-code">{currencyCodeOf(currency)}</span>
      </span>
    </span>
  );
}

/**
 * Which marketplace, as the venues' marks: a radio per venue the row can reach, and a disabled
 * one, saying why in its tip, for a venue it cannot. A row with one venue and no alternative to
 * explain is a fixed venue and shows the one mark. Each mark carries the venue's name for a
 * reader who cannot see it.
 */
function VenueChoice({ label, value, venues, unavailable, onChange, className }: {
  /** "Marketplace for every row", or for the item by name. */
  label: string;
  value: Venue;
  venues: readonly Venue[];
  unavailable?: Partial<Record<Venue, string>> | undefined;
  onChange: (next: Venue) => void;
  className?: string | undefined;
}): React.JSX.Element {
  const offered = (Object.keys(VENUE) as Venue[]).filter((venue) => venues.includes(venue) || unavailable?.[venue]);
  if (offered.length <= 1) {
    return (
      <span className={['listing-venue', 'listing-venue-fixed', className].filter(Boolean).join(' ')} title={VENUE[value].label}>
        <VenueMark venue={value} size={14} decorative />
        <span className="visually-hidden">{VENUE[value].label}</span>
      </span>
    );
  }
  return (
    <span className={['listing-venue', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
      {offered.map((venue) => {
        const why = venues.includes(venue) ? null : unavailable?.[venue] ?? null;
        return (
          <button
            key={venue}
            type="button"
            role="radio"
            className="listing-venue-item"
            aria-checked={value === venue}
            disabled={why !== null}
            title={why ? `${VENUE[venue].short} — ${why}` : VENUE[venue].label}
            onClick={() => onChange(venue)}
          >
            <VenueMark venue={venue} size={14} decorative />
            <span className="visually-hidden">{VENUE[venue].label}</span>
          </button>
        );
      })}
    </span>
  );
}

/**
 * A price field that says it is one. `parseMoney` already ignores a leading currency mark, so a
 * typed $ is harmless; the class is not called `money`, which this sheet already uses for the
 * cross-venue figure that carries its own currency.
 */
function MoneyInput({ label, currency, value, onChange, disabled, derived, invalid }: {
  label: string;
  /** What a typed figure is in; the mark beside the field says so. */
  currency: number | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
  /** Worked out from the other field rather than typed, which it shows by being quieter. */
  derived?: boolean | undefined;
  /** Typed, and not a price: the field says so itself, in red, rather than a sentence under it. */
  invalid?: boolean | undefined;
}): React.JSX.Element {
  return (
    <span className="price-input">
      <span className="price-input-mark" aria-hidden="true">{currencyCodeOf(currency) || '¤'}</span>
      <input
        className="input input-sm input-money"
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-currency={currencyCodeOf(currency) || undefined}
        inputMode="decimal"
        data-derived={derived || undefined}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

/**
 * *You receive* and *Buyer pays*, side by side, for one row or for every row.
 *
 * Typing into either one makes it the figure that is kept; the other is worked out from the
 * venue's fees and shown quieter. The fee total sits beside the *Buyer pays* label, and its
 * breakdown is in the tooltip, because the difference between the two fields is the whole point.
 */
function PriceFields({ subject, venue, currency, priced, disabled, onChange }: {
  /** "every row", or the item's name; it completes each field's accessible name. */
  subject: string;
  venue: Venue;
  currency: number | null;
  priced: Pricing;
  disabled: boolean;
  onChange: (next: string, basis: PriceBasis) => void;
}): React.JSX.Element {
  const fees = priced.quote ? priced.quote.buyerCents - priced.quote.receiveCents : null;
  const breakdown = priced.quote?.fees.map((fee) => `${fee.name} ${formatAmount(fee.cents, currency)}`).join(' + ') ?? '';
  // The typed figure stays in the account's own currency and is sent as typed (plan D9). With
  // the account-pages toggle on and a rate held, its base-currency equivalent is shown beside
  // it, read-only, so nobody mistakes a converted figure for the price to type.
  const { settings, base, fx } = useCurrency();
  const code = currencyCodeOf(currency);
  const hint = settings.showAccountPagesInBase && priced.quote && code && code !== base ? convert(priced.quote.receiveCents, code, base, fx) : null;
  // Something was typed and it is not a price: the typed field shows it, the other stays quiet.
  const invalid = priced.quote === null && (priced.basis === 'receive' ? priced.receiveText : priced.buyerText).trim() !== '';
  return (
    <>
      {hint ? <span className="listing-control-hint cell-sub" data-testid="price-converted-hint" title={conversionNote(hint)}>you receive {formatConverted(hint)}</span> : null}
      <label className="listing-control">
        <span className="listing-control-label">You receive</span>
        <MoneyInput
          currency={currency}
          label={`You receive for ${subject}`}
          value={priced.receiveText}
          derived={priced.basis !== 'receive'}
          invalid={invalid && priced.basis === 'receive'}
          disabled={disabled}
          onChange={(next) => onChange(next, 'receive')}
        />
      </label>
      <label className="listing-control">
        <span className="listing-control-label">
          Buyer pays
          {fees !== null && fees > 0 ? (
            <span className="listing-control-fee num" title={`${VENUE[venue].label}: ${breakdown}`}>+{formatTick(fees, currency)}</span>
          ) : null}
        </span>
        <MoneyInput
          currency={currency}
          label={`Buyer pays for ${subject}`}
          value={priced.buyerText}
          derived={priced.basis !== 'buyer'}
          invalid={invalid && priced.basis === 'buyer'}
          disabled={disabled}
          onChange={(next) => onChange(next, 'buyer')}
        />
      </label>
    </>
  );
}

/**
 * The shell's slot for the pill, read during render as well as after it.
 *
 * The shell is committed long before a section stages anything, so the slot is normally there on
 * the first render and the pill never passes through the fallback. The layout effect covers the
 * one case it is not — a view mounted in the same commit as the shell — before anything paints.
 */
function useSlot(): Element | null {
  const [slot, setSlot] = useState<Element | null>(() => document.querySelector(SLOT));
  useLayoutEffect(() => {
    const found = document.querySelector(SLOT);
    if (found !== slot) setSlot(found);
  });
  return slot;
}

/**
 * Just under the pill, with its right edge on the right-hand end of the account strip.
 *
 * The top comes from the pill and the right edge from the strip's aside rather than from the pill,
 * because the work indicator beside it widens and narrows as work starts and settles, and a panel
 * that slid sideways under a price being typed would be worse than one a few pixels off its pill.
 * The panel is `position: fixed` (an ancestor mid-animation would otherwise become its containing
 * block), so the measurement has to come back as real pixels.
 */
function usePillAnchor(pill: React.RefObject<HTMLButtonElement | null>, open: boolean, slot: Element | null): { top: number; right: number } {
  const [anchor, setAnchor] = useState(FALLBACK_ANCHOR);
  useLayoutEffect(() => {
    const button = pill.current;
    if (!open || !button) return undefined;
    const edge = button.closest('.account-bar-aside') ?? button;
    const measure = (): void => {
      const top = Math.round(button.getBoundingClientRect().bottom + 8);
      const right = Math.max(12, Math.round(window.innerWidth - edge.getBoundingClientRect().right));
      setAnchor((current) => (current.top === top && current.right === right ? current : { top, right }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(edge);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [pill, open, slot]);
  return anchor;
}

type Pricing = {
  basis: PriceBasis;
  /** The listing the typed figure describes, or `null` when it is not a price. */
  quote: PriceQuote | null;
  /** What the venue's list call is sent, or `null` when there is nothing it would take. */
  listCents: number | null;
  /** The text each field shows: the typed one as typed, the other worked out to the cent. */
  receiveText: string;
  buyerText: string;
  /**
   * Why there is no list price, or how the listing differs from the figure typed. `short` is the
   * chip on the row and `text` the sentence in its tip; a note with no `short` is the field's own
   * to show.
   */
  note: { tone: 'warn' | 'info'; short: string | null; text: string } | null;
};

/** A typed figure, read through one venue's fees. Every price on this screen goes through here. */
function pricing(venue: Venue, currency: number | null, text: string, basis: PriceBasis): Pricing {
  const typed = parseMoney(text);
  const quote = typed === null ? null : basis === 'receive' ? quoteFromReceive(venue, typed) : quoteFromBuyer(venue, typed);
  const receiveText = basis === 'receive' ? text : quote ? dollars(quote.receiveCents) : '';
  const buyerText = basis === 'buyer' ? text : quote ? dollars(quote.buyerCents) : '';
  if (typed === null || quote === null) {
    return { basis, quote: null, listCents: null, receiveText, buyerText, note: { tone: 'warn', short: null, text: 'Not a price.' } };
  }
  const listCents = listPriceOf(venue, quote);
  const minimum = MINIMUM_LIST_CENTS[venue];
  if (listCents < minimum) {
    const least = MARKETPLACE_FEES[venue].listPrice === 'receive' ? quoteFromReceive(venue, minimum) : quoteFromBuyer(venue, minimum);
    return {
      basis, quote, listCents: null, receiveText, buyerText,
      note: {
        tone: 'warn',
        short: `min ${formatTick(least.buyerCents, currency)}`,
        text: `The cheapest ${VENUE[venue].short} listing has the buyer pay ${formatAmount(least.buyerCents, currency)}, which pays you ${formatAmount(least.receiveCents, currency)}.`
      }
    };
  }
  // Not every buyer price exists on a venue that adds its fees on top: 44¢ does not on Steam.
  // The row lists at the nearest one below, and says so rather than listing a figure nobody typed.
  const shown = basis === 'receive' ? quote.receiveCents : quote.buyerCents;
  const note = shown === typed
    ? null
    : {
      tone: 'info' as const,
      short: `lists at ${formatTick(quote.buyerCents, currency)}`,
      text: `No ${VENUE[venue].short} listing has the buyer pay ${formatAmount(typed, currency)}. The nearest below is ${formatAmount(quote.buyerCents, currency)}, which pays you ${formatAmount(quote.receiveCents, currency)}.`
    };
  return { basis, quote, listCents, receiveText, buyerText, note };
}

/**
 * A row's figure, read through its venue — and, for a standing listing, against what it is
 * already listed at. A figure that changes nothing is still a price, so both fields show it, but
 * it is not something to send.
 */
function pricingOf(row: StagedRow<StagedEntry>, currency: number | null): Pricing {
  const priced = pricing(row.venue, currency, row.price, row.basis);
  if (priced.listCents === null || priced.listCents !== row.entry.currentListCents) return priced;
  return { ...priced, listCents: null, note: { tone: 'info', short: 'unchanged', text: 'This is the price it is already listed at.' } };
}

/** A row's list price in integer cents, or `null` when it has none its venue would take. */
function priceOf(row: StagedRow<StagedEntry>, currency: number | null): number | null {
  return pricingOf(row, currency).listCents;
}

/**
 * The bid level that takes the `unit`th unit of a name (counting from zero), walking the levels
 * best-first by the units each rests for; `null` once the orders are used up.
 */
function levelForUnit(bids: readonly BookLevel[], unit: number): number | null {
  let seen = 0;
  for (const level of bids) {
    seen += level.quantity;
    if (unit < seen) return level.priceCents;
  }
  return null;
}

/** Both figures, summed over rows that each have a list price. */
function tally(rows: ReadonlyArray<StagedRow<StagedEntry>>, currencyOf: (row: StagedRow<StagedEntry>) => number | null): { receiveCents: number; buyerCents: number } {
  return rows.reduce((sum, row) => {
    const quote = pricing(row.venue, currencyOf(row), row.price, row.basis).quote;
    return quote ? { receiveCents: sum.receiveCents + quote.receiveCents, buyerCents: sum.buyerCents + quote.buyerCents } : sum;
  }, { receiveCents: 0, buyerCents: 0 });
}
