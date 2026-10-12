import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../../components/Icon.js';
import { Thumbnail } from '../../components/ui.js';
import { VenueMark } from '../../components/VenueMark.js';
import { WorkPanel, type WorkTab } from './WorkPanel.js';
import { WaitingPill } from './Waiting.js';
import { WORK_STATE, destinationOf, plural, stateLabel, venuePhrase } from '../../lib/labels.js';
import { Outbox, type OutboxSend } from './outbox.js';
import { useWaiting } from './use-waiting.js';
import { isOpenWork } from './work-busy.js';
import { acknowledgeSeen, browserSeenStore, readSeenFailures, unseenFailures, writeSeenFailures } from './work-seen.js';

export { isOpenWork };

/**
 * One row of `work.open`, after the host has attached a name and an image.
 *
 * `memberState` is the engine's observation-honest answer: `COMPLETE` means an observation proved
 * the effect, not that a mutation returned. Everything this file shows is downstream of that.
 */
export type WorkRow = {
  accountId: string;
  commandId: string;
  commandKind: string;
  commandState: string;
  submittedAt: string;
  memberId: string;
  memberState: string;
  quantity: number;
  localId: string | null;
  stackKey: string | null;
  destinationCasketId: string | null;
  priceReceiveCents: number | null;
  actionKind: string | null;
  actionState: string | null;
  updatedAt: string;
  /** Why the member is blocked or failed, when it is: the engine's reason, verbatim. */
  reason: string | null;
  /** When a `RETRYING` member is sent again, and which send it will be — `retryPhrase` reads them. */
  retryAt: string | null;
  attempt: number | null;
  attemptLimit: number | null;
  name: string;
  imageUrl: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  /**
   * Not an engine row: a send this window has made and the engine has not answered yet
   * (`features/work/outbox.ts`). Its state is the window's, there is no command to stop, and a refusal is
   * the window's to dismiss.
   */
  outbox?: true | undefined;
};

/** Command state changes raise no `changed` notice, so this polls — but only while work is open. */
const POLL_MS = 2_000;
/** How long a finished piece of work keeps its tick before the indicator lets go of it. */
const SETTLED_MS = 4_000;

type WorkShared = {
  rows: WorkRow[]; refresh: () => void; outbox: Outbox;
  /** Set by the mounted indicator: opens its panel on a tab. Empty when no indicator is mounted. */
  panel: { current: ((tab: WorkTab) => void) | null };
};
const WorkContext = createContext<WorkShared | null>(null);

/** Outside a provider a send still goes; there is just no panel to report it. */
const DETACHED = new Outbox(() => Promise.resolve());

/**
 * One poll for the window, shared.
 *
 * The indicator and the tile grid ask the same question about the same scope, and two independent
 * polls of `work.open` would be two IPC round trips every two seconds saying the same thing — and
 * worse, could disagree for a tick, so a tile could read as busy while the indicator showed
 * nothing. The provider makes the scope a single fact.
 */
export function WorkProvider({ accountIds, children }: { accountIds: readonly string[]; children: React.ReactNode }): React.JSX.Element {
  const shared = usePolledWork(accountIds);
  return <WorkContext.Provider value={shared}>{children}</WorkContext.Provider>;
}

/**
 * Opens the work panel from outside the indicator — a notification's action about work. The panel
 * and its tab are the indicator's state, so this reaches it through the provider; with no indicator
 * mounted it does nothing.
 */
export function useWorkPanelOpener(): (tab: WorkTab) => void {
  const panel = useContext(WorkContext)?.panel;
  return useCallback((tab: WorkTab) => { panel?.current?.(tab); }, [panel]);
}

/**
 * Open work for the current scope.
 *
 * Inside a `WorkProvider` this is the shared answer and costs nothing. Outside one it polls on its
 * own, so a view can be mounted in isolation — a test, a screenshot harness — without the shell.
 */
export function useOpenWork(accountIds: readonly string[] = []): WorkRow[] {
  const shared = useContext(WorkContext);
  // Hooks run unconditionally; an empty scope makes this one inert rather than absent.
  const own = usePolledWork(shared ? [] : accountIds);
  return (shared ?? own).rows;
}

/**
 * Ask for a re-read now.
 *
 * Submitting a command is the one moment work appears out of nothing, and it raises no `changed`
 * notice — command state is not an observation surface. Without this the poll never starts,
 * because it only runs while there is already something open: the indicator would stay silent
 * until the next unrelated observation happened to wake it.
 */
export function useWorkRefresh(): () => void {
  return useContext(WorkContext)?.refresh ?? (() => undefined);
}

/**
 * Where a send goes the moment it is pressed (`features/work/outbox.ts`). The window's one outbox, so the
 * panel and the indicator report a send from whichever section made it.
 */
export function useOutbox(): Outbox {
  return useContext(WorkContext)?.outbox ?? DETACHED;
}

/**
 * Two triggers, and both are needed. A `changed` notice fires when an *observation* lands, which
 * is exactly when a member can become `Completed` — but a member moving from queued to sent
 * changes no observation surface and raises no notice, so a slow poll covers that. The poll stops
 * when nothing is open, which is most of the time.
 *
 * The outbox's sends are rows here too, ahead of the engine's, so the panel, the indicator and a
 * tile's busy state all see an item leave the listing workspace in the same render.
 */
