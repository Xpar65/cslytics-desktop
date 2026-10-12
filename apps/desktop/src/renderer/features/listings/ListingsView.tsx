import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ListingsSummary, ListingSort, ListingSortDirection, ListingVenue, PageEnvelope } from '@cslytics/engine';
import { Button, IconButton, Notice, Panel, Select } from '../../components/ui.js';
import { PageHeader } from '../../components/PageHeader.js';
import { VenueFilter, useOfferedVenue } from '../../components/VenueFilter.js';
import { useOpenWork, useWorkRefresh } from '../work/WorkIndicator.js';
import { formatRelative, plural } from '../../lib/labels.js';
import { busyKeysFromWork, itemIsBusy } from '../work/work-busy.js';
import { SortControl, type SortOption } from '../../components/SortControl.js';
import { FilterBar } from '../../components/FilterBar.js';
import { LISTING_CHIP_KINDS, chipsToListingFilter } from '../../components/filter-grammar.js';
import { InspectorSplit } from '../../components/InspectorSplit.js';
import { ListingWorkspace } from '../../components/ListingWorkspace.js';
import { useScopedChips } from '../../components/scoped-chips.js';
import { ListingInspector } from './ListingInspector.js';
import { ListingTiles } from './ListingTiles.js';
import { REPRICE_INTENT, stageListing, useDelisting, type StagedListing } from './listing-actions.js';
import { listingKey, listingState, type NamedListing } from './listing-parts.js';
import { VENUE_LABEL, byVenue, venueOffer, type VenueId } from '../../lib/marketplaces.js';
import type { Message } from '../../components/ui.js';

/**
 * What the book can be sorted by, and what each direction means for it in words, for the arrow's
 * label. `seen` is when this app first saw the listing, which is the one date both venues' rows carry.
 */
