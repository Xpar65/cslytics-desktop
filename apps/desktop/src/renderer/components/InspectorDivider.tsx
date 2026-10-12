import React, { useRef, useState } from 'react';
import {
  clampInspectorWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_KEY_STEP,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  type InspectorLayout
} from './inspector-width.js';

type Drag = { pointerId: number; x: number; start: number; room: number; last: number; moved: boolean };

/**
 * The join between the list or grid and the item inspector, dragged to trade width between them.
 *
 * It fills the gap between the two columns, so the whole join is the target, and it only draws
 * itself when the pointer is over it or it has focus. A drag previews by writing the width straight
 * onto the grid and commits once, on release, so moving the pointer never re-renders a page of
 * rows or tiles.
 *
 * A click that does not move commits nothing: the track can be clamped narrower than the saved
 * width by a small window, and a stray click on the divider must not overwrite what was saved.
 */
export function InspectorDivider({ view, width, measure, onPreview, onCommit, onResizing }: {
  view: InspectorLayout;
  /** The saved width for this view. */
  width: number;
  /** The inspector's rendered width and the room it shares with the list, or `null` before layout. */
  measure: () => { inspector: number; room: number } | null;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  onResizing: (resizing: boolean) => void;
}): React.JSX.Element {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  function finish(event: React.PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    onResizing(false);
    if (current.moved) onCommit(current.last);
  }

  function commitWithin(next: number): void {
    const box = measure();
    if (box) onCommit(clampInspectorWidth(next, box.room, view));
  }

  return <div
    className="split-handle"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize item inspector"
    aria-valuemin={INSPECTOR_MIN_WIDTH}
    aria-valuemax={INSPECTOR_MAX_WIDTH}
    aria-valuenow={width}
    title="Drag to resize. Double-click to reset."
    tabIndex={0}
    data-dragging={dragging || undefined}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const box = measure();
      if (!box) return;
      // No text selection starts under a drag.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      // From the rendered width, not the saved one, so the divider never jumps under the pointer.
      drag.current = { pointerId: event.pointerId, x: event.clientX, start: box.inspector, room: box.room, last: box.inspector, moved: false };
      setDragging(true);
      onResizing(true);
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      // Dragging left widens the inspector.
      const next = clampInspectorWidth(current.start + current.x - event.clientX, current.room, view);
      if (next === current.last) return;
      current.last = next;
      current.moved = true;
      onPreview(next);
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onDoubleClick={() => commitWithin(INSPECTOR_DEFAULT_WIDTH)}
    onKeyDown={(event) => {
      const box = measure();
      if (!box) return;
      // Steps start from the saved width rather than the rendered one: a second press lands while
      // the track is still animating from the first.
      const base = clampInspectorWidth(width, box.room, view);
      const next = event.key === 'ArrowLeft' ? base + INSPECTOR_KEY_STEP
        : event.key === 'ArrowRight' ? base - INSPECTOR_KEY_STEP
          : event.key === 'Home' ? INSPECTOR_MIN_WIDTH
            : event.key === 'End' ? INSPECTOR_MAX_WIDTH
              : event.key === 'Enter' ? INSPECTOR_DEFAULT_WIDTH
                : null;
      if (next === null) return;
      event.preventDefault();
      onCommit(clampInspectorWidth(next, box.room, view));
    }}
  >
    <span className="split-grip" aria-hidden="true" />
  </div>;
}