function usePolledWork(accountIds: readonly string[]): WorkShared {
  const [rows, setRows] = useState<WorkRow[]>([]);
  const scope = accountIds.join('\0');
  const open = rows.some(isOpenWork);
  // Only the newest read may land. The outbox lets go of an accepted send once the read after it
  // has, and a poll that left before the send and came back after would otherwise put the
  // engine's rows back as they were — the item in neither place until something woke the read.
  const latest = useRef(0);

  const read = useCallback((): Promise<void> => {
    const ids = scope.split('\0').filter(Boolean);
    const mine = ++latest.current;
    if (ids.length === 0) { setRows([]); return Promise.resolve(); }
    return window.trading.invoke({ type: 'work.open', accountIds: ids })
      .then((answer) => {
        if (mine !== latest.current) return;
        const page = answer as { rows?: WorkRow[] };
        setRows(Array.isArray(page?.rows) ? page.rows : []);
      })
      .catch(() => undefined);
  }, [scope]);

  const readNow = useRef(read);
  useEffect(() => { readNow.current = read; }, [read]);
  const [outbox] = useState(() => new Outbox(() => readNow.current()));
  const sends = useSyncExternalStore(outbox.subscribe, outbox.snapshot);
  const merged = useMemo(() => [...outboxWork(sends, scope.split('\0')), ...rows], [sends, rows, scope]);

  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    const unsubscribe = window.trading.subscribe(() => { void read(); });
    return () => unsubscribe();
  }, [read]);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, read]);

  const refresh = useCallback(() => { void read(); }, [read]);
  const [panel] = useState<WorkShared['panel']>(() => ({ current: null }));
  return useMemo(() => ({ rows: merged, refresh, outbox, panel }), [merged, refresh, outbox, panel]);
}

/**
 * The outbox's sends as work rows, one per item in scope (rule 8), each marked `outbox`. The
 * state is the send's own — `UNSUBMITTED`, `SUBMITTING`, `REFUSED` — and none of those is a word
 * the engine uses, so nothing can read one as an observation.
 */
function outboxWork(sends: readonly OutboxSend[], accountIds: readonly string[]): WorkRow[] {
  return sends.flatMap((send) => send.items
    .filter((item) => accountIds.includes(item.accountId))
    .map((item) => ({
      accountId: item.accountId,
      commandId: send.id,
      commandKind: send.kind,
      commandState: send.state,
      submittedAt: send.queuedAt,
      memberId: item.key,
      memberState: send.state,
      quantity: 1,
      localId: item.localId,
      stackKey: null,
      destinationCasketId: null,
      priceReceiveCents: item.receiveCents,
      actionKind: null,
      actionState: null,
      retryAt: null,
      attempt: null,
      attemptLimit: null,
      updatedAt: send.queuedAt,
      reason: send.reason,
      name: item.name,
      imageUrl: item.imageUrl,
      rarity: null,
      outbox: true as const
    })));
}

/**
 * What is happening, in the top-right of the window.
 *
 * A quiet button when nothing is in flight, so the panel is somewhere a person can go and look.
 * A finished piece of work keeps its tick for a few seconds and then lets go. A refusal stays red
 * until the panel has been opened on it — a failure that scrolls past unseen is the same as no
 * report — and that opening is remembered in the window. `work.open` keeps recent failures, so
 * without the memory every launch paints the first ones red again.
 */
