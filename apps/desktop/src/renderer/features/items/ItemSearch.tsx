import React, { useState } from 'react';
import { browseRows, FilterBar } from '../../components/FilterBar.js';
import { addChip, ITEM_BROWSE_CHIP_KINDS, type FilterChip } from '../../components/filter-grammar.js';
import { engine } from '../../lib/engine.js';
import { marketNameOf } from './variants.js';

/**
 * Inventory's search bar, over the catalogue instead of over holdings: the same suggestions and
 * keys, and two things a pick can do.
 *
 * A pick that names one item opens that item's page, and the bar keeps nothing of it. A suggestion
 * is a base name and a page is one market name, so main is asked for the names the item is sold
 * under and the one the scope holds most of is opened, or the first.
 *
 * A pick that names many items (a weapon, a type, a collection, a grade) stays in the bar as a
 * chip, and the chips are what the grid under the bar shows. They narrow together as they do on
 * every other page: AWP beside Covert is the covert AWPs.
 *
 * Text typed and entered before any suggestion arrived is answered the way the list would have
 * been: by the first row the catalogue gives for it, a name that stands for many before an item.
 */

export function ItemSearch({ accountIds, chips, onChips, onPick }: {
  accountIds: readonly string[];
  /** The chips the grid is showing; none on an item's page, where the bar only launches. */
  chips: readonly FilterChip[];
  onChips: (next: FilterChip[]) => void;
  onPick: (name: string) => void;
}): React.JSX.Element {
  const [missing, setMissing] = useState<string | null>(null);

  const change = async (next: FilterChip[]): Promise<void> => {
    setMissing(null);
    const kept = next.filter((chip) => chip.kind !== 'item' && chip.kind !== 'name');
    const picked = next.find((chip) => chip.kind === 'item' || chip.kind === 'name');
    if (!picked) { onChips(kept); return; }
    if (picked.kind === 'item') { onPick(await marketNameOf(picked.text, accountIds)); return; }
    // Typed and not picked: what the list's first row would have been.
    const answer = await engine.suggestBrowse(picked.text, accountIds).catch(() => null);
    const first = browseRows(answer)[0]?.chip;
    if (!first) setMissing(picked.text);
    else if (first.kind === 'item') onPick(await marketNameOf(first.text, accountIds));
    else onChips(addChip(kept, first));
  };

  return (
    <div className="items-search" data-testid="items-search">
      <FilterBar
        chips={chips}
        kinds={ITEM_BROWSE_CHIP_KINDS}
        browse
        holdingsOf={accountIds}
        label="Find an item"
        placeholder="Find an item, or browse: ak redline, awp, pistol, huntsman collection"
        onChange={(next) => { void change(next); }}
      />
      {missing ? <div className="items-search-missing" role="status">No item called “{missing}”.</div> : null}
    </div>
  );
}
