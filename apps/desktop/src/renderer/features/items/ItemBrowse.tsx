import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkinPage, SkinTile as Skin } from '../../../shared/market.js';
import { Button, Empty, Skeleton, Thumbnail } from '../../components/ui.js';
import { browseChips, type FilterChip } from '../../components/filter-grammar.js';
import { engine } from '../../lib/engine.js';
import { scrollParent } from '../../lib/scroll.js';
import { skinParts, withoutWear } from '../../lib/skin-name.js';

/**
 * The skins the Items page's chips name, as tiles, a page at a time.
 *
 * A weapon is a few dozen skins and the stickers are thousands, so the list is never read whole:
 * main sorts it once and hands over fifty at a time, and more come only as a person scrolls for
 * them.
 *
 * A list that has not been scrolled holds no more than fills the window: one page, or as many as
 * it takes for the grid to reach the window's foot, since a grid that ends above it could never be
 * scrolled. Once the person scrolls down, the next page is asked for a little before the end
 * comes into view, so the tiles are there when it does and scrolling never stops at an edge that
 * then moves. Main answers from memory, so a short way ahead is enough.
 *
 * Changing the chips narrows in place: the tiles on screen stay until the new list's first page
 * has landed, so adding a chip never blanks the page between the two.
 *
 * The grid stays mounted, hidden, while an item opened from it is on screen, so Back returns to
 * the tiles already loaded and the place they were scrolled to.
 *
 * The reading is `useSkinPages`, which an item's page uses too, for the rest of its collection.
 */

export const SKIN_PAGE_SIZE = 50;
/**
 * Once the list is being scrolled: how far below the window its end is when the next page is asked
 * for. About three rows, which is less than the height of a page on any window, so one scroll of a
 * mouse wheel brings one page and never two.
 */
const AHEAD_PX = 250;
/** How far down counts as scrolling the list, rather than a pixel of settling. */
const SCROLLED_PX = 4;
/** Main answers in a few milliseconds; placeholders are only drawn for an answer slower than this. */
const SLOW_MS = 160;

/** A page appended to the tiles held. A skin the list already shows is not shown twice, should the catalogue change between two pages. */
export function appendPage(held: SkinPage | null, page: SkinPage): SkinPage {
  if (!held) return page;
  const shown = new Set(held.skins.map((skin) => skin.name));
  return { total: page.total, next: page.next, skins: [...held.skins, ...page.skins.filter((skin) => !shown.has(skin.name))] };
}

/**
 * One skin, as the grid and Recent both show it: its picture, what it is, and which one. Never its
 * wear, which its page switches between. The whole name is the button's own, for a screen reader
 * and for a name too long for two lines.
 */
export function SkinTile({ name, imageUrl, rarity, onOpen }: {
  name: string;
  imageUrl: string | null;
  rarity?: { name: string; colour: string } | null | undefined;
  onOpen: () => void;
}): React.JSX.Element {
  const skin = withoutWear(name);
  const { lead, title } = skinParts(name);
  return (
    <button
      type="button"
      className="items-tile"
      data-skin={skin}
      aria-label={skin}
      title={rarity ? `${skin} · ${rarity.name}` : skin}
      style={rarity ? { '--tile-rarity': rarity.colour } as React.CSSProperties : undefined}
      onClick={onOpen}
    >
      <Thumbnail url={imageUrl} name={skin} size={56} />
      <span className="items-tile-text">
        {lead ? <span className="items-tile-lead">{lead}</span> : null}
        <span className="items-tile-title">{title}</span>
      </span>
    </button>
  );
}

/** A list of skins as it is being read: what is on screen, and what the grid that draws it must hold. */
export type SkinPages = {
  /** The tiles to draw: this set's own, or the last set's until this one's first page lands. */
  shown: SkinPage | null;
  /** How many skins the chips name, once this set's own first page has said. */
  total: number | undefined;
  failed: boolean;
  /** True once an answer has taken long enough to be worth drawing placeholders for. */
  slow: boolean;
  retry: () => void;
  /** Goes on the element the tiles are in: the box that scrolls it is found from here. */
  panel: React.RefObject<HTMLElement | null>;
  /** Goes on an element after the last tile: coming near the window is what asks for the next page. */
  end: React.RefObject<HTMLDivElement | null>;
};

/**
 * The skins a set of chips names, read a page at a time as the list is scrolled.
 *
 * `hidden` is true while the list is kept and not drawn: it loads nothing then, and hears no scroll.
 */
