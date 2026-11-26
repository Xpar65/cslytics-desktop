import React from 'react';
import { Caption, IconButton } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { useNowUntil } from '../../lib/clock.js';
import { formatCountdown } from '../../lib/labels.js';
import { cooldownLine, cooldownTip, pendingTitle, repriceReadyAtOf, repriceState } from './reprice-state.js';
import type { NamedListing } from './listing-parts.js';

/**
 * The parts of the Listings page that count down to Steam's next price change on a listing.
 *
 * Each is a small component of its own that reads the clock (`useNowUntil`), so a countdown
 * re-renders itself once a second and not the grid or the inspector around it, and stops reading
 * the clock the moment it reaches zero. What each shows is `repriceState`'s to say.
 */

/**
 * The reprice control in a tile's footer.
 *
 * A pencil where the price can be changed now. While Steam's cooldown on the listing runs, a clock
 * and the time left in the pencil's place: it stages the listing exactly as the pencil does,
 * because a change sent inside the cooldown is held and goes when it ends. The pencil comes back
 * by itself when the countdown reaches zero.
 *
 * Only on a tile whose controls are offered. A busy tile, whose item open work names, shows its
 * pill and no countdown: the narrowest tile has no width for both beside a four-figure price, and
 * a change held for the cooldown is that work, whose countdown the work panel shows.
 */
export function TileReprice({ row, name, onReprice }: {
  row: NamedListing;
  name: string;
  onReprice: (row: NamedListing) => void;
}): React.JSX.Element | null {
  const now = useNowUntil(repriceReadyAtOf(row));
  const state = repriceState(row, now);
  if (state.kind === 'cooling-down') {
    return (
      <button type="button" className="btn btn-ghost btn-sm tile-cooldown" data-testid="tile-cooldown" aria-label={`Reprice ${name}`} title={cooldownTip(state.leftMs)} onClick={() => onReprice(row)}>
        <Icon name="clock" size={10} /><span className="num">{formatCountdown(state.leftMs)}</span>
      </button>
    );
  }
  return state.kind === 'ready' ? <IconButton icon="pencil" size="sm" label={`Reprice ${name}`} onClick={() => onReprice(row)} /> : null;
}

/**
 * What the inspector says about changing a listing's price: a lower price that is waiting for its
 * confirmation, or how long until Steam takes a change. Nothing for a listing that is ready, and
 * nothing for one not yet on the market (`repriceState` ranks it first), whose own confirmation is
 * said above this.
 */
export function RepriceNotes({ row }: { row: NamedListing }): React.JSX.Element | null {
  const now = useNowUntil(repriceReadyAtOf(row));
  const state = repriceState(row, now);
  if (state.kind === 'awaiting-confirmation') {
    return <Caption icon={state.confirmBy === 'email' ? 'mail' : 'smartphone'} tone="accent">{pendingTitle(row, state)}</Caption>;
  }
  if (state.kind === 'cooling-down') {
    return <Caption icon="clock"><span data-testid="reprice-cooldown" title={cooldownTip(state.leftMs)}>{cooldownLine(state.leftMs)}</span></Caption>;
  }
  return null;
}
