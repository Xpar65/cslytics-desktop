import React from 'react';
import { Select } from './ui.js';
import { Icon } from './Icon.js';

export type SortDirection = 'asc' | 'desc';

/** One order a list offers, and what each direction means for it in words, for the arrow's label. */
export type SortOption<T extends string> = { id: T; label: string; asc: string; desc: string };

/**
 * What a list is sorted by, and an arrow that points the way it runs.
 *
 * Drawn as one control so the two stay together when a toolbar wraps and read as one question.
 * Listings and both Inventory views use it. A list with a single order still shows that order, as
 * a plain label rather than a dropdown with one choice in it, so every list says what it is
 * ordered by and the arrow is always in the same place.
 */
export function SortControl<T extends string>({ label, options, value, direction, onSort, onDirection }: {
  /** The dropdown's accessible name, such as "Sort listings by". */
  label: string;
  options: ReadonlyArray<SortOption<T>>;
  value: T;
  direction: SortDirection;
  onSort?: ((next: T) => void) | undefined;
  onDirection: (next: SortDirection) => void;
}): React.JSX.Element {
  const current = options.find((option) => option.id === value) ?? options[0]!;
  return (
    <div className="sort-control" role="group" aria-label="Sort">
      <Icon name="sort" size={15} className="sort-control-icon" />
      {options.length > 1 && onSort ? (
        <Select label={label} value={current.id} onChange={(next) => onSort(next as T)}>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      ) : <span className="sort-control-label" title={label}>{current.label}</span>}
      <button
        type="button"
        className="sort-direction"
        aria-label={direction === 'asc' ? `Ascending, ${current.asc}. Switch to descending` : `Descending, ${current.desc}. Switch to ascending`}
        title={`${current.label}, ${direction === 'asc' ? current.asc : current.desc}`}
        onClick={() => onDirection(direction === 'asc' ? 'desc' : 'asc')}
      >
        <Icon name={direction === 'asc' ? 'arrow-up' : 'arrow-down'} size={15} />
      </button>
    </div>
  );
}
