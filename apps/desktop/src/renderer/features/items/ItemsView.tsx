import React, { useEffect, useRef, useState } from 'react';
import type { ItemHistory, ItemPage, ItemVariants } from '../../../shared/market.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Button, Empty, Panel, Segmented, Skeleton, Thumbnail } from '../../components/ui.js';
import { engine } from '../../lib/engine.js';
import { recentItems, rememberItem, type RecentItem } from '../../lib/recent-items.js';
import { BookPanel, CurvePanel, HistoryPanel, Quote, type Loaded } from './ItemPanels.js';
import { ItemSearch } from './ItemSearch.js';

/**
 * Items: one market name on a page of its own (portfolio and pricing plan §7).
 *
 * The search bar is Inventory's, and picking from it opens an item rather than filtering a list.
 * An item opened from somewhere else, the inventory inspector today, offers a Back to that page.
 *
 * The page reads in the order a trader asks: what is it and what is it worth now (the header, with
 * the ask, the bid and what the scope holds), where has it been (the price history beside the
 * book), and what does its float do to the price (the curve, across the foot, for an item with a
 * float). Each part loads on its own behind a skeleton, so a slow fetch never holds the others back.
 *
 * Every read here is local or main's cache: the book is asked for on the demand lane and polled
 * every five seconds while the page is open, and the series and curves are fetched at most once a
 * day per name. Nothing here mutates anything.
 */

const WATCH_MS = 5_000;
/** How often the page looks for its first book, before one or an absence has been recorded. */
const FIRST_BOOK_MS = 1_000;
const FIRST_BOOK_TRIES = 30;

export function ItemsView({ name, accountIds, onOpen, back }: {
  /** The market name open, or `null` for the search and recent items. */
  name: string | null;
  accountIds: readonly string[];
  onOpen: (name: string) => void;
  /** Where Back goes, when the item was opened from another page. */
  back?: { label: string; onBack: () => void } | null | undefined;
}): React.JSX.Element {
  // Escape is Back, as it closes a drawer elsewhere, unless something on the page wants it first.
  useEffect(() => {
    if (!back) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || takesText(event.target) || document.querySelector('[aria-modal="true"]')) return;
      back.onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  // A new item starts at the top of the page, search bar included, wherever the last one was read to.
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => { frame.current?.scrollIntoView({ block: 'start' }); }, [name]);

  return (
    <div className="items-view" ref={frame} data-testid="items-view" data-name={name ?? undefined}>
      <div className="items-bar">
        {back ? (
          <Button variant="ghost" size="sm" icon="chevron-left" data-testid="items-back" onClick={back.onBack}>Back to {back.label}</Button>
        ) : null}
        <ItemSearch accountIds={accountIds} onPick={onOpen} />
      </div>
      {name === null
        ? <ItemsLanding onOpen={onOpen} />
        : <ItemDetail key={name} name={name} accountIds={accountIds} onOpen={onOpen} />}
    </div>
  );
}

function ItemsLanding({ onOpen }: { onOpen: (name: string) => void }): React.JSX.Element {
  const [recent] = useState<RecentItem[]>(recentItems);
  return recent.length === 0 ? (
    <Panel>
      <Empty icon="search" title="Find an item" hint="A skin, a case, a sticker." />
    </Panel>
  ) : (
    <Panel className="items-recent">
      <div className="panel-body">
        <div className="holdings-label">Recent</div>
        <div className="items-recent-grid" data-testid="items-recent">
          {recent.map((item) => (
            <button key={item.name} type="button" className="items-recent-tile" onClick={() => onOpen(item.name)} title={item.name}>
              <Thumbnail url={item.imageUrl} name={item.name} size={56} />
              <span className="items-recent-name">{item.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function ItemDetail({ name, accountIds, onOpen }: { name: string; accountIds: readonly string[]; onOpen: (name: string) => void }): React.JSX.Element {
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

  // The book, every five seconds while the page is open: the server's own cadence, and one read per
  // name per five seconds however often the page is opened (scheduler demandMinIntervalMs). Until a
  // first book or an absence has been recorded, the whole page is read again each second instead:
  // the demand read is on its way, and only the page carries an absence, the kept days and the
  // conversions that come with a first book. Each of these is main's cache, never the network.
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const ids = scope === '' ? [] : scope.split('\0');
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // Bounded: a market paused by Steam answers nothing for a while, and the page then waits at the
    // ordinary cadence rather than reading itself every second until it is closed.
    let quick = FIRST_BOOK_TRIES;
    const waiting = (): boolean => {
      const current = pageRef.current;
      return quick > 0 && current.state === 'ready' && current.value.book === null && current.value.status?.kind !== 'absent';
    };
    const tick = async (): Promise<void> => {
      try {
        if (waiting() && ids.length > 0) {
          quick -= 1;
          const fresh = await engine.itemPage(name, ids);
          if (live && (fresh.book !== null || fresh.status?.kind === 'absent')) setPage({ state: 'ready', value: fresh });
        } else {
          const book = await engine.itemWatch(name);
          if (live && book !== null) {
            setPage((current) => {
              if (current.state !== 'ready') return current;
              const held = current.value.book;
              if (held !== null && held.observedAt === book.observedAt && held.etag === book.etag) return current;
              return { state: 'ready', value: { ...current.value, book } };
            });
          }
        }
      } catch { /* the next tick asks again */ }
      if (live) timer = setTimeout(() => { void tick(); }, waiting() ? FIRST_BOOK_MS : WATCH_MS);
    };
    timer = setTimeout(() => { void tick(); }, FIRST_BOOK_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [name, scope]);

  const answer = page.state === 'ready' ? page.value : null;
  const floats = answer ? answer.holdings.map((row) => row.minWear).filter((wear): wear is number => wear !== null) : [];
  const current = variants?.variants.find((variant) => variant.name === name) ?? null;

  return (
    <div className="items-detail">
      <PageHeader subtitle={name} />
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
            {variants && variants.variants.length > 1 ? (
              <div className="items-tiers" data-testid="item-tiers">
                <Segmented
                  label="Wear"
                  value={current?.name ?? ''}
                  onChange={(next) => { if (next !== name) onOpen(next); }}
                  options={variants.variants.map((variant) => ({ id: variant.name, label: variant.tier ?? variant.name, count: variant.held ?? undefined }))}
                />
              </div>
            ) : null}
          </div>
          <Quote page={page} />
        </div>
      </Panel>

      <div className="items-grid">
        <HistoryPanel history={history} page={page} />
        <BookPanel page={page} />
        <CurvePanel name={name} variants={variants} floats={floats} />
      </div>
    </div>
  );
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
