import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { BuyOrderBook, BuyOrderBookRow, BuyOrderVenue } from '@cslytics/engine';
import { Button, Empty, Field, IconButton, Metric, Notice, Panel, Spinner, Thumbnail } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Avatar } from '../../components/Avatar.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { VenueFilter, useOfferedVenue } from '../../components/VenueFilter.js';
import { VENUE_ID, VENUE_LABEL, VENUE_ORDER, byVenue, venueOffer, type VenueId } from '../../lib/marketplaces.js';
import { useWorkRefresh } from '../work/WorkIndicator.js';
import { formatCents } from '../../lib/format.js';
import { currencyCode, formatDateTime, formatRelative, plural } from '../../lib/labels.js';
import { SortControl, type SortDirection, type SortOption } from '../../components/SortControl.js';
import { FilterBar } from '../../components/FilterBar.js';
import { BUY_ORDER_CHIP_KINDS, chipsToListingFilter } from '../../components/filter-grammar.js';
import { useScopedChips } from '../../components/scoped-chips.js';
import { Money } from '../listings/listing-parts.js';
import {
  anyRowOpen, buyOrderKey, buyOrderStatus, checkEdit, parsePriceCents, parseQuantity, rememberRowLayout, rememberedRowLayout, rowOpen, setAllRows, toggleRow,
  useCancelBuyOrder, useEditBuyOrder, useRefreshBuyOrders,
  type BuyOrderCancelling, type BuyOrderEditing, type BuyOrderMessage, type BuyOrderTerms, type CsfloatAccountFacts, type NamedBuyOrder
} from './buy-order-actions.js';
import { BuyOrderFilters, filterPieces, filterSummary } from './buy-order-filters.js';
import { BuyOrderFilterFields } from './buy-order-filter-fields.js';
import { constraintsFromDraft, draftFromFilters, sameConstraints } from './buy-order-filter-draft.js';

type BuyOrderSort = 'name' | 'price' | 'open' | 'seen';

