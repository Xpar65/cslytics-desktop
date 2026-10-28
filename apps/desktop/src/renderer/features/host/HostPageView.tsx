import React, { useEffect, useRef, useState } from 'react';
import type { HostPage } from '../../../shared/api.js';
import { engine } from '../../lib/engine.js';
import { Notice } from '../../components/ui.js';

/**
 * A page the connected engine host serves (remote engine host plan D12).
 *
 * The page itself is not rendered here: main shows it in its own sandboxed view over this frame,
 * which is why the frame is empty. What this component owns is the frame's rectangle, sent to main
 * on mount and on every change of size or place, and the view's removal on unmount. While a drawer
 * or a dialog is open over the content the view is hidden too, because a native view paints above
 * everything in this window.
 */
export function HostPageView({ page }: { page: HostPage }): React.JSX.Element {
  const frame = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    let cancelled = false;
    let scheduled: number | null = null;
    let covered = false;
    const place = (): void => {
      scheduled = null;
      if (cancelled) return;
      if (covered) {
        void engine.hideHostPage().catch(() => undefined);
        return;
      }
      const rect = element.getBoundingClientRect();
      void engine.showHostPage(page.id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .then(() => { if (!cancelled) setError(null); })
        .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    };
    const schedule = (): void => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(place);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    window.addEventListener('resize', schedule);
    // A drawer or a dialog over the content: the view steps aside until it closes.
    const cover = new MutationObserver(() => {
      const next = document.querySelector('.drawer, .modal, [role="dialog"]') !== null;
      if (next !== covered) {
        covered = next;
        schedule();
      }
    });
    cover.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => {
      cancelled = true;
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      resize.disconnect();
      cover.disconnect();
      window.removeEventListener('resize', schedule);
      void engine.hideHostPage().catch(() => undefined);
    };
  }, [page.id, page.path]);

  return (
    <>
      {error ? <Notice tone="error" role="status" title="The host page could not be shown">{error}</Notice> : null}
      <div ref={frame} className="host-page-frame" data-testid="host-page-frame" data-page={page.id}>
        {error ? null : <span>Loading {page.title} from the engine host…</span>}
      </div>
    </>
  );
}
