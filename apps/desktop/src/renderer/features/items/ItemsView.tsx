import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StoredBook } from '@cslytics/market-data';
import type { ItemHistory, ItemPage, ItemVariants } from '../../../shared/market.js';
import { Button, Empty, Panel, Segmented, Skeleton, Thumbnail } from '../../components/ui.js';
import { browseChips, type FilterChip } from '../../components/filter-grammar.js';
import { engine } from '../../lib/engine.js';
import { recentItems, rememberItem, type RecentItem } from '../../lib/recent-items.js';
import { scrollParent } from '../../lib/scroll.js';
import { CollectionSkins, CollectionTiles, useCollections } from './CollectionPanels.js';
import { ItemBrowse, SkinTile } from './ItemBrowse.js';
import { BookPanel, CurvePanel, HistoryPanel, Quote, useBookChanges, type Loaded } from './ItemPanels.js';
import { ItemSearch } from './ItemSearch.js';
import type { StagedUnit } from './staged-marks.js';
import { marketNameOf } from './variants.js';

/**
 * Items: one market name on a page of its own (portfolio and pricing plan §7).
 *
 * The search bar is Inventory's, and picking an item from it opens that item rather than filtering
 * a list. Picking a name that stands for many (a weapon, a type, a collection, a grade) leaves a
 * chip in the bar and shows every skin under the chips as tiles, a page at a time; a tile opens its
 * skin, and Back returns to the tiles where they were left. With no chips the page shows the items
 * opened last and every collection, the newest first, each a press away from being the chip. An
 * item opened from somewhere else, the inventory inspector today, offers a Back to that page
 * instead.
 *
 * The page reads in the order a trader asks: what is it and what is it worth now (the header, with
 * the ask, the bid and what the scope holds), where has it been (the price history beside the
 * book), and what does its float do to the price (the curve, for an item with a float). Under
 * those is the rest of its collection, as tiles. Each part loads on its own behind a skeleton, so
 * a slow fetch never holds the others back.
 *
 * Every read here is local or main's cache: the book is live while the page is open, read on the
 * demand lane at Steam's own five-second cadence, and the series and curves are fetched at most
 * once a day per name. Nothing here mutates anything.
 */

/** Steam's own cadence: its book changes about every five seconds, and its page reads it at that rate. */
const WATCH_MS = 5_000;
/** The shortest wait between two reads; the next is normally due five seconds after the last landed. */
const WATCH_FLOOR_MS = 1_000;
/** How soon the page asks again when a read lands before the page's own first answer has. */
const PAGE_PENDING_MS = 250;

export function ItemsView({ name, chips, accountIds, onOpen, onBrowse, back, staged }: {
  /** The market name open, or `null` for the tiles: the chips' skins, or the items opened last. */
  name: string | null;
  /** The chips the grid is of. They outlast an item opened from it, so Back has tiles to return to. */
  chips: readonly FilterChip[];
  accountIds: readonly string[];
  onOpen: (name: string) => void;
  /** Shows the tiles for `chips` in place of whatever item is open; no chips is the items opened last. */
  onBrowse: (chips: FilterChip[]) => void;
  /** Where Back goes, when the item was opened from another page. */
  back?: { label: string; onBack: () => void } | null | undefined;
  /** Every unit staged in a listing workspace; the open item's curve marks the ones of its name. */
  staged?: readonly StagedUnit[] | undefined;
}): React.JSX.Element {
  const browsing = chips.length > 0;
  const chipsKey = JSON.stringify(browseChips(chips));
  const frame = useRef<HTMLDivElement>(null);
  // Where the grid was left when an item was opened from it, and the tile that opened it.
  const left = useRef<{ top: number; skin: string | null } | null>(null);

  const open = (next: string, skin: string | null = null): void => {
    if (name === null && browsing) left.current = { top: scrollParent(frame.current)?.scrollTop ?? 0, skin };
    onOpen(next);
  };
  // New chips are a new grid, read from its top: nothing of the last one's place is kept.
  const browse = (next: FilterChip[]): void => {
    left.current = null;
    onBrowse(next);
  };

  // An item opened from another page goes back there. One opened over the grid goes back to the
  // grid, named by its chip when there is only the one.
  const toGrid = name !== null && browsing
    ? { label: chips.length === 1 ? chips[0]!.text : 'results', onBack: () => onBrowse([...chips]) }
    : null;
  const goBack = back ?? toGrid;

  // Escape is Back, as it closes a drawer elsewhere, unless something on the page wants it first.
  // Read through a ref: where Back goes is worked out on every render, and the key is bound once.
  const backNow = useRef(goBack);
  backNow.current = goBack;
  const canGoBack = goBack !== null;
  useEffect(() => {
    if (!canGoBack) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || takesText(event.target) || document.querySelector('[aria-modal="true"]')) return;
      backNow.current?.onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canGoBack]);

  // A new item, and a new set of chips, start at the top of the page, search bar included, wherever
  // the last was read to. Going back to the grid is the exception: it returns to where the grid
  // was left, with the tile that was opened in focus, so the keyboard carries on from it. A layout
  // effect, so the place is restored before the grid is painted at the top.
  useLayoutEffect(() => {
    const was = left.current;
    if (name === null && was) {
      left.current = null;
      const scroller = scrollParent(frame.current);
      if (scroller) scroller.scrollTop = was.top;
      if (was.skin) frame.current?.querySelector<HTMLElement>(`.items-tile[data-skin="${CSS.escape(was.skin)}"]`)?.focus({ preventScroll: true });
      return;
    }
    frame.current?.scrollIntoView({ block: 'start' });
  }, [name, chipsKey]);

  return (
    <div className="items-view" ref={frame} data-testid="items-view" data-name={name ?? undefined}>
      <div className="items-bar">
        {goBack ? (
          <Button variant="ghost" size="sm" icon="chevron-left" data-testid="items-back" onClick={goBack.onBack}>Back to {goBack.label}</Button>
        ) : null}
        <ItemSearch accountIds={accountIds} chips={name === null ? chips : NO_CHIPS} onChips={browse} onPick={(next) => open(next)} />
      </div>
      {browsing ? (
        <ItemBrowse
          chips={chips}
          hidden={name !== null}
          onOpen={(skin) => { void marketNameOf(skin.name, accountIds).then((next) => open(next, skin.name)); }}
        />
      ) : null}
      {name !== null
        ? <ItemDetail key={name} name={name} accountIds={accountIds} onOpen={onOpen} staged={staged} />
        : browsing ? null : <ItemsLanding onOpen={onOpen} onBrowse={browse} />}
    </div>
  );
}

