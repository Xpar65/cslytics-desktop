import type { StoragePageRow } from '@cslytics/engine';
import type { RenameStorageUnitResult } from '../../lib/engine.js';

/** A storage unit holds at most this many items; the Game Coordinator refuses the thousand-and-first. */
export const UNIT_CAPACITY = 1000;

/** The def index every storage unit has. */
const STORAGE_UNIT_DEF_INDEX = 1201;

/** Whether an inventory row or group is a storage unit, whether or not its unit has been read. */
export function isStorageUnit(row: { defIndex?: number | undefined }): boolean {
  return row.defIndex === STORAGE_UNIT_DEF_INDEX;
}

/**
 * The storage unit an inventory row *is*, when it is one.
 *
 * Matched by the unit's own local id, which the storage read carries beside its casket id. A unit
 * the inventory has not seen yet has no local id, and a row is never matched to a unit by name.
 */
export function unitOfItem(
  row: { accountId: string; localId: string; defIndex: number },
  units: readonly StoragePageRow[]
): StoragePageRow | null {
  if (!isStorageUnit(row)) return null;
  return units.find((unit) => unit.accountId === row.accountId && unit.localId === row.localId) ?? null;
}

/** A unit's own name. One never named in the game has none, and says so. */
export function unitName(unit: StoragePageRow): string {
  return unit.label ?? 'Unnamed unit';
}

/**
 * What an item is called on screen: a storage unit by its own name, anything else by its
 * catalogue name. Every unit's catalogue name is the same "Storage Unit", which tells two of them
 * apart no better than a blank would. Until its unit has been read, a unit keeps the catalogue name.
 */
export function itemName(
  row: { accountId: string; localId: string; defIndex: number; name: string },
  units: readonly StoragePageRow[]
): string {
  const unit = unitOfItem(row, units);
  return unit ? unitName(unit) : row.name;
}

/** The grouped view's row for every unit an account holds: one is a unit, several are units. */
export function unitGroupName(quantity: number): string {
  return quantity === 1 ? 'Storage Unit' : 'Storage Units';
}

/**
 * How full a unit is, by the count the unit itself reports.
 *
 * That count is what the Game Coordinator will refuse against, so it is the one capacity is read
 * from — not how many items this app has observed inside.
 */
export function unitFill(reportedCount: number): { used: number; free: number; full: boolean } {
  const used = Math.max(0, reportedCount);
  return { used, free: Math.max(0, UNIT_CAPACITY - used), full: used >= UNIT_CAPACITY };
}

/** What a settled rename says. The label it names is always the observed one (rule 1). */
export function describeRename(result: RenameStorageUnitResult, requested: string): { tone: 'positive' | 'warn' | 'quiet'; text: string } {
  if (result.state === 'DONE') return { tone: 'positive', text: `Steam shows “${result.label ?? ''}”` };
  if (result.outcome === 'DEFINITIVELY_REJECTED') return { tone: 'warn', text: 'Steam refused the rename' };
  return { tone: 'quiet', text: `Asked for “${requested}”; waiting for Steam to show it` };
}
