import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PageEnvelope } from '@cslytics/engine';
import { Button, Empty, Notice, Skeleton } from './ui.js';

/**
 * `PagedRows`, for tiles.
 *
 * Same keyset cursor and stale-page recovery as the list. Pages concatenate as the viewport
 * approaches the end, so the grid is one infinite list rather than a book of pages — scrolling
 * back still shows what was loaded, which is why this cache is not sliced to eight.
 *
 * A list virtualises rows of one; this virtualises rows of `columns`, where `columns` comes from
 * measuring the viewport rather than from a breakpoint, so the grid is `auto-fill` in CSS and the
 * virtualiser agrees with it at every width.
 *
 * The measurement is the part worth being careful about: get `columns` wrong and the window of
 * rendered tiles is offset from the one being scrolled, which reads as items that vanish when you
 * scroll past them.
 */

/** Kept in step with `--tile-min` and the 10px gap in `app.css`. */
export const TILE_MIN_WIDTH = 132;
export const TILE_GAP = 10;
export const TILE_HEIGHT = 186;
const OVERSCAN_ROWS = 2;
const VIEWPORT_HEIGHT = 560;
/** About two tile-rows: close enough that the next keyset page is in flight before the end. */
export const LOAD_MORE_SLACK = 120;

/** How many `minmax(TILE_MIN_WIDTH, 1fr)` columns fit, which is what `auto-fill` does. */
export function tileColumns(width: number, minWidth = TILE_MIN_WIDTH, gap = TILE_GAP): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

/**
 * Whether the next keyset page should load.
 *
 * A first page that does not fill the viewport is near the end at scrollTop 0: that is how a
 * short page still walks, rather than waiting for a scroll that cannot happen.
 */
