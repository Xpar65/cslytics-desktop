import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';

/**
 * An explanation kept off the page until someone asks for it, on the thing it explains.
 *
 * A page that says what every figure means in a sentence under it buries the figures. The sentence
 * belongs where a reader who wonders goes looking: on the figure, or on a small ⓘ beside a title.
 * Hover, focus or a tap opens it; Escape, leaving, blurring or a scroll closes it.
 *
 * The text is always in the document, visually hidden and named by `aria-describedby`, so a screen
 * reader hears it with the trigger and a test can read it in place. What appears on hover is a copy
 * drawn in a portal on `document.body`, because a panel clips its overflow and an entering panel is
 * transformed, and either would cut a bubble positioned inside it.
 */
export function Tip({
  content,
  children,
  label = 'What this means',
  wide = false
}: {
  content: React.ReactNode;
  /** The thing explained. Without it the trigger is a small ⓘ, named by `label`. */
  children?: React.ReactNode;
  label?: string | undefined;
  /** For a tip that carries a breakdown rather than a sentence. */
  wide?: boolean | undefined;
}): React.JSX.Element {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number; below: boolean } | null>(null);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => { setOpen(false); setPlace(null); }, []);

  // Above the trigger and centred on it, below when there is no room above, and never off either side.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return;
    const at = trigger.current.getBoundingClientRect();
    const size = bubble.current.getBoundingClientRect();
    const gap = 8;
    const below = at.top - size.height - gap < gap;
    const top = below ? at.bottom + gap : at.top - size.height - gap;
    const left = Math.min(Math.max(gap, at.left + at.width / 2 - size.width / 2), window.innerWidth - size.width - gap);
    setPlace({ top, left, below });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide(); };
    // A scroll moves the trigger out from under a bubble that is fixed to the viewport.
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', hide, true); };
  }, [open, hide]);

  const handlers = {
    onPointerEnter: show,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
    // Opens, never toggles: a click is preceded by the focus that already opened it.
    onClick: (event: React.MouseEvent) => { event.stopPropagation(); show(); }
  };

  return (
    <>
      {children === undefined ? (
        <button
          ref={(node) => { trigger.current = node; }}
          type="button"
          className="tip-icon"
          aria-label={label}
          aria-describedby={id}
          {...handlers}
        >
          <Icon name="info" size={13} />
        </button>
      ) : (
        <span ref={(node) => { trigger.current = node; }} className="tip-target" tabIndex={0} aria-describedby={id} {...handlers}>
          {children}
        </span>
      )}
      <span id={id} className="visually-hidden">{content}</span>
      {open ? createPortal(
        <div
          ref={bubble}
          className="tip-bubble"
          data-wide={wide || undefined}
          data-below={place?.below || undefined}
          aria-hidden="true"
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
        >
          {content}
        </div>,
        document.body
      ) : null}
    </>
  );
}
