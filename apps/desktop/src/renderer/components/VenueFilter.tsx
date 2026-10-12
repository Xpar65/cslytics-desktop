import React from 'react';
import { Segmented } from './ui.js';
import { Icon } from './Icon.js';
import { VenueMark } from './VenueMark.js';
import type { VenueCode, VenueId, VenueOffer } from '../lib/marketplaces.js';

/**
 * A page's venue control: the venues the accounts in view trade on, and a plus for each one they
 * could.
 *
 * What is offered is `venueOffer`'s to decide; this only draws it. With two venues or more the
 * control is *All venues* and one tab each, as it always was. With one, there is nothing to choose
 * between, so it is that venue alone, standing for the whole book. Each venue no account in view
 * has set up follows as a plus with its mark, and opens that venue's page in Settings for the
 * account `venueOffer` named. The plus sits outside the tabs because it is not one: it changes
 * what the page shows only after a key is saved somewhere else.
 *
 * `onChange` hears a venue only while there is a choice. A page whose chosen venue stops being
 * offered resets itself to `''` (`useOfferedVenue`), so the single tab is always the selected one.
 */
export function VenueFilter({ offer, value, onChange, counts, onAdd, nameOf, multiAccount }: {
  offer: VenueOffer;
  value: '' | VenueCode;
  onChange: (next: '' | VenueCode) => void;
  counts: ReadonlyMap<VenueCode, number>;
  /** Opens one venue's page in Settings for one account. */
  onAdd: (accountId: string, venue: VenueId) => void;
  nameOf: (accountId: string) => string;
  multiAccount: boolean;
}): React.JSX.Element {
  const choice = offer.shown.length > 1;
  return (
    <div className="venue-filter">
      <Segmented
        label="Venue"
        value={choice ? value : ''}
        onChange={onChange}
        options={[
          ...(choice ? [{ id: '' as const, label: 'All venues' }] : []),
          ...offer.shown.map((market) => ({
            id: choice ? market.code : '' as const,
            label: market.label,
            icon: <VenueMark venue={market.id} size={14} decorative />,
            count: counts.get(market.code) ?? 0
          }))
        ]}
      />
      {offer.addable.map(({ market, accountId }) => (
        <button
          key={market.code}
          type="button"
          className="venue-add"
          aria-label={`Add ${market.label}`}
          title={multiAccount
            ? `Add ${market.label}. No account in view has it yet, so Settings opens on ${nameOf(accountId)}.`
            : `Add ${market.label} for ${nameOf(accountId)} in Settings`}
          data-testid={`venue-add-${market.id}`}
          onClick={() => onAdd(accountId, market.id)}
        >
          <Icon name="plus" size={14} />
          <VenueMark venue={market.id} size={14} decorative />
        </button>
      ))}
    </div>
  );
}

/**
 * A chosen venue the control no longer offers is no choice at all: back to the whole book, so the
 * rows on screen are never filtered by a tab that is not there.
 */
export function useOfferedVenue(offer: VenueOffer, value: '' | VenueCode, reset: () => void): void {
  const offered = offer.shown.length > 1 && offer.shown.some((market) => market.code === value);
  React.useEffect(() => {
    if (value && !offered) reset();
  }, [value, offered, reset]);
}
