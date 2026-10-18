import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MARKETPLACE_FEES, listPriceOf, quoteFromBuyer, quoteFromReceive, type PriceQuote } from '@cslytics/ports';
import { Button, Caption, IconButton, Select, Thumbnail } from './ui.js';
import { Icon, type IconName } from './Icon.js';
import { VenueMark } from './VenueMark.js';
import { useOutbox } from '../features/work/WorkIndicator.js';
import { formatFloat, wearTier } from '../lib/format.js';
import { convert } from '@cslytics/market-data';
import { parseMoney, plural } from '../lib/labels.js';
import { useCurrency } from '../lib/currency.js';
import { conversionNote, currencyCodeOf, formatAmount, formatConverted } from '../lib/money.js';
import type { OutboxOutcome } from '../features/work/outbox.js';
import type { Message } from './ui.js';

export type Venue = 'steam' | 'csfloat';

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

/** Which of the two money fields a figure was typed into. The other follows from the venue's fees. */
export type PriceBasis = 'receive' | 'buyer';

/**
 * `csfloat.list` takes at most 100 members (`apps/desktop/src/shared/api.ts`). The bound is shown
 * and enforced here rather than left to the schema, because a refusal from the request validator
 * names no item and gives the person nothing to act on.
 */
const CSFLOAT_BATCH = 100;

/** The element the shell leaves in the account strip for this workspace's pill (`App.tsx`). */
const SLOT = '[data-slot="listing-workspace"]';

/** Where the panel sits before its pill has been measured — the window's own top right. */
const FALLBACK_ANCHOR = { top: 56, right: 12 };

/** `handed`: in the window's outbox. Off screen, and back as `refused` if the engine turns it down. */
type RowState = 'ready' | 'handed' | 'refused';

/**
 * One thing the workspace prices: an item about to be listed, or a standing listing about to be
 * repriced. It carries what a row prints and nothing about how it is sent — that is the intent's.
 */
export type StagedEntry = {
  /** Stable for as long as the thing is staged. Staging the same key twice is one row. */
  key: string;
  accountId: string;
  name: string;
  imageUrl: string | null;
  paintWear: number | null;
  /** The handle a tile's busy state keys on, so the item reads as busy while its send is out. */
  localId?: string | null | undefined;
  /** Where it is, or what it is listed at: the fact the price is being decided against. */
  place: { icon: IconName; label: string };
  /** A step that sending implies before the listing itself, said before it is sent. */
  caption?: { icon: IconName; text: string } | undefined;
  /**
   * The same, for one marketplace, when it differs there. Staged before the marketplace is chosen,
   * so the row prints the one for whichever is selected now.
   */
  venueCaption?: Partial<Record<Venue, { icon: IconName; text: string }>> | undefined;
  /** The venues this entry can go to, the default first. One venue is a fixed venue. */
  venues: readonly Venue[];
  /**
   * Venues shown in the marketplace control but not choosable, each with why, worded to follow the
   * venue's name: "does not support this item". A venue in neither list is not shown at all.
   */
  unavailable?: Partial<Record<Venue, string>> | undefined;
  /** The figure the row opens with. Absent, it opens with the workspace's own. */
  seed?: { price: string; basis: PriceBasis } | undefined;
  /**
   * What it is listed at now, in the figure its venue's call takes. A row still at this figure
   * has nothing to send: on Steam a reprice is a delist and a relist, and the relist costs a
   * phone confirmation, so sending one that changes nothing is not harmless.
   */
  currentListCents?: number | undefined;
};

/** A row with a price its venue would take, as an intent is handed it. */
export type PricedEntry<E extends StagedEntry> = { entry: E; venue: Venue; cents: number };

/**
 * What the workspace is being used to do.
 *
 * Listing and repricing are the same work — a figure per row, read through a venue's fees, sent
 * and then waited on — and differ only in words and in the call at the end. So the dock is one
 * component and this is the difference. Listing's is `list-intent.ts`; repricing's belongs to the
 * Listings page.
 */
