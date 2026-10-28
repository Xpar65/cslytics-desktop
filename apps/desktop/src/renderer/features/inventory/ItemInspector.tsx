import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StoragePageRow } from '@cslytics/engine';
import { Button, Caption, Empty, Field, Select, Thumbnail } from '../../components/ui.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { useWorkRefresh } from '../work/WorkIndicator.js';
import { formatFloat, wearTier } from '../../lib/format.js';
import { buyerPaysFor } from '@cslytics/ports';
import { COMMAND_KIND, formatDate, locationLabel, lockLabel, parseMoney, plural } from '../../lib/labels.js';
import { itemIsBusy } from '../work/work-busy.js';
import { submitCommand, type CommandKind } from './commands.js';
import type { StagedItem } from './list-intent.js';
import { InspectorHero, InspectorKind, InspectorWear } from '../../components/InspectorParts.js';
import { OrderBookLine } from '../../components/OrderBookLine.js';
import { bookKey, useOrderBooks } from '../../lib/order-books.js';
import { UnitFill, UnitName } from './UnitParts.js';
import { ItemMoreDetails } from './ItemMoreDetails.js';
import { isStorageUnit, itemName, unitOfItem } from './storage-unit.js';
import { DISPLAY_ONLY_CAPTION, isDisplayOnly } from './display-only.js';
import { TransferDetail, askSteamForTransfer, type TransferAsked, type TransferMemberInput } from './TransferDetail.js';
import { StoreDetail } from './StoreDetail.js';
import {
  ACTION_ORDER,
  GROUP_KINDS,
  actionContext,
  GROUP_ORDER,
  allowedActions,
  groupsFor,
  intersect,
  lockOf,
  venuesFor,
  type ActionGroup,
  type ActionKind,
  type CsfloatState
} from './item-actions.js';
import { selectedRows, selectionKey, selectionQuantity, type InventorySelection } from './selection.js';
import type { NamedItem } from './InventoryTiles.js';
import type { Message } from '../../components/ui.js';


/**
 * What each group is called, and what the button that finally does it says.
 *
 * The two names never contain one another, so "Store" and "Store 3 items" are separate controls
 * to a screen reader and to a test driving by role and name.
 */
const GROUP_META: Readonly<Record<ActionGroup, { label: string; icon: IconName; submit: (count: number) => string; tab?: (count: number) => string }>> = {
  // The verb's tab names what choosing it does: the selection joins the listing workspace, which
  // is where the sale is priced and sent. `label` is the verb wherever a count is not to hand.
  LIST: { label: 'Stage listing', icon: 'tag', submit: (count) => `List ${plural(count, 'item')}`, tab: (count) => (count === 1 ? 'Stage listing' : 'Stage listings') },
  STORE: { label: 'Store', icon: 'archive', submit: (count) => `Store ${plural(count, 'item')}` },
  TRANSFER: { label: 'Transfer', icon: 'send', submit: (count) => `Transfer ${plural(count, 'item')}` },
  RETRIEVE: { label: 'Retrieve', icon: 'download', submit: (count) => `Retrieve ${plural(count, 'item')}` },
  REPRICE: { label: 'Reprice', icon: 'pencil', submit: (count) => `Reprice ${plural(count, 'item')}` },
  DELIST_TO_STORE: { label: 'Delist to storage', icon: 'undo', submit: (count) => `Delist ${plural(count, 'item')} to storage` }
};

