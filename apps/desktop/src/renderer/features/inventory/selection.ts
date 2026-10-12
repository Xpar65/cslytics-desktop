import type { InventoryPageRow, SelectionSnapshot } from '@cslytics/engine';

/**
 * What is selected, in one shape both views agree on.
 *
 * Selection stays at the handle level whichever view made it: a tile and a list row select the
 * same thing, so switching between Grouped and Tiles keeps the selection rather than quietly
 * dropping it. That is only true because this type lives outside both views.
 *
 * `manifest` is a **frozen** selection captured by the engine — "everything matching these
 * filters", resolved once, at a revision. It is not a superset of `rows` and not a cache of it:
 * when it is present it *is* the selection, and a later inventory change cannot silently add to
 * it. `selectionQuantity` reads it first for that reason.
 */
export type InventorySelection = { rows: Record<string, { row: InventoryPageRow; quantity: number }>; manifest?: SelectionSnapshot };

export const emptyInventorySelection = (): InventorySelection => ({ rows: {} });

export function selectionQuantity(selection: InventorySelection): number {
  return selection.manifest?.counts.quantity ?? Object.values(selection.rows).reduce((n, row) => n + row.quantity, 0);
}

/** The key a row is held under. Account-scoped, because two accounts can hold the same handle id. */
export function selectionKey(row: Pick<InventoryPageRow, 'accountId' | 'rowKey'>): string {
  return `${row.accountId}:${row.rowKey}`;
}

/** The rows themselves, or `[]` for a frozen selection — whose members only the engine holds. */
export function selectedRows(selection: InventorySelection): InventoryPageRow[] {
  return Object.values(selection.rows).map((entry) => entry.row);
}

/**
 * Add, replace or remove one row.
 *
 * Quantity 0 removes. A quantity outside `[0, row.quantity]` is refused rather than clamped: it
 * means the caller computed something wrong, and clamping would hide that behind a plausible
 * number.
 */
export function withRow(selection: InventorySelection, row: InventoryPageRow, quantity: number): InventorySelection {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > row.quantity) return selection;
  const rows = { ...selection.rows };
  const key = selectionKey(row);
  if (quantity) rows[key] = { row, quantity };
  else delete rows[key];
  return { rows };
}

/**
 * Tick these handles so they highlight. There is no frozen manifest: a later inventory change can
 * still add to what the filter would match.
 */
export function withPage(rows: readonly InventoryPageRow[]): InventorySelection {
  const next: InventorySelection['rows'] = {};
  for (const row of rows) next[selectionKey(row)] = { row, quantity: row.quantity };
  return { rows: next };
}

export function isSelected(selection: InventorySelection, row: Pick<InventoryPageRow, 'accountId' | 'rowKey'>): boolean {
  return (selection.rows[selectionKey(row)]?.quantity ?? 0) > 0;
}

/** How a tile was pressed. `toggle` is Ctrl, Cmd or the tile's own check; `range` is Shift. */
export type TilePress = { toggle: boolean; range: boolean };

/**
 * What one press on a tile does to the selection, answered the way a file manager answers it.
 *
 * A plain press selects that tile and nothing else. A toggle adds or removes it and keeps the
 * rest. A range selects from the anchor — the last tile pressed without Shift — to this one, in
 * place of the selection or, with a toggle, added to it; the anchor stays where it was, so a second
 * Shift press redraws the range from the same tile.
 *
 * `rows` is the order on screen. An anchor that is no longer in it — a new filter, a new sort —
 * leaves no range to mean, and the press is answered as though Shift were up.
 */
export function pressTile(
  selection: InventorySelection,
  rows: readonly InventoryPageRow[],
  row: InventoryPageRow,
  anchor: string | null,
  press: TilePress
): { selection: InventorySelection; anchor: string } {
  const key = selectionKey(row);
  const from = press.range && anchor !== null ? rows.findIndex((entry) => selectionKey(entry) === anchor) : -1;
  const to = rows.findIndex((entry) => selectionKey(entry) === key);
  if (from >= 0 && to >= 0) {
    const [low, high] = from <= to ? [from, to] : [to, from];
    let next: InventorySelection = press.toggle ? { rows: selection.rows } : emptyInventorySelection();
    for (const member of rows.slice(low, high + 1)) next = withRow(next, member, 1);
    return { selection: next, anchor: anchor! };
  }
  if (press.toggle) return { selection: withRow(selection, row, isSelected(selection, row) ? 0 : 1), anchor: key };
  return { selection: withRow(emptyInventorySelection(), row, 1), anchor: key };
}