/** An item's page shows no chips: the bar there only launches, and the grid's chips wait behind Back. */
const NO_CHIPS: readonly FilterChip[] = [];

function ItemsLanding({ onOpen, onBrowse }: { onOpen: (name: string) => void; onBrowse: (chips: FilterChip[]) => void }): React.JSX.Element | null {
  const [recent] = useState<RecentItem[]>(recentItems);
  const collections = useCollections();
  // Main answers within a frame or two. Until it has, a page with nothing opened yet draws
  // nothing, so the empty state is never flashed ahead of the collections.
  if (recent.length === 0 && collections === null) return null;
  if (recent.length === 0 && collections!.length === 0) {
    return (
      <Panel>
        <Empty icon="search" title="Find an item" />
      </Panel>
    );
  }
  return (
    <>
      {recent.length > 0 ? (
        <Panel className="items-recent">
          <div className="panel-body">
            <div className="holdings-label">Recent</div>
            <div className="items-tiles" data-testid="items-recent">
              {/* The name kept is the market name last read, so a tile goes back to that wear. */}
              {recent.map((item) => <SkinTile key={item.name} name={item.name} imageUrl={item.imageUrl} onOpen={() => onOpen(item.name)} />)}
            </div>
          </div>
        </Panel>
      ) : null}
      {collections && collections.length > 0 ? <CollectionTiles collections={collections} onBrowse={onBrowse} /> : null}
    </>
  );
}

