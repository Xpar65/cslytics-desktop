import { useEffect, useState } from 'react';

/**
 * The window's one clock.
 *
 * Several things on screen count by themselves: the cooldown on a listing's tile, a retry in the
 * work panel, the age of a live order book. Each kept a one-second timer of its own. They share
 * one here, started by the first subscriber and stopped by the last, so a window with nothing
 * counting wakes for nothing, and everything that counts moves on the same tick.
 *
 * A countdown belongs in a small component of its own that calls one of the hooks below. The tick
 * then re-renders that component and nothing around it, which is what lets a grid of several
 * hundred tiles hold a few countdowns without redrawing itself every second.
 */

type Listener = (now: number) => void;

export type Clock = {
  /** Calls `listener` with the wall clock on every tick, until the function it returns is called. */
  subscribe: (listener: Listener) => () => void;
};

/** A clock that ticks every `periodMs` while it has a subscriber, and holds no timer while it has none. */
export function createClock(periodMs = 1_000): Clock {
  const listeners = new Set<Listener>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    // Read once, so two countdowns on one tick cannot disagree about the time.
    const now = Date.now();
    // Over a copy: a countdown that leaves on the tick it finishes must not cost the others
    // theirs. One that was removed earlier in this same tick is skipped.
    for (const listener of [...listeners]) if (listeners.has(listener)) listener(now);
  };

  return {
    subscribe(listener) {
      // Its own entry, so one function subscribed twice is two subscriptions that leave separately.
      const entry: Listener = (now) => listener(now);
      listeners.add(entry);
      timer ??= setInterval(tick, periodMs);
      return () => {
        // Leaving twice must never stop the timer under somebody else.
        if (!listeners.delete(entry)) return;
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    }
  };
}

const clock = createClock();

/**
 * An instant the engine sent, as ISO-8601 text like every time on its reads, in milliseconds since
 * the epoch, which is what a countdown compares with the clock. `null` when there is none, and
 * when the text is not an instant: a wait nobody can count down to is no wait.
 */
export function instantOf(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

/**
 * The wall clock, re-read on every tick while `ticking`, so a caption that depends on the time
 * counts. While not ticking it keeps the last instant it read and costs nothing.
 */
export function useNow(ticking = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    // At once: the instant kept from the last time this ticked may be minutes old.
    setNow(Date.now());
    return clock.subscribe(setNow);
  }, [ticking]);
  return now;
}

/**
 * The wall clock for something counting down to `until`, in milliseconds since the epoch.
 *
 * Read when the deadline is first seen and whenever it changes, then on every tick until the
 * deadline has passed, and never after: a countdown that has reached zero stops subscribing, so
 * it re-renders nothing and does not keep the timer alive. With no deadline it never subscribes.
 */
export function useNowUntil(until: number | null | undefined): number {
  // Anything that is not an instant is no deadline. `NaN` in particular never equals itself, and
  // would read below as a deadline that changes on every render.
  const deadline = typeof until === 'number' && Number.isFinite(until) ? until : null;
  const [seen, setSeen] = useState(() => ({ deadline, now: Date.now() }));
  let now = seen.now;
  if (seen.deadline !== deadline) {
    // A new deadline is measured from this instant, not from the last tick this component took.
    now = Date.now();
    setSeen({ deadline, now });
  }
  useEffect(() => {
    if (deadline === null) return undefined;
    const started = Date.now();
    if (started >= deadline) {
      // It passed between the render and now. Without this the render that still showed a wait
      // would stand, with no tick coming to correct it.
      setSeen((current) => (current.deadline === deadline && current.now < deadline ? { deadline, now: started } : current));
      return undefined;
    }
    const leave = clock.subscribe((at) => {
      setSeen({ deadline, now: at });
      if (at >= deadline) leave();
    });
    return leave;
  }, [deadline]);
  return now;
}
