import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MARKETPLACE_FEES, listPriceOf, quoteFromBuyer, quoteFromReceive, steamFeeMinimumCents, type FeeTerms, type PriceQuote } from '@cslytics/ports';
import { Button, Caption, IconButton, Select, Thumbnail } from './ui.js';
import { Icon, type IconName } from './Icon.js';
import { Tip } from './Tip.js';
import { VenueMark } from './VenueMark.js';
import { OrderBookLine } from './OrderBookLine.js';
import { CompactAccessories } from './AccessoryStrip.js';
import { useOutbox } from '../features/work/WorkIndicator.js';
import { priceAtFloat } from '../features/items/curve-math.js';
import { formatFloat, wearTier } from '../lib/format.js';
import { convert, type BookLevel, type StoredCurve } from '@cslytics/market-data';
import { parseMoney, plural } from '../lib/labels.js';
import { useNowUntil } from '../lib/clock.js';
import { feeTermsNow } from '../lib/wallet-minimums.js';
import { useCurrency } from '../lib/currency.js';
import { engine } from '../lib/engine.js';
import { bookKey, useOrderBooks } from '../lib/order-books.js';
import { useCslytics } from '../lib/cslytics.js';
import { SignInLock } from './SignInLock.js';
import { FEATURE_STEAM_MARKET, curveFeature, hasFeature, lockReason } from '../../shared/command-access.js';
import { conversionNote, currencyCodeOf, formatAmount, formatConverted, formatTick, type CurrencyRef } from '../lib/money.js';
import { extensions, type ListingStrategyPreview, type ListingStrategySend, type ListingStrategyView } from '../lib/extensions.js';
import {
  EMPTY,
  bulkVenueOf,
  dollars,
  heldSendOf,
  LISTING_STRATEGY_KIND,
  planRow,
  reduce,
  rowListingStrategy,
  sendsInLabel,
  venueCurrency,
  type Applied,
  type CurrentListingStrategy,
  type ListingStrategyOption,
  type PriceBasis,
  type RowPlan,
  type StagedEntry,
  type StagedRow,
  type StrategyId,
  type Venue,
  type WorkspaceAction,
  type WorkspaceIntent,
  type WorkspaceState
} from './listing-workspace-store.js';
import type { OutboxOutcome } from '../features/work/outbox.js';

/**
 * The listing strategies this build offers (`lib/extensions.ts`). The desktop offers none: no row
 * shows the control, and every row is listed at the price typed, as it always was.
 */
const LISTING_STRATEGIES = extensions.listingStrategies;
const NO_STRATEGY_VIEW: ListingStrategyView = { options: null, current: new Map(), reading: new Set(), previews: new Map(), error: null };
function useNoListingStrategies(): ListingStrategyView {
  return NO_STRATEGY_VIEW;
}
/** Chosen once, as the module loads, so every render calls the same hook. */
const useListingStrategyView = LISTING_STRATEGIES?.useView ?? useNoListingStrategies;
/** The select's value for none, and for the every-row control's "leave each row as it is". */
const NO_STRATEGY = '';
const KEEP_STRATEGY = '\u0000keep';

/** What a venue is called on screen. What it charges is `MARKETPLACE_FEES`, and nowhere else. */
const VENUE: Readonly<Record<Venue, { label: string; short: string }>> = {
  steam: { label: MARKETPLACE_FEES.steam.label, short: 'Steam' },
  csfloat: { label: MARKETPLACE_FEES.csfloat.label, short: 'CSFloat' }
};

/**
 * The least each venue lists at, in the figure its list call takes. CSFloat's is the `csfloat.list`
 * request schema's (`apps/desktop/src/shared/api.ts`); a Steam listing has to pay its seller the
 * wallet's minimum (`steamFeeMinimumCents`): what the wallet's own read stated, or by the fee table
 * a cent, and 2¢ on an AUD wallet from 2026-11-21.
 */