export function WorkIndicator({ accountIds, accounts, onOpenListings }: {
  accountIds: readonly string[];
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined;
  onOpenListings?: (() => void) | undefined;
}): React.JSX.Element | null {
  const rows = useOpenWork(accountIds);
  // Named for the obligation, not the hook: `waiting` already means "this member is awaiting an
  // observation" further down, and the two must never be confused — one is the app waiting, the
  // other is the app waiting on a person.
  const owed = useWaiting(accountIds);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<WorkTab>('work');
  const [holdUntil, setHoldUntil] = useState(0);
  const [, setTick] = useState(0);
  // Loaded once, with the window: a failure opened on last launch must already be quiet on the
  // first paint, or the indicator flashes red for work the person has seen. `useRef(value)`
  // evaluates `value` on every render and throws it away, so the read is guarded instead.
  const acknowledged = useRef<ReadonlySet<string> | null>(null);
  if (acknowledged.current === null) acknowledged.current = readSeenFailures(browserSeenStore());
  const [seenTick, setSeenTick] = useState(0);
  const previousOpen = useRef(0);
  const shared = useContext(WorkContext);
  useEffect(() => {
    if (!shared) return undefined;
    shared.panel.current = (next) => { setTab(next); setPanelOpen(true); };
    return () => { shared.panel.current = null; };
  }, [shared]);

  const open = useMemo(() => rows.filter(isOpenWork), [rows]);
  const failed = useMemo(
    () => unseenFailures(rows, acknowledged.current ?? new Set()),
    [rows, seenTick]
  );

  // The moment the last open member settles, hold the indicator briefly so the tick is seen.
  useEffect(() => {
    if (previousOpen.current > 0 && open.length === 0) setHoldUntil(Date.now() + SETTLED_MS);
    previousOpen.current = open.length;
  }, [open.length]);

  // A hold is a deadline, not a state: re-render once when it expires so the indicator unmounts.
  useEffect(() => {
    if (holdUntil <= Date.now()) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, holdUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [holdUntil]);

  // Opening the panel is the acknowledgement a refusal waits for. Written down, so the next launch
  // does not treat the same members as unseen. `acknowledgeSeen` returns the same set when nothing
  // new failed, and a poll must not re-render on that.
  useEffect(() => {
    if (!panelOpen) return;
    const next = acknowledgeSeen(acknowledged.current ?? new Set(), rows);
    if (next === acknowledged.current) return;
    acknowledged.current = next;
    writeSeenFailures(browserSeenStore(), next);
    setSeenTick((value) => value + 1);
  }, [panelOpen, rows]);

  const holding = holdUntil > Date.now();
  const settledRecently = rows.some((row) => row.memberState === 'COMPLETE');
  // The most recently started member of any open command: the thing happening right now.
  const subject = open[0] ?? failed[0] ?? rows[0];
  const idle = !subject || (open.length === 0 && failed.length === 0 && !(holding && settledRecently));
  const others = Math.max(0, open.length - 1);

  const panel = (
    <WorkPanel
      open={panelOpen}
      tab={tab}
      onTab={setTab}
      onClose={() => setPanelOpen(false)}
      rows={rows}
      waiting={owed}
      accountIds={accountIds}
      accounts={accounts}
      {...(onOpenListings ? { onOpenListings } : {})}
    />
  );

  // The pill comes first in the DOM, so it sits to the left of the indicator: what you owe, then
  // what the app owes you. Rendering both here rather than from the shell keeps one drawer and
  // one tab state — two owners would let the two buttons disagree about which half is showing.
  const pill = <WaitingPill waiting={owed} onOpen={() => { setTab('waiting'); setPanelOpen(true); }} />;

  /*
   * Idle is a state, not an absence.
   *
   * The plan had this unmount when nothing was in flight, on the argument that an idle pill
   * trains the eye to ignore it. In the built window that reasoning inverted: with nothing to
   * click for most of a session, the control was not somewhere you could go and look — you could
   * only find out what the app was doing at the moment it happened to be doing something. A
   * permanent, quiet button is the discoverable version, and the panel answers "nothing in
   * progress" in words rather than by not existing.
   */
  if (idle) {
    return <>
      {pill}
      <button
        type="button"
        className="work-indicator"
        data-mode="idle"
        title="Nothing in progress. Open the work panel to see what has been submitted."
        aria-label="Open the work panel"
        onClick={() => { setTab('work'); setPanelOpen(true); }}
      >
        <span className="work-glyph"><Icon name="activity" size={15} /></span>
      </button>
      {panel}
    </>;
  }

  // Retrieved and waiting for the marketplace to see it: the retrieve is over, so the glyph is
  // where the item is going, with the hourglass.
  const awaitingVenue = subject!.memberState === 'AWAITING_VENUE';
  const destination = awaitingVenue ? destinationOf(subject!.commandKind) : destinationOf(subject!.commandKind, subject!.actionKind);
  const state = stateLabel(WORK_STATE, subject!.memberState);
  const waiting = subject!.memberState === 'SUBMITTED' || subject!.memberState === 'RETRYING' || subject!.actionState === 'AWAITING_OBSERVATION' || awaitingVenue;
  const mode = failed.length > 0 ? 'failed' : open.length === 0 ? 'done' : waiting ? 'waiting' : 'moving';
  const sentence = failed.length > 0
    ? `${state.label}: ${subject!.name}`
    : open.length === 0
      ? `${subject!.name} completed`
      : `${[destination.verb, subject!.name, venuePhrase(destination)].filter(Boolean).join(' ')}${others > 0 ? ` · ${plural(others, 'more')} queued` : ''}`;

  return <>
    {pill}
    <button
      type="button"
      className="work-indicator"
      data-mode={mode}
      title={sentence}
      aria-label={sentence}
      onClick={() => { setTab('work'); setPanelOpen(true); }}
    >
      <Thumbnail url={subject!.imageUrl} name={subject!.name} size={20} />
      <span className="work-travel" aria-hidden="true">
        <span className="work-dot" /><span className="work-dot" /><span className="work-dot" />
      </span>
      <span className="work-glyph">
        {destination.venue ? <VenueMark venue={destination.venue} size={14} /> : <Icon name={destination.icon} size={14} />}
        {mode === 'waiting' ? <Icon name="hourglass" size={10} className="work-waiting" /> : null}
        {mode === 'done' ? <Icon name="check-circle" size={12} /> : null}
        {mode === 'failed' ? <Icon name="alert-circle" size={12} /> : null}
      </span>
      {others > 0 ? <span className="work-more num">+{others}</span> : null}
    </button>
    {panel}
  </>;
}
