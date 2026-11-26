import React from 'react';
import { Badge, Button, Caption, Empty, KeyValue, StatusBadge } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { Tip } from '../../components/Tip.js';
import { VenueMark } from '../../components/VenueMark.js';
import { UNRESOLVED_REASON, formatDateTime, formatRelative, humanize } from '../../lib/labels.js';
import { InspectorBusy, InspectorHero, InspectorWear } from '../../components/InspectorParts.js';
import { InspectorAccessories } from '../../components/AccessoryStrip.js';
import { InspectorMarket } from '../../components/InspectorMarket.js';
import { delistBlocked, repriceBlocked, type Delisting } from './listing-actions.js';
import { DelistPrompt, Money, listingState, listingTitle, type NamedListing } from './listing-parts.js';
import { RepriceNotes } from './RepriceParts.js';
import { VENUE_ID, VENUE_LABEL } from '../../lib/marketplaces.js';
import { extensions } from '../../lib/extensions.js';

/**
 * The listing beside the grid: what it is, what it is priced at, and the two things that can be
 * done to it.
 *
 * The same aside as the item inspector, in the same column, built from the same parts, because it
 * describes the same object from the market's side. It is an aside and not a drawer for the same
 * reason too: the person keeps clicking tiles while it is open.
 *
 * **Figures and controls, no sentences.** What a state means is in its chip's tip (a listing
 * waiting on the phone says *Confirm on phone* and nothing under it), when it went up is a relative
 * time whose tip is the date, and why nothing can be pressed is a *Busy* chip. The dates, the
 * account and the identifiers someone pastes elsewhere are folded under *Show more details*, as
 * they are for an item. A figure is never printed twice.
 *
 * The buyer's price leads and names its currency. What the seller receives is the line under it:
 * present for Steam, and absent for CSFloat, which does not report it — the fold says so in words,
 * because a figure silently missing reads as a bug. The listing date follows the same rule: CSFloat
 * names one and Steam's walk does not, so a Steam listing says when it was first *seen*.
 */
