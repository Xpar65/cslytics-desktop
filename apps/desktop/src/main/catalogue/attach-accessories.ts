import type { HoldingAccessories } from '@cslytics/engine';
import type { AppliedValue, NamedAccessory, NamedHoldingAccessories } from '../../shared/accessories.js';

/** As many holdings as one `inventory.accessories` read answers: the largest page there is. */
const READ_LIMIT = 250;

/** What a row gains: what is applied to its holding, and what that is estimated to add to it. */
export type AppliedRow = { accessories?: NamedAccessory[]; appliedValue?: AppliedValue | null };

/**
 * Each row of a page with the stickers, patches and charm applied to its holding, named and priced.
 *
 * A page is a tile grid, the rows of an opened group or the Listings tiles, and every one of them
 * draws the strip, so the strip comes with the page rather than one read per tile. The engine's
 * page stays what it was: this asks `inventory.accessories` once per account on the page, for the
 * local ids the page names, and `name` says what each slot is and what it sells for (the
 * catalogue's `nameAccessories`, then `priceAccessories`).
 *
 * A row with no holding, a listing this app never associated with one, is left as it was. So is
 * every row of an account whose read failed: an engine host from before the read refuses it, and
 * what is applied to an item is a detail of the item, never a reason to withhold the page. A row
 * that was read carries `accessories`, empty when nothing is applied, and `appliedValue`, `null`
 * when nothing on it has a price.
 */
export async function attachAccessories<T extends Record<string, unknown>>(
  rows: readonly T[],
  read: (accountId: string, localIds: string[]) => Promise<unknown>,
  name: (held: HoldingAccessories[]) => NamedHoldingAccessories[]
): Promise<Array<T & AppliedRow>> {
  const asked = new Map<string, Set<string>>();
  for (const row of rows) {
    const accountId = row['accountId'];
    const localId = row['localId'];
    if (typeof accountId !== 'string' || typeof localId !== 'string' || localId === '') continue;
    const ids = asked.get(accountId) ?? new Set<string>();
    ids.add(localId);
    asked.set(accountId, ids);
  }
  if (asked.size === 0) return [...rows];
  const found = new Map<string, Required<AppliedRow>>();
  await Promise.all([...asked].map(async ([accountId, ids]) => {
    const all = [...ids];
    for (let start = 0; start < all.length; start += READ_LIMIT) {
      try {
        const answer = await read(accountId, all.slice(start, start + READ_LIMIT));
        if (!Array.isArray(answer)) return;
        for (const held of name(answer as HoldingAccessories[])) {
          found.set(`${accountId}\u0000${held.localId}`, { accessories: held.accessories, appliedValue: held.appliedValue });
        }
      } catch {
        return;
      }
    }
  }));
  return rows.map((row) => {
    const applied = found.get(`${String(row['accountId'])}\u0000${String(row['localId'])}`);
    return applied === undefined ? row : { ...row, ...applied };
  });
}
