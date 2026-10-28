import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * A page's part of the window's one header.
 *
 * The shell's top bar names the open section; the page carries its own controls into it. Before
 * this, every page opened on a panel that repeated the section's name under the top bar that had
 * just printed it, and for a while each page described itself in a line under the title, which
 * nobody read. The page still owns the state behind its controls, so it portals them into the bar
 * rather than lifting that state into the shell — the same move the listing workspace makes into
 * the account strip.
 *
 * Each part goes to its own slot, so a page may render this more than once.
 */

export type PageHeaderSlots = {
  badge: HTMLElement | null;
  actions: HTMLElement | null;
};

const Slots = createContext<PageHeaderSlots | null>(null);

export const PageHeaderSlotsProvider = Slots.Provider;

export function PageHeader({
  badge,
  actions
}: {
  /** A state of the page worth naming beside its title, such as a frozen selection. */
  badge?: React.ReactNode | undefined;
  /** Page-wide controls, at the right-hand end of the header before the connection and status. */
  actions?: React.ReactNode | undefined;
}): React.JSX.Element | null {
  const slots = useContext(Slots);
  // The slots are elements the shell has to mount first, so the first render has nowhere to go.
  if (!slots) return null;
  return <>
    {badge && slots.badge ? createPortal(badge, slots.badge) : null}
    {actions && slots.actions ? createPortal(actions, slots.actions) : null}
  </>;
}
