import React from 'react';
import { Badge, Button, Caption, Empty, Notice, Thumbnail } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { Avatar } from '../../components/Avatar.js';
import { engine } from '../../lib/engine.js';
import { formatCents } from '../../lib/format.js';
import { currencyCode, formatDateTime, formatRelative, plural, shortId, surfaceLabel } from '../../lib/labels.js';
import { isOverdue, type WaitingRow, type WaitingState } from './use-waiting.js';

/**
 * The count of things only the person can do, in the topbar beside the work indicator.
 *
 * Beside it on purpose. The indicator says what the *app* is doing and empties itself; this says
 * what the app is waiting for a *human* to do and never empties itself. Standing next to each
 * other is what teaches the difference, and the difference is the whole feature: a listing left
 * unconfirmed is not listed, earns nothing, and nothing in the app will ever fix it.
 *
 * **Absent at zero**, which is the opposite of the decision `WorkIndicator` came to and for the
 * opposite reason. An idle work indicator is a place to go and look — "what has this app been
 * doing?" is a question worth being able to ask at any time. "What do I owe?" is not a question
 * with an interesting empty answer, and a permanent "0 waiting" is exactly how an eye learns to
 * skip the one badge in the window that must never be skipped.
 */
export function WaitingPill({ waiting, onOpen }: { waiting: WaitingState; onOpen: () => void }): React.JSX.Element | null {
  const rows = waiting.rows;
  if (rows.length === 0) return null;
  const overdue = rows.filter((row) => isOverdue(row)).length;
  const sentence = `${plural(rows.length, 'thing')} waiting for you to confirm on your phone`
    + (overdue > 0 ? ` · ${overdue} waiting more than an hour` : '')
    + (waiting.complete ? '' : ' · at least this many; a walk did not finish');

  return (
    <button
      type="button"
      className="waiting-pill"
      data-mode={overdue > 0 ? 'overdue' : 'pending'}
      data-testid="waiting-pill"
      title={sentence}
      aria-label={sentence}
      onClick={onOpen}
    >
      <span className="waiting-glyph"><Icon name="smartphone" size={14} /></span>
      <span className="waiting-count num">{rows.length.toLocaleString()}</span>
      {waiting.complete ? null : <span className="waiting-floor" aria-hidden="true">+</span>}
    </button>
  );
}

/**
 * Everything owed, oldest first, grouped by account.
 *
 * Deliberately *not* a list of buttons. There is no action this window can offer that discharges
 * one of these rows — the tap happens in Steam Mobile, on a secret this product refuses to hold
 * (rule 2) — so offering a `Confirm` button would be a lie the first time it was pressed. What it
 * offers instead is the one honest action: go and look again.
 *
 * That re-read is why the copy dwells on the lag. A person taps six confirmations, comes back,
 * and the list is still six long until the next complete walk observes the change. Without a
 * sentence saying so, the obvious reading is that the taps did not work — and a person who stops
 * believing this list is in exactly the position the feature was built to prevent.
 */
