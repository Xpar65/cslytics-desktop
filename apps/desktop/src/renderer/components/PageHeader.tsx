import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * A page's part of the window's one header.
 *
 * The shell's top bar names the open section; the page says what it is about and carries its
 * own controls. Before this, every page opened on a panel that repeated the section's name under
 * the top bar that had just printed it. The page still owns the state behind its controls, so it
 * portals them into the bar rather than lifting that state into the shell — the same move the
 * listing workspace makes into the account strip.
 *
 * Each part goes to its own slot, so a page may render this more than once: Records puts its
 * tabs in from the shell and the open book's description from the book.
 */

export type PageHeaderSlots = {
  subtitle: HTMLElement | null;
  badge: HTMLElement | null;
  actions: HTMLElement | null;
};

const Slots = createContext<PageHeaderSlots | null>(null);

export const PageHeaderSlotsProvider = Slots.Provider;

export function PageHeader({
  subtitle,
  badge,
  actions
}: {
  /** What the page is about. Takes the place of the section's own one-line description. */
  subtitle?: React.ReactNode | undefined;
  /** A state of the page worth naming beside its title, such as a frozen selection. */
  badge?: React.ReactNode | undefined;
  /** Page-wide controls, at the right-hand end of the header before the connection and status. */
  actions?: React.ReactNode | undefined;
}): React.JSX.Element | null {
  const slots = useContext(Slots);
  // The slots are elements the shell has to mount first, so the first render has nowhere to go.
  if (!slots) return null;
  return <>
    {subtitle && slots.subtitle ? createPortal(subtitle, slots.subtitle) : null}
    {badge && slots.badge ? createPortal(badge, slots.badge) : null}
    {actions && slots.actions ? createPortal(actions, slots.actions) : null}
  </>;
}
