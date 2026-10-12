import React from 'react';
import { Badge, Button, Caption, Empty, KeyValue, StatusBadge } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { formatCents } from '../../lib/format.js';
import { UNRESOLVED_REASON, formatDateTime, formatRelative, humanize } from '../../lib/labels.js';
import { InspectorHero, InspectorWear } from '../../components/InspectorParts.js';
import { delistBlocked, repriceBlocked, type Delisting } from './listing-actions.js';
import { DelistPrompt, Money, listingState, listingTitle, type NamedListing } from './listing-parts.js';
import { VENUE_ID, VENUE_LABEL } from '../../lib/marketplaces.js';

/**
 * The listing beside the grid: what it is, what it is priced at, when it went up, and the two
 * things that can be done to it.
 *
 * The same aside as the item inspector, in the same column, built from the same parts, because it
 * describes the same object from the market's side. It is an aside and not a drawer for the same
 * reason too: the person keeps clicking tiles while it is open.
 *
 * Every money row names its currency, and the seller-receives row is present for Steam and
 * explicitly absent for CSFloat rather than silently missing — an empty field reads as a bug,
 * where "CSFloat does not report it" reads as the fact it is. The listing date follows the same
 * rule: CSFloat names one and Steam's walk does not, so a Steam listing says when this app first
 * saw it and calls it that.
 */
export function ListingInspector({ row, account, multiAccount, busy, staged, delisting, onReprice }: {
  row: NamedListing | null;
  account: string;
  multiAccount: boolean;
  /** An open command already names the item behind this listing. */
  busy: boolean;
  /** Already in the listing workspace, so the verb is "show me" rather than "stage". */
  staged: boolean;
  delisting: Delisting;
  onReprice: (row: NamedListing) => void;
}): React.JSX.Element {
  if (!row) {
    return <aside className="inspector" aria-label="Listing inspector">
      <Empty icon="tag" title="No listing selected" hint="Click a listing to see its details, change its price or take it down." />
    </aside>;
  }

  const name = listingTitle(row);
  const shown = listingState(row.venue, row.state);
  const phase = delisting.phase(row);
  const noReprice = repriceBlocked(row);
  const noDelist = delistBlocked(row);

  return <aside className="inspector" aria-label="Listing inspector">
    <InspectorHero
      name={name}
      imageUrl={row.imageUrl}
      rarity={row.rarity}
      collection={row.collection}
      account={multiAccount ? account : undefined}
    />

    <div className="inspector-price">
      <Money cents={row.buyerPriceCents} currency={row.currency} />
      <span className="caption">
        {row.receiveCents === null ? 'buyer pays' : `buyer pays · you receive ${formatCents(row.receiveCents, row.currency)}`}
      </span>
    </div>

    <div className="toolbar">
      <StatusBadge label={shown.label} tone={shown.tone} icon={shown.icon} />
      <Badge tone="quiet"><VenueMark venue={VENUE_ID[row.venue]} size={12} /> {VENUE_LABEL[row.venue]}</Badge>
    </div>
    {row.awaitingConfirmation === 1 ? (
      <Caption icon="smartphone" tone="accent">Waiting for you to confirm in the Steam Mobile app. Until then it is not on the market.</Caption>
    ) : null}
    {row.unresolved ? <Caption icon="info">{UNRESOLVED_REASON[row.unresolved] ?? row.unresolved}</Caption> : null}

    <div className="inspector-actions">
      {busy ? (
        <Caption icon="hourglass">Busy: an open command already names this item. Its actions return when the work leaves the panel.</Caption>
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
      {/* One quiet caption per withheld action, naming why — the same shape the item inspector uses. */}
      {noReprice !== null ? <Caption icon="info">Reprice unavailable: this listing is {noReprice}.</Caption> : null}
      {noDelist !== null ? <Caption icon="info">Delist unavailable: this listing is {noDelist}.</Caption> : null}
    </div>

    <InspectorWear paintWear={row.paintWear} paintSeed={row.paintSeed} range={row} />

    <KeyValue
      rows={[
        row.createdAt
          ? { label: 'Listed', value: <>{formatDateTime(row.createdAt)} <span className="quiet">· {formatRelative(row.createdAt)}</span></> }
          : {
            label: 'First seen listed',
            value: row.firstSeenAt
              ? <span title={`${VENUE_LABEL[row.venue]} does not report when a listing was made. This is the first walk that showed it.`}>{formatDateTime(row.firstSeenAt)} <span className="quiet">· {formatRelative(row.firstSeenAt)}</span></span>
              : <span className="quiet">Not recorded</span>
          },
        ...(row.holdUntil ? [{ label: 'Held until', value: formatDateTime(row.holdUntil) }] : []),
        {
          label: 'Last observed',
          value: row.observedAt
            ? <>{formatDateTime(row.observedAt)} <span className="quiet">· {formatRelative(row.observedAt)}{row.observationComplete === 1 ? '' : ' · that walk did not finish'}</span></>
            : <span className="quiet">Never</span>
        },
        { label: 'Account', value: account },
        { label: 'Buyer pays', value: <Money cents={row.buyerPriceCents} currency={row.currency} /> },
        {
          label: 'You receive',
          value: row.receiveCents === null
            ? <span className="quiet">CSFloat reports fees and proceeds; this app was not told them</span>
            : <Money cents={row.receiveCents} currency={row.currency} />
        }
      ]}
    />

    <details className="technical">
      <summary><Icon name="chevron-right" size={13} /> Technical details</summary>
      <KeyValue
        rows={[
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