/**
 * The item beside the list or the grid, and only the actions that can actually be taken on it.
 *
 * An aside rather than a modal: the user keeps clicking items while it is open, and a modal would
 * fight the selection model it is meant to explain. The selected item's image is a preview the
 * user can expand to fill the aside or collapse beside the name; the choice is remembered.
 *
 * **A multi-selection lists every item it holds.** It used to show whichever one was clicked last,
 * which quietly answered a different question — "what is this item" instead of "what did I just
 * select" — and gave no way to check the other nine before acting on all ten. Each row opens for
 * inspection in place, the one last clicked opens first, and an X on the card drops that handle
 * from the selection without clearing the rest.
 *
 * **The verb comes before its details.** The panel asks *List, Store, Transfer* first and only
 * then asks for a price, a unit or an account. Rendering every allowed action with its own inputs
 * at once put three or four half-filled forms on a 320px column and made the venue — the rarest
 * decision of the lot — look like a second verb. Choosing a group opens exactly one detail panel;
 * choosing **Stage listing** stages the selection in the [listing workspace](../../components/ListingWorkspace.tsx),
 * because listing is the one action whose details differ per item. That dock belongs to the shell
 * rather than to this panel: it has to outlive the selection it was staged from, since submitting
 * a row is what takes that row out of the selection, and staging adds to what is already there.
 *
 * Two rules run through the whole thing. **The engine is the gate** — hiding a button never
 * replaces a refusal, so whatever the engine says comes back verbatim in the notice. And **a
 * multi-selection offers only the intersection**, because the engine rejects a batch atomically:
 * a button that would fail the whole batch over one item is a trap, so the action is withheld,
 * each roster card says what its own item could do on its own, and can drop it from the selection.
 * Store is the one exception (`PARTIAL_GROUPS`): it is offered when some of the selection can be
 * stored, and its panel ([StoreDetail](./StoreDetail.tsx)) sends only those and says what it leaves out.
 */