const SORTS: ReadonlyArray<SortOption<ListingSort>> = [
  { id: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  { id: 'price', label: 'Price', asc: 'lowest first', desc: 'highest first' },
  { id: 'float', label: 'Float', asc: 'lowest first', desc: 'highest first' },
  { id: 'seen', label: 'First seen', asc: 'oldest first', desc: 'newest first' }
];

/**
 * Every open advertisement, on every account, at every venue.
 *
 * A seller with three accounts and two venues has six books to read and one question. This is the
 * question: *what have I got listed.* The account strip above narrows it exactly as it narrows
 * inventory — all accounts, or one — and the scope is always named, because there is no ambient
 * current account (rule 8).
 *
 * The search is Inventory's filter bar, less what a listed item cannot answer: names, collections,
 * rarities, StatTrak™ and Souvenir, float, normalised float, pattern and account all narrow the
 * book exactly as they narrow inventory, and a location, storage unit or lock is never offered,
 * because a listing is at the venue by definition. A typed name also finds a listing number.
 *
 * There are no headline figures. Steam prices in each wallet's currency and CSFloat in US dollars,
 * and this app has no FX source (`cslytics-app-docs/steam/wallet.md`), so the only honest totals
 * were one card per venue and currency — which the tiles already say row by row.
 *
 * The book itself is Inventory's page again: tiles on the left built from the same tile, the
 * listing just clicked in the same inspector column on the right, and the same divider between
 * them. A tile adds the one thing a listing has that an item does not — its price — and the two
 * things that can be done about it. Changing a price stages the listing in the listing workspace,
 * the same dock Inventory lists from, because that is where a figure is read through a venue's
 * fees before anything is sent; what is sent then shows in the work panel like any other work.
 * Delisting asks first.
 *
 * The venue control offers the venues the accounts in view have set up, and a plus for each they
 * have not, which opens that venue's page in Settings (`VenueFilter`, `venueOffer`).
 */
export function ListingsView({ accountIds, accounts = [], setUp, onAddVenue }: {
  accountIds: string[];
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined;
  /** Which venues each account has set up (`setUpByAccount`); an account is absent until known. */
  setUp: Readonly<Record<string, ReadonlySet<VenueId>>>;
  /** Opens one venue's page in Settings for one account. */
  onAddVenue: (accountId: string, venue: VenueId) => void;
}): React.JSX.Element {
  const [venue, setVenue] = useState<'' | ListingVenue>('');
  const [state, setState] = useState('');
  const { chips, setChips, scope, queryScope, scopeAccounts } = useScopedChips(accountIds, accounts);
  const [sort, setSort] = useState<ListingSort>('name');
  const [direction, setDirection] = useState<ListingSortDirection>('asc');
  const [summary, setSummary] = useState<ListingsSummary | null>(null);
  const [subject, setSubject] = useState<NamedListing | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [revision, setRevision] = useState(0);
  /** What is staged for a new price. The workspace is keyed by `id`, and joins rows added to it. */
  const [staging, setStaging] = useState<{ id: string; reveal: number; rows: readonly StagedListing[] } | null>(null);
  const work = useOpenWork(accountIds);
  const busyKeys = useMemo(() => busyKeysFromWork(work), [work]);
  const delisting = useDelisting(setMessage, useWorkRefresh());
  const nameOf = useCallback((id: string): string => accounts.find((account) => account.id === id)?.name ?? id, [accounts]);

  /**
   * Staging a listing that is already staged is "show me the workspace"; any other joins the rows
   * already there, each of which keeps whatever has been typed into it.
   */
  function stageReprice(row: NamedListing): void {
    const entry = stageListing(row);
    setStaging((current) => {
      if (current === null) return { id: crypto.randomUUID(), reveal: 0, rows: [entry] };
      return current.rows.some((staged) => staged.key === entry.key)
        ? { ...current, reveal: current.reveal + 1 }
        : { ...current, rows: [...current.rows, entry] };
    });
  }

  /**
   * The inspector holds a copy of a row, and a walk replaces the rows. Point it at the fresh copy
   * so a repriced listing shows its new price, and let go of one the book no longer holds.
   */
  const followSubject = useCallback((rows: NamedListing[]) => {
    setSubject((current) => (current === null ? null : rows.find((row) => listingKey(row) === listingKey(current)) ?? null));
  }, []);

  // A state that belongs to the other venue would match nothing, and a list that empties itself
  // when the venue changes reads as a failure rather than as a filter being reset.
  useEffect(() => { setState(''); }, [venue]);

  // The chips are the inventory's, turned into the listings half of the same filter: numbers to
  // the engine, catalogue chips to main, a typed name to the engine as the venue's own name.
  const filterKey = JSON.stringify({
    ...(venue ? { venue } : {}),
    ...(state ? { state } : {}),
    ...chipsToListingFilter(chips)
  });
  const hasFilter = Boolean(venue || state || chips.length > 0);

  // `revision` is in the dependency list and deliberately absent from the body: changing the
  // identity of `load` is how the grid is told to go back and read again.
  const load = useCallback(async (cursor?: string) => await window.trading.invoke({
    type: 'listings.page',
    accountIds: queryScope.split('\0'),
    sort,
    direction,
    filter: JSON.parse(filterKey),
    ...(cursor ? { cursor } : {})
  }) as PageEnvelope<NamedListing>, [queryScope, sort, direction, filterKey, revision]);

  // The summary is its own read: the list turns pages as the user scrolls, and the state counts
  // and coverage beside it describe the whole filtered set rather than the page in view.
  useEffect(() => {
    let current = true;
    void window.trading.invoke({ type: 'listings.summary', accountIds: queryScope.split('\0'), filter: JSON.parse(filterKey) })
      .then((answer) => { if (current) setSummary(answer as ListingsSummary); })
      .catch(() => { if (current) setSummary(null); });
    return () => { current = false; };
  }, [queryScope, filterKey, revision]);

  // A walk that lands while this page is open changes what is listed, so re-read rather than
  // leave a screen the engine already knows is out of date. So does a catalogue that arrives
  // after the page did: names and pictures come with it, and so do the keys a collection or
  // rarity chip resolves to, which matched nothing while there was no catalogue to ask.
  // `scope` rather than `accountIds` is the dependency: the array is rebuilt on every render of
  // the shell, and resubscribing that often would drop notices. The joined string is the same
  // fact, and the set is read back out of it so nothing here closes over a stale array.
  useEffect(() => {
    const watched = ['steam-market', 'steam-wallet', 'csfloat-stall', 'csfloat-listing'];
    const inScope = new Set(scope.split('\0'));
    return window.trading.subscribe((notice) => {
      if (notice.surfaces.includes('catalogue')) { setRevision((n) => n + 1); return; }
      if (!inScope.has(notice.accountId)) return;
      if (notice.surfaces.some((surface) => watched.includes(surface))) setRevision((n) => n + 1);
    });
  }, [scope]);

  const venueCounts = useMemo(() => {
    const counts = new Map<ListingVenue, number>();
    for (const bucket of summary?.states ?? []) counts.set(bucket.venue, (counts.get(bucket.venue) ?? 0) + bucket.listings);
    return counts;
  }, [summary]);
  const offer = useMemo(() => venueOffer({ accountIds, setUp, counts: venueCounts }), [accountIds, setUp, venueCounts]);
  useOfferedVenue(offer, venue, () => setVenue(''));
  const stateOptions = useMemo(
    () => (summary?.states ?? []).filter((bucket) => !venue || bucket.venue === venue),
    [summary, venue]
  );
  const coverage = useMemo(() => [...(summary?.coverage ?? [])].sort(byVenue), [summary]);
  // One incomplete or never-run walk makes every figure here a floor. Say which one, by name.
  const unproven = coverage.filter((row) => row.complete !== 1);

  /**
   * Listings inside the current filter that are waiting on a phone tap.
   *
   * `summary.states` is deliberately computed without the venue and state filters applied, so it
   * can offer a count for an option that is not currently chosen. That makes it the wrong number
   * to subtract from a figure that *is* filtered, and the three cases below are that correction:
   * CSFloat has no such state at all, any other state filter excludes them by construction, and
   * only the unfiltered case can take the count at face value.
   */
  const awaitingInView = useMemo(() => {
    if (venue === 'CSFLOAT') return 0;
    if (state && state !== 'PENDING_CONFIRMATION') return 0;
    return (summary?.states ?? [])
      .filter((bucket) => bucket.venue === 'STEAM' && bucket.state === 'PENDING_CONFIRMATION')
      .reduce((total, bucket) => total + bucket.listings, 0);
  }, [summary, venue, state]);

  const inspector = (
    <ListingInspector
      row={subject}
      account={subject ? nameOf(subject.accountId) : ''}
      multiAccount={accountIds.length > 1}
      busy={subject !== null && itemIsBusy(busyKeys, subject)}
      staged={subject !== null && Boolean(staging?.rows.some((entry) => entry.key === listingKey(subject)))}
      delisting={delisting}
      onReprice={stageReprice}
    />
  );

  return (
    <div className="stack-lg" data-testid="listings-screen">
      <PageHeader subtitle="Every advertisement standing across your accounts and venues. Steam prices in each account's wallet currency and CSFloat in US dollars, and nothing is converted." />

      {/*
        Above the coverage caveat on purpose. An unfinished walk is a reason to distrust the
        list; an unconfirmed listing is something to go and do, and the thing to do outranks the
        thing to know. These rows are in the book below, and a seller reading a book of thirty
        as thirty things on the market is the mistake this band is here to stop.

        `Show them` sets the state filter and never the venue: changing the venue resets the state
        (the effect above), so setting both would land on every Steam listing instead of these.
        CSFloat has no such state, so the state alone already narrows to the Steam rows.
      */}
      {awaitingInView > 0 && state !== 'PENDING_CONFIRMATION' ? (
        <Notice
          tone="warn"
          role="status"
          title={`${plural(awaitingInView, 'listing')} ${awaitingInView === 1 ? 'is' : 'are'} waiting for you to confirm on your phone`}
          action={<Button size="sm" icon="smartphone" onClick={() => setState('PENDING_CONFIRMATION')}>Show them</Button>}
        >
          Steam is holding {awaitingInView === 1 ? 'it' : 'them'} until you confirm in the Steam Mobile
          app. Until then {awaitingInView === 1 ? 'it is' : 'they are'} not on the market and cannot sell,
          though {awaitingInView === 1 ? 'it is' : 'they are'} in the list below.
        </Notice>
      ) : null}

      {unproven.length > 0 ? (
        <Notice tone="warn" role="status" title="This is a floor, not a total">
          {unproven.map((row) => `${nameOf(row.accountId)} on ${VENUE_LABEL[row.venue]} ${row.observedAt ? `was last walked ${formatRelative(row.observedAt)} and the walk did not finish` : 'has never been walked'}`).join('; ')}.
          Nothing is concluded from an unfinished walk, so a listing it did not reach is still missing from this list.
        </Notice>
      ) : null}

      <Panel className="enter">

        {message ? (
          <div className="panel-body tight">
            <Notice tone={message.tone} role="status" title={message.title} action={<IconButton icon="x" size="sm" label="Dismiss" onClick={() => setMessage(null)} />}>{message.detail}</Notice>
          </div>
        ) : null}

        <InspectorSplit layout="listings" inspector={inspector}>
          <div className="toolbar page-controls">
            <FilterBar
              chips={chips}
              onChange={setChips}
              accounts={scopeAccounts}
              kinds={LISTING_CHIP_KINDS}
              label="Filter listings"
              placeholder="Filter: awp fn st, f > 0.15, or a listing number"
            />
            <VenueFilter
              offer={offer}
              value={venue}
              onChange={setVenue}
              counts={venueCounts}
              onAdd={onAddVenue}
              nameOf={nameOf}
              multiAccount={accountIds.length > 1}
            />
            {/* Only the states actually present in this scope are offered, so no option here can
                be chosen and find nothing. */}
            {stateOptions.length > 1 ? (
              <Select label="Listing state" value={state} onChange={setState}>
                <option value="">All states</option>
                {stateOptions.map((bucket) => (
                  <option key={`${bucket.venue}:${bucket.state}`} value={bucket.state}>
                    {listingState(bucket.venue, bucket.state).label}{venue || offer.shown.length < 2 ? '' : ` (${VENUE_LABEL[bucket.venue]})`}
                  </option>
                ))}
              </Select>
            ) : null}
            <SortControl label="Sort listings by" options={SORTS} value={sort} direction={direction} onSort={setSort} onDirection={setDirection} />
            {hasFilter ? <Button size="sm" variant="ghost" icon="filter" onClick={() => { setVenue(''); setState(''); setChips([]); }}>Reset filters</Button> : null}
          </div>

          <ListingTiles
            load={load}
            onRows={followSubject}
            subject={subject}
            onSubject={setSubject}
            onReprice={stageReprice}
            delisting={delisting}
            busyKeys={busyKeys}
            accounts={accounts}
            multiAccount={accountIds.length > 1}
            emptyTitle={hasFilter ? 'Nothing matches these filters' : 'Nothing is listed'}
            emptyHint={hasFilter
              ? 'Try a broader search, or reset the filters.'
              : 'Listings appear here once a market or CSFloat walk has read them. Select items in Inventory to list them.'}
          />
        </InspectorSplit>
      </Panel>

      {staging ? (
        <ListingWorkspace
          key={staging.id}
          staged={staging.rows}
          intent={REPRICE_INTENT}
          reveal={staging.reveal}
          accounts={accounts}
          onMessage={setMessage}
          onUnstaged={(key) => setStaging((current) => (current === null ? null : { ...current, rows: current.rows.filter((entry) => entry.key !== key) }))}
          onDismiss={() => setStaging(null)}
        />
      ) : null}
    </div>
  );
}