function ItemDetail({ name, accountIds, onOpen, staged }: {
  name: string; accountIds: readonly string[]; onOpen: (name: string) => void; staged?: readonly StagedUnit[] | undefined;
}): React.JSX.Element {
  const [variants, setVariants] = useState<ItemVariants | null>(null);
  const [page, setPage] = useState<Loaded<ItemPage>>({ state: 'loading' });
  const [history, setHistory] = useState<Loaded<ItemHistory>>({ state: 'loading' });
  const scope = accountIds.join('\0');

  // Three reads, each settling its own part; the curves are the curve panel's own. The page is keyed
  // by name, so none of these can land on the wrong item.
  useEffect(() => {
    const ids = scope === '' ? [] : scope.split('\0');
    let live = true;
    const settle = <T,>(work: Promise<T>, set: (next: Loaded<T>) => void): void => {
      work.then((value) => { if (live) set({ state: 'ready', value }); })
        .catch((failure: unknown) => { if (live) set({ state: 'failed', error: message(failure) }); });
    };
    if (ids.length > 0) {
      settle(engine.itemPage(name, ids), setPage);
      engine.itemVariants(name, ids).then((answer) => {
        if (!live) return;
        setVariants(answer);
        rememberItem({ name, imageUrl: answer.imageUrl });
      }).catch(() => { if (live) rememberItem({ name, imageUrl: null }); });
    }
    settle(engine.itemHistory(name), setHistory);
    return () => { live = false; };
  }, [name, scope]);

  // The book, live while the page is open. `item.watch` answers once the read it asked for has
  // landed, so each answer is the book Steam has just served, with its status and its conversions;
  // the next read is due five seconds after that book was observed. That is Steam's cadence and the
  // scheduler's floor for a name on screen (demandMinIntervalMs), so a page opened twenty times
  // still costs one read per five seconds. Steam never answers a validator with 304 (corpus
  // `steamcommunity.market.orderbook`, re-checked 2026-10-27), so every read is a whole book and a
  // read that changed nothing marks nothing. An absence ends the watch: there is nothing to follow.
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      let next = WATCH_MS;
      try {
        const answer = await engine.itemWatch(name);
        if (!live) return;
        if (pageRef.current.state === 'loading') {
          // The page's own first answer is still on its way and would land over this one; the next
          // ask answers at once from the read just made. With no account in scope the page is never
          // asked for, so there is nothing to wait for.
          if (scope !== '') next = PAGE_PENDING_MS;
        } else {
          setPage((current) => current.state !== 'ready' || (sameRead(current.value.book, answer.book) && current.value.status?.kind === answer.status?.kind)
            ? current
            : { state: 'ready', value: { ...current.value, book: answer.book, status: answer.status, converted: answer.converted } });
          if (answer.book === null && answer.status?.kind === 'absent') return;
          if (answer.book) next = Math.max(WATCH_FLOOR_MS, Date.parse(answer.book.observedAt) + WATCH_MS - Date.now());
        }
      } catch { /* the next tick asks again */ }
      if (live) timer = setTimeout(() => { void tick(); }, next);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [name, scope]);

  const answer = page.state === 'ready' ? page.value : null;
  const changes = useBookChanges(answer?.book ?? null);
  const current = variants?.variants.find((variant) => variant.name === name) ?? null;

  return (
    <div className="items-detail">
      <Panel className="items-head">
        <div className="panel-body items-head-body" data-testid="item-head">
          {variants ? <Thumbnail url={variants.imageUrl} name={name} size={76} /> : <Skeleton width={76} height={76} className="skeleton-square" />}
          <div className="items-head-text">
            <h2 className="items-title" data-testid="item-title">{name}</h2>
            <div className="items-kind">
              {variants ? (
                <>
                  {variants.rarity ? <span className="items-rarity" style={{ color: variants.rarity.colour }}>{variants.rarity.name}</span> : null}
                  {variants.category ? <span>{variants.category}</span> : null}
                  {!variants.known ? <span>Not in the catalogue yet</span> : null}
                </>
              ) : <Skeleton width={140} height={12} />}
              <span className="items-holding" data-testid="item-holding" data-held={answer ? answer.holdings.some((row) => row.quantity > 0) : undefined}>
                {answer ? holdingLine(answer) : page.state === 'failed' ? 'Holdings could not be read' : <Skeleton width={60} height={12} />}
              </span>
            </div>
            {variants && (variants.variants.length > 1 || variants.qualities.length > 1) ? (
              <div className="items-switches">
                {variants.variants.length > 1 ? (
                  <div className="items-tiers" data-testid="item-tiers">
                    <Segmented
                      label="Wear"
                      value={current?.name ?? ''}
                      onChange={(next) => { if (next !== name) onOpen(next); }}
                      options={variants.variants.map((variant) => ({ id: variant.name, label: variant.tier ?? variant.name, count: variant.held ?? undefined }))}
                    />
                  </div>
                ) : null}
                {/* StatTrak™ and Souvenir are market names of their own. A tile is the skin once,
                    so this is where its other qualities are reached, at the wear the page is on. */}
                {variants.qualities.length > 1 ? (
                  <div className="items-tiers" data-testid="item-qualities">
                    <Segmented
                      label="Quality"
                      value={variants.qualities.find((quality) => quality.current)?.name ?? ''}
                      onChange={(next) => { if (next !== name) onOpen(next); }}
                      options={variants.qualities.map((quality) => ({ id: quality.name, label: quality.label }))}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <Quote page={page} changes={changes} />
        </div>
      </Panel>

      <div className="items-grid">
        <HistoryPanel history={history} page={page} />
        <BookPanel page={page} changes={changes} />
        <CurvePanel name={name} variants={variants} staged={staged} />
      </div>

      {variants?.collection ? (
        <CollectionSkins
          collection={variants.collection}
          skin={variants.skin}
          onOpen={(skin) => { void marketNameOf(skin.name, accountIds).then(onOpen); }}
        />
      ) : null}
    </div>
  );
}

/** True when two books are the same read of the market, so the page keeps the one it holds. */
function sameRead(held: StoredBook | null, next: StoredBook | null): boolean {
  return held === next || (held !== null && next !== null && held.observedAt === next.observedAt && held.currency === next.currency && held.etag === next.etag);
}

/** What the scope holds of this name, in a few words: the count, then where any of it is not. */
function holdingLine(page: ItemPage): string {
  const units = page.holdings.reduce((sum, row) => sum + row.quantity, 0);
  if (units === 0) return 'Not held';
  const crated = page.holdings.reduce((sum, row) => sum + row.storage, 0);
  const listed = page.holdings.reduce((sum, row) => sum + row.listed, 0);
  const accounts = new Set(page.holdings.map((row) => row.accountId)).size;
  return [
    `${units.toLocaleString()} held`,
    accounts > 1 ? `${accounts} accounts` : null,
    crated ? `${crated.toLocaleString()} in storage` : null,
    listed ? `${listed.toLocaleString()} listed` : null
  ].filter((part): part is string => part !== null).join(' · ');
}

function message(failure: unknown): string {
  return (failure instanceof Error ? failure.message : String(failure))
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '').trim();
}

function takesText(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
}