export function nearEnd(scrollTop: number, clientHeight: number, scrollHeight: number, slack = LOAD_MORE_SLACK): boolean {
  if (!(clientHeight > 0) || !Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight)) return false;
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** The inclusive row window to render for a scroll position, with overscan on both sides. */
export function rowWindow(scrollTop: number, viewportHeight: number, rowHeight: number, rowCount: number): { first: number; last: number } {
  if (rowCount <= 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const visible = Math.ceil(viewportHeight / rowHeight) + OVERSCAN_ROWS * 2;
  return { first, last: Math.min(rowCount - 1, first + visible) };
}

export function PagedGrid<T>({ load, render, rowKey, onRows, emptyTitle = 'Nothing here yet', emptyHint, header, tileHeight = TILE_HEIGHT, tileMinWidth = TILE_MIN_WIDTH, fit = false, noun = 'records' }: {
  load: (cursor?: string) => Promise<PageEnvelope<T>>;
  render: (row: T, index: number) => React.ReactNode;
  rowKey: (row: T) => string;
  /** Every loaded row, so range-select spans pages that have been scrolled in. */
  onRows?: ((rows: T[]) => void) | undefined;
  emptyTitle?: string | undefined;
  emptyHint?: React.ReactNode | undefined;
  header?: React.ReactNode | undefined;
  tileHeight?: number | undefined;
  /** For a tile that carries more than a name: a price and its controls need the room. */
  tileMinWidth?: number | undefined;
  /**
   * Shrink the viewport to the rows loaded, up to the usual height. For a grid that shares the page
   * with another — a trade's two sides — where a fixed 560px would leave a two-tile side mostly empty.
   */
  fit?: boolean | undefined;
  /** What the count strip calls a tile. "3 items" beats "3 records". */
  noun?: string | undefined;
}): React.JSX.Element {
  type Cached = { cursor?: string; page: Extract<PageEnvelope<T>, { kind: 'page' }> };
  const [cache, setCache] = useState<Cached[]>([]);
  const [top, setTop] = useState(0);
  const [columns, setColumns] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const ticket = useRef(0);
  const inflight = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  const tail = cache.at(-1);
  const nextCursor = tail?.page.nextCursor ?? null;
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const fetchPage = useCallback(async (cursor?: string, append = false) => {
    if (append && inflight.current) return;
    const request = ++ticket.current;
    inflight.current = true;
    setLoading(true); setError('');
    try {
      let page = await load(cursor);
      if (request !== ticket.current) return;
      // A cursor bound to a revision that has moved is not an error and not an empty page: it is
      // a request to start again, which is what keeps a page turn honest after an observation.
      if (page.kind === 'stale-page') { page = await load(); append = false; cursor = undefined; }
      if (request !== ticket.current || page.kind !== 'page') return;
      const entry: Cached = { ...(cursor ? { cursor } : {}), page };
      const next = append ? [...cacheRef.current, entry] : [entry];
      cacheRef.current = next;
      setCache(next);
      onRowsRef.current?.(next.flatMap((item) => item.page.rows));
      if (!append) {
        setTop(0);
        if (viewport.current) viewport.current.scrollTop = 0;
      }
    } catch (reason) { if (request === ticket.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      if (request === ticket.current) {
        setLoading(false);
        inflight.current = false;
      }
    }
  }, [load]);

  useEffect(() => { void fetchPage(); return () => { ticket.current += 1; inflight.current = false; }; }, [fetchPage]);

  // The column count follows the window, not a breakpoint, so the virtualiser and `auto-fill`
  // never disagree about how many tiles are on a row.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return undefined;
    const measure = (): void => setColumns(tileColumns(node.clientWidth, tileMinWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [cache.length, tileMinWidth]);

  const rows = cache.flatMap((item) => item.page.rows);
  const rowCount = Math.ceil(rows.length / columns);
  const height = tileHeight + TILE_GAP;
  const { first, last } = rowWindow(top, VIEWPORT_HEIGHT, height, rowCount);
  const total = tail?.page.total.quantity;
  const visible: Array<{ row: T; index: number; line: number }> = [];
  for (let line = first; line <= last; line += 1) {
    for (let column = 0; column < columns; column += 1) {
      const position = line * columns + column;
      const row = rows[position];
      if (row !== undefined) visible.push({ row, index: position, line });
    }
  }

  function loadMoreIfNeeded(node: HTMLElement): void {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingRef.current) return;
    if (nearEnd(node.scrollTop, node.clientHeight, node.scrollHeight)) void fetchPage(cursor, true);
  }

  useEffect(() => {
    if (viewport.current) loadMoreIfNeeded(viewport.current);
    // Rows, columns and the cursor are what change whether the viewport still has room.
  }, [rows.length, columns, nextCursor, loading]);

  return <div className="paged-grid" data-infinite="true" data-cache-pages={cache.length} data-loaded-rows={rows.length} data-columns={columns} aria-busy={loading}>
    <div className="paged-head">
      <span className="paged-total" data-testid="page-total">
        {total === undefined ? <Skeleton width={90} /> : <><strong className="num">{total.toLocaleString()}</strong> {total === 1 ? noun.replace(/s$/, '') : noun}</>}
      </span>
      {header}
    </div>
    {error ? <Notice tone="warn" role="alert" title="This view cannot be shown">{error}</Notice> : null}
    <div
      ref={viewport}
      className="virtual-viewport tile-viewport"
      style={{ height: rows.length === 0 ? (fit ? 140 : 200) : fit ? Math.min(VIEWPORT_HEIGHT, rowCount * height + 4) : VIEWPORT_HEIGHT }}
      onScroll={(event) => {
        const node = event.currentTarget;
        setTop(node.scrollTop);
        loadMoreIfNeeded(node);
      }}
    >
      <div className="virtual-space" style={{ height: rowCount * height }}>
        {visible.map(({ row, index: position, line }) => (
          <div
            className="tile-slot"
            key={rowKey(row)}
            data-row-key={rowKey(row)}
            style={{ top: line * height, left: `calc(${(position % columns) * (100 / columns)}% + ${(position % columns) ? TILE_GAP / 2 : 0}px)`, width: `calc(${100 / columns}% - ${TILE_GAP}px)` }}
          >
            {render(row, position)}
          </div>
        ))}
      </div>
      {loading && rows.length === 0 ? (
        <div className="tile-skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => <Skeleton key={n} height={TILE_HEIGHT} className="skeleton-square" />)}
        </div>
      ) : null}
      {!loading && !error && rows.length === 0 ? <Empty title={emptyTitle} hint={emptyHint} /> : null}
    </div>
    <div className="paged-foot">
      <span className="paged-page quiet">
        {loading && rows.length > 0 ? 'Loading more…' : ''}
      </span>
      <span className="toolbar">
        <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void fetchPage()}>Refresh</Button>
      </span>
    </div>
  </div>;
}
