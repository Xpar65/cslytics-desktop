import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { BodyVariant, ConditionKindId, EventKindId, Route } from './kinds.js';
import { EMPTY_STATE, nextToastExpiry, reduce, type NotificationAction, type NotificationState } from './model.js';
import { useCatalogueProducer } from './producers/catalogue.js';
import { useReleaseProducer } from './producers/release.js';
import { useVenueProducer } from './producers/venue.js';
import { useWorkFailureProducer } from './producers/work.js';
import { useEngineFactsProducer } from './producers/engine.js';
import { useEngineHostProducer } from './producers/engine-host.js';
import { useWorkPanelOpener } from '../work/WorkIndicator.js';

/**
 * What a producer and a surface can do with the record. One object for the window, shared.
 *
 * `raise`, `assert` and `resolve` are typed by shape, so the wrong verb for a kind is a type
 * error before it is a runtime one, and `variant` can only name a body the registry declares.
 */
export type NotificationApi = {
  state: NotificationState;
  /** The clock the toast selectors read. It moves when a toast is due to leave, not every second. */
  now: number;
  /** Something happened once. */
  raise<K extends EventKindId>(kind: K, options?: RaiseOptions<K>): void;
  /** A condition holds. Safe to repeat: it changes nothing while the condition already holds. */
  assert<K extends ConditionKindId>(kind: K, options?: RaiseOptions<K>): void;
  /** A condition stopped holding. Safe to repeat. */
  resolve(kind: ConditionKindId, accountId?: string | null | undefined): void;
  /** The toast's ×. The row stays, and stays unseen. */
  closeToast(id: string): void;
  /** The bell was opened. */
  markAllSeen(): void;
  /** Takes the user where a notification's action points. */
  navigate(route: Route): void;
};

type RaiseOptions<K extends EventKindId | ConditionKindId> = {
  accountId?: string | null | undefined;
  variant?: BodyVariant<K> | undefined;
};

const NotificationContext = createContext<NotificationApi | null>(null);

/**
 * Holds the record for the window and mounts every producer once.
 *
 * Producers are hooks that live beside the thing they know about (`producers/`), and they are
 * mounted here rather than in the views so a condition is noticed whichever tab is open.
 */
export function NotificationProvider({ onNavigate, children }: {
  onNavigate: (route: Route) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(
    (current: NotificationState, action: NotificationAction) => reduce(current, action),
    EMPTY_STATE
  );
  const [now, setNow] = useState(() => Date.now());
  // The shell's navigate closes over its state and changes every render; a ref keeps the api
  // stable so producers' effects do not re-subscribe on every keystroke elsewhere.
  const navigateRef = useRef(onNavigate);
  useEffect(() => { navigateRef.current = onNavigate; }, [onNavigate]);
  // The provider sits inside `WorkProvider`, so a route naming the work panel can open it.
  const openPanel = useWorkPanelOpener();

  // A toast leaves on its own. One timer for the next departure, re-armed as the record
  // changes; when nothing is on screen there is no timer at all.
  useEffect(() => {
    const due = nextToastExpiry(state, now);
    if (due === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [state, now]);

  const raise = useCallback(<K extends EventKindId>(kind: K, options?: RaiseOptions<K>): void => {
    dispatch({ type: 'raise', id: crypto.randomUUID(), kind, accountId: options?.accountId ?? null, variant: options?.variant, at: new Date().toISOString() });
  }, []);
  const assert = useCallback(<K extends ConditionKindId>(kind: K, options?: RaiseOptions<K>): void => {
    dispatch({ type: 'assert', kind, accountId: options?.accountId ?? null, variant: options?.variant, at: new Date().toISOString() });
  }, []);
  const resolve = useCallback((kind: ConditionKindId, accountId?: string | null | undefined): void => {
    dispatch({ type: 'resolve', kind, accountId: accountId ?? null, at: new Date().toISOString() });
  }, []);
  const closeToast = useCallback((id: string): void => dispatch({ type: 'close-toast', id }), []);
  const markAllSeen = useCallback((): void => dispatch({ type: 'mark-all-seen' }), []);
  const navigate = useCallback((route: Route): void => {
    navigateRef.current(route);
    if (route.panel) openPanel(route.panel);
  }, [openPanel]);

  const api = useMemo<NotificationApi>(
    () => ({ state, now, raise, assert, resolve, closeToast, markAllSeen, navigate }),
    [state, now, raise, assert, resolve, closeToast, markAllSeen, navigate]
  );

  return (
    <NotificationContext.Provider value={api}>
      <Producers api={api} />
      {children}
    </NotificationContext.Provider>
  );
}

/** Every producer, mounted once. A new producer is one more hook call here. */
function Producers({ api }: { api: NotificationApi }): null {
  useCatalogueProducer(api);
  useVenueProducer(api);
  useWorkFailureProducer(api);
  useEngineFactsProducer(api);
  useReleaseProducer(api);
  useEngineHostProducer(api);
  return null;
}

/** The record and the verbs, for the bell, the stack, the centre and any view that wants to raise. */
export function useNotifications(): NotificationApi {
  const api = useContext(NotificationContext);
  if (!api) throw new Error('useNotifications() needs a NotificationProvider above it; App.tsx mounts one around the shell.');
  return api;
}
