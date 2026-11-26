import React, { useEffect, useState } from 'react';
import type { StoragePageRow } from '@cslytics/engine';
import { Badge, Button, Drawer, Empty, ProgressBar, Segmented, Thumbnail } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { WaitingList } from './Waiting.js';
import { isOpenWork, useOutbox, useWorkRefresh, type WorkRow } from './WorkIndicator.js';
import { isHeldForCooldown, isWaitingPriceChange } from './work-busy.js';
import type { WaitingState } from './use-waiting.js';
import { DESTINATION, VENUE_NAME, chainFor, commandCounts, commandHeadline, currentHop, destinationOf, failureReason, formatRelative, inventoryWaitPhrase, plural, priceChangeDeadlinePhrase, retryPhrase, stopOffer, tallyCommand, workFigure, workStateLabel, type Destination } from '../../lib/labels.js';
import { useNow } from '../../lib/clock.js';

/** Which half of the drawer is showing. The app's work, or the person's. */
export type WorkTab = 'work' | 'waiting';

/** Work of one hop with nothing for Stop to halt: a bare action's kind, or a confirmation that follows work already sent. */
const COMMANDLESS: ReadonlySet<string> = new Set(['DELIST', 'BUY_ORDER_CREATE', 'BUY_ORDER_CANCEL', 'CONFIRM']);

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
 * **The headline counts what is confirmed.** "Storing 968 items" while nothing is, "Stored 567 of 968
 * items · 401 failed" once a walk has proved some and the rest have settled, and the failures' reason
 * once above the rows when they share one. A batch that has stopped for good must not read as still
 * going (`commandHeadline`).
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
 * **A Steam price change waits in two ways, and each says which.** One asked for inside the five
 * minutes Steam keeps between changes to a listing is held unsent (`isHeldForCooldown`) and counts
 * down to its send, and can still be removed. A lower price that has been sent waits for the
 * person's confirmation, with the listing on sale at its old price meanwhile, and says when the
 * engine drops it unconfirmed; Stop withdraws it, and its button says so (`stopOffer`). One that
 * fails says what became of the listing in plain words (`failureReason`) rather than in the
 * engine's code for it. A row's price says which figure it is, in the currency it is in, or is
 * not printed (`workFigure`).
 *
 * **A strategy's work says so.** A rule the person set up acts through the same commands, and its
 * work reads "by a strategy" beside the time; a person's needs no word (strategy authority plan D5).
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
  /** Each account, with its wallet currency once a read has named it: a Steam price on a row is in it. */
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null; currency?: number | null | undefined }> | undefined;
  onOpenListings?: (() => void) | undefined;
}): React.JSX.Element | null {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<StoragePageRow[]>([]);
  const outbox = useOutbox();
  const refreshWork = useWorkRefresh();
  // A countdown is a caption that changes by itself: the clock is read once a second while a row
  // is waiting for its resend or for Steam's price-change cooldown, and not at all otherwise.
  const now = useNow(open && rows.some((row) => row.memberState === 'RETRYING' || row.memberState === 'AWAITING_VENUE' || isHeldForCooldown(row)));

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

  // The account's wallet currency, when a read has named it. A price on a Steam row is in it, and
  // printing it as any other currency would state a figure nobody was sent.
  const walletOf = (accountId: string): number | null | undefined => accounts?.find((account) => account.id === accountId)?.currency;

  // The unit a hop puts the item into. Only a store hop ends in one: a retrieve ends in the
  // inventory, and a send to another account names a unit of that account, which is not in this list.
  const unitName = (member: WorkRow): string | null | undefined =>
    member.destinationCasketId && member.actionKind !== 'RETRIEVE_FROM_CASKET'
      ? units.find((unit) => unit.accountId === member.accountId && unit.casketId === member.destinationCasketId)?.label
      : undefined;

  const commands = new Map<string, WorkRow[]>();
  for (const row of rows) commands.set(row.commandId, [...(commands.get(row.commandId) ?? []), row]);
  const ordered = [...commands.entries()].sort((left, right) => {
    const at = (entry: WorkRow[]): string => entry[0]?.updatedAt ?? '';
    return at(right[1]).localeCompare(at(left[1]));
  });

  async function stop(commandId: string): Promise<void> {
    setStopping(commandId);
    setError(null);
    try {
      await window.trading.invoke({ type: 'command.stop', commandId });
      // A stop changes no observation surface and raises no notice: the panel reads again now.
      refreshWork();
    }
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
        <Empty icon="check-circle" title="Nothing in progress" />
      ) : ordered.map(([commandId, members]) => {
        const first = members[0]!;
        const kind = DESTINATION[first.commandKind] ?? { icon: 'package' as const, verb: 'Working on' };
        const quantity = members.reduce((sum, member) => sum + member.quantity, 0);
        const tally = tallyCommand(members);
        const counts = first.outbox ? [] : commandCounts(tally);
        // Said once above the rows when every failure has it; each row then shows only a different one.
        const sharedReason = !first.outbox && tally.failed > 1 ? tally.sharedReason : null;
        // Stop halts a command's unsent members and withdraws its lower prices waiting for their
        // confirmation, so it is offered only while it would do one of those, in words that say
        // which (`stopOffer`): a transfer already waiting on the phone has nothing left to remove.
        // A price change still held for Steam's cooldown has not been sent, and can be removed. A
        // CSFloat operation, a delist asked for by hand, a Steam buy-order action and a send still
        // in the outbox have no command behind them, so there is nothing for it to stop.
        const offer = !first.outbox && !first.commandKind.startsWith('CSFLOAT_') && !COMMANDLESS.has(first.commandKind) ? stopOffer(members) : null;
        const dismissable = first.outbox && first.memberState === 'REFUSED';
        return (
          <section className="work-command" key={commandId}>
            <header className="work-command-head">
              <span className="panel-icon"><Icon name={kind.icon} size={14} /></span>
              <span className="grow">
                <span className="work-command-title">{first.outbox ? `${kind.verb} ${plural(quantity, kind.noun ?? 'item')}` : commandHeadline(kind, tally)}<Venue of={kind} /></span>
                <span className="work-command-meta quiet">
                  {formatRelative(first.submittedAt)}
                  {first.authority === 'STRATEGY' ? <> · by a strategy</> : null}
                  {accountIds.length > 1 ? <> · {first.accountId}</> : null}
                  {counts.map((part) => <React.Fragment key={part}> · {part}</React.Fragment>)}
                </span>
                {sharedReason ? <span className="work-command-reason caption" data-tone="warn">{failureReason(sharedReason, first)}</span> : null}
              </span>
              {offer ? (
                <Button size="sm" variant="ghost" icon="pause" title={offer.title} data-testid="work-stop" loading={stopping === commandId} onClick={() => void stop(commandId)}>{offer.label}</Button>
              ) : null}
              {dismissable ? (
                <Button size="sm" variant="ghost" icon="x" onClick={() => outbox.dismiss(commandId)}>Dismiss</Button>
              ) : null}
            </header>
            {!first.outbox && tally.total > 1 ? (
              <ProgressBar value={tally.confirmed} max={tally.total} tone={tally.open > 0 ? 'accent' : 'positive'} label={`${tally.confirmed} of ${tally.total} confirmed`} />
            ) : null}
            {members.map((member) => {
              const hop = destinationOf(member.commandKind, member.actionKind);
              // The command's marketplace when the hop has none: a CSFloat listing waiting on its
              // retrieve's walk is still waiting for CSFloat, not for Steam.
              const venue = hop.venue ?? DESTINATION[member.commandKind]?.venue;
              const state = workStateLabel(member.memberState, venue, member);
              // Held unsent until Steam takes a price change on the listing again.
              const cooling = isHeldForCooldown(member);
              // A lower price sent and waiting for its confirmation: the engine drops it at its deadline.
              const dropped = isWaitingPriceChange(member) ? priceChangeDeadlinePhrase(member.waitDeadline) : null;
              const figure = workFigure(member, venue, walletOf(member.accountId));
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
                        {/* A confirmed row says what happened, not what was under way: "Stored · into Storage Unit 1". */}
                        {member.memberState === 'COMPLETE' ? hop.done ?? hop.verb : hop.verb}<Venue of={hop} />
                        {unitName(member) ? <> · into {unitName(member)}</> : null}
                        {/* Which figure it is, in the currency it is in, or nothing (`workFigure`). */}
                        {figure ? <> · <span data-testid="work-row-price">{figure}</span></> : null}
                      </span>
                    )}
                    {member.reason && member.reason !== sharedReason && (member.memberState === 'BLOCKED' || member.memberState === 'FAILED' || member.memberState === 'REFUSED') ? (
                      // The engine's reason, verbatim, or in plain words where it is a price change's
                      // code. A refusal the panel shows as a bare badge is a recorded reason no read
                      // returns, which OP-08 says does not count.
                      <span className="work-row-meta caption" data-tone="warn">{failureReason(member.reason, member)}</span>
                    ) : cooling ? (
                      // Steam takes one price change per listing every five minutes. The change is
                      // held until then; the person sees why it has not gone, and when it will.
                      <span className="work-row-meta caption" data-tone="accent">{retryPhrase(member, venue, now)}</span>
                    ) : dropped ? (
                      // Nothing walks while a lower price waits on a person, so a time is what ends it.
                      <span className="work-row-meta caption" data-tone="accent" data-testid="work-row-deadline">{dropped.charAt(0).toUpperCase()}{dropped.slice(1)}</span>
                    ) : member.memberState === 'AWAITING_VENUE' ? (
                      // CSFloat's copy of the inventory has not caught up with the item. The listing
                      // is sent again on its schedule; the person sees when, and when it gives up.
                      <span className="work-row-meta caption" data-tone="accent">{inventoryWaitPhrase(member, now)}</span>
                    ) : member.memberState === 'RETRYING' ? (
                      // A walk after the send still showed the old state. The engine will send
                      // again on its schedule; the person sees when, and which try it will be,
                      // rather than a wait with no end.
                      <span className="work-row-meta caption" data-tone="warn">{retryPhrase(member, venue, now)}</span>
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

/** " on Steam", " from CSFloat", with the marketplace's own mark — nothing for work that is on neither. */
function Venue({ of }: { of: Destination }): React.JSX.Element | null {
  if (!of.venue) return null;
  return <span className="work-venue"> {of.joiner ?? 'on'} <VenueMark venue={of.venue} size={11} /> {VENUE_NAME[of.venue]}</span>;
}
