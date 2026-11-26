import React from 'react';
import type { PageEnvelope } from '@cslytics/engine';
import { PagedGrid, TILE_HEIGHT } from '../../components/PagedGrid.js';
import { ItemTile, TileAccountBadge, TileBadge, TileBusy, TileWear, stopTilePress } from '../../components/ItemTile.js';
import { IconButton } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { VenueMark } from '../../components/VenueMark.js';
import { formatAmount } from '../../lib/money.js';
import { formatDateTime } from '../../lib/labels.js';
import { itemIsBusy } from '../work/work-busy.js';
import { delistBlocked, type Delisting } from './listing-actions.js';
import { DelistPrompt, Money, listingKey, listingState, listingTitle, type NamedListing } from './listing-parts.js';
import { TileReprice } from './RepriceParts.js';
import { pendingPriceChangeOf, pendingSubLine, pendingTitle } from './reprice-state.js';
import { VENUE_ID, VENUE_LABEL } from '../../lib/marketplaces.js';
import { extensions } from '../../lib/extensions.js';

/** The inventory tile, and one more line for the price and the two things that can be done to it. */
const LISTING_TILE_HEIGHT = TILE_HEIGHT + 30;
/** A price, its currency and two controls do not fit across the narrowest inventory tile. */
const LISTING_TILE_MIN_WIDTH = 164;

/**
 * One tile per listing: the inventory tile, with the price under it.
 *
 * It is `ItemTile`, so a listed skin looks here exactly as it does in Inventory. What this adds is
 * what only a listing has — the venue in the corner where Inventory says where an item is, the
 * state where Inventory shows a lock, and a footer with the buyer's price.
 *
 * The pencil is there only where the venue can change a price and this listing is one it will
 * change (`repriceBlocked`); it stages the listing in the listing workspace rather than editing in
 * place, because that is where a figure is read through the venue's fees before anything is sent.
 * The trash asks before it delists. Clicking anywhere else makes the tile the inspector's subject.
 *
 * Steam takes one price change per listing every five minutes. While that runs the pencil's place
 * holds a clock and the time left (`TileReprice`), which stages the listing just the same, and the
 * pencil returns when the time is up; a busy tile shows its pill alone. A lower price waiting for
 * its confirmation takes the corner and the line a listing not yet on the market uses, with its own
 * words, because it is the opposite case: this listing is on sale, at the price it had.
 *
 * The footer is one line whatever it holds, and the tile's height is pinned to it here and in
 * `app.css` (`.tile[data-footer]`), so the countdown is sized to the buttons it stands among.
 */
export function ListingTiles({ load, onRows, subject, onSubject, onReprice, delisting, busyKeys, accounts, multiAccount, emptyTitle, emptyHint }: {
  load: (cursor?: string) => Promise<PageEnvelope<NamedListing>>;
  /** Every loaded row, each time the grid reads: a walk replaces the rows the inspector copied from. */
  onRows: (rows: NamedListing[]) => void;
  subject: NamedListing | null;
  onSubject: (row: NamedListing | null) => void;
  onReprice: (row: NamedListing) => void;
  delisting: Delisting;
  /** `accountId:localId` for every item some open command names. Its controls are withheld. */
  busyKeys: ReadonlySet<string>;
  accounts: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null }>;
  multiAccount: boolean;
  emptyTitle: string;
  emptyHint: string;
}): React.JSX.Element {
  const accountOf = (id: string): { name: string; photo: string | null | undefined } => {
    const account = accounts.find((entry) => entry.id === id);
    return { name: account?.name ?? id, photo: account?.avatarRef };
  };
  const subjectKey = subject ? listingKey(subject) : null;

  return <PagedGrid<NamedListing>
    load={load}
    onRows={onRows}
    rowKey={listingKey}
    tileHeight={LISTING_TILE_HEIGHT}
    tileMinWidth={LISTING_TILE_MIN_WIDTH}
    emptyTitle={emptyTitle}
    emptyHint={emptyHint}
    render={(row, index) => {
      const name = listingTitle(row);
      const focused = subjectKey === listingKey(row);
      const busy = itemIsBusy(busyKeys, row);
      const shown = listingState(row.venue, row.state);
      const phase = delisting.phase(row);
      const account = accountOf(row.accountId);
      // A waiting lower price, unless the listing is not on the market yet: that says so in this
      // corner and on this line, and outranks it (`repriceState` holds the order).
      const pending = pendingPriceChangeOf(row);
      return (
        <ItemTile
          name={name}
          imageUrl={row.imageUrl}
          rarity={row.rarity}
          selected={focused}
          focused={focused}
          tabbable={focused || (subject === null && index === 0)}
          busy={busy}
          unresolved={row.unresolved}
          onActivate={() => onSubject(focused ? null : row)}
          onDismiss={() => onSubject(null)}
          accessories={row.accessories}
          badges={<>
            {row.awaitingConfirmation === 1
              ? <TileBadge corner="lock" title="Waiting for you to confirm on your phone. Not on the market yet."><Icon name="smartphone" size={11} /></TileBadge>
              : pending ? <TileBadge corner="lock" title={pendingTitle(row, pending)}><Icon name={pending.confirmBy === 'email' ? 'mail' : 'smartphone'} size={11} /></TileBadge>
              : row.holdUntil ? <TileBadge corner="lock" title={`Held until ${formatDateTime(row.holdUntil)}`}><Icon name="clock" size={11} /></TileBadge> : null}
            {/* Larger than Inventory's: on this page the venue and the account are what tell two
                listings of one skin apart, and they are read before the price is. */}
            <TileBadge corner="where" size="lg" title={`Listed on ${VENUE_LABEL[row.venue]}`}><VenueMark venue={VENUE_ID[row.venue]} size={16} decorative /></TileBadge>
            {multiAccount ? <TileAccountBadge name={account.name} photo={account.photo} size="lg" /> : null}
            {extensions.listingBadges?.(row)}
          </>}
          // A state worth reading outranks the float on this line; the inspector has both.
          sub={pending
            ? <span className="tile-state" data-tone="accent">{pendingSubLine(pending.confirmBy)}</span>
            : shown.tone === 'positive' ? <TileWear paintWear={row.paintWear} /> : <span className="tile-state" data-tone={shown.tone}>{shown.label}</span>}
          footer={
            <div className="tile-foot">
              {phase === 'idle' ? <>
                <span
                  className="tile-price"
                  title={row.receiveCents === null ? 'Buyer pays' : `Buyer pays · you receive ${formatAmount(row.receiveCents, row.currency)}`}
                >
                  <Money cents={row.buyerPriceCents} currency={row.currency} />
                </span>
                {busy ? (
                  // The controls are withheld, and so is the countdown: the price keeps its width,
                  // and a change held for the cooldown counts down in the work panel.
                  <span className="tile-actions" data-busy="true">
                    <TileBusy />
                  </span>
                ) : (
                  <span className="tile-actions" onClick={stopTilePress} onDoubleClick={stopTilePress}>
                    <TileReprice row={row} name={name} onReprice={onReprice} />
                    {delistBlocked(row) === null ? <IconButton icon="trash" size="sm" label={`Delist ${name}`} onClick={() => delisting.ask(row)} /> : null}
                  </span>
                )}
              </> : <DelistPrompt phase={phase} name={name} onAnswer={(yes) => delisting.answer(row, yes)} />}
            </div>
          }
        />
      );
    }}
  />;
}