export function ListingInspector({ row, account, multiAccount, busy, staged, delisting, onReprice, onOpenItem }: {
  row: NamedListing | null;
  account: string;
  multiAccount: boolean;
  /** An open command already names the item behind this listing. */
  busy: boolean;
  /** Already in the listing workspace, so the verb is "show me" rather than "stage". */
  staged: boolean;
  delisting: Delisting;
  onReprice: (row: NamedListing) => void;
  /** Opens one market name on the Items page: the listed item's, or a sticker or charm pressed on the strip. */
  onOpenItem?: ((name: string) => void) | undefined;
}): React.JSX.Element {
  if (!row) {
    return <aside className="inspector" aria-label="Listing inspector">
      <Empty icon="tag" title="No listing selected" />
    </aside>;
  }

  const name = listingTitle(row);
  const shown = listingState(row.venue, row.state);
  const phase = delisting.phase(row);
  const noReprice = repriceBlocked(row);
  const noDelist = delistBlocked(row);
  const venue = VENUE_LABEL[row.venue];
  // What the state chip would otherwise need a sentence under it to say.
  const stateTip = row.awaitingConfirmation === 1
    ? 'Waiting for you to confirm in the Steam Mobile app. Until then it is not on the market.'
    : row.holdUntil ? `Held until ${formatDateTime(row.holdUntil)}.` : null;
  const state = <StatusBadge label={shown.label} tone={shown.tone} icon={shown.icon} />;
  // How long it has been up, as far as anyone has said: the venue's own date, or the first walk that showed it.
  const age = row.createdAt
    ? { text: `listed ${formatRelative(row.createdAt)}`, tip: `Listed ${formatDateTime(row.createdAt)}.` }
    : row.firstSeenAt
      ? { text: `seen ${formatRelative(row.firstSeenAt)}`, tip: `First seen listed ${formatDateTime(row.firstSeenAt)}. ${venue} does not report when a listing was made, so this is the first walk that showed it.` }
      : null;

  return <aside className="inspector" aria-label="Listing inspector">
    <InspectorHero
      name={name}
      imageUrl={row.imageUrl}
      rarity={row.rarity}
      collection={row.collection}
      account={multiAccount ? account : undefined}
      // What is applied to the item behind the listing, when the listing names a holding this app has.
      beneath={<InspectorAccessories accessories={row.accessories} value={row.appliedValue} onOpen={onOpenItem} />}
    />

    <div className="inspector-price">
      <span className="inspector-price-line">
        <Money cents={row.buyerPriceCents} currency={row.currency} />
        <span className="caption">buyer pays</span>
      </span>
      {row.receiveCents !== null ? (
        <span className="inspector-price-line" data-size="sm">
          <Money cents={row.receiveCents} currency={row.currency} />
          <span className="caption">you receive</span>
        </span>
      ) : null}
    </div>

    <div className="toolbar inspector-state">
      {stateTip ? <Tip content={stateTip}>{state}</Tip> : state}
      <Badge tone="quiet"><VenueMark venue={VENUE_ID[row.venue]} size={12} decorative /> {venue}</Badge>
      {age ? <Tip content={age.tip}><span className="caption" data-testid="listing-age">{age.text}</span></Tip> : null}
    </div>
    <RepriceNotes row={row} />
    {row.unresolved ? <Caption icon="info">{UNRESOLVED_REASON[row.unresolved] ?? row.unresolved}</Caption> : null}

    {/* The item inspector's market block, for the item behind the listing: Steam's book for its
        name (a CSFloat listing sells under it too), its float price, and its Items page. */}
    <InspectorMarket accountId={row.accountId} marketHashName={row.hashName} paintWear={row.paintWear} onOpenItem={onOpenItem} />

    <div className="inspector-actions">
      {busy ? (
        <InspectorBusy />
      ) : phase !== 'idle' ? (
        <DelistPrompt phase={phase} name={name} onAnswer={(yes) => delisting.answer(row, yes)} />
      ) : (
        <div className="inspector-action">
          {noReprice === null ? (
            <Button size="sm" variant="primary" icon="pencil" onClick={() => onReprice(row)}>
              {staged ? 'Open the listing workspace' : 'Reprice'}
            </Button>
          ) : null}
          {noDelist === null ? <Button size="sm" variant="danger" icon="trash" onClick={() => delisting.ask(row)}>Delist</Button> : null}
        </div>
      )}
      {/* A withheld action says why, once: it is the rare listing, and a missing button reads as a fault. */}
      {noReprice !== null ? <Caption icon="info">Reprice unavailable: {noReprice}.</Caption> : null}
      {noDelist !== null ? <Caption icon="info">Delist unavailable: {noDelist}.</Caption> : null}
    </div>

    <InspectorWear paintWear={row.paintWear} paintSeed={row.paintSeed} range={row} />
    {extensions.inspectorPanels?.({ kind: 'listing', row })}

    <details className="technical">
      <summary><Icon name="chevron-right" size={13} /> Show more details</summary>
      <KeyValue
        rows={[
          row.createdAt
            ? { label: 'Listed', value: formatDateTime(row.createdAt) }
            : { label: 'First seen listed', value: row.firstSeenAt ? formatDateTime(row.firstSeenAt) : <span className="quiet">Not recorded</span> },
          ...(row.holdUntil ? [{ label: 'Held until', value: formatDateTime(row.holdUntil) }] : []),
          {
            label: 'Last observed',
            value: row.observedAt
              ? <>{formatDateTime(row.observedAt)}{row.observationComplete === 1 ? '' : <span className="quiet"> · that walk did not finish</span>}</>
              : <span className="quiet">Never</span>
          },
          { label: 'Account', value: account },
          ...(row.receiveCents === null ? [{ label: 'You receive', value: <span className="quiet">Not reported by {venue}</span> }] : []),
          { label: 'Listing id', value: row.listingId, mono: true },
          { label: 'Asset id', value: row.assetId, mono: true },
          { label: 'Local id', value: row.localId ?? '—', mono: true },
          { label: 'Identity key', value: row.matchKey || '—', mono: true },
          { label: 'Venue state', value: humanize(row.state), mono: true }
        ]}
      />
    </details>
  </aside>;
}
