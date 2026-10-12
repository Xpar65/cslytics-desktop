import { locationLabel } from '../../lib/labels.js';
import { submitCommand } from './commands.js';
import { unavailableVenues, venuesFor, type ActionVerdict } from './item-actions.js';
import { selectionKey } from './selection.js';
import type { NamedItem } from './InventoryTiles.js';
import type { PricedEntry, StagedEntry, WorkspaceIntent } from '../../components/ListingWorkspace.js';

/** What a crated row says once CSFloat is its marketplace. */
export const CSFLOAT_FROM_STORAGE_CAPTION = 'Retrieved from storage first, then listed once CSFloat sees it in your inventory, which can take a few minutes. It needs one free inventory slot.';

/** A selected item as the inspector saw it when *List for sale* was chosen, with its own verdict. */
export type StagedItem = { row: NamedItem; verdict: ActionVerdict };

/** An item in the listing workspace: what its row prints, and the row the command is built from. */
export type StagedListItem = StagedEntry & { row: NamedItem };

/**
 * The workspace's entries for a selection.
 *
 * The venues are the ones each row's own verdict allows, never widened: a row Steam will take and
 * CSFloat will not is not a row to offer CSFloat on and refuse later.
 */
export function stageItems(staged: readonly StagedItem[]): StagedListItem[] {
  return staged.map(({ row, verdict }) => {
    const place = locationLabel(row.location);
    return {
      key: selectionKey(row),
      accountId: row.accountId,
      name: row.name,
      imageUrl: row.imageUrl,
      paintWear: row.paintWear ?? null,
      localId: row.localId,
      place: { icon: place.icon ?? 'package', label: place.label },
      ...(row.location === 'CASKET' ? {
        caption: { icon: 'download' as const, text: 'Retrieved from storage first, then listed. It needs one free inventory slot.' },
        // CSFloat reads its own copy of the inventory, which caught up about two minutes after a
        // retrieve on 2026-09-23 (fixtures/csfloat/INDEX.md). The engine waits up to ten.
        venueCaption: { csfloat: { icon: 'download' as const, text: CSFLOAT_FROM_STORAGE_CAPTION } }
      } : {}),
      venues: venuesFor(verdict),
      unavailable: unavailableVenues(verdict),
      row
    };
  });
}

/**
 * Listing: one command per venue, each atomic, each carrying a price per member.
 *
 * The engine rejects a batch whole, so the Steam rows go in one `command.submit` and the CSFloat
 * rows in one `csfloat.list`. What is sent is the figure the venue's list call takes — what the
 * seller receives for Steam (rule 4), what the buyer pays for CSFloat. Every member is one item by
 * its local id, a case as much as a skin.
 */
export const LIST_INTENT: WorkspaceIntent<StagedListItem> = {
  verb: 'List',
  noun: 'item',
  refused: 'the listing',
  batches(rows) {
    const at = (venue: 'steam' | 'csfloat'): Array<PricedEntry<StagedListItem>> => rows.filter((row) => row.venue === venue);
    const steam = at('steam');
    const csfloat = at('csfloat');
    return [
      ...(steam.length === 0 ? [] : [{
        venue: 'steam' as const,
        kind: 'LIST',
        keys: steam.map(({ entry }) => entry.key),
        send: () => submitCommand('LIST', { rows: Object.fromEntries(steam.map(({ entry }) => [entry.key, { row: entry.row, quantity: entry.row.quantity }])) }, {
          destinations: {},
          priceCents: null,
          prices: Object.fromEntries(steam.map(({ entry, cents }) => [entry.key, cents]))
        })
      }]),
      ...(csfloat.length === 0 ? [] : [{
        venue: 'csfloat' as const,
        kind: 'CSFLOAT_LIST',
        keys: csfloat.map(({ entry }) => entry.key),
        send: () => window.trading.invoke({
          type: 'csfloat.list',
          commandId: crypto.randomUUID(),
          members: csfloat.map(({ entry, cents }) => ({ accountId: entry.row.accountId, localId: entry.row.localId, priceCents: cents }))
        })
      }])
    ];
  }
};
