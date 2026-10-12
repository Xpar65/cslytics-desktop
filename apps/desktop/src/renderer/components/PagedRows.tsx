import React, { useEffect, useRef, useState } from 'react';
import type { PageEnvelope } from '@cslytics/engine';
import { Button, Empty, Notice, Skeleton } from './ui.js';
import { Icon } from './Icon.js';
import { nearEnd } from './PagedGrid.js';

const ROW = 64;

/**
 * Virtual rows over keyset pages.
 *
 * The list is a fixed-height viewport: rows are 64px, only the ones in view are in the DOM.
 * `infinite` concatenates loaded pages as the viewport approaches the end, which is how
 * inventory is looked at. Other screens keep the eight-page cache and the pager under the list.
 *
 * One row may grow (`expandedKey`) when its render returns extra content — a group opening its
 * copies underneath. Later rows shift down by the measured extra height so the sub-table occupies
 * real space rather than painting over them.
 */
export function PagedRows<T>({ load, render, rowKey, onPage, emptyTitle = 'Nothing here yet', emptyHint, header, expandedKey, viewportCap = 480, nested = false, infinite = false, noun = 'records' }: {
  load: (cursor?: string) => Promise<PageEnvelope<T>>;
  render: (row: T) => React.ReactNode;
  rowKey: (row: T) => string;
  onPage?: ((page: Extract<PageEnvelope<T>, { kind: 'page' }>) => void) | undefined;
  emptyTitle?: string | undefined;
  emptyHint?: React.ReactNode | undefined;
  /** Rendered in the count strip, beside the total: filters, a selection summary, anything. */
  header?: React.ReactNode | undefined;
  /** `rowKey` of the row that is allowed to grow past 64px. */
  expandedKey?: string | undefined;
  /** Viewport height cap in px. Nested lists sit under a row, so they use a shorter one. */
  viewportCap?: number | undefined;
  /** Quieter chrome when this list is a sub-table inside another. */
  nested?: boolean | undefined;
  /**
   * Concatenate pages instead of turning them. Inventory uses this; a history of 100,000 rows
   * still wants the pager, because walking that far in one list is how the eight-page cache
   * existed in the first place.
   */
  infinite?: boolean | undefined;
  /** What the count strip calls a row. "3 listings" beats "3 records" on a page of listings. */
  noun?: string | undefined;
}): React.JSX.Element {
  type Cached = { cursor?: string; page: Extract<PageEnvelope<T>, { kind: 'page' }> };
  const [cache, setCache] = useState<Cached[]>([]);
  const [index, setIndex] = useState(0);
  const [top, setTop] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [extra, setExtra] = useState(0);
  const extraHold = useRef(0);
  const ticket = useRef(0);
  const inflight = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const current = cache[index];
  const tail = infinite ? cache.at(-1) : current;
  const nextCursor = tail?.page.nextCursor ?? null;
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  async function fetchPage(cursor?: string, append = false) {
    if (append && inflight.current) return;
    const request = ++ticket.current;
    inflight.current = true;
    setLoading(true); setError('');
    try {
      let page = await load(cursor);
      if (request !== ticket.current) return;
      if (page.kind === 'stale-page') { page = await load(); append = false; cursor = undefined; }
      if (request !== ticket.current || page.kind !== 'page') return;
      const entry: Cached = { ...(cursor ? { cursor } : {}), page };
      if (infinite) {
        const next = append ? [...cacheRef.current, entry] : [entry];
        cacheRef.current = next;
        setCache(next);
        onPage?.(page);
        if (!append) {
          setTop(0);
          if (viewport.current) viewport.current.scrollTop = 0;
        }
      } else if (append) {
        const next = [...cache.slice(0, index + 1), entry].slice(-8);
        setCache(next); setIndex(next.length - 1);
        onPage?.(page); setTop(0);
        if (viewport.current) viewport.current.scrollTop = 0;
      } else {
        setCache([entry]); setIndex(0);
        onPage?.(page); setTop(0);
        if (viewport.current) viewport.current.scrollTop = 0;
      }
    } catch (reason) { if (request === ticket.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      if (request === ticket.current) {
        setLoading(false);
        inflight.current = false;
      }
    }
  }
  useEffect(() => { void fetchPage(); return () => { ticket.current += 1; inflight.current = false; }; }, [load]);

  const rows = infinite ? cache.flatMap((item) => item.page.rows) : (current?.page.rows ?? []);
  const expandedIndex = expandedKey ? rows.findIndex((row) => rowKey(row) === expandedKey) : -1;

  // Start the opened row at 64px, then grow to the measured sub-table so the extra copies appear
  // to come out from under it. Measuring after paint is what makes that transition exist.
  useEffect(() => {
    if (!expandedKey) {
      extraHold.current = 0;
      setExtra(0);
      return undefined;
    }
    extraHold.current = 0;
    setExtra(0);
    const root = viewport.current;
    if (!root) return undefined;
    let observer: ResizeObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const rowOf = (): HTMLElement | undefined =>
        [...root.querySelectorAll<HTMLElement>(':scope > .virtual-space > .virtual-row')]
          .find((node) => node.dataset.rowKey === expandedKey);
      const measure = (): void => {
        const node = rowOf();
        const stack = node?.querySelector<HTMLElement>('.group-stack');
        if (!stack) return;
        const style = getComputedStyle(stack);
        const margin = Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
        const next = Math.round(stack.offsetHeight + margin);
        if (next === extraHold.current) return;
        extraHold.current = next;
        setExtra(next);
      };
      measure();
      const node = rowOf();
      if (!node) return;
      observer = new ResizeObserver(measure);
      observer.observe(node);
      const stack = node.querySelector('.group-stack');
      if (stack) observer.observe(stack);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [expandedKey, index, rows.length]);

  const overscan = expandedIndex >= 0 ? 8 : 5;
  const first = Math.max(0, Math.floor(Math.max(0, top - extra) / ROW) - overscan);
  const windowSize = 20 + overscan + (extra > 0 ? Math.ceil(extra / ROW) : 0);
  const shown = new Set<number>();
  for (let i = first; i < Math.min(rows.length, first + windowSize); i += 1) shown.add(i);
  if (expandedIndex >= 0) shown.add(expandedIndex);
  const visibleAt = [...shown].sort((left, right) => left - right);
  const topOf = (i: number): number => i * ROW + (expandedIndex >= 0 && i > expandedIndex ? extra : 0);
  const space = rows.length * ROW + extra;
  // A nested list opens under its group row. Until its first page arrives it holds one row, so the
  // tray only ever grows into its copies. Reserving the whole skeleton and then shrinking back to a
  // short group's one or two copies read as a bounce, and so did a footer that showed only while
  // that first page loaded.
  const opening = nested && cache.length === 0 && !error;
  const viewportHeight = opening ? ROW : rows.length === 0 ? Math.min(200, viewportCap) : Math.min(expandedKey ? Math.max(viewportCap, 560) : viewportCap, space);
  const total = tail?.page.total.quantity;
  const pageNumber = index + 1;
  const showFoot = !infinite || !nested || (loading && rows.length > 0) || Boolean(nextCursor);

  function loadMoreIfNeeded(node: HTMLElement): void {
    if (!infinite) return;
    const cursor = nextCursorRef.current;
    if (!cursor || loadingRef.current) return;
    if (nearEnd(node.scrollTop, node.clientHeight, node.scrollHeight)) void fetchPage(cursor, true);
  }

  useEffect(() => {
    if (infinite && viewport.current) loadMoreIfNeeded(viewport.current);
  }, [infinite, rows.length, extra, viewportHeight, nextCursor, loading]);

  return <div className="paged-rows" data-nested={nested || undefined} data-infinite={infinite || undefined} data-cache-pages={cache.length} data-loaded-rows={rows.length} aria-busy={loading}>
    <div className="paged-head">
      <span className="paged-total" data-testid="page-total">
        {total === undefined ? <Skeleton width={90} /> : <><strong className="num">{total.toLocaleString()}</strong> {nested ? 'in this group' : noun}</>}
        {nested ? null : <span className="badge" data-tone="quiet" title="Read from the local cache of the last complete observation. Nothing here reaches Steam."><Icon name="database" size={11} /> Cached observation</span>}
      </span>
      {header}
    </div>
    {error ? <Notice tone="warn" role="alert" title="This view cannot be shown">{error}</Notice> : null}
    <div ref={viewport} className="virtual-viewport" style={{ height: viewportHeight }} onScroll={event => {
      const node = event.currentTarget; setTop(node.scrollTop);
      if (infinite) loadMoreIfNeeded(node);
      else if (!loading && node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2 && current?.page.nextCursor) void fetchPage(current.page.nextCursor, true);
    }}>
      <div className="virtual-space" style={{ height: space }}>
        {visibleAt.map((at) => {
          const row = rows[at]!;
          const key = rowKey(row);
          const opened = key === expandedKey;
          return (
            <div
              className="virtual-row"
              data-row-key={key}
              data-expanded={opened || undefined}
              key={key}
              style={{ top: topOf(at), height: opened ? ROW + extra : ROW }}
            >
              {render(row)}
            </div>
          );
        })}
      </div>
      {loading && rows.length === 0 ? (
        <div className="virtual-skeleton" aria-hidden="true">
          {(opening ? [0] : [0, 1, 2, 3, 4]).map((n) => <div className="skeleton-row" key={n}><Skeleton width={44} height={44} className="skeleton-square" /><span className="skeleton-lines"><Skeleton width="42%" /><Skeleton width="28%" height={11} /></span></div>)}
        </div>
      ) : null}
      {!loading && !error && rows.length === 0 ? <Empty title={emptyTitle} hint={emptyHint} /> : null}
    </div>
    {showFoot ? (
      <div className="paged-foot">
        {infinite ? (
          <>
            <span className="paged-page quiet">
              {loading && rows.length > 0 ? 'Loading more…' : nextCursor ? `${rows.length.toLocaleString()} loaded` : rows.length > 0 ? 'end of list' : ''}
            </span>
            <span className="toolbar">
              {nested ? null : <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void fetchPage()}>Refresh cached view</Button>}
            </span>
          </>
        ) : (
          <>
            <span className="paged-page quiet">Page {pageNumber}{current?.page.hasNext ? '' : ' · end of list'}</span>
            <span className="toolbar">
              <Button size="sm" icon="chevron-left" disabled={loading || index === 0} onClick={() => { setIndex(index - 1); setTop(0); if (viewport.current) viewport.current.scrollTop = 0; onPage?.(cache[index - 1]!.page); }}>Previous page</Button>
              <Button size="sm" iconRight="chevron-right" disabled={loading || !current?.page.nextCursor} onClick={() => void fetchPage(current?.page.nextCursor ?? undefined, true)}>Next page</Button>
              {nested ? null : <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void fetchPage()}>Refresh cached view</Button>}
            </span>
          </>
        )}
      </div>
    ) : null}
  </div>;
}