function minimumListCents(venue: Venue, terms: FeeTerms): number {
  return venue === 'steam' ? steamFeeMinimumCents(terms.walletCurrency, terms.at, terms.walletMinimumCents) : 3;
}

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
 *
 * **A row its venue is not taking yet says when it sends.** A Steam listing's price can change
 * once every five minutes, and a row staged inside that time, once a new price is typed on it,
 * carries a chip that counts down to it (`StagedEntry.heldUntil`, `heldSendOf`); a row still at
 * the price it has sends nothing and says nothing about when. Staging the listing again reads the
 * time again. Its button stays enabled: the engine holds a change sent early and sends it when the
 * wait ends, and the work panel shows it waiting.
 *
 * **Every row opens its Items page.** The press folds the panel, because the page is what the
 * price is decided against, and the page's float curve marks every unit of that name staged here
 * at the price typed for it (`features/items/staged-marks.ts`); the pill is the way back.
 *
 * **A build may offer listing strategies** (`lib/extensions.ts`), and the desktop offers none, so
 * none of this shows there. With them, every row and the controls for every row have a *Listing
 * strategy*: none, which is everything above (the price typed, sent by hand, and nothing reprices
 * it), or a strategy the row is handed to, which lists it and keeps it listed. A row opens on what
 * it is under now. One on a strategy that sets its own price shows what it would list at where the
 * two fields were. What each press sends is `planRow`'s: a hand-over, a strategy letting go, the
 * typed price, or a strategy letting go and then the typed price, in one send.
 */