export function useSkinPages(chips: readonly FilterChip[], hidden: boolean): SkinPages {
  const key = JSON.stringify(browseChips(chips));
  const query = useMemo(() => browseChips(chips), [key]);
  // The list held, and the chips it answers. It is drawn until this set's own first page lands.
  const [held, setHeld] = useState<{ key: string; page: SkinPage } | null>(null);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  // Whether the person has scrolled this list down. Until they do, nothing is read ahead.
  const [scrolled, setScrolled] = useState(false);
  const asked = useRef(key);
  const busy = useRef(false);
  const panel = useRef<HTMLElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const load = useCallback((offset: number): void => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    engine.catalogueSkins(query, offset, SKIN_PAGE_SIZE)
      // An answer for chips since changed is dropped: `asked` is the set the page is on now.
      .then((answer) => {
        if (asked.current === key) setHeld((last) => ({ key, page: appendPage(offset > 0 && last?.key === key ? last.page : null, answer) }));
      })
      .catch(() => { if (asked.current === key) setFailed(true); })
      .finally(() => { if (asked.current === key) busy.current = false; });
  }, [query, key]);

  useEffect(() => {
    asked.current = key;
    busy.current = false;
    setSlow(false);
    // A new list is read from its top, and has not been scrolled.
    setScrolled(false);
    load(0);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [key, load]);

  // The first scroll down, measured from where the list was when it was shown: the page above it
  // has put it at the top, or back where it was left. The page behind the grid scrolls the same
  // box, so nothing is heard while the grid is hidden.
  useEffect(() => {
    const scroller = hidden || scrolled ? null : scrollParent(panel.current);
    if (!scroller) return undefined;
    const from = scroller.scrollTop;
    const onScroll = (): void => { if (scroller.scrollTop > from + SCROLLED_PX) setScrolled(true); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [hidden, scrolled, key]);

  const shown = held?.page ?? null;
  // Only this set's own list pages on; the last set's tiles are on screen for a moment and no longer.
  const next = held?.key === key ? held.page.next : null;

  // The next page, when the end of the grid is in the window, or, once the list is being scrolled,
  // a little below it. The observer is made again for each page: a new one reports where the end
  // is now, so a window tall enough to show a whole page keeps asking until the grid reaches its
  // foot or the list ends, and then waits for a scroll.
  useEffect(() => {
    const mark = end.current;
    if (hidden || failed || next === null || !mark) return undefined;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) load(next); },
      { root: scrollParent(mark), rootMargin: `0px 0px ${scrolled ? AHEAD_PX : 0}px 0px` }
    );
    observer.observe(mark);
    return () => observer.disconnect();
  }, [next, hidden, failed, scrolled, load]);

  return { shown, total: held?.key === key ? held.page.total : undefined, failed, slow, retry: () => load(next ?? 0), panel, end };
}

export function ItemBrowse({ chips, hidden, onOpen }: {
  chips: readonly FilterChip[];
  /** True while an item opened from the grid is on screen: kept, not drawn, and loading nothing. */
  hidden: boolean;
  onOpen: (skin: Skin) => void;
}): React.JSX.Element {
  const { shown, total, failed, slow, retry: again, panel, end } = useSkinPages(chips, hidden);
  const retry = <Button size="sm" icon="refresh" onClick={again}>Try again</Button>;
  return (
    <section ref={panel} className="panel items-browse" hidden={hidden} data-testid="items-browse" data-total={total}>
      <div className="panel-body">
        {shown === null ? (
          failed ? <Empty icon="alert-triangle" title="The catalogue could not be read" action={retry} />
            : slow ? <div className="items-tiles" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <TilePlaceholder key={index} />)}</div>
            : <div className="items-tiles-wait" />
        ) : shown.total === 0 ? (
          <Empty icon="search" title="No items match" />
        ) : (
          <>
            <div className="holdings-label" data-testid="items-browse-count">{shown.total.toLocaleString()} {shown.total === 1 ? 'item' : 'items'}</div>
            <div className="items-tiles">
              {shown.skins.map((skin) => (
                <SkinTile key={skin.name} name={skin.name} imageUrl={skin.imageUrl} rarity={skin.rarity} onOpen={() => onOpen(skin)} />
              ))}
            </div>
            {failed ? <div className="items-tiles-more">{retry}</div> : null}
            <div ref={end} className="items-tiles-end" aria-hidden="true" />
          </>
        )}
      </div>
    </section>
  );
}

function TilePlaceholder(): React.JSX.Element {
  return (
    <span className="items-tile" data-placeholder>
      <Skeleton width={56} height={56} className="skeleton-square" />
      <span className="items-tile-text">
        <Skeleton width="45%" height={10} />
        <Skeleton width="80%" height={12} />
      </span>
    </span>
  );
}
