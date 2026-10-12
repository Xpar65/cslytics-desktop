import React, { useEffect, useState } from 'react';
import type { StoragePageRow } from '@cslytics/engine';
import { Badge, Button, Drawer, Empty, Segmented, Thumbnail } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { WaitingList } from './Waiting.js';
import { isOpenWork, useOutbox, type WorkRow } from './WorkIndicator.js';
import type { WaitingState } from './use-waiting.js';
import { ACTION_DESTINATION, DESTINATION, VENUE_NAME, destinationOf, formatRelative, formatUsd, plural, retryPhrase, workStateLabel, type Destination } from '../../lib/labels.js';

/** Which half of the drawer is showing. The app's work, or the person's. */
export type WorkTab = 'work' | 'waiting';

/** Work the engine reports under a bare action's kind: there is no command for Stop to halt. */
const COMMANDLESS: ReadonlySet<string> = new Set(['DELIST', 'CREATE_BUY_ORDER', 'CANCEL_BUY_ORDER']);

/**
 * Everything queued, in flight and waiting to be observed — and, beside it, everything waiting
 * on the person instead.
 *
 * **What reaches it.** `work.open` and the window's outbox, nothing else. A page that queues work
 * does not report its progress itself: the engine's read does, and the page calls
 * `useWorkRefresh()` after the reply. Work that read does not report is work this panel never
 * shows — CLAUDE.md, *Queued work shows in the work panel*.
 *
 * Grouped by command, newest first, because a command is what a person pressed: "Storing 3 items"
 * is the unit they remember, and three separate rows saying "Storing" is the same fact told badly.
 *
 * Every state is shown in observation-honest words (`WORK_STATE`). The one that matters is
 * *Sent, waiting for Steam to show it*: it is the state a less careful panel would call "Done",
 * and calling it that is precisely the claim rule 1 forbids.
 *
 * **A listing, a reprice and a delist say which marketplace.** "Listing 3 items" was the whole
 * sentence while there was one marketplace; with two it leaves out the half a person checks first,
 * and a delist most of all, because the place to go and look is the marketplace it left.
 *
 * **Why two tabs and not two drawers.** The obligations are opposite — work drains by itself and
 * a confirmation never does — but they are the same question asked twice ("is this actually
 * happening?"), and a person who has to guess which of two panels holds the answer will check
 * neither. One drawer with the two halves named side by side makes the distinction the first
 * thing read rather than a thing to work out. It is also, for a listing, literally the same row
 * seen from two ends: `AWAITING_CONFIRMATION` in the work tab is the member, and the waiting tab
 * is the listing that member is stuck behind.
 *
 * **A send is here from the moment it is pressed.** The listing workspace hands its rows to the
 * outbox and lets go of them at once, so the first states a listing shows are the window's own —
 * *Waiting to submit*, *Submitting* — until the engine accepts it and its rows take over. Those
 * have no command to stop; a refusal nothing else took back stays until it is dismissed.
 */