export function ListingWorkspace<E extends StagedEntry>({ workspace, accounts, onOpenItem }: {
  workspace: Workspace<E>;
  /** Each account with its wallet currency, which every Steam figure here is in; CSFloat figures are USD. */
  accounts: ReadonlyArray<{ id: string; name: string; currency?: number | null | undefined }>;
  /** Opens a market name's Items page; without it a row offers no way there. */
  onOpenItem?: ((name: string) => void) | undefined;
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
  // The book and the curves are behind the CSlytics sign-in (pricing behind sign-in plan §7.6):
  // while it is locked, or not yet known, no book is read and no curve asked for. A typed price,
  // the venue choice and List are never locked.
  const cslytics = useCslytics();
  const marketLocked = cslytics === null || lockReason(cslytics, FEATURE_STEAM_MARKET) !== null;
  const curveHeld = (venue: Venue): boolean => cslytics !== null && hasFeature(cslytics, curveFeature(venue));
  const books = useOrderBooks(marketLocked ? [] : keys, open);
  // The float curves asked for, by venue and name. Only an answer is kept: a read that failed is asked again next press.
  const curves = useRef(new Map<string, StoredCurve | null>());
  const [curving, setCurving] = useState(false);
  const { fx } = useCurrency();
  // What the build's listing strategies say about these rows: what each is under now, what can be
  // chosen, and what a strategy that prices a row itself would list it at.
  const strategyRows = useMemo(() => shown.map((row) => ({ key: row.key, entry: row.entry, venue: row.venue, chosen: row.listingStrategy })), [shown]);
  const strategies = useListingStrategyView(strategyRows, open);

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

  /** The currency a row's figures are in (`venueCurrency`). A typed price is in it and is sent as typed. */
  const currencyFor = (venue: Venue, accountId: string): number | null => venueCurrency(venue, accounts.find((account) => account.id === accountId)?.currency);
  const rowCurrency = (row: StagedRow<StagedEntry>): number | null => currencyFor(row.venue, row.entry.accountId);
  /** One currency for rows on one venue, or none when accounts with different wallets are mixed in. */
  const currencyOfRows = (venue: Venue, rows: ReadonlyArray<StagedRow<StagedEntry>>): number | null => {
    const codes = new Set(rows.filter((row) => row.venue === venue).map((row) => currencyFor(venue, row.entry.accountId)));
    return codes.size === 1 ? [...codes][0]! : null;
  };
  const options = strategies.options ?? [];
  const currentOf = (row: StagedRow<StagedEntry>): CurrentListingStrategy | null => strategies.current.get(row.key) ?? null;
  /** What a row's press sends (`planRow`). A row whose strategy is still being read sends nothing yet. */
  const planOf = (row: StagedRow<StagedEntry>): RowPlan => {
    if (LISTING_STRATEGIES && row.listingStrategy === undefined && strategies.reading.has(row.key)) return { kind: 'blocked', why: 'Reading its listing strategy.' };
    const currency = rowCurrency(row);
    const typed = pricing(row.venue, currency, row.price, row.basis);
    return planRow({
      chosen: row.listingStrategy,
      current: currentOf(row),
      options,
      venue: row.venue,
      priced: typed.listCents !== null,
      changed: priceOf(row, currency) !== null,
      buyerCents: typed.listCents !== null ? typed.quote?.buyerCents ?? null : null
    });
  };
  const plans = new Map(shown.map((row) => [row.key, planOf(row)]));
  const planFor = (row: StagedRow<StagedEntry>): RowPlan => plans.get(row.key) ?? planOf(row);
  const sends = (plan: RowPlan): boolean => plan.kind === 'price' || plan.kind === 'release' || plan.kind === 'assign';
  const sendable = shown.filter((row) => sends(planFor(row)));
  const priceRows = sendable.filter((row) => planFor(row).kind === 'price');
  const steamRows = priceRows.filter((row) => row.venue === 'steam');
  const csfloatRows = priceRows.filter((row) => row.venue === 'csfloat');
  // Rows handed to a strategy, or let go by one: no price of theirs is sent from here.
  const strategyBound = sendable.length - priceRows.length;
  /** The option a row is on, when it is one a row can be handed to. */
  const optionOf = (row: StagedRow<StagedEntry>): ListingStrategyOption | null => {
    const id = rowListingStrategy(row.listingStrategy, currentOf(row));
    return id === null ? null : options.find((option) => option.id === id) ?? null;
  };
  /** The row is on a strategy that sets its price, so the price typed here is not what is sent. */
  const pricedByStrategy = (row: StagedRow<StagedEntry>): boolean => {
    if (rowListingStrategy(row.listingStrategy, currentOf(row)) === null) return false;
    return !(optionOf(row)?.takesPrice ?? false);
  };
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
   * The float price for each row: its marketplace's curve at its float, from CSlytics behind the
   * sign-in, through main (`item.curve`, which records an absence rather than asking again). A row
   * whose venue's curves the grant does not hold is left alone, and nothing is asked for it. The curve is in USD;
   * a row in another currency takes the figure through the newest rate, or is left alone when
   * there is none. This is the one converted figure that is ever sent (AGENTS.md rule 9): the fair
   * price is an estimate, and an estimate converted is still one.
   */
  async function floatOutcomes(): Promise<Map<string, Outcome>> {
    const wanted = new Map<string, { venue: Venue; name: string }>();
    for (const row of shown) {
      const name = row.entry.marketHashName;
      if (name && curveHeld(row.venue)) wanted.set(`${row.venue}:${name}`, { venue: row.venue, name });
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
      if (!curveHeld(row.venue)) { outcomes.set(row.key, { skip: 'without a CSlytics sign-in' }); continue; }
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
    const planned = targets.map((row) => ({ row, plan: planFor(row) })).filter(({ plan }) => sends(plan));
    if (planned.length === 0) return;
    const byKey = new Map(planned.map(({ row }) => [row.key, row]));
    workspace.hand(planned.map(({ row }) => row.key));
    const priced = planned.filter(({ plan }) => plan.kind === 'price');
    // A row a strategy held and a person now prices is let go first, in the same send, so the
    // strategy never reprices what was just priced by hand, and a refusal of either returns it here.
    const releaseFirst = new Set(planned.flatMap(({ row, plan }) => (plan.kind === 'price' && plan.release ? [row.key] : [])));
    const batches: ListingStrategySend[] = intent.batches(priced.map(({ row }) => ({ entry: row.entry, venue: row.venue, cents: priceOf(row, rowCurrency(row))! }))).map((batch) => {
      const releasing = batch.keys.filter((key) => releaseFirst.has(key)).map((key) => byKey.get(key)!.entry);
      const ext = LISTING_STRATEGIES;
      if (!ext || releasing.length === 0) return batch;
      return { ...batch, send: async () => { await ext.release(releasing, 'none'); return batch.send(); } };
    });
    const ext = LISTING_STRATEGIES;
    if (ext) {
      for (const to of ['none', 'fallback'] as const) {
        const rows = planned.flatMap(({ row, plan }) => (plan.kind === 'release' && plan.to === to ? [row] : []));
        if (rows.length > 0) batches.push({ venue: rows[0]!.venue, kind: LISTING_STRATEGY_KIND, keys: rows.map((row) => row.key), send: () => ext.release(rows.map((row) => row.entry), to) });
      }
      const assigning = planned.flatMap(({ row, plan }) => (plan.kind === 'assign'
        ? [{ entry: row.entry, venue: row.venue, strategy: plan.strategy, buyerCents: optionOf(row)?.takesPrice ? pricing(row.venue, rowCurrency(row), row.price, row.basis).quote?.buyerCents ?? null : null }]
        : []));
      if (assigning.length > 0) batches.push(...ext.assign(assigning));
    }
    for (const batch of batches) {
      outbox.enqueue({
        kind: batch.kind,
        items: batch.keys.map((key) => {
          const row = byKey.get(key)!;
          const receive = receiveOf(row);
          return {
            key,
            accountId: row.entry.accountId,
            name: row.entry.name,
            imageUrl: row.entry.imageUrl,
            localId: row.entry.localId ?? null,
            receiveCents: receive.cents,
            currency: receive.currency
          };
        }),
        send: batch.send,
        onSettled: (outcome) => workspace.settle(batch.keys, outcome)
      });
    }
  }

  /**
   * What the seller receives for a row as it is sent, and the currency it is in: the typed price in
   * the row's currency, or the strategy's in its own when it prices the row. The work panel prints
   * the figure in that currency, since a row handed to a strategy names no marketplace to read it from.
   */
  function receiveOf(row: StagedRow<StagedEntry>): { cents: number | null; currency: CurrencyRef } {
    if (!pricedByStrategy(row)) {
      const currency = rowCurrency(row);
      return { cents: pricing(row.venue, currency, row.price, row.basis).quote?.receiveCents ?? null, currency };
    }
    const preview = strategies.previews.get(row.key);
    return preview?.state === 'priced' ? { cents: preview.receiveCents, currency: preview.currency } : { cents: null, currency: null };
  }

  if (shown.length === 0) return null;

  const steamTotal = tally(steamRows, rowCurrency);
  const csfloatTotal = tally(csfloatRows, rowCurrency);
  const steamCurrency = currencyOfRows('steam', steamRows);
  // A standing listing still at its own price is priced, just not worth sending; so is a row left on
  // the strategy it is under. Only a row with no figure its venue would take, or a choice that
  // cannot be sent from it, is missing something.
  const unchanged = shown.filter((row) => planFor(row).kind === 'unchanged').length;
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
            title="Close and unstage everything. The items stay selected."
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
                      disabled={curving || (entry.id === 'float' ? !(curveHeld('steam') || curveHeld('csfloat')) : marketLocked)}
                      onClick={() => { void pressStrategy(entry.id); }}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
                {marketLocked && cslytics ? (
                  <SignInLock
                    status={cslytics}
                    feature={FEATURE_STEAM_MARKET}
                    shape="inline"
                    title="Price from the market"
                    tip="Sell now, Top bid and Undercut price from the Steam order book, and Float price from the float curve. A price you type works without signing in."
                    testId="workspace-pricing-lock"
                  />
                ) : null}
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
                      title="Every row takes this price and marketplace, including rows priced by hand"
                      onClick={() => dispatch({ type: 'apply' })}
                    />
                    <Tip label="How the controls for every row work" content="Type either figure and the other follows from that marketplace's fees. A row you price or route yourself keeps that until you apply to all." />
                  </span>
                </div>
                <NoteChips note={bulkPriced.note} />
                {LISTING_STRATEGIES ? (
                  <div className="listing-strategy-line">
                    <span className="listing-control-label">Listing strategy</span>
                    <StrategySelect
                      label="Listing strategy for every row"
                      keep
                      value={bulk.listingStrategy === undefined ? KEEP_STRATEGY : bulk.listingStrategy.id ?? NO_STRATEGY}
                      options={options}
                      onChange={(next) => dispatch({
                        type: 'listingStrategyAll',
                        strategy: next === KEEP_STRATEGY ? undefined : next === NO_STRATEGY ? { id: null, venues: null } : { id: next, venues: options.find((option) => option.id === next)?.venues ?? null }
                      })}
                    />
                    <Tip label="How the listing strategy for every row works" content="Written on every row that has not chosen its own and whose marketplace the strategy lists on. None lists each row at the price typed, and nothing reprices it after. Apply to all writes it on every row." />
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          {strategies.error ? <Caption icon="alert-triangle" tone="warn">Listing strategies could not be read: {strategies.error}</Caption> : null}

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
              const tier = wearTier(entry.paintWear);
              const caption = entry.venueCaption?.[row.venue] ?? entry.caption;
              const quote = entry.marketHashName ? books.get(bookKey(entry.accountId, entry.marketHashName)) : undefined;
              const plan = planFor(row);
              const current = currentOf(row);
              const byStrategy = pricedByStrategy(row);
              // The price note is about the typed figure, which a strategy that sets the price ignores;
              // and a row handed over or let go sends something even at the price it is listed at.
              const note = byStrategy ? null : plan.kind === 'assign' || plan.kind === 'release' ? pricing(row.venue, currency, row.price, row.basis).note : priced.note;
              const planChip = chipOfPlan(plan, current, intent.verb, labelOfStrategy(rowListingStrategy(row.listingStrategy, current), options, current));
              const chosen = optionOf(row);
              // "Sends in" only while the press would send a price the venue holds (`heldSendOf`).
              const held = heldSendOf(entry, plan);
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
                        {/* What is applied is part of what is being priced: two copies at one float
                            are not one price if one carries a sticker. */}
                        <CompactAccessories accessories={entry.accessories} />
                        {multiAccount ? <span className="listing-row-account">{accountName(entry.accountId)}</span> : null}
                      </span>
                      {entry.marketHashName && !marketLocked ? (
                        <OrderBookLine
                          quote={quote}
                          currency={currency}
                          onPick={(figure) => dispatch({ type: 'price', key: row.key, price: dollars(figure), basis: 'buyer' })}
                        />
                      ) : null}
                    </span>
                    {/* What the row has to say beyond its figures, on a line of its own so the
                        facts and the book above it keep theirs. */}
                    {caption || held || (note && note.short !== null) || planChip ? (
                      <span className="listing-row-chips">
                        {caption ? <Chip icon={caption.icon} text={caption.text}>{caption.short}</Chip> : null}
                        {held ? <HeldChip until={held.at} why={held.why} /> : null}
                        <NoteChips note={note} />
                        {planChip ? <Chip icon={planChip.icon} tone={planChip.tone} text={planChip.text}>{planChip.short}</Chip> : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="listing-row-tools">
                    {/* The item's page, where this row and every other of its name sit on the
                        float curve at their prices. The press folds the panel off the page. */}
                    {onOpenItem && entry.marketHashName ? (
                      <IconButton
                        icon="trending-up"
                        size="sm"
                        className="listing-row-page"
                        data-testid="listing-row-item-page"
                        label={`Item page for ${entry.name}`}
                        onClick={() => { dispatch({ type: 'fold' }); onOpenItem(entry.marketHashName!); }}
                      />
                    ) : null}
                    {/* Taking a row out, and emptying the workspace — pill and all — by taking out
                        the last one. The row stays selected, so the next staging brings it back. */}
                    <IconButton
                      icon="x"
                      size="sm"
                      className="listing-row-drop"
                      label={`Take ${entry.name} off the list`}
                      onClick={() => dispatch({ type: 'drop', key: row.key })}
                    />
                  </span>

                  {/* Who lists the row and keeps it listed: none (the price typed, by hand) or a
                      strategy the build offers. It opens on what the row is under now. */}
                  {LISTING_STRATEGIES ? (
                    <div className="listing-strategy-line">
                      <span className="listing-control-label">Listing strategy</span>
                      <StrategySelect
                        label={`Listing strategy for ${entry.name}`}
                        value={rowListingStrategy(row.listingStrategy, current) ?? NO_STRATEGY}
                        options={options}
                        current={current}
                        venue={row.venue}
                        disabled={row.listingStrategy === undefined && strategies.reading.has(row.key)}
                        onChange={(next) => dispatch({ type: 'listingStrategy', key: row.key, strategy: next === NO_STRATEGY ? null : next })}
                      />
                      {chosen ? <Tip label={`About ${chosen.label}`} content={chosen.title} /> : current && rowListingStrategy(row.listingStrategy, current) === current.id ? <Tip label={`About ${current.label}`} content={current.title} /> : null}
                    </div>
                  ) : null}

                  <div className="listing-controls">
                    {byStrategy ? (
                      <StrategyPrice
                        label={labelOfStrategy(rowListingStrategy(row.listingStrategy, current), options, current)}
                        preview={strategies.previews.get(row.key)}
                      />
                    ) : (
                      <PriceFields
                        currency={currency}
                        subject={entry.name}
                        venue={row.venue}
                        priced={priced}
                        disabled={false}
                        onChange={(price, basis) => dispatch({ type: 'price', key: row.key, price, basis })}
                      />
                    )}

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
                      disabled={!sends(plan)}
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
            {strategyBound > 0 ? (
              <span className="listing-tally" title={`${plural(strategyBound, intent.noun)} handed to a listing strategy, or let go by one: no price of theirs is sent from here`}>
                <Icon name="route" size={12} />{strategyBound.toLocaleString()} to strategies
              </span>
            ) : null}
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

/** What a strategy id is called: its option's label, else what the row is under now or goes back to. */
function labelOfStrategy(id: string | null, options: readonly ListingStrategyOption[], current: CurrentListingStrategy | null): string {
  if (id === null) return 'None';
  const option = options.find((candidate) => candidate.id === id);
  if (option) return option.label;
  if (current?.id === id) return current.label;
  if (current?.fallback?.id === id) return current.fallback.label;
  return id;
}

/**
 * The listing strategy control: none, what the row is under now when it is a default rather than
 * a strategy it was handed to, what an assigned row goes back to, and every strategy on offer. One
 * that does not list on the row's marketplace is shown, disabled, saying where it does.
 */
function StrategySelect({ label, value, options, current, venue, keep, disabled, onChange }: {
  label: string;
  value: string;
  options: readonly ListingStrategyOption[];
  current?: CurrentListingStrategy | null | undefined;
  /** The row's marketplace; absent for the control over every row. */
  venue?: Venue | undefined;
  /** Offer "each row's own", which writes nothing: the control over every row. */
  keep?: boolean | undefined;
  disabled?: boolean | undefined;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const extra: Array<{ id: string; label: string }> = [];
  if (current && !current.assigned) extra.push({ id: current.id, label: `${current.label} (now)` });
  if (current?.assigned && current.fallback) extra.push({ id: current.fallback.id, label: current.fallback.label });
  if (current?.assigned && !options.some((option) => option.id === current.id)) extra.push({ id: current.id, label: `${current.label} (now)` });
  return (
    <Select className="listing-strategy-select" label={label} value={value} disabled={disabled} onChange={onChange}>
      {keep ? <option value={KEEP_STRATEGY}>Each row's own</option> : null}
      <option value={NO_STRATEGY}>None: the price typed, by hand</option>
      {extra.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      {options.map((option) => {
        const reachable = venue === undefined || option.venues.includes(venue);
        const now = current?.assigned === true && current.id === option.id;
        return (
          <option key={option.id} value={option.id} disabled={!reachable}>
            {option.label}{now ? ' (now)' : ''}{reachable ? '' : ` (${option.venues.map((name) => VENUE[name].short).join(', ')} only)`}
          </option>
        );
      })}
    </Select>
  );
}

/** In place of the price fields, for a row on a strategy that sets its price: what it would list at now. */
function StrategyPrice({ label, preview }: { label: string; preview: ListingStrategyPreview | undefined }): React.JSX.Element {
  // The line is the width of the two fields it replaces, and the control above it names the
  // strategy, so the line says the figures; the whole sentence is its tip.
  let text = `${label} sets the price`;
  let tip = `${label} sets the price, and changes it as it reprices.`;
  let tone: 'warn' | undefined;
  if (preview?.state === 'reading') {
    text = 'Reading its price…';
    tip = `Reading what ${label} would list it at now.`;
  } else if (preview?.state === 'priced') {
    const buyer = formatAmount(preview.buyerCents, preview.currency);
    const receive = preview.receiveCents === null ? null : formatAmount(preview.receiveCents, preview.currency);
    text = `Lists at ${formatTick(preview.buyerCents, preview.currency)}${preview.receiveCents === null ? '' : ` · you get ${formatTick(preview.receiveCents, preview.currency)}`}`;
    tip = `${label} would list it now with the buyer paying ${buyer}${receive ? `, which pays you ${receive}` : ''}. It changes the price as it reprices.`;
  } else if (preview?.state === 'waiting') {
    text = `Waits: ${preview.why}`;
    tip = `${label} would not list it yet: ${preview.why}. It lists it once it can.`;
    tone = 'warn';
  } else if (preview?.state === 'failed') {
    text = 'Its price could not be read';
    tip = `What ${label} would list it at could not be read: ${preview.why}`;
    tone = 'warn';
  }
  return (
    <span className="listing-strategy-price" data-tone={tone} data-testid="listing-strategy-price">
      <Icon name="route" size={12} />
      <span title={tip}>{text}</span>
    </span>
  );
}

/** What a row's plan has to say beyond its figures, as a chip; `null` when it is the ordinary one. */
function chipOfPlan(plan: RowPlan, current: CurrentListingStrategy | null, verb: string, chosen: string): { icon: IconName; tone?: 'warn' | 'info'; short: string; text: string } | null {
  switch (plan.kind) {
    case 'blocked':
      return { icon: 'alert-circle', tone: 'warn', short: 'Not sent', text: plan.why };
    case 'assign':
      return { icon: 'route', tone: 'info', short: 'Hands over', text: `${verb} hands it to ${chosen}, which lists it and keeps it listed from then on. Nothing is listed by hand from here.` };
    case 'release':
      return plan.to === 'fallback'
        ? { icon: 'route', tone: 'info', short: 'Back to default', text: `${verb} takes it from ${current?.label ?? 'its strategy'}, and ${chosen} lists it again.` }
        : { icon: 'route', tone: 'info', short: 'Lets go', text: `${verb} takes it from ${current?.label ?? 'its strategy'}. It stays at the price it is listed at, and nothing reprices it.` };
    case 'price':
      return plan.release
        ? { icon: 'route', tone: 'info', short: 'Lets go', text: `It is under ${current?.label ?? 'a strategy'}, which lets it go first. Then it is listed at the price typed, and nothing reprices it.` }
        : null;
    default:
      return null;
  }
}

/** A word or two on the row, with the sentence behind it in a tip. */
function Chip({ icon, text, tone, children }: { icon: IconName; text: string; tone?: 'warn' | 'info' | undefined; children: React.ReactNode }): React.JSX.Element {
  return (
    <Tip content={text}>
      <span className="listing-chip" data-tone={tone}><Icon name={icon} size={11} />{children}</span>
    </Tip>
  );
}

/**
 * The countdown on a row its venue is not taking yet: "Sends in 3:41", with why in its tip. It
 * reads the clock itself, so the second that passes re-renders this chip and not the workspace,
 * and it is gone, and done with the clock, once the wait is over.
 */
function HeldChip({ until, why }: { until: number; why: string }): React.JSX.Element | null {
  const label = sendsInLabel(until, useNowUntil(until));
  return label === null ? null : <span data-testid="listing-row-held"><Chip icon="clock" tone="info" text={why}>{label}</Chip></span>;
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
            title={why ? `${VENUE[venue].short}: ${why}` : VENUE[venue].label}
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

/**
 * A typed figure, read through one venue's fees. Every price on this screen goes through here. It
 * is priced to list now from a wallet in `currency` (`FeeTerms`): Steam's minimum fee is the one
 * the wallet's own read stated (`lib/wallet-minimums.ts`), and a wallet that has stated none is
 * charged by the fee table.
 */
function pricing(venue: Venue, currency: number | null, text: string, basis: PriceBasis): Pricing {
  const terms: FeeTerms = feeTermsNow(currency);
  const typed = parseMoney(text);
  const quote = typed === null ? null : basis === 'receive' ? quoteFromReceive(venue, typed, terms) : quoteFromBuyer(venue, typed, terms);
  const receiveText = basis === 'receive' ? text : quote ? dollars(quote.receiveCents) : '';
  const buyerText = basis === 'buyer' ? text : quote ? dollars(quote.buyerCents) : '';
  if (typed === null || quote === null) {
    return { basis, quote: null, listCents: null, receiveText, buyerText, note: { tone: 'warn', short: null, text: 'Not a price.' } };
  }
  const listCents = listPriceOf(venue, quote);
  const minimum = minimumListCents(venue, terms);
  // Typed in the figure the venue lists at, a price under its minimum is under the cheapest
  // listing: Steam would raise it to the minimum's listing, and a figure sent is never moved.
  const asked = basis === MARKETPLACE_FEES[venue].listPrice ? typed : listCents;
  if (Math.min(asked, listCents) < minimum) {
    const least = MARKETPLACE_FEES[venue].listPrice === 'receive' ? quoteFromReceive(venue, minimum, terms) : quoteFromBuyer(venue, minimum, terms);
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
