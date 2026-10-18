import React, { useState } from 'react';
import { FilterBar } from '../../components/FilterBar.js';
import type { ChipKind, FilterChip } from '../../components/filter-grammar.js';
import { engine } from '../../lib/engine.js';
import { defaultVariant } from './variants.js';

/**
 * Inventory's search bar, as a launcher: the same chips, suggestions and keys, but picking a name
 * opens that item's page instead of narrowing a list, and the bar empties again.
 *
 * A suggestion is a base name and a page is one market name, so a pick asks main for the names the
 * item is sold under and opens the one the scope holds most of, or the first. Free text that no
 * suggestion claimed is answered by the catalogue's best match for it.
 */

const KINDS: ReadonlySet<ChipKind> = new Set<ChipKind>(['item', 'name']);

export function ItemSearch({ accountIds, onPick }: { accountIds: readonly string[]; onPick: (name: string) => void }): React.JSX.Element {
  const [missing, setMissing] = useState<string | null>(null);

  const open = async (chip: FilterChip): Promise<void> => {
    setMissing(null);
    let text = chip.text;
    if (chip.kind === 'name') {
      // Typed and not picked: the catalogue's best name for it, held ones first.
      const answer = await engine.suggestItems(chip.text, accountIds).catch(() => null);
      const top = answer?.items?.[0]?.name;
      if (!top) { setMissing(chip.text); return; }
      text = top;
    }
    const variants = await engine.itemVariants(text, accountIds).catch(() => null);
    onPick(variants ? defaultVariant(variants) : text);
  };

  return (
    <div className="items-search" data-testid="items-search">
      <FilterBar
        chips={[]}
        kinds={KINDS}
        itemsOnly
        holdingsOf={accountIds}
        label="Find an item"
        placeholder="Find an item: ak redline, karambit doppler, revolution case"
        onChange={(next) => {
          const chip = next[next.length - 1];
          if (chip) void open(chip);
        }}
      />
      {missing ? <div className="items-search-missing" role="status">No item called “{missing}”.</div> : null}
    </div>
  );
}