export function WorkPanel({ open, tab, onTab, onClose, rows, waiting, accountIds, accounts, onOpenListings }: {
  open: boolean;
  tab: WorkTab;
  onTab: (next: WorkTab) => void;
  onClose: () => void;
  rows: readonly WorkRow[];
  waiting: WaitingState;
  accountIds: readonly string[];
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined;
  onOpenListings?: (() => void) | undefined;
}): React.JSX.Element | null {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<StoragePageRow[]>([]);
  const outbox = useOutbox();
  // A countdown is a caption that changes by itself: the clock is read once a second while a row
  // is waiting for its resend, and not at all otherwise.
  const now = useNow(open && rows.some((row) => row.memberState === 'RETRYING'));

  // A casket id is a code, and codes never reach the screen. The unit has a name the user gave it
  // or that Steam gave it, and that is the only thing worth printing.
  const scope = accountIds.join('\0');
  useEffect(() => {
    const ids = scope.split('\0').filter(Boolean);
    if (!open || ids.length === 0) return undefined;
    let live = true;
    void window.trading.invoke({ type: 'storage.page', accountIds: ids, pageSize: 250 })
      .then((envelope) => {
        const page = envelope as { kind?: string; rows?: StoragePageRow[] };
        if (live && page?.kind === 'page' && Array.isArray(page.rows)) setUnits(page.rows);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open, scope]);

  const unitLabel = (accountId: string, casketId: string): string =>
    units.find((unit) => unit.accountId === accountId && unit.casketId === casketId)?.label ?? 'a storage unit';

  const commands = new Map<string, WorkRow[]>();
  for (const row of rows) commands.set(row.commandId, [...(commands.get(row.commandId) ?? []), row]);
  const ordered = [...commands.entries()].sort((left, right) => {
    const at = (entry: WorkRow[]): string => entry[0]?.updatedAt ?? '';
    return at(right[1]).localeCompare(at(left[1]));
  });

  async function stop(commandId: string): Promise<void> {
    setStopping(commandId);
    setError(null);
    try { await window.trading.invoke({ type: 'command.stop', commandId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStopping(null); }
  }

  const tabs = (
    <Segmented
      label="What is happening"
      value={tab}
      onChange={onTab}
      options={[
        { id: 'work' as const, label: 'In progress', icon: 'activity', count: rows.filter(isOpenWork).length },
        { id: 'waiting' as const, label: 'Waiting on you', icon: 'smartphone', count: waiting.rows.length }
      ]}
    />
  );

  return (
    <Drawer
      open={open}
      wide
      icon={tab === 'waiting' ? 'smartphone' : 'activity'}
      title={tab === 'waiting' ? 'Waiting on you' : 'Work in progress'}
      subtitle={tab === 'waiting'
        ? 'Steam is holding these until you confirm them on your phone. This app cannot confirm for you.'
        : 'Every step is confirmed by a later observation. Sent is not the same as done.'}
      onClose={onClose}
    >
      <div className="work-tabs">{tabs}</div>

      {tab === 'waiting' ? (
        <WaitingList
          waiting={waiting}
          accountIds={accountIds}
          accounts={accounts}
          {...(onOpenListings ? { onOpenListings: () => { onClose(); onOpenListings(); } } : {})}
        />
      ) : <>
      {error ? <div className="caption" data-tone="warn" role="alert">{error}</div> : null}
      {ordered.length === 0 ? (
        <Empty icon="check-circle" title="Nothing in progress" hint="Commands you submit appear here until an observation confirms each step." />
      ) : ordered.map(([commandId, members]) => {
        const first = members[0]!;
        const kind = DESTINATION[first.commandKind] ?? { icon: 'package' as const, verb: 'Working on' };
        const quantity = members.reduce((sum, member) => sum + member.quantity, 0);
        // Stop halts a command's unsent members. A CSFloat operation, a delist asked for by hand, a
        // Steam buy-order action and a send still in the outbox have no command behind them, so
        // there is nothing for it to stop.
        const stoppable = !first.outbox && members.some(isOpenWork) && !first.commandKind.startsWith('CSFLOAT_') && !COMMANDLESS.has(first.commandKind);
        const dismissable = first.outbox && first.memberState === 'REFUSED';
        return (
          <section className="work-command" key={commandId}>
            <header className="work-command-head">
              <span className="panel-icon"><Icon name={kind.icon} size={14} /></span>
              <span className="grow">
                <span className="work-command-title">{kind.verb} {plural(quantity, kind.noun ?? 'item')}<Venue of={kind} /></span>
                <span className="work-command-meta quiet">
                  {formatRelative(first.submittedAt)}
                  {accountIds.length > 1 ? <> · {first.accountId}</> : null}
                </span>
              </span>
              {stoppable ? (
                <Button size="sm" variant="ghost" icon="pause" loading={stopping === commandId} onClick={() => void stop(commandId)}>Remove all queued</Button>
              ) : null}
              {dismissable ? (
                <Button size="sm" variant="ghost" icon="x" onClick={() => outbox.dismiss(commandId)}>Dismiss</Button>
              ) : null}
            </header>
            {members.map((member) => {
              const hop = destinationOf(member.commandKind, member.actionKind);
              // The command's marketplace when the hop has none: a CSFloat listing waiting on its
              // retrieve's walk is still waiting for CSFloat, not for Steam.
              const state = workStateLabel(member.memberState, hop.venue ?? DESTINATION[member.commandKind]?.venue);
              // A chained member shows both hops, the current one highlighted, so a crated item
              // being listed reads as "retrieve, then list" rather than jumping to the end.
              const hops = chainFor(member);
              const current = currentHop(member, hops);
              return (
                <div className="work-row" key={`${commandId}:${member.memberId}`} data-state={member.memberState} data-outbox={member.outbox}>
                  <Thumbnail url={member.imageUrl} name={member.name} size={32} />
                  <span className="work-row-text grow">
                    <span className="work-row-name">{member.name}{member.quantity > 1 ? <span className="num"> × {member.quantity}</span> : null}</span>
                    {hops.length > 1 ? (
                      <span className="work-hops">
                        {hops.map((step, index) => (
                          <span className="work-hop" key={step.kind} data-current={step.kind === current}>
                            {step.venue ? null : <Icon name={step.icon} size={11} />}
                            <span>{step.verb}<Venue of={step} /></span>
                            {index < hops.length - 1 ? <Icon name="chevron-right" size={10} className="work-hop-arrow" /> : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="work-row-meta quiet">
                        {hop.verb}<Venue of={hop} />
                        {member.destinationCasketId ? <> · into {unitLabel(member.accountId, member.destinationCasketId)}</> : null}
                        {member.priceReceiveCents !== null ? <> · {formatUsd(member.priceReceiveCents)}</> : null}
                      </span>
                    )}
                    {member.reason && (member.memberState === 'BLOCKED' || member.memberState === 'FAILED' || member.memberState === 'REFUSED') ? (
                      // The engine's reason, verbatim. A refusal the panel shows as a bare badge is
                      // a recorded reason no read returns, which OP-08 says does not count.
                      <span className="work-row-meta caption" data-tone="warn">{member.reason}</span>
                    ) : member.memberState === 'RETRYING' ? (
                      // A walk after the send still showed the old state. The engine will send
                      // again on its schedule; the person sees when, and which try it will be,
                      // rather than a wait with no end.
                      <span className="work-row-meta caption" data-tone="warn">{retryPhrase(member, hop.venue ?? DESTINATION[member.commandKind]?.venue, now)}</span>
                    ) : member.attempt !== null && member.attempt > 1 ? (
                      <span className="work-row-meta caption quiet">attempt {member.attempt} of {member.attemptLimit}</span>
                    ) : null}
                  </span>
                  <Badge tone={state.tone === 'positive' ? 'positive' : state.tone === 'negative' ? 'negative' : state.tone === 'warn' ? 'warn' : 'quiet'} icon={state.icon}>
                    {state.label}
                  </Badge>
                </div>
              );
            })}
          </section>
        );
      })}
      </>}
    </Drawer>
  );
}

/** The wall clock, re-read once a second while `ticking`, so a countdown counts. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** " on Steam", " from CSFloat", with the marketplace's own mark — nothing for work that is on neither. */
function Venue({ of }: { of: Destination }): React.JSX.Element | null {
  if (!of.venue) return null;
  return <span className="work-venue"> {of.joiner ?? 'on'} <VenueMark venue={of.venue} size={11} /> {VENUE_NAME[of.venue]}</span>;
}

/** One step of a chain: the action kind it is, and how `ACTION_DESTINATION` says it. */
type Hop = Destination & { kind: string };

/**
 * The hop a member is on.
 *
 * The engine reports the newest action carrying the member. When that action is `DONE` and the
 * chain has another hop, the member is waiting for the next one to be sent — a crated item whose
 * retrieve was observed is queued for listing, not still retrieving — so the highlight moves on.
 */
function currentHop(member: WorkRow, hops: Hop[]): string | null {
  if (member.actionState !== 'DONE') return member.actionKind;
  const index = hops.findIndex((hop) => hop.kind === member.actionKind);
  return index >= 0 ? hops[index + 1]?.kind ?? member.actionKind : member.actionKind;
}

/**
 * The hops a member passes through.
 *
 * Derived from the command kind rather than read from the plan, because the plan is the engine's
 * and this is a caption. A LIST member carrying a retrieve action is the chained case: it is being
 * taken out of a unit first, and the glyph must not show the Steam mark until that is observed.
 */
function chainFor(member: WorkRow): Hop[] {
  const hops = (...kinds: string[]): Hop[] => kinds.map((kind) => ({ kind, ...ACTION_DESTINATION[kind]! }));
  if (member.commandKind === 'LIST' && member.actionKind === 'RETRIEVE_FROM_CASKET') return hops('RETRIEVE_FROM_CASKET', 'CREATE_SELL_LISTING');
  // The engine's name for a CSFloat list; `CSFLOAT_LIST` is only the outbox's word for it.
  if (member.commandKind === 'CSFLOAT_CREATE' && member.actionKind === 'RETRIEVE_FROM_CASKET') return hops('RETRIEVE_FROM_CASKET', 'CSFLOAT_CREATE');
  if (member.commandKind === 'DELIST_TO_STORE') return hops('REMOVE_SELL_LISTING', 'STORE_IN_CASKET');
  if (member.commandKind === 'REPRICE') return hops('REMOVE_SELL_LISTING', 'CREATE_SELL_LISTING');
  return [];
}