export function ItemInspector({ accountIds, accounts, units, selection, subject, busyKeys, onMessage, destinations, onDestinations, price, onPrice, onSubmitted, onStage, onDeselect, onUnitRenamed, onOpenItem, onShowUnit }: {
  accountIds: readonly string[];
  accounts: ReadonlyArray<{ id: string; name: string; steamId64?: string | null | undefined }>;
  units: readonly StoragePageRow[];
  selection: InventorySelection;
  subject: NamedItem | null;
  busyKeys: ReadonlySet<string>;
  onMessage: (message: Message | null) => void;
  destinations: Record<string, string>;
  onDestinations: (next: Record<string, string>) => void;
  price: string;
  onPrice: (next: string) => void;
  onSubmitted?: (() => void) | undefined;
  /** Stage this selection for listing. The workspace itself belongs to the view, not to this panel. */
  onStage: (staged: readonly StagedItem[]) => void;
  /** Drop one handle from a multi-selection without clearing the rest. */
  onDeselect?: ((key: string) => void) | undefined;
  /** Opens the item page for the selected item's market name. */
  onOpenItem?: ((name: string) => void) | undefined;
  /** A rename of the selected storage unit has settled, so `units` should be read again. */
  onUnitRenamed?: (() => void) | undefined;
  /** Narrows the view to what the selected storage unit holds, as picking it in the filter bar does. */
  onShowUnit?: ((unit: StoragePageRow) => void) | undefined;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState<ActionKind | null>(null);
  const [eligibility, setEligibility] = useState<Record<string, CsfloatState>>({});
  const [csfloatConnected, setCsfloatConnected] = useState(false);
  /** The venue's own reason a new listing would be refused, when there is one (a suspension). */
  const [csfloatRestricted, setCsfloatRestricted] = useState<string | null>(null);
  const [destinationAccount, setDestinationAccount] = useState('');
  const [group, setGroup] = useState<ActionGroup | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const lastSubject = useRef<string | null>(null);
  const transferAsked = useRef<TransferAsked>(null);
  const refreshWork = useWorkRefresh();
  const panelId = useId();

  const rows = useMemo(() => {
    const chosen = selectedRows(selection) as NamedItem[];
    if (chosen.length > 0) return chosen;
    return subject ? [subject] : [];
  }, [selection, subject]);
  // One item fills the panel. Several are listed, and `subject` decides only which row opens
  // first — actions run on the whole selection either way, so opening a copy to read its float
  // never drops a batch that is already ticked.
  const single = rows.length === 1 ? rows[0]! : null;
  const subjectKey = subject ? selectionKey(subject) : null;
  if (lastSubject.current !== subjectKey) {
    // The tile just clicked opens in the roster. After that the roster owns which row is open, so
    // a row clicked shut stays shut until another tile is clicked.
    lastSubject.current = subjectKey;
    setOpenRow(subjectKey);
  }
  const count = selectionQuantity(selection) || rows.length;
  const frozen = Boolean(selection.manifest);
  // The Steam order book for the one item shown, or for the roster row open, read live while it is
  // on screen and for no other row: a selection of hundreds costs the market nothing until a row
  // opens. Asked with the account, so a wallet the anonymous book is not priced for sees its own.
  const shownRow = single ?? rows.find((row) => selectionKey(row) === openRow) ?? null;
  const bookAccount = shownRow?.accountId ?? null;
  const bookName = shownRow?.marketHashName ?? null;
  const bookKeys = useMemo(() => (bookAccount !== null && bookName !== null ? [{ accountId: bookAccount, name: bookName }] : []), [bookAccount, bookName]);
  const books = useOrderBooks(bookKeys, true);

  // Whether the venue is connected at all, which is a different question from whether this item is
  // eligible on it. A disconnected venue hides the action; an unchecked item explains itself.
  const scope = accountIds.join('\0');
  useEffect(() => {
    const ids = scope.split('\0').filter(Boolean);
    if (ids.length === 0) return undefined;
    let live = true;
    void Promise.all(ids.map((accountId) => window.trading
      .invoke({ type: 'marketplace.status', accountId, venue: 'csfloat' })
      .catch(() => null)))
      .then((answers) => {
        // Connected on *every* account in scope, because the action is offered for all of them at
        // once: one connected account in a two-account window is not a venue this batch can use.
        if (!live) return;
        setCsfloatConnected(answers.length > 0 && answers.every((answer) => (answer as { status?: string } | null)?.status === 'CONNECTED'));
        // One suspended account in scope refuses the batch, the way one disconnected one does.
        const restriction = answers
          .map((answer) => (answer as { restriction?: { until: string; state: string } | null } | null)?.restriction ?? null)
          .find((row) => row !== null && row.state !== 'ended');
        setCsfloatRestricted(restriction ? `suspended on CSFloat until ${formatDate(restriction.until)}` : null);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [scope]);

  /**
   * A select with a single option is a question with one answer, so a lone unit is preselected.
   *
   * This is an effect and not a write during render. The destination lives in the view above, and
   * updating a parent while rendering a child is an error React answers by tearing the window
   * down — which is exactly what it did once the pickers were built on every render rather than
   * only inside the action that needed them.
   */
  const soleUnits = useMemo(() => {
    const picked: Record<string, string> = {};
    for (const accountId of new Set(rows.map((row) => row.accountId))) {
      const available = units.filter((unit) => unit.accountId === accountId);
      if (available.length === 1) picked[accountId] = available[0]!.casketId;
    }
    return picked;
  }, [rows, units]);
  const soleKey = JSON.stringify(soleUnits);
  useEffect(() => {
    const picked = JSON.parse(soleKey) as Record<string, string>;
    const missing = Object.entries(picked).filter(([accountId, casketId]) => destinations[accountId] !== casketId);
    if (missing.length > 0) onDestinations({ ...destinations, ...Object.fromEntries(missing) });
  }, [soleKey, destinations, onDestinations]);

  // Eligibility for the items actually on screen, asked of each one's own account by local id.
  // Capped at the read's own ceiling. A display item is never asked about: no venue will take one,
  // so the answer could only cost a read.
  const asked = useMemo(() => {
    const byAccount: Record<string, string[]> = {};
    for (const row of rows) {
      if (isDisplayOnly(row)) continue;
      const wanted = (byAccount[row.accountId] ??= []);
      if (wanted.length < 100) wanted.push(row.localId);
    }
    return JSON.stringify(byAccount);
  }, [rows]);
  useEffect(() => {
    const byAccount = JSON.parse(asked) as Record<string, string[]>;
    let live = true;
    for (const [accountId, localIds] of Object.entries(byAccount)) {
      if (localIds.length === 0) continue;
      void window.trading.invoke({ type: 'csfloat.eligibility', accountId, localIds })
        .then((answer) => {
          if (!live || !Array.isArray(answer)) return;
          const next: Record<string, CsfloatState> = {};
          for (const entry of answer as Array<{ localId: string; state: CsfloatState }>) next[entry.localId] = entry.state;
          setEligibility((current) => ({ ...current, ...next }));
        })
        .catch(() => undefined);
    }
    return () => { live = false; };
  }, [asked]);

  if (rows.length === 0) {
    return <aside className="inspector" aria-label="Item inspector">
      <Empty icon="package" title="No item selected" />
    </aside>;
  }

  const context = actionContext({ scope: accountIds, window: accounts, csfloatConnected, csfloatRestricted, csfloatEligibility: eligibility });
  const now = new Date();
  // A storage unit goes by its own name in the roster and in what blocks an action, the way it
  // does in the list and the grid.
  const verdicts = rows.map((row) => ({
    row: { ...row, name: itemName(row, units) },
    verdict: allowedActions(row, context, now)
  }));
  const combined = intersect(verdicts);
  const groups = groupsFor(verdicts);
  // A group the selection no longer offers falls away rather than lingering as a chosen tab over
  // an empty panel: clicking another tile is how a person changes their mind about the verb too.
  const chosen = group && groups.allowed.includes(group) ? group : null;
  const busy = rows.some((row) => itemIsBusy(busyKeys, row));
  const priceCents = parseMoney(price);
  const accountsWithUnits = [...new Set(rows.map((row) => row.accountId))];
  const unitsFor = (accountId: string): StoragePageRow[] => units.filter((unit) => unit.accountId === accountId);
  const otherAccounts = accounts.filter((account) => !rows.some((row) => row.accountId === account.id));
  const transferMembers: TransferMemberInput[] = rows.map((row) => ({ accountId: row.accountId, localId: row.localId, casketId: row.casketId }));
  // Listing prices item by item, so it needs the rows themselves. A frozen selection has none to
  // give: the engine holds those members and takes one price for the whole manifest.
  const workspaceAvailable = !frozen;

  function choose(next: ActionGroup): void {
    setGroup(next);
    onMessage(null);
    if (next === 'LIST' && workspaceAvailable && !busy) onStage(verdicts);
  }

  async function run(kind: ActionKind): Promise<void> {
    setSubmitting(kind);
    onMessage(null);
    try {
      // A CSFloat listing is never sent from here: it is staged in the listing workspace, which
      // prices it per row and shows the refusal against that row (see `detailFor('LIST')`).
      if (kind === 'CSFLOAT_LIST') throw new Error('List on CSFloat from the listing workspace');
      if (kind === 'TRANSFER') {
        // An ask older than its reuse window is renewed first, so admission judges reads as recent
        // as the ones the panel showed as ready.
        await askSteamForTransfer(destinationAccount, [...new Set(transferMembers.map((member) => member.accountId))], transferAsked);
        await window.trading.invoke({
          type: 'transfer.submit',
          commandId: crypto.randomUUID(),
          destinationAccountId: destinationAccount,
          members: transferMembers
        });
      } else {
        const chosenSelection: InventorySelection = selection.manifest || Object.keys(selection.rows).length > 0
          ? selection
          : { rows: Object.fromEntries(rows.map((row) => [`${row.accountId}:${row.rowKey}`, { row, quantity: 1 }])) };
        await submitCommand(kind as CommandKind, chosenSelection, { destinations, priceCents });
      }
      // Work appears out of nothing here, and a command raises no observation notice. Without
      // this nudge the indicator would not read again until something unrelated woke it.
      refreshWork();
      const verb = COMMAND_KIND[kind]?.progressive ?? GROUP_META[groupOf(kind)].label;
      onMessage({
        tone: 'success',
        title: `${verb} ${plural(count, 'item')}`,
        detail: 'Submitted. Each step is confirmed by a later observation, and progress is shown in the work panel.'
      });
      setGroup(null);
      onSubmitted?.();
    } catch (error) {
      // The engine's own words, verbatim. A paraphrase here is a second, wrong explanation of a
      // refusal the engine already stated exactly.
      onMessage({ tone: 'error', title: 'The command was not accepted', detail: error instanceof Error ? error.message : String(error) });
    } finally { setSubmitting(null); }
  }

  const lock = single ? lockOf(single, now) : null;
  // A storage unit selected as an item: its own name, which can be changed here, and how full it is.
  const selectedUnit = single ? unitOfItem(single, units) : null;
  // The item page is the item's market. A storage unit, a display item and a holding Steam reads as
  // unmarketable are sold on none, so they have no page to open.
  const hasItemPage = single !== null && !isStorageUnit(single) && !isDisplayOnly(single) && single.marketable !== 0;

  const unitFor = (row: NamedItem): string => (
    units.find((unit) => unit.accountId === row.accountId && unit.casketId === row.casketId)?.label
    ?? `unit ${row.casketId ?? ''}`
  );
  const placeOf = (row: NamedItem): string => (
    row.location === 'CASKET' ? `In ${unitFor(row)}` : locationLabel(row.location).label
  );
  const accountName = (accountId: string): string => accounts.find((account) => account.id === accountId)?.name ?? accountId;

  /** Which storage units are still unchosen, which is what withholds a Store or a Delist. */
  const unitMissing = accountsWithUnits.some((accountId) => unitsFor(accountId).length > 0 && !destinations[accountId]);

  /** The unit pickers, shared by Store and Delist to storage: both end in a casket. */
  function unitPickers(): React.JSX.Element[] {
    return accountsWithUnits.flatMap((accountId) => {
      const available = unitsFor(accountId);
      if (available.length === 0) return [];
      // The lone unit was already chosen by the effect above; here it is only stated.
      if (available.length === 1) {
        const only = available[0]!;
        return [<Caption key={accountId} icon="archive">into {only.label ?? `unit ${only.casketId}`}</Caption>];
      }
      return [(
        <Field key={accountId} label={accountsWithUnits.length > 1 ? `${accountName(accountId)} unit` : 'Storage unit'}>
          <Select label={`Destination ${accountId}`} className="input-sm" value={destinations[accountId] ?? ''} onChange={(next) => onDestinations({ ...destinations, [accountId]: next })}>
            <option value="">Choose a unit…</option>
            {available.map((unit) => <option key={unit.casketId} value={unit.casketId}>{unit.label ?? `Unit ${unit.casketId}`} · {unit.reportedCount}/1000</option>)}
          </Select>
        </Field>
      )];
    });
  }

  /** The price field, shared by the frozen-selection List and by Reprice. */
  const priceField = (label: string): React.JSX.Element => (
    <>
      <Field label={label}>
        <input
          className="input input-sm input-money"
          aria-label={label}
          inputMode="decimal"
          value={price}
          onChange={(event) => onPrice(event.target.value)}
        />
      </Field>
      {priceCents !== null ? (
        <Caption icon="dollar-sign">
          <span title="Steam adds its fee and the game's fee, each at least one cent.">buyer pays about {(buyerPaysFor('steam', priceCents) / 100).toFixed(2)}</span>
        </Caption>
      ) : null}
    </>
  );

  function submitButton(kind: ActionKind, blockedByInput = false): React.JSX.Element {
    return (
      <Button
        size="sm"
        variant="primary"
        icon={GROUP_META[groupOf(kind)].icon}
        disabled={busy || blockedByInput || submitting !== null}
        loading={submitting === kind}
        onClick={() => void run(kind)}
      >
        {GROUP_META[groupOf(kind)].submit(count)}
      </Button>
    );
  }

  /** How many of the selection have to be taken out of a unit first, and what that costs. */
  function chainCaption(kind: ActionKind): React.JSX.Element | null {
    const chain = combined.chains[kind];
    if (!chain) return null;
    return (
      <Caption icon="download">
        {single && single.location === 'CASKET'
          ? `Retrieve from ${units.find((unit) => unit.accountId === single.accountId && unit.casketId === single.casketId)?.label ?? 'its unit'}, then list`
          : `${chain.hops} of ${rows.length} will be retrieved first`}
        {' · '}needs {plural(chain.slotsNeeded, 'free inventory slot')}
      </Caption>
    );
  }

  function detailFor(active: ActionGroup): React.JSX.Element {
    if (active === 'LIST') {
      if (!workspaceAvailable) {
        // Per-row pricing over members only the engine holds is not possible, and pretending
        // otherwise would price a manifest by a set of rows that is not the manifest.
        return (
          <>
            <Caption icon="lock">A frozen selection lists at one price: the engine holds its members, so there is no row here to price on its own.</Caption>
            {priceField('Seller receives')}
            {chainCaption('LIST')}
            {submitButton('LIST', priceCents === null)}
          </>
        );
      }
      const venues = new Set(verdicts.flatMap(({ verdict }) => venuesFor(verdict)));
      return (
        <>
          <Caption icon="tag">
            {plural(rows.length, 'item')} in the listing workspace, priced and sent from there.
          </Caption>
          <Caption icon="info">
            {venues.has('steam') ? <><VenueMark venue="steam" size={12} /> Steam</> : null}
            {venues.has('steam') && venues.has('csfloat') ? ' · ' : ''}
            {venues.has('csfloat') ? <><VenueMark venue="csfloat" size={12} /> CSFloat</> : null}
            {venues.size === 1 ? ' is the only marketplace this selection can reach.' : ' are both open to this selection.'}
          </Caption>
          {chainCaption('LIST')}
          <Button size="sm" variant="primary" icon="tag" disabled={busy} onClick={() => onStage(verdicts)}>
            Open the listing workspace
          </Button>
        </>
      );
    }

    if (active === 'STORE') {
      return (
        <StoreDetail
          selection={selection}
          verdicts={verdicts}
          destinations={destinations}
          unitPickers={unitPickers()}
          unitMissing={unitMissing}
          accountName={accountName}
          busy={busy}
          onSent={(stored) => {
            // Work appears out of nothing here, and a command raises no observation notice.
            refreshWork();
            onMessage({
              tone: 'success',
              title: `Storing ${plural(stored, 'item')}`,
              detail: 'Submitted. Each item is confirmed by a later observation, and progress is shown in the work panel.'
            });
            setGroup(null);
            onSubmitted?.();
          }}
          onFailed={(reason) => onMessage({ tone: 'error', title: 'The command was not accepted', detail: reason })}
        />
      );
    }

    if (active === 'DELIST_TO_STORE') {
      return <>
        {unitPickers()}
        {chainCaption(active)}
        {submitButton(active, unitMissing)}
      </>;
    }

    if (active === 'TRANSFER') {
      return (
        <TransferDetail
          accounts={otherAccounts}
          destination={destinationAccount}
          onDestination={setDestinationAccount}
          members={transferMembers}
          asked={transferAsked}
          accountName={accountName}
          submit={(blocked) => submitButton('TRANSFER', blocked)}
        />
      );
    }

    if (active === 'REPRICE') {
      return <>
        {priceField('New price, seller receives')}
        <Caption icon="info">The listing is removed and a new one created at the new price. Both steps are observed.</Caption>
        {submitButton('REPRICE', priceCents === null)}
      </>;
    }

    return <>
      <Caption icon="download">Taken out of storage and back into main inventory. It needs {plural(rows.length, 'free inventory slot')}.</Caption>
      {submitButton('RETRIEVE')}
    </>;
  }

  return <aside className="inspector" aria-label="Item inspector">
    {single ? (
      <InspectorHero
        name={single.name}
        imageUrl={single.imageUrl}
        rarity={single.rarity}
        collection={single.collection}
        account={accountIds.length > 1 ? accountName(single.accountId) : undefined}
        heading={selectedUnit ? <UnitName key={`${selectedUnit.accountId}:${selectedUnit.casketId}`} unit={selectedUnit} onSettled={() => onUnitRenamed?.()} /> : undefined}
      />
    ) : (
      <div className="inspector-hero">
        <span className="panel-icon"><Icon name="list-checks" size={18} /></span>
        <div className="inspector-hero-text">
          <div className="inspector-name">{plural(count, 'item')} selected</div>
          <div className="inspector-meta quiet">{breakdown(rows, now)}</div>
        </div>
      </div>
    )}

    {/* Actions first, and the verb before its details.
        "What can I do with this" is the question the panel exists to answer, and with a long
        selection listed underneath, an answer you have to scroll to find is not an answer. The
        intersection rule is unchanged: the engine accepts or refuses a batch atomically, so an
        action one item blocks is withheld for all of them. */}
    {/* The market the item is priced against, read live while it is shown: bid, mid and ask in
        the book's currency, the account's own read when its wallet is in another (plan D17).
        To read, not to press: a price is typed in the listing workspace, from the book on its row. */}
    {single && single.marketHashName ? (
      <div className="inspector-book" data-testid="inspector-book">
        <OrderBookLine quote={books.get(bookKey(single.accountId, single.marketHashName))} />
        {onOpenItem && hasItemPage ? (
          <Button size="sm" variant="ghost" icon="trending-up" data-testid="open-item-page" onClick={() => onOpenItem(single.marketHashName!)}>
            Item page
          </Button>
        ) : null}
      </div>
    ) : null}
    <div className="inspector-actions">
      {selectedUnit && onShowUnit ? (
        <Button size="sm" icon="search" data-testid="show-unit-items" onClick={() => onShowUnit(selectedUnit)}>
          Show items in storage unit
        </Button>
      ) : null}
      {groups.allowed.length === 0 ? (
        <Caption icon="info">
          {single && isStorageUnit(single)
            ? 'A storage unit cannot be listed, stored or transferred.'
            : rows.every((row) => isDisplayOnly(row))
              ? DISPLAY_ONLY_CAPTION
              : 'Nothing can be done to this selection as a whole.'}
        </Caption>
      ) : (
        <>
          <div className="action-choices" role="tablist" aria-label="What to do with this selection">
            {GROUP_ORDER.filter((option) => groups.allowed.includes(option)).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                id={`${panelId}-${option}`}
                className="action-choice"
                aria-selected={chosen === option}
                data-selected={chosen === option}
                aria-controls={chosen === option ? `${panelId}-detail` : undefined}
                onClick={() => choose(option)}
              >
                <Icon name={GROUP_META[option].icon} size={15} />
                <span>{GROUP_META[option].tab?.(count) ?? GROUP_META[option].label}</span>
              </button>
            ))}
          </div>
          {chosen ? (
            <div className="action-detail" role="tabpanel" id={`${panelId}-detail`} aria-labelledby={`${panelId}-${chosen}`}>
              {detailFor(chosen)}
            </div>
          ) : null}
        </>
      )}

      {/* For one item, one quiet caption per withheld action says why. A selection of many does
          not list them: every action one item withholds from the rest, named item by item, buried
          the answer that matters, which is what can be done to the selection as a whole. */}
      {single ? GROUP_ORDER.filter((option) => groups.blockers[option]).map((option) => {
        const blocker = groups.blockers[option]!;
        return (
          <Caption key={option} icon="info">
            {GROUP_META[option].label} unavailable: {plural(blocker.count, 'item')} {blocker.count === 1 ? 'is' : 'are'} {blocker.reason}
            {' — '}<em>{blocker.first}</em>{blocker.count > 1 ? ` and ${blocker.count - 1} more` : ''}
          </Caption>
        );
      }) : null}

      {single && !combined.allowed.includes('CSFLOAT_LIST') && csfloatConnected && eligibility[single.localId] === 'unknown' ? (
        <Caption icon="info">Refresh eligibility on the CSFloat tab to see whether this item can be listed there.</Caption>
      ) : null}
    </div>

    {/* True of the selection as a whole rather than of any one item in it. */}
    {frozen || busy ? (
      <div className="inspector-where">
        {frozen ? <Caption icon="lock">This selection is frozen: a later inventory change will not add to it.</Caption> : null}
        {busy ? <Caption icon="hourglass">Busy: an open command already names {single ? 'this item' : 'one of these items'}. Its actions return when the work leaves the panel.</Caption> : null}
      </div>
    ) : null}

    {single ? (
      <>
        <InspectorWear paintWear={single.paintWear} paintSeed={single.paintSeed} range={single} />
        <div className="inspector-where">
          <span className="inline">
            <Icon name={locationLabel(single.location).icon ?? 'package'} size={13} />
            {placeOf(single)}
          </span>
          {lock ? <Caption icon="lock" tone="warn">{lockLabel(lock.kind, lock.until)}</Caption> : null}
          {selectedUnit ? <UnitFill unit={selectedUnit} /> : null}
        </div>
        <ItemMoreDetails row={single} accounts={accounts} units={units} />
      </>
    ) : (
      /* Every selected item, not a sample of one. A row carries what tells copies apart at a
         glance — where it is, its wear, whether it is locked — and opens for the rest. The X
         drops that one handle; it is a sibling of the expand button so the markup stays valid. */
      <ul className="inspector-roster" aria-label="Selected items">
        {verdicts.map(({ row, verdict }) => {
          const key = selectionKey(row);
          const open = openRow === key;
          const rowLock = lockOf(row, now);
          const wear = row.paintWear ?? null;
          const rowTier = wear === null ? null : wearTier(wear);
          const rowBusy = itemIsBusy(busyKeys, row);
          return (
            <li className="roster-item" key={key} data-open={open}>
              <div className="roster-head">
                <button
                  type="button"
                  className="roster-row"
                  aria-expanded={open}
                  onClick={() => setOpenRow(open ? null : key)}
                >
                  <Thumbnail url={row.imageUrl} name={row.name} size={34} />
                  <span className="roster-text">
                    <span className="roster-name">{row.name}</span>
                    <span className="roster-meta quiet">
                      <Icon name={locationLabel(row.location).icon ?? 'package'} size={11} />
                      {placeOf(row)}
                      {rowTier ? ` · ${rowTier.label}` : ''}
                      {wear !== null ? <> · <span className="num">{formatFloat(wear)}</span></> : null}
                    </span>
                  </span>
                  {rowBusy ? <Icon name="hourglass" size={12} className="roster-mark" /> : null}
                  {rowLock ? <Icon name="lock" size={12} className="roster-mark" /> : null}
                  <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} className="roster-chevron" />
                </button>
                {frozen || !onDeselect ? null : (
                  <button
                    type="button"
                    className="roster-remove"
                    aria-label={`Remove ${row.name} from selection`}
                    title={`Remove ${row.name} from selection`}
                    onClick={() => {
                      if (openRow === key) setOpenRow(null);
                      onDeselect(key);
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
              {open ? (
                <div className="roster-detail">
                  <Thumbnail url={row.imageUrl} name={row.name} size={84} />
                  <div className="roster-detail-text">
                    <InspectorKind rarity={row.rarity} collection={row.collection} />
                    {accountIds.length > 1 ? <div className="inspector-meta quiet">{accountName(row.accountId)}</div> : null}
                    <InspectorWear paintWear={wear} paintSeed={row.paintSeed} range={row} />
                    {row.marketHashName ? <OrderBookLine quote={books.get(bookKey(row.accountId, row.marketHashName))} /> : null}
                    {rowLock ? <Caption icon="lock" tone="warn">{lockLabel(rowLock.kind, rowLock.until)}</Caption> : null}
                    {/* What this one allows, which is not always what the batch allows: it is how
                        a person finds the item that is holding an action back. */}
                    <Caption icon="info">
                      {verdict.allowed.length > 0
                        ? `On its own: ${ACTION_ORDER.filter((kind) => verdict.allowed.includes(kind)).map((kind) => GROUP_META[groupOf(kind)].label).filter((label, index, all) => all.indexOf(label) === index).join(', ')}`
                        : 'Nothing can be done to this item on its own.'}
                    </Caption>
                  </div>
                  <ItemMoreDetails row={row} accounts={accounts} units={units} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    )}
  </aside>;
}

/** The verb a kind belongs to. Only listing has more than one kind under it. */
function groupOf(kind: ActionKind): ActionGroup {
  return GROUP_ORDER.find((group) => GROUP_KINDS[group].includes(kind)) ?? 'LIST';
}

/**
 * "3 in inventory, 2 in storage, 1 listed, 1 locked", so a multi-selection says what it is made of.
 * Listed is said of items already counted in inventory: a listed item never leaves it.
 */
function breakdown(rows: readonly NamedItem[], now: Date): string {
  const parts: string[] = [];
  const at = (location: string): number => rows.filter((row) => row.location === location).length;
  const main = at('MAIN');
  const stored = at('CASKET');
  const listed = rows.filter((row) => row.steamListed).length;
  const locked = rows.filter((row) => lockOf(row, now) !== null).length;
  if (main) parts.push(`${main} in inventory`);
  if (stored) parts.push(`${stored} in storage`);
  if (listed) parts.push(`${listed} listed`);
  if (locked) parts.push(`${locked} locked`);
  return parts.join(', ');
}

export type { Message };
