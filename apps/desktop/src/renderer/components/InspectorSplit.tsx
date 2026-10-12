import React, { useRef, useState } from 'react';
import { InspectorDivider } from './InspectorDivider.js';
import { INSPECTOR_MIN_WIDTH, MAIN_MIN_WIDTH, inspectorWidthKey, readInspectorWidth, type InspectorLayout } from './inspector-width.js';

const LAYOUTS: readonly InspectorLayout[] = ['grouped', 'tiles', 'listings', 'trades'];

/**
 * A list or a grid, the inspector beside it, and the divider dragged between them.
 *
 * Inventory and Listings are the same page twice — something tiled on the left, the thing just
 * clicked on the right — so the join is one component and the two pages differ only in what they
 * put either side of it. Inventory has a filter rail as well; Listings filters from its toolbar
 * and passes none.
 *
 * The width is per layout and remembered per window, like the view itself. Mid-drag it goes
 * straight onto the grid as a custom property, and React hears about it once, on release, so
 * moving the pointer never re-renders a page of rows or tiles.
 */
export function InspectorSplit({ layout, rail, railState = 'open', railWidth, inspector, children }: {
  layout: InspectorLayout;
  /** The filter rail, for a page that has one. */
  rail?: React.ReactNode;
  railState?: 'open' | 'collapsed' | undefined;
  /** A rail that lists things rather than filters them — Trades' list of trades — needs more room. */
  railWidth?: 'wide' | undefined;
  /** `null` is the page used as a picker: the list alone, with nothing to act on it. */
  inspector: React.ReactNode | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const [widths, setWidths] = useState<Record<InspectorLayout, number>>(() => Object.fromEntries(LAYOUTS.map((each) => [
    each,
    readInspectorWidth(typeof localStorage === 'undefined' ? null : localStorage.getItem(inspectorWidthKey(each)))
  ])) as Record<InspectorLayout, number>);
  const [resizing, setResizing] = useState(false);
  const split = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);

  function measure(): { inspector: number; room: number } | null {
    if (!main.current || !column.current) return null;
    const width = column.current.getBoundingClientRect().width;
    return { inspector: width, room: main.current.getBoundingClientRect().width + width };
  }

  function commit(width: number): void {
    setWidths((current) => (current[layout] === width ? current : { ...current, [layout]: width }));
    localStorage.setItem(inspectorWidthKey(layout), String(width));
  }

  return (
    <div
      ref={split}
      className="inventory-split"
      data-rail={rail ? undefined : 'none'}
      data-filters={railState}
      data-rail-width={railWidth}
      data-picker={inspector === null || undefined}
      data-resizing={resizing || undefined}
      style={inspector === null ? undefined : {
        '--inspector-width': `${widths[layout]}px`,
        '--inspector-min': `${INSPECTOR_MIN_WIDTH}px`,
        '--main-min': `${MAIN_MIN_WIDTH[layout]}px`
      } as React.CSSProperties}
    >
      {rail}
      <div className="inventory-main" ref={main}>{children}</div>
      {inspector === null ? null : (
        <div className="inspector-column" ref={column}>
          <InspectorDivider
            view={layout}
            width={widths[layout]}
            measure={measure}
            onPreview={(width) => split.current?.style.setProperty('--inspector-width', `${width}px`)}
            onCommit={commit}
            onResizing={setResizing}
          />
          {inspector}
        </div>
      )}
    </div>
  );
}