export type WorkspaceIntent<E extends StagedEntry> = {
  /** "List", "Reprice": the button on a row, and the start of the footer's. */
  verb: string;
  /** What a row is: "item", "listing". */
  noun: string;
  /** What a venue turned down, for the notice that carries its words: "the listing". */
  refused: string;
  /**
   * The sends these rows need, one per thing a venue accepts or refuses as a whole. A send that
   * throws marks exactly its own rows refused, with the engine's words. `kind` is the work it
   * becomes, as the work panel names it (`DESTINATION`), so the panel can say what it is before
   * the engine has it.
   */
  batches: (rows: ReadonlyArray<PricedEntry<E>>) => Array<{ venue: Venue; kind: string; keys: readonly string[]; send: () => Promise<unknown> }>;
};

type Staged<E extends StagedEntry> = {
  key: string;
  entry: E;
  /** The venues this row's own verdict allows. Never widened by a bulk control. */
  venues: readonly Venue[];
  venue: Venue;
  /** The figure as typed, into the field `basis` names. */
  price: string;
  basis: PriceBasis;
  /** This row's price was typed here, so a change to the price for every row leaves it alone. */
  ownPrice: boolean;
  /** Likewise for its marketplace. */
  ownVenue: boolean;
  state: RowState;
  /** The engine's words, verbatim, when it refused this row's batch. */
  detail?: string | undefined;
};


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
 * **It lives in the account strip, not in a window of its own.** A pill left of the work
 * indicator is there whenever the workspace holds a row and gone the moment it does not; the
 * panel opens under it, over everything else. Staging is the step before the work indicator has
 * anything to say, so the two sit side by side. It was a modal drawer once and that was wrong
 * twice over: a scrim blocked the very list a person needs in order to decide a price, and
 * dismissing it was unrecoverable — the inspector would only open it again from a selection with
 * no work in flight, so closing it over a row that had just been sent left no way back to that
 * row at all. It was then a free-floating dock over the work area, which covered the section it
 * was pricing from even when collapsed. Folding the panel into its pill is therefore the ordinary
 * gesture, the pill is always the way back, and the close button is destructive: it empties the
 * staging.
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
 */