const SORTS: ReadonlyArray<SortOption<BuyOrderSort>> = [
  { id: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  { id: 'price', label: 'Price each', asc: 'lowest first', desc: 'highest first' },
  { id: 'open', label: 'Committed', asc: 'least first', desc: 'most first' },
  { id: 'seen', label: 'First seen', asc: 'oldest first', desc: 'newest first' }
];

/**
 * Surfaces whose walk can change this book: the market walk writes Steam's, the status poll
 * updates its counts, the own-book walk writes CSFloat's, and CSFloat's `/me` carries the balance
 * a change is warned against.
 */
const WATCHED = ['steam-market', 'steam-wallet', 'steam-buy-order-status', 'csfloat-buy-orders', 'csfloat-account-status'];

/** The picture is a tile's, on the tile's halo, with where the order stands marked on its corner. */
const PICTURE = 72;

const BUY_ORDER_NOTE = 'Steam orders in each account\'s wallet currency and CSFloat in US dollars, and nothing is converted. Orders are placed on each venue\'s own site and appear here after its next read.';

/** The filled information mark (SVG Repo), inlined so it takes the text colour. */
function InfoMark(): React.JSX.Element {
  return (
    <svg className="icon" width={14} height={14} viewBox="0 0 496.304 496.303" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M248.146,0C111.314,0,0,111.321,0,248.152c0,136.829,111.314,248.151,248.146,248.151c136.835,0,248.158-111.322,248.158-248.151C496.304,111.321,384.98,0,248.146,0z M248.146,472.093c-123.473,0-223.935-100.459-223.935-223.941c0-123.479,100.462-223.941,223.935-223.941c123.488,0,223.947,100.462,223.947,223.941C472.093,371.634,371.634,472.093,248.146,472.093z M319.536,383.42v32.852c0,1.383-1.123,2.494-2.482,2.494H196.45c-1.374,0-2.482-1.117-2.482-2.494V383.42c0-1.372,1.114-2.482,2.482-2.482h34.744V205.831h-35.101c-1.375,0-2.468-1.111-2.468-2.474v-33.6c0-1.38,1.1-2.479,2.468-2.479h82.293c1.371,0,2.482,1.105,2.482,2.479v211.181h36.186C318.413,380.938,319.536,382.048,319.536,383.42z M209.93,105.927c0-20.895,16.929-37.829,37.829-37.829c20.886,0,37.826,16.935,37.826,37.829s-16.94,37.829-37.826,37.829C226.853,143.756,209.93,126.822,209.93,105.927z" />
    </svg>
  );
}

function BuyOrderNote(): React.JSX.Element {
  const id = useId();
  return (
    <span className="buy-order-note">
      <button type="button" className="buy-order-note-button" aria-label="About these orders" aria-describedby={id}>
        <InfoMark />
      </button>
      <span className="buy-order-note-bubble" id={id} role="tooltip">{BUY_ORDER_NOTE}</span>
    </span>
  );
}

function compare(sort: BuyOrderSort, left: BuyOrderBookRow, right: BuyOrderBookRow): number {
  if (sort === 'price') return left.priceCents - right.priceCents;
  if (sort === 'open') return left.openCents - right.openCents;
  // An order whose first sighting is unknown sorts last either way, rather than first on the way up.
  if (sort === 'seen') return (left.firstSeenAt ?? '￿').localeCompare(right.firstSeenAt ?? '￿');
  return left.hashName.localeCompare(right.hashName);
}

/**
 * Every buy order a venue is showing open, on every account in scope, on Steam and on CSFloat.
 *
 * Orders are placed on the venues' own sites; this page reads them, cancels them on either venue,
 * and changes a CSFloat order's price or quantity. The account strip narrows it exactly as it
 * narrows Listings — all accounts, or one — and the search is Listings' filter bar, less the
 * normalised float, which an order cannot answer. Its chips are compiled as Listings compiles them
 * and answered in main by what each order would buy (`markBuyOrderMatches`): a skin type, rarity,
 * collection or StatTrak by the catalogue entry of its name, a sticker or charm by the ones it
 * requires, a wear or float by its tier and float range, a pattern by the ones it names, and a typed
 * name by the market name or the order number. The venue control beside it narrows the way the
 * Listings page's does. A row always names its venue,
 * and its account when more than one is in view (rule 8).
 *
 * The book is the engine's, written only by a walk of each venue's book, so it is never edited
 * here: a cancel is sent and the row says *Cancelling* until a later walk no longer shows the
 * order, and a change says *Changing* while the row keeps the terms the venue last showed. An
 * order that fills in that gap was bought, not cancelled, and only the walk can tell the two apart.
 * The cancel or change is open work too, reported by the work panel from the moment it is
 * admitted until that walk settles it. *Refresh* asks for that walk now, for the venue chosen, and
 * the rows change only when it lands.
 *
 * Every row opens as a tile on its side — the picture on its halo, the venue, the account, the
 * constraints and the order number — and *Collapse all rows* folds the book to lines. The fold
 * is this window's to remember; the engine never learns it.
 *
 * Money is what the orders still commit — the limit times what is left to buy — Steam's in each
 * account's own wallet currency and CSFloat's in US dollars. Two currencies are two figures,
 * never one sum, and so are two venues.
 *
 * The venue control offers the venues the accounts in view have set up, and a plus for each they
 * have not, which opens that venue's page in Settings (`VenueFilter`, `venueOffer`). *Refresh*
 * names the one venue when only one is offered.
 */
export function BuyOrdersView({ accountIds, accounts = [], setUp, onAddVenue }: {
  accountIds: string[];
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined;
  /** Which venues each account has set up (`setUpByAccount`); an account is absent until known. */
  setUp: Readonly<Record<string, ReadonlySet<VenueId>>>;
  /** Opens one venue's page in Settings for one account. */
  onAddVenue: (accountId: string, venue: VenueId) => void;
}): React.JSX.Element {
  const [book, setBook] = useState<BuyOrderBook | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [venue, setVenue] = useState<'' | BuyOrderVenue>('');
  const { chips, setChips, scope, queryScope, scopeAccounts } = useScopedChips(accountIds, accounts);
  const [sort, setSort] = useState<BuyOrderSort>('name');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [message, setMessage] = useState<BuyOrderMessage | null>(null);
  const [layout, setLayout] = useState(rememberedRowLayout);
  const reread = useCallback(() => setRevision((n) => n + 1), []);
  const refreshWork = useWorkRefresh();
  const cancelling = useCancelBuyOrder(setMessage, reread, refreshWork);
  const editing = useEditBuyOrder(setMessage, reread, refreshWork);
  const refreshing = useRefreshBuyOrders(setMessage, reread);
  const nameOf = useCallback((id: string): string => accounts.find((account) => account.id === id)?.name ?? id, [accounts]);
  const photoOf = (id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef;
  const multiAccount = accountIds.length > 1;

  // The bar's chips, compiled as the Listings bar compiles them. Main resolves them against the
  // catalogue and flags each order it keeps (`markBuyOrderMatches`): a skin type, a rarity or a
  // sticker is a catalogue question, and the window never holds the catalogue.
  const filterKey = JSON.stringify(chipsToListingFilter(chips, BUY_ORDER_CHIP_KINDS));

  // `revision` is a dependency so that a walk landing, or a cancel settling, reads the book again.
  useEffect(() => {
    let current = true;
    const filter = JSON.parse(filterKey) as Record<string, unknown>;
    void window.trading.invoke({ type: 'buyOrders.read', accountIds: scope.split('\0'), ...(Object.keys(filter).length ? { filter } : {}) })
      .then((answer) => { if (current) { setBook(answer as BuyOrderBook); setFailure(null); } })
      .catch((error: unknown) => { if (current) setFailure(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [scope, revision, filterKey]);

  // The scope changed: the old book is another account's, and must not stand in for this one's.
  useEffect(() => { setBook(null); }, [scope]);

  // A catalogue arriving after the page did brings the pictures with it, so re-read for those too.
  useEffect(() => {
    const inScope = new Set(scope.split('\0'));
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue')) { reread(); return; }
      if (inScope.has(notice.accountId) && notice.surfaces.some((surface) => WATCHED.includes(surface))) reread();
    });
  }, [scope, reread]);

  const rows = useMemo(() => {
    const accountsInView = new Set(queryScope.split('\0'));
    const matching = ((book?.rows ?? []) as NamedBuyOrder[])
      .filter((row) => accountsInView.has(row.accountId))
      .filter((row) => !venue || row.venue === venue)
      .filter((row) => row.matches !== false);
    const sign = direction === 'desc' ? -1 : 1;
    return [...matching].sort((left, right) => sign * compare(sort, left, right)
      || left.hashName.localeCompare(right.hashName)
      || buyOrderKey(left).localeCompare(buyOrderKey(right)));
  }, [book, queryScope, venue, sort, direction]);

  // Counted over the whole book rather than the rows on screen, so the control says what each
  // venue holds before it is chosen.
  const venueCounts = useMemo(() => {
    const counts = new Map<BuyOrderVenue, number>();
    for (const row of book?.rows ?? []) counts.set(row.venue, (counts.get(row.venue) ?? 0) + 1);
    return counts;
  }, [book]);
  const offer = useMemo(() => venueOffer({ accountIds, setUp, counts: venueCounts }), [accountIds, setUp, venueCounts]);
  useOfferedVenue(offer, venue, () => setVenue(''));
  // The one venue on offer is the one a refresh reads, and says so, rather than "both".
  const refreshVenue = venue || (offer.shown.length === 1 ? offer.shown[0]!.code : '');

  // What each CSFloat account holds and has open, for warning a change before it is sent. Counted
  // over the whole book, not the rows on screen: a filter must not hide the orders that fill a
  // balance or reach the order cap.
  const csfloatAccounts = useMemo(() => {
    const accounts = new Map<string, { availableCents: number | null; balanceObservedAt: string | null; openOrders: number; committedCents: number }>();
    for (const balance of book?.balances ?? []) {
      accounts.set(balance.accountId, { availableCents: balance.availableCents, balanceObservedAt: balance.observedAt, openOrders: 0, committedCents: 0 });
    }
    for (const row of book?.rows ?? []) {
      if (row.venue !== 'CSFLOAT') continue;
      const account = accounts.get(row.accountId) ?? { availableCents: null, balanceObservedAt: null, openOrders: 0, committedCents: 0 };
      account.openOrders += 1;
      account.committedCents += row.openCents;
      accounts.set(row.accountId, account);
    }
    return accounts;
  }, [book]);
  const factsFor = (row: NamedBuyOrder): CsfloatAccountFacts | null => {
    const account = row.venue === 'CSFLOAT' ? csfloatAccounts.get(row.accountId) : undefined;
    if (!account) return null;
    return { availableCents: account.availableCents, balanceObservedAt: account.balanceObservedAt, openOrders: account.openOrders, otherOrdersCents: account.committedCents - row.openCents };
  };

  // One unfinished or never-run walk makes the book a floor. Say which one, by name and venue.
  const unproven = [...(book?.coverage ?? [])]
    .filter((row) => row.complete !== 1 && (!venue || row.venue === venue))
    .sort(byVenue);
  const shown = venue ? rows : ((book?.rows ?? []) as NamedBuyOrder[]);
  const stillToBuy = shown.reduce((total, row) => total + row.quantityRemaining, 0);
  const money = [...(book?.money ?? [])].filter((bucket) => !venue || bucket.venue === venue)
    .sort((left, right) => VENUE_ORDER[left.venue] - VENUE_ORDER[right.venue] || (left.currency ?? -1) - (right.currency ?? -1));
  const openOrders = venue ? (venueCounts.get(venue) ?? 0) : (book?.total ?? 0);
  const hasFilter = chips.length > 0 || Boolean(venue);

  // The details button speaks for the rows on screen: while any of them shows its details it hides
  // them all, and only when none does does it show them. All is remembered; one row is not.
  const anyOpen = anyRowOpen(layout, rows.map(buyOrderKey));
  const foldAll = (): void => {
    const next = setAllRows(!anyOpen);
    setLayout(next);
    rememberRowLayout(next);
  };
  const toggle = useCallback((row: NamedBuyOrder) => setLayout((current) => toggleRow(current, buyOrderKey(row))), []);

  return (
    <div className="stack-lg" data-testid="buy-orders-screen">
      <PageHeader
        subtitle={<>Every buy order standing open across your accounts and venues. <BuyOrderNote /></>}
        actions={(
          <>
            <Button
              size="sm"
              icon="refresh"
              loading={refreshing.busy}
              disabled={book === null}
              title={`Reads the ${refreshVenue ? VENUE_LABEL[refreshVenue] : new Intl.ListFormat('en').format(offer.shown.map((market) => market.label))} buy orders of the accounts in view again now`}
              data-testid="buy-orders-refresh"
              onClick={() => refreshing.run(accountIds, refreshVenue)}
            >
              {refreshVenue ? `Refresh ${VENUE_LABEL[refreshVenue]}` : offer.shown.length === 2 ? 'Refresh both venues' : 'Refresh every venue'}
            </Button>
            {rows.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                icon={anyOpen ? 'chevron-up' : 'chevron-down'}
                title={anyOpen ? 'Hides the details of every order in view' : 'Shows the details of every order in view'}
                data-testid="buy-orders-fold"
                onClick={foldAll}
              >
                {anyOpen ? 'Hide all details' : 'Show all details'}
              </Button>
            ) : null}
          </>
        )}
      />

      {unproven.length > 0 ? (
        <Notice tone="warn" role="status" title="This is a floor, not a total">
          {unproven.map((row) => `${nameOf(row.accountId)} on ${VENUE_LABEL[row.venue]} ${row.observedAt ? `was last read ${formatRelative(row.observedAt)} and the read did not finish` : 'has never had its orders read'}`).join('; ')}.
          Nothing is concluded from an unfinished read, so an order it did not reach is still missing from this list.
        </Notice>
      ) : null}

      {book && openOrders > 0 ? (
        <div className="metrics enter">
          <Metric label="Open orders" icon="shopping-cart" value={openOrders.toLocaleString()} />
          <Metric label="Still to buy" icon="list-checks" value={stillToBuy.toLocaleString()} note={book.total > book.rows.length ? `Across the first ${book.rows.length.toLocaleString()} orders` : undefined} />
          {money.map((bucket) => (
            <Metric
              key={`${bucket.venue}:${bucket.currency ?? 'unknown'}`}
              label={money.length > 1 ? `Committed · ${VENUE_LABEL[bucket.venue]} · ${currencyCode(bucket.currency) || 'unknown currency'}` : 'Committed'}
              icon="wallet"
              value={<Money cents={bucket.openCents} currency={bucket.currency} />}
            />
          ))}
        </div>
      ) : null}

      <Panel className="enter">
        {message ? (
          <div className="panel-body tight">
            <Notice tone={message.tone} role="status" title={message.title} action={<IconButton icon="x" size="sm" label="Dismiss" onClick={() => setMessage(null)} />}>{message.detail}</Notice>
          </div>
        ) : null}

        <div className="toolbar page-controls">
          <FilterBar
            chips={chips}
            onChange={setChips}
            accounts={scopeAccounts}
            kinds={BUY_ORDER_CHIP_KINDS}
            label="Filter buy orders"
            placeholder="Filter: rifle, awp fn, covert, a sticker, seed 661, or an order number"
          />
          <VenueFilter
            offer={offer}
            value={venue}
            onChange={setVenue}
            counts={venueCounts}
            onAdd={onAddVenue}
            nameOf={nameOf}
            multiAccount={multiAccount}
          />
          <SortControl label="Sort buy orders by" options={SORTS} value={sort} direction={direction} onSort={setSort} onDirection={setDirection} />
          {hasFilter ? <Button size="sm" variant="ghost" icon="filter" onClick={() => { setVenue(''); setChips([]); }}>Reset filters</Button> : null}
        </div>

        {failure ? (
          <div className="panel-body">
            <Notice tone="error" role="alert" title="Buy orders could not be read" action={<Button size="sm" icon="refresh" onClick={reread}>Try again</Button>}>{failure}</Notice>
          </div>
        ) : book === null ? (
          <Empty icon="loader" title="Reading buy orders" />
        ) : rows.length === 0 ? (
          hasFilter
            ? <Empty icon="search" title="No buy order matches" hint="Try a broader search, another venue, or reset the filters." />
            : <Empty icon="shopping-cart" title="No open buy orders" hint="Buy orders placed on the Steam Community Market or on CSFloat appear here after the next read of that venue." />
        ) : (
          <div className="table-scroll">
            <table className="table buy-order-table" aria-label="Open buy orders">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="num-cell">Price each</th>
                  <th scope="col" className="num-cell">Bought</th>
                  <th scope="col" className="num-cell">Committed</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BuyOrderRow
                    key={buyOrderKey(row)}
                    row={row}
                    open={rowOpen(layout, buyOrderKey(row))}
                    onToggle={toggle}
                    account={multiAccount ? { name: nameOf(row.accountId), photo: photoOf(row.accountId) } : null}
                    cancelling={cancelling}
                    editing={editing}
                    facts={factsFor(row)}
                  />
                ))}
              </tbody>
            </table>
            {book.total > book.rows.length ? (
              <div className="panel-body tight">
                <Notice tone="info" role="status" title={`Showing the first ${book.rows.length.toLocaleString()} of ${book.total.toLocaleString()} orders`}>
                  Narrow the accounts in view to see the rest.
                </Notice>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * One order: its picture, its name and venue, where it stands, and its details behind a button.
 *
 * Where it stands is drawn, not written in a column. A marker on the picture's corner carries the
 * status's colour — open, part filled, on its way, failed — with the whole sentence as its title,
 * and a labelled pill beside the details button appears only when the order needs looking at: a
 * cancel or a change on its way, or one that failed. How much has been bought is a bar under the
 * count. An account is named beside the button when more than one is in view (rule 8).
 *
 * Everything else — venue and account in words, when it was first seen, the status's sentence,
 * the filters and the venue's order number — is behind *Show buy order details*. The details are
 * laid out to the column's width and never widen it, so opening them does not move the table.
 *
 * Filters are drawn by the venue's presenter (`buy-order-filters.tsx`): each marketplace says what
 * its orders can restrict, and a float range or a sticker reads the same on any of them.
 */
export function BuyOrderRow({ row, open, onToggle, account, cancelling, editing, facts = null }: {
  row: NamedBuyOrder;
  open: boolean;
  onToggle: (row: NamedBuyOrder) => void;
  account: { name: string; photo: string | null | undefined } | null;
  cancelling: BuyOrderCancelling;
  editing: BuyOrderEditing;
  /** The account's CSFloat balance and book, for warning a change before it is sent. */
  facts?: CsfloatAccountFacts | null | undefined;
}): React.JSX.Element {
  const status = buyOrderStatus(row);
  const phase = cancelling.phase(row);
  const editPhase = editing.phase(row);
  const cannotEdit = row.venue === 'CSFLOAT' && !row.editable;
  const pieces = row.filters === null ? null : filterPieces(row.venue, row.filters);
  const summary = pieces === null ? 'filters not reported' : filterSummary(pieces);
  // Open and part filled are the ordinary states, and the corner says them. Anything on its way or
  // failed is also said in words, beside the button, because it is what the person came to see.
  const needsLooking = status.tone === 'warn' || status.tone === 'negative';
  const sentence = status.detail ? `${status.label}. ${status.detail}` : status.label;
  const bought = row.purchased === null ? null : Math.min(1, row.purchased / Math.max(1, row.quantity));
  return (
    <>
      <tr data-testid="buy-order-row" data-state={status.label} data-tone={status.tone} data-venue={row.venue} data-open={open}>
        <td>
          <span className="buy-order-name">
            <span className="buy-order-picture">
              <Thumbnail url={row.imageUrl} name={row.hashName} size={PICTURE} />
              <span className="buy-order-pip" data-tone={status.tone} role="img" aria-label={status.label} title={sentence} data-testid="buy-order-status">
                {status.tone === 'positive' ? null : <Icon name={status.icon} size={11} />}
              </span>
            </span>
            <span className="buy-order-name-text">
              <span className="cell-primary buy-order-title">
                {row.hashName}
                <VenueMark venue={VENUE_ID[row.venue]} size={12} title={VENUE_LABEL[row.venue]} />
              </span>
              <span className="buy-order-foot">
                {needsLooking ? (
                  <span className="buy-order-state" data-tone={status.tone} title={status.detail ?? undefined}>
                    <Icon name={status.icon} size={12} />{status.label}
                  </span>
                ) : null}
                {account ? <span className="inline buy-order-account"><Avatar name={account.name} size={14} photo={account.photo} />{account.name}</span> : null}
                <button type="button" className="buy-order-details-toggle" aria-expanded={open} data-testid="buy-order-details-toggle" onClick={() => onToggle(row)}>
                  <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
                  {open ? 'Hide buy order details' : 'Show buy order details'}
                  {!open && pieces && pieces.length > 0 ? <span className="buy-order-details-count">{plural(pieces.length, 'filter')}</span> : null}
                </button>
              </span>
              {open ? (
                <span className="buy-order-details" data-testid="buy-order-details">
                  <span className="cell-sub buy-order-meta">
                    <span className="inline"><VenueMark venue={VENUE_ID[row.venue]} size={12} decorative />{VENUE_LABEL[row.venue]}</span>
                    <span title={row.firstSeenAt ? formatDateTime(row.firstSeenAt) : undefined}>
                      {row.firstSeenAt ? `First seen ${formatRelative(row.firstSeenAt)}` : 'First sighting unknown'}
                    </span>
                  </span>
                  {status.detail ? <span className="cell-sub buy-order-status-detail" data-tone={status.tone}>{status.label}: {status.detail}</span> : null}
                  {row.editPending?.filters ? (
                    // The filters shown below stay the venue's until a read shows these instead.
                    <span className="buy-order-asked">
                      <span className="order-field-label">Asked for these filters</span>
                      <BuyOrderFilters venue={row.venue} filters={row.editPending.filters} />
                    </span>
                  ) : null}
                  <BuyOrderFilters
                    venue={row.venue}
                    filters={row.filters}
                    note={cannotEdit ? 'This app cannot carry every one of these filters through a change, so change the order on CSFloat.' : null}
                  />
                  <span className="cell-sub buy-order-number">
                    <span className="mono">Order {row.buyOrderId}</span>
                    {row.observedAt ? <span title={formatDateTime(row.observedAt)}> · last read {formatRelative(row.observedAt)}</span> : null}
                  </span>
                </span>
              ) : null}
            </span>
          </span>
        </td>
        <td className="num-cell"><Money cents={row.priceCents} currency={row.currency} /></td>
        <td className="num-cell">
          <span className="buy-order-bought">
            <span className="num">{row.purchased === null ? '—' : row.purchased.toLocaleString()} of {row.quantity.toLocaleString()}</span>
            {bought === null ? null : <span className="buy-order-bought-bar" aria-hidden="true"><span style={{ width: `${bought * 100}%` }} /></span>}
          </span>
        </td>
        <td className="num-cell"><Money cents={row.openCents} currency={row.currency} /></td>
        <td className="buy-order-actions">
          {phase === 'sending' ? (
            <span className="delist-prompt" role="status"><Spinner size={12} /> Cancelling…</span>
          ) : phase === 'asking' ? (
            <span className="delist-prompt" role="group" aria-label={`Cancel the buy order for ${row.hashName}?`}>
              <span className="delist-prompt-label">Cancel order?</span>
              <Button size="sm" variant="danger" aria-label={`Yes, cancel the buy order for ${row.hashName}`} onClick={() => cancelling.answer(row, true)}>Yes</Button>
              <Button size="sm" aria-label={`No, keep the buy order for ${row.hashName}`} onClick={() => cancelling.answer(row, false)}>No</Button>
            </span>
          ) : (
            <>
              {status.canEdit && editPhase === 'idle' ? (
                <IconButton icon="pencil" size="sm" label={`Change the buy order for ${row.hashName}`} onClick={() => editing.open(row)} />
              ) : null}
              {status.canCancel && editPhase === 'idle' ? (
                <Button size="sm" variant="ghost" icon="x" aria-label={`Cancel the buy order for ${row.hashName}`} onClick={() => cancelling.ask(row)}>Cancel</Button>
              ) : null}
            </>
          )}
        </td>
      </tr>
      {editPhase !== 'idle' ? (
        <tr className="buy-order-editor" data-testid="buy-order-editor">
          <td colSpan={5}>
            <BuyOrderEditor row={row} summary={summary} facts={facts} sending={editPhase === 'sending'} onSubmit={(terms) => editing.submit(row, terms)} onClose={editing.close} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * A CSFloat order's new terms: the most to pay for one, in US dollars, and how many are wanted.
 *
 * The price and quantity always travel. The filters travel only when they were changed, and then
 * as the order's whole new set, because the edit route replaces every one it is sent; untouched,
 * the engine carries the order's own through from the book as it last read it, so nothing left
 * alone here can strip a float range by omission. Which filters a venue's form offers is
 * `VENUE_FILTER_FIELDS`, narrowed to those that apply to what the order is for (`filterFieldsFor`):
 * a charm order is offered its pattern range and nothing else, a case order nothing at all.
 *
 * What CSFloat would refuse is said before Save (`checkEdit`): a price under its floor withholds
 * Save, and a total past the account's balance, or an account past the order cap, warns and
 * leaves the choice to the person, because a balance read minutes ago may since have moved.
 */
function BuyOrderEditor({ row, summary, facts, sending, onSubmit, onClose }: {
  row: NamedBuyOrder;
  /** The order's filters in words, which a change carries through unchanged. */
  summary: string;
  facts: CsfloatAccountFacts | null;
  sending: boolean;
  onSubmit: (terms: BuyOrderTerms) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [price, setPrice] = useState((row.priceCents / 100).toFixed(2));
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [initial] = useState(() => draftFromFilters(row.filters));
  const [draft, setDraft] = useState(initial);
  // What the order carries now, so a filter set elsewhere that does not apply can still be cleared.
  const [held] = useState(() => new Set((row.filters ?? []).map((filter) => filter.kind)));
  const cents = parsePriceCents(price);
  const wanted = parseQuantity(quantity);
  const reading = constraintsFromDraft(draft);
  const before = constraintsFromDraft(initial);
  const filtersChanged = reading.constraints !== null && before.constraints !== null && !sameConstraints(reading.constraints, before.constraints);
  const unchanged = cents === row.priceCents && wanted === row.quantity && !filtersChanged;
  const check = cents !== null && wanted !== null && !unchanged ? checkEdit({ maxPriceCents: cents, quantity: wanted }, facts) : null;
  const problem = cents === null
    ? 'Enter the most to pay for one, in US dollars, such as 90.50'
    : wanted === null
      ? 'Enter a whole number of items'
      : reading.problem ?? (unchanged ? 'Nothing has changed yet' : check?.blocking ?? null);
  return (
    <form
      className="buy-order-editor-form"
      aria-label={`New terms for the buy order for ${row.hashName}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (problem || cents === null || wanted === null) return;
        onSubmit({ maxPriceCents: cents, quantity: wanted, ...(filtersChanged && reading.constraints ? { constraints: reading.constraints } : {}) });
      }}
    >
      <Field label="Most to pay each (USD)">
        <input className="input" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} disabled={sending} aria-label="Most to pay for one, in US dollars" />
      </Field>
      <Field label="Wanted">
        <input className="input" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={sending} aria-label="How many are wanted" />
      </Field>
      <span className="cell-sub buy-order-editor-note">
        {problem ?? `CSFloat will pay at most ${formatCents(cents!, row.currency)} for each of ${wanted!.toLocaleString()}, ${formatCents(cents! * wanted!, row.currency)} in all${filtersChanged ? ', with the filters below' : summary ? `, and still only ${summary}` : ''}.`}
      </span>
      <BuyOrderFilterFields venue={row.venue} item={row.csfloatItem} held={held} draft={draft} onChange={setDraft} disabled={sending} />
      <Button type="submit" size="sm" variant="primary" loading={sending} disabled={Boolean(problem)}>Save</Button>
      <Button size="sm" variant="ghost" onClick={onClose} disabled={sending}>Keep as is</Button>
      {check && check.warnings.length > 0 ? (
        <span className="buy-order-editor-warnings" role="status" data-testid="buy-order-edit-warnings">
          {check.warnings.map((warning) => (
            <span className="buy-order-editor-warning" key={warning}><Icon name="alert-triangle" size={13} />{warning}</span>
          ))}
        </span>
      ) : null}
    </form>
  );
}