export function WaitingList({ waiting, accountIds, accounts = [], onOpenListings }: {
  waiting: WaitingState;
  accountIds: readonly string[];
  accounts?: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }> | undefined;
  onOpenListings?: (() => void) | undefined;
}): React.JSX.Element {
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const nameOf = (id: string): string => accounts.find((account) => account.id === id)?.name ?? id;
  const photoOf = (id: string): string | null | undefined => accounts.find((account) => account.id === id)?.avatarRef;

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    try { await engine.refreshNow([...accountIds]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChecking(false); }
  }

  // Never walked and walked-but-broke-off are different claims, and only the first can be the
  // reason this list is empty when the person is sure it should not be.
  const unwalked = waiting.coverage.filter((row) => row.observedAt === null);
  const incomplete = waiting.coverage.filter((row) => row.observedAt !== null && row.complete !== 1);

  const byAccount = new Map<string, WaitingRow[]>();
  for (const row of waiting.rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);

  return (
    <div className="stack" data-testid="waiting-list">
      {error ? <div className="caption" data-tone="warn" role="alert">{error}</div> : null}

      {waiting.rows.length > 0 ? (
        <Notice tone="warn" role="status" title="These are not done until you confirm them">
          Open the Steam Mobile app and go to <strong>Confirmations</strong>. A sell listing that is
          never confirmed is never listed: it earns nothing and no amount of waiting here will change
          that. After you confirm, this list clears on the next complete walk, not immediately —
          nothing is concluded from a tap this app did not see.
        </Notice>
      ) : null}

      {waiting.rows.length === 0 ? (
        <Empty
          icon="check-circle"
          title="Nothing is waiting on you"
          hint={unwalked.length > 0
            ? 'Nothing has been walked yet on at least one surface, so this is what has been observed rather than what is true.'
            : 'Listings and trade offers Steam is holding for a phone confirmation appear here.'}
        />
      ) : null}

      {[...byAccount.entries()].map(([accountId, rows]) => (
        <section className="waiting-group" key={accountId}>
          {accountIds.length > 1 ? (
            <header className="waiting-group-head">
              <Avatar name={nameOf(accountId)} size={16} photo={photoOf(accountId)} />
              <span className="grow">{nameOf(accountId)}</span>
              <span className="quiet num">{rows.length.toLocaleString()}</span>
            </header>
          ) : null}
          {rows.map((row) => <WaitingLine key={`${row.accountId}:${row.kind}:${row.id}`} row={row} />)}
        </section>
      ))}

      {unwalked.length > 0 || incomplete.length > 0 ? (
        <Caption icon="alert-triangle" tone="warn">
          Not everything has been looked at — {[
            ...unwalked.map((row) => `${surfaceLabel(row.surface)} for ${nameOf(row.accountId)} has never run`),
            ...incomplete.map((row) => `${surfaceLabel(row.surface)} for ${nameOf(row.accountId)} last finished ${formatRelative(row.observedAt)} without completing`)
          ].join('; ')}. This list is a floor, not a total: something waiting on you may not be in it.
        </Caption>
      ) : null}

      <div className="toolbar">
        <Button size="sm" icon="refresh" loading={checking} onClick={() => void check()} data-testid="waiting-check">
          Check again
        </Button>
        {onOpenListings ? (
          <Button size="sm" variant="ghost" icon="layers" onClick={onOpenListings}>Open Listings</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One obligation.
 *
 * The age is the load-bearing figure, not the price: what makes a person go and tap is being told
 * an item has been sitting unsold since this morning. It is measured from the walk that first saw
 * the row, never from when this app sent the mutation — the second is something the app assumed
 * and the first is something it observed.
 */
function WaitingLine({ row }: { row: WaitingRow }): React.JSX.Element {
  const overdue = isOverdue(row);
  const listing = row.kind === 'SELL_LISTING';
  // Named by the catalogue from the item the walk matched, or by the venue's own string. A row
  // with neither — an offer whose first line no single local item carried — says what it is
  // rather than wearing the identity `enrich` falls back to, which is nobody's item.
  const named = row.matchKey !== '' || row.hashName !== null;
  const title = !named
    ? (row.items > 1 ? plural(row.items, 'item') : 'An item')
    : row.unresolved ? row.hashName ?? row.name : row.name || row.hashName || 'An item';
  // "× 3" is a claim of three copies. Three different skins are the first one and two more.
  const others = named && row.items > 1
    ? (row.distinctItems > 1 ? ` and ${plural(row.items - 1, 'more item')}` : ` × ${row.items}`)
    : null;
  return (
    <div className="waiting-row" data-kind={row.kind} data-overdue={overdue || undefined}>
      <Thumbnail url={row.imageUrl} name={title} size={32} />
      <span className="waiting-row-text grow">
        <span className="waiting-row-name">
          {title}
          {others ? <span className={row.distinctItems > 1 ? 'quiet' : 'num'}>{others}</span> : null}
        </span>
        <span className="waiting-row-meta quiet">
          {listing ? <VenueMark venue="steam" size={11} /> : <Icon name="arrow-left-right" size={11} />}
          <span>{listing ? 'Sell listing' : 'Trade offer'}</span>
          <span className="sep">·</span>
          {/* "Waiting since" rather than "created": what is known is when a walk first saw it. */}
          <span>{row.waitingSince ? `waiting ${formatRelative(row.waitingSince)}` : 'waiting since a walk that did not date it'}</span>
          {listing && row.receiveCents !== null ? (
            <><span className="sep">·</span><span>you receive {formatCents(row.receiveCents, row.currency)} {currencyCode(row.currency)}</span></>
          ) : null}
          {row.expiresAt ? (
            <><span className="sep">·</span><span><Icon name="clock" size={11} /> expires {formatDateTime(row.expiresAt)}</span></>
          ) : null}
          <span className="sep">·</span>
          <span className="quiet">#{shortId(row.id, 5)}</span>
        </span>
      </span>
      <Badge tone={overdue ? 'warn' : 'accent'} icon="smartphone">
        {overdue ? 'Still not confirmed' : 'Confirm on phone'}
      </Badge>
    </div>
  );
}