export function ListingWorkspace<E extends StagedEntry>({ staged, intent, reveal, accounts, price = '', onPrice, onMessage, onSent, onUnstaged, onDismiss }: {
  /**
   * What is staged. A row is seeded from its entry once and never again, so nothing here re-seeds
   * under a row that has already been priced or sent: the caller remounts this component (a fresh
   * `key`) to start a new set, or adds entries to this one, which join the rows already here.
   */
  staged: readonly E[];
  intent: WorkspaceIntent<E>;
  /**
   * Bumped when the same selection is staged again, which is the person asking to see the
   * workspace rather than to start it over — so this opens a folded one instead of re-seeding it.
   */
  reveal: number;
  /** Each account with its wallet currency, which every Steam figure here is in; CSFloat figures are USD. */
  accounts: ReadonlyArray<{ id: string; name: string; currency?: number | null | undefined }>;
  /** The inspector's price field, so a figure typed on either side survives the other. */
  price?: string | undefined;
  onPrice?: ((next: string) => void) | undefined;
  onMessage: (message: Message | null) => void;
  /** The keys of rows handed to the outbox, so the selection lets go of exactly those. */
  onSent?: ((keys: readonly string[]) => void) | undefined;
  /**
   * A row has left for good — taken out by hand, or its send accepted — so a caller that adds
   * entries does not add that one back.
   */
  onUnstaged?: ((key: string) => void) | undefined;
  /** Nothing is staged any more: the workspace has been closed, or its last row taken out of it. */
  onDismiss: () => void;
}): React.JSX.Element | null {
  const seed = (entry: E): Staged<E> => ({
    key: entry.key,
    entry,
    venues: entry.venues,
    venue: entry.venues.includes('steam') ? 'steam' : entry.venues[0] ?? 'steam',
    // The inspector's field is what the seller receives, so a row seeded from it is too.
    price: entry.seed?.price ?? price,
    basis: entry.seed?.basis ?? 'receive',
    ownPrice: false,
    ownVenue: false,
    state: 'ready'
  });
  const [rows, setRows] = useState<Array<Staged<E>>>(() => staged.map(seed));
  const [open, setOpen] = useState(true);
  // Entries staged after the workspace opened join it, and open it. Rows already here keep what
  // was typed. Only a join opens it: the owner's list also shrinks when a send is accepted, and a
  // folded workspace must not spring open because something left it.
  useEffect(() => {
    if (!staged.some((entry) => !rows.some((row) => row.key === entry.key))) return;
    setRows((current) => {
      const fresh = staged.filter((entry) => !current.some((row) => row.key === entry.key));
      return fresh.length === 0 ? current : [...current, ...fresh.map(seed)];
    });
    setOpen(true);
  }, [staged]);
  useEffect(() => { setOpen(true); }, [reveal]);
  const [bulkPrice, setBulkPrice] = useState(price);
  const [bulkBasis, setBulkBasis] = useState<PriceBasis>('receive');
  const [bulkVenue, setBulkVenue] = useState<Venue>(() => (staged.some((entry) => entry.venues.includes('steam')) ? 'steam' : 'csfloat'));
  // Folded until asked for: most stagings are priced a row at a time, and the rows are what the
  // person came to see.
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkId = useId();
  const outbox = useOutbox();
  // A send can come back after the owner has closed the workspace. Its refusal then has no rows
  // to return to, and the outbox keeps it on the work panel instead.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // What is on screen. A handed row is the outbox's until the engine answers, and a workspace
  // holding nothing else shows nothing — no pill, no panel — while it waits to hear.
  const shown = useMemo(() => rows.filter((row) => row.state !== 'handed'), [rows]);
  const slot = useSlot();
  const pill = useRef<HTMLButtonElement | null>(null);
  const anchor = usePillAnchor(pill, open && shown.length > 0, slot);

  // Nothing staged any more, on screen or on its way: the workspace is over.
  useEffect(() => {
    if (rows.length === 0) onDismiss();
  }, [rows.length]);

  /**
   * The currency a row's figures are in: USD on CSFloat everywhere, the account's wallet on Steam
   * (portfolio and pricing plan §5.1). A typed price is in this currency and is sent as typed.
   */
  const currencyFor = (venue: Venue, accountId: string): number | null => (venue === 'csfloat' ? 1 : accounts.find((account) => account.id === accountId)?.currency ?? null);
  const rowCurrency = (row: Staged<StagedEntry>): number | null => currencyFor(row.venue, row.entry.accountId);
  /** One currency for rows on one venue, or none when accounts with different wallets are mixed in. */
  const currencyOfRows = (venue: Venue, rows: ReadonlyArray<Staged<StagedEntry>>): number | null => {
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

  function update(key: string, change: (row: Staged<E>) => Staged<E>): void {
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
  }

  /**
   * A bulk change writes only where the row has not spoken for itself.
   *
   * It writes the figure and which field it was typed into, not a converted amount: each row works
   * the other figure out through its own venue's fees, so one buyer price spread over a Steam row
   * and a CSFloat row pays their sellers different amounts, as it would.
   */
  function spreadPrice(next: string, basis: PriceBasis): void {
    setBulkPrice(next);
    setBulkBasis(basis);
    // The inspector's field only ever means what the seller receives.
    onPrice?.(basis === 'receive' ? next : pricing(bulkVenue, currencyOfRows(bulkVenue, shown), next, basis).receiveText);
    setRows((current) => current.map((row) => (
      row.ownPrice || row.state === 'handed' ? row : { ...row, price: next, basis }
    )));
  }

  function spreadVenue(next: Venue): void {
    setBulkVenue(next);
    setRows((current) => current.map((row) => (
      row.ownVenue || row.state === 'handed' || !row.venues.includes(next) ? row : { ...row, venue: next }
    )));
  }

  /** The one control that overrules a row: everything ready takes the bulk price and venue. */
  function applyToAll(): void {
    setRows((current) => current.map((row) => (
      row.state === 'handed'
        ? row
        : { ...row, price: bulkPrice, basis: bulkBasis, ownPrice: false, ownVenue: false, ...(row.venues.includes(bulkVenue) ? { venue: bulkVenue } : {}) }
    )));
  }

  /**
   * Taking a row out of the workspace, and emptying it — pill and all — by taking out the last one.
   *
   * A row removed here is only unstaged — it stays selected, so *List for sale* stages it again.
   */
  function drop(key: string): void {
    setRows((current) => current.filter((entry) => entry.key !== key));
    onUnstaged?.(key);
  }

  /**
   * Hand the rows to the outbox and let go of them, in the same render as the press.
   *
   * Each batch is atomic, and what goes in one is the intent's to say. The selection lets go of
   * the rows now too: the workspace is the view's, not the inspector's, so an emptied selection no
   * longer takes it down, and the item is busy on its tile from this render on.
   */
  function list(targets: ReadonlyArray<Staged<E>>): void {
    if (targets.length === 0) return;
    const keys = targets.map((row) => row.key);
    const byKey = new Map(targets.map((row) => [row.key, row]));
    onMessage(null);
    setRows((current) => current.map((row) => (keys.includes(row.key) ? { ...row, state: 'handed', detail: undefined } : row)));
    onSent?.(keys);
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
        onSettled: (outcome) => settle(batch, outcome)
      });
    }
  }

  /**
   * What the engine said about one batch. Accepted, its rows are gone for good. Refused, they come
   * back marked with its words and the panel opens on them, which is `true` to the outbox: this
   * refusal has been shown where it can be fixed. A batch refused marks only its own rows, because
   * every other batch either never existed or succeeded on its own terms.
   */
  function settle(batch: { venue: Venue; keys: readonly string[] }, outcome: OutboxOutcome): boolean | undefined {
    if (!live.current) return false;
    if (outcome.accepted) {
      setRows((current) => current.filter((row) => !batch.keys.includes(row.key)));
      for (const key of batch.keys) onUnstaged?.(key);
      return undefined;
    }
    setRows((current) => current.map((row) => (batch.keys.includes(row.key) ? { ...row, state: 'refused', detail: outcome.reason } : row)));
    setOpen(true);
    onMessage({ tone: 'error', title: `${VENUE[batch.venue].label} did not accept ${intent.refused}`, detail: outcome.reason });
    return true;
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
  const bulk = pricing(bulkVenue, bulkCurrency, bulkPrice, bulkBasis);
  // What the header says in one line, so the pill still reports the state of the work folded up.
  const summary = [
    `${plural(shown.length, intent.noun)} staged`,
    ...(refused.length > 0 ? [`${refused.length} refused`] : []),
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
    ...(unpriced > 0 ? [`${unpriced} without a price`] : [])
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
      onClick={() => setOpen((current) => !current)}
    >
      <span className="listing-pill-glyph"><Icon name="tag" size={14} /></span>
      <span className="listing-pill-count num">{shown.length.toLocaleString()}</span>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} className="listing-pill-chevron" />
    </button>
  );

  return <>
    {createPortal(launcher, slot ?? document.body)}
    {open ? createPortal(
      <aside
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
            onClick={() => setOpen(false)}
          >
            <span className="panel-icon"><Icon name="tag" size={15} /></span>
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
            onClick={onDismiss}
          />
        </header>

        <div className="listing-dock-body">
          {/* One price and one marketplace for everything. Folded by default, and its summary
              says what it would write, so a folded section is never a hidden setting. A row that
              has been given its own price or venue is left alone until Apply to all. */}
          <section className="listing-bulk" data-open={bulkOpen || undefined}>
            <button
              type="button"
              className="listing-bulk-toggle"
              aria-expanded={bulkOpen}
              aria-controls={bulkId}
              onClick={() => setBulkOpen((current) => !current)}
            >
              <Icon name={bulkOpen ? 'chevron-down' : 'chevron-right'} size={13} className="listing-bulk-chevron" />
              <span className="kicker">For every row</span>
              {bulkOpen ? null : (
                <span className="listing-bulk-summary">
                  {bulk.quote ? <>receive <span className="num">{formatAmount(bulk.quote.receiveCents, bulkCurrency)}</span> · buyer pays <span className="num">{formatAmount(bulk.quote.buyerCents, bulkCurrency)}</span> · </> : null}
                  {routable ? VENUE[bulkVenue].short : null}
                </span>
              )}
            </button>
            {bulkOpen ? (
              <div className="listing-bulk-body" id={bulkId}>
                <div className="listing-controls" data-bulk="true">
                  <PriceFields subject="every row" venue={bulkVenue} currency={bulkCurrency} priced={bulk} disabled={false} onChange={spreadPrice} />
                  {routable ? (
                    <label className="listing-control">
                      <span className="listing-control-label">Marketplace</span>
                      <Select label="Marketplace for every row" className="input-sm" value={bulkVenue} onChange={(next) => spreadVenue(next as Venue)}>
                        <option value="steam">{VENUE.steam.label}</option>
                        <option value="csfloat">{VENUE.csfloat.label}</option>
                      </Select>
                    </label>
                  ) : null}
                </div>
                {bulk.note ? <Caption icon={bulk.note.tone === 'warn' ? 'alert-circle' : 'info'} tone={bulk.note.tone === 'warn' ? 'warn' : undefined}>{bulk.note.text}</Caption> : null}
                <div className="listing-bulk-foot">
                  <Caption icon="info">
                    Type either figure and the other follows from that marketplace's fees. A row you price or route
                    yourself keeps that until you apply to all.
                  </Caption>
                  <Button size="sm" icon="chevrons-right" onClick={applyToAll}>Apply to all rows</Button>
                </div>
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
              const priced = pricingOf(row, rowCurrency(row));
              const cents = priced.listCents;
              const tier = wearTier(entry.paintWear);
              return (
                <li className="listing-row" key={row.key} data-state={row.state}>
                  <Thumbnail url={entry.imageUrl} name={entry.name} size={34} />
                  <span className="listing-row-text">
                    <span className="listing-row-name" title={entry.name}>{entry.name}</span>
                    <span className="listing-row-meta quiet">
                      <Icon name={entry.place.icon} size={11} />
                      {entry.place.label}
                      {tier ? ` · ${tier.label}` : ''}
                      {entry.paintWear !== null ? <> · <span className="num">{formatFloat(entry.paintWear)}</span></> : null}
                      {multiAccount ? ` · ${accountName(entry.accountId)}` : ''}
                    </span>
                  </span>
                  <IconButton
                    icon="x"
                    size="sm"
                    className="listing-row-drop"
                    label={`Take ${entry.name} off the list`}
                    onClick={() => drop(row.key)}
                  />

                  <div className="listing-controls">
                    <PriceFields
                      currency={rowCurrency(row)}
                      subject={entry.name}
                      venue={row.venue}
                      priced={priced}
                      disabled={false}
                      onChange={(next, basis) => update(row.key, (current) => ({ ...current, price: next, basis, ownPrice: true }))}
                    />

                    {/* Only the venues this row's own verdict allows can be chosen. A row Steam will
                        take and CSFloat will not is not a row to offer CSFloat on and refuse later —
                        but CSFloat is still shown, disabled, saying why, so its absence is not a
                        question the person has to ask. */}
                    <span className="listing-control listing-row-venue">
                      <span className="listing-control-label">Marketplace</span>
                      {row.venues.length > 1 || Object.keys(entry.unavailable ?? {}).length > 0 ? (
                        <Select
                          label={`Marketplace for ${entry.name}`}
                          className="input-sm"
                          value={row.venue}
                          onChange={(next) => update(row.key, (current) => ({ ...current, venue: next as Venue, ownVenue: true }))}
                        >
                          {(Object.keys(VENUE) as Venue[]).map((venue) => {
                            if (row.venues.includes(venue)) return <option key={venue} value={venue}>{VENUE[venue].label}</option>;
                            const why = entry.unavailable?.[venue];
                            return why ? <option key={venue} value={venue} disabled>{`${VENUE[venue].short} — ${why}`}</option> : null;
                          })}
                        </Select>
                      ) : (
                        <span className="listing-row-fixed quiet" title={VENUE[row.venue].label}>
                          <VenueMark venue={row.venue} size={13} />{VENUE[row.venue].label}
                        </span>
                      )}
                    </span>

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

                  {priced.note ? (
                    <Caption icon={priced.note.tone === 'warn' ? 'alert-circle' : 'info'} tone={priced.note.tone === 'warn' ? 'warn' : undefined}>
                      {priced.note.text}
                    </Caption>
                  ) : null}
                  {(() => {
                    const caption = entry.venueCaption?.[row.venue] ?? entry.caption;
                    return caption ? <Caption icon={caption.icon}>{caption.text}</Caption> : null;
                  })()}
                  {row.state === 'refused' && row.detail ? <Caption icon="ban" tone="warn">{row.detail}</Caption> : null}
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="listing-dock-foot">
          <span className="listing-total quiet">
            {steamRows.length > 0 ? (
              <span className="listing-tally" title="Before anything is listed: what these would pay you, and what their buyers would pay">
                <VenueMark venue="steam" size={12} />{plural(steamRows.length, 'item')} · you receive <span className="num">{formatAmount(steamTotal.receiveCents, steamCurrency)}</span>
                {' '}· buyers pay <span className="num">{formatAmount(steamTotal.buyerCents, steamCurrency)}</span>
              </span>
            ) : null}
            {csfloatRows.length > 0 ? (
              <span className="listing-tally" title="Before anything is listed: what these would pay you after CSFloat's fee, and what the listings would show">
                <VenueMark venue="csfloat" size={12} />{plural(csfloatRows.length, 'item')} · you receive <span className="num">{formatAmount(csfloatTotal.receiveCents, 1)}</span>
                {' '}· buyers pay <span className="num">{formatAmount(csfloatTotal.buyerCents, 1)}</span>
              </span>
            ) : null}
            {unpriced > 0 ? (
              <span className="listing-tally" data-tone="warn"><Icon name="alert-circle" size={12} />{plural(unpriced, intent.noun)} without a price</span>
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

/**
 * A price field that says it is one. `parseMoney` already ignores a leading currency mark, so a
 * typed $ is harmless; the class is not called `money`, which this sheet already uses for the
 * cross-venue figure that carries its own currency.
 */
function MoneyInput({ label, currency, value, onChange, disabled, derived }: {
  label: string;
  /** What a typed figure is in; the mark beside the field says so. */
  currency: number | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean | undefined;
  /** Worked out from the other field rather than typed, which it shows by being quieter. */
  derived?: boolean | undefined;
}): React.JSX.Element {
  return (
    <span className="price-input">
      <span className="price-input-mark" aria-hidden="true">{currencyCodeOf(currency) || '¤'}</span>
      <input
        className="input input-sm input-money"
        aria-label={label}
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
          disabled={disabled}
          onChange={(next) => onChange(next, 'receive')}
        />
      </label>
      <label className="listing-control">
        <span className="listing-control-label">
          Buyer pays
          {fees !== null && fees > 0 ? (
            <span className="listing-control-fee num" title={`${VENUE[venue].label}: ${breakdown}`}>+{formatAmount(fees, currency)}</span>
          ) : null}
        </span>
        <MoneyInput
          currency={currency}
          label={`Buyer pays for ${subject}`}
          value={priced.buyerText}
          derived={priced.basis !== 'buyer'}
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
  /** Why there is no list price, or how the listing differs from the figure typed. */
  note: { tone: 'warn' | 'info'; text: string } | null;
};

/** A typed figure, read through one venue's fees. Every price on this screen goes through here. */
function pricing(venue: Venue, currency: number | null, text: string, basis: PriceBasis): Pricing {
  const typed = parseMoney(text);
  const quote = typed === null ? null : basis === 'receive' ? quoteFromReceive(venue, typed) : quoteFromBuyer(venue, typed);
  const receiveText = basis === 'receive' ? text : quote ? dollars(quote.receiveCents) : '';
  const buyerText = basis === 'buyer' ? text : quote ? dollars(quote.buyerCents) : '';
  if (typed === null || quote === null) {
    return { basis, quote: null, listCents: null, receiveText, buyerText, note: { tone: 'warn', text: 'Not a price.' } };
  }
  const listCents = listPriceOf(venue, quote);
  const minimum = MINIMUM_LIST_CENTS[venue];
  if (listCents < minimum) {
    const least = MARKETPLACE_FEES[venue].listPrice === 'receive' ? quoteFromReceive(venue, minimum) : quoteFromBuyer(venue, minimum);
    return {
      basis, quote, listCents: null, receiveText, buyerText,
      note: { tone: 'warn', text: `The cheapest ${VENUE[venue].short} listing has the buyer pay ${formatAmount(least.buyerCents, currency)}, which pays you ${formatAmount(least.receiveCents, currency)}.` }
    };
  }
  // Not every buyer price exists on a venue that adds its fees on top: 44¢ does not on Steam.
  // The row lists at the nearest one below, and says so rather than listing a figure nobody typed.
  const shown = basis === 'receive' ? quote.receiveCents : quote.buyerCents;
  const note = shown === typed
    ? null
    : { tone: 'info' as const, text: `No ${VENUE[venue].short} listing has the buyer pay ${formatAmount(typed, currency)}. The nearest below is ${formatAmount(quote.buyerCents, currency)}, which pays you ${formatAmount(quote.receiveCents, currency)}.` };
  return { basis, quote, listCents, receiveText, buyerText, note };
}

/**
 * A row's figure, read through its venue — and, for a standing listing, against what it is
 * already listed at. A figure that changes nothing is still a price, so both fields show it, but
 * it is not something to send.
 */
function pricingOf(row: Staged<StagedEntry>, currency: number | null): Pricing {
  const priced = pricing(row.venue, currency, row.price, row.basis);
  if (priced.listCents === null || priced.listCents !== row.entry.currentListCents) return priced;
  return { ...priced, listCents: null, note: { tone: 'info', text: 'This is the price it is already listed at.' } };
}

/** A row's list price in integer cents, or `null` when it has none its venue would take. */
function priceOf(row: Staged<StagedEntry>, currency: number | null): number | null {
  return pricingOf(row, currency).listCents;
}

/** Both figures, summed over rows that each have a list price. */
function tally(rows: ReadonlyArray<Staged<StagedEntry>>, currencyOf: (row: Staged<StagedEntry>) => number | null): { receiveCents: number; buyerCents: number } {
  return rows.reduce((sum, row) => {
    const quote = pricing(row.venue, currencyOf(row), row.price, row.basis).quote;
    return quote ? { receiveCents: sum.receiveCents + quote.receiveCents, buyerCents: sum.buyerCents + quote.buyerCents } : sum;
  }, { receiveCents: 0, buyerCents: 0 });
}

/** Cents as a money field holds them: no currency mark, always two places. */
export function dollars(cents: number): string {
  return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
}
