import { randomUUID } from 'node:crypto';
import type { RawEconItem } from '@cslytics/ports';
import type { CommodityStackRow, EngineDatabase, ItemAccessoryRow, ItemLineageRow, ItemRow } from './database.js';
import { groupKey, isIndividualItem, kitToken, stableItemKey, tradeProtectedUntil } from '../kernel/identity.js';
import { accessorySlots, encodeAttributes } from '../kernel/attributes.js';

/**
 * The holdings write path (holdings plan D1–D6): one `item` row per unit the Game Coordinator
 * shows, of either kind, found by asset id and by nothing else.
 *
 * A store over the one writer, like `CsfloatStore` and `TransferStore`, rather than more methods
 * on `EngineDatabase`: every SQL statement that decides what a unit row is lives here, so the
 * next change to the table is one file. `EngineDatabase` keeps the row lookups every surface
 * shares (`itemByLocalId`, `itemByAssetId`, `setItemLocation`) and the staging that wraps a walk.
 */
export class HoldingsStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * One unit as a walk or an event showed it. A row's asset id never changes, so a new id is a
   * new row. What the tuple rebind used to do — bind a returning skin to the row that last held
   * it — is now a lineage link, written when exactly one ended row carries the same fingerprint,
   * and only for a kind whose fingerprint is per-unit. The link may suggest; it never moves a row.
   *
   * `keyOf` is the group key seam a saboteur overrides; production passes nothing.
   */
  upsertUnit(accountId: string, item: RawEconItem, observationId: number, location: ItemRow['location'], casketId: string | null, keyOf: (item: RawEconItem) => string = groupKey): string {
    const sqlite = this.db.raw();
    const observation = this.db.observation(accountId, observationId)!;
    const existing = this.db.itemByAssetId(accountId, item.id);
    const localId = existing?.local_id ?? randomUUID();
    if (existing && !this.db.canUpdateLocation(existing, observation)) return localId;
    const individual = isIndividualItem(item);
    const fingerprint = stableItemKey(item);
    sqlite.prepare(`
      INSERT INTO item(local_id, account_id, def_index, paint_index, paint_wear, paint_seed, quality,
                       kit, stable_key, current_asset_id, location, casket_id, tradable_after,
                       trade_protected_until, first_seen_obs, last_seen_obs, location_obs, location_generation,
                       row_generation, unit_kind, group_key, quantity, reserved_command, attributes_json, end_reason)
      VALUES (@localId, @accountId, @defIndex, @paintIndex, @paintWear, @paintSeed, @quality,
              @kit, @stableKey, @assetId, @location, @casketId, @tradableAfter,
              @tradeProtectedUntil, @firstSeen, @lastSeen, @lastSeen, @generation,
              @rowGeneration, @unitKind, @groupKey, @quantity, NULL, @attributes, NULL)
      ON CONFLICT(local_id) DO UPDATE SET
        -- Re-derived on every pass. An item that gains or loses an identity-bearing attribute is
        -- a different market item and must stop matching the old one; one that gains a sticker
        -- is the same market item in a different group.
        kit=excluded.kit,
        group_key=excluded.group_key,
        quantity=excluded.quantity,
        attributes_json=excluded.attributes_json,
        location=excluded.location,
        casket_id=excluded.casket_id,
        tradable_after=excluded.tradable_after,
        trade_protected_until=excluded.trade_protected_until,
        last_seen_obs=excluded.last_seen_obs,
        location_obs=excluded.location_obs,
        location_generation=COALESCE(excluded.location_generation, item.location_generation),
        row_generation=excluded.row_generation,
        end_reason=NULL
    `).run({
      localId,
      accountId,
      defIndex: item.defIndex,
      paintIndex: item.paintIndex ?? null,
      paintWear: item.paintWear ?? null,
      paintSeed: item.paintSeed ?? null,
      quality: item.quality,
      kit: kitToken(item),
      stableKey: fingerprint,
      assetId: item.id,
      location,
      casketId: location === 'CASKET' ? casketId : null,
      tradableAfter: item.tradableAfter ?? null,
      tradeProtectedUntil: tradeProtectedUntil(item),
      firstSeen: existing?.first_seen_obs ?? observationId,
      lastSeen: observationId,
      generation: observation.generation,
      rowGeneration: this.db.activeRowGeneration(accountId, location === 'CASKET' ? 'gc-casket' : 'gc-inventory', location === 'CASKET' ? casketId ?? '' : '', observation.generation),
      unitKind: individual ? 'individual' : 'fungible',
      groupKey: keyOf(item),
      quantity: item.quantity ?? 1,
      attributes: JSON.stringify(encodeAttributes(item))
    });
    if (!existing) {
      if (individual) this.linkFingerprint(accountId, localId, fingerprint, item.id, observationId, observation.finished_at);
      const given = sqlite.prepare(`SELECT DISTINCT asset_id FROM trade_line WHERE new_asset_id=?`).all(item.id) as Array<{ asset_id: string }>;
      for (const line of given) this.linkReceipt(accountId, localId, line.asset_id, observationId, observation.finished_at);
    }
    this.replaceAccessories(accountId, localId, item, observationId);
    return localId;
  }

  /**
   * Every unit of one scope as a walk saw it, then — when the walk was complete — every row of
   * that scope the walk did not see marked `MISSING`. One function for main inventory and for a
   * casket, for skins and for cases: the split that used to live here is what let the two kinds
   * drift apart.
   */
  replaceUnits(accountId: string, location: ItemRow['location'], casketId: string | null, items: readonly RawEconItem[], observationId: number, sweepUnseen: boolean, keyOf?: (item: RawEconItem) => string): void {
    for (const item of items) this.upsertUnit(accountId, item, observationId, location, casketId, keyOf);
    if (sweepUnseen) this.sweepUnseen(accountId, location, casketId, observationId);
  }

  /**
   * Rows of one scope the observation did not see. Only a complete walk may call this (rule 5).
   * A row a trade receipt already links onward ended by that trade, whichever was read first.
   */
  sweepUnseen(accountId: string, location: ItemRow['location'], casketId: string | null, observationId: number): void {
    const stale = this.db.raw().prepare(`
      SELECT local_id FROM item WHERE account_id=? AND location=? AND IFNULL(casket_id,'')=? AND last_seen_obs<>?
    `).all(accountId, location, location === 'CASKET' ? casketId ?? '' : '', observationId) as Array<{ local_id: string }>;
    const traded = this.db.raw().prepare(`SELECT 1 FROM item_lineage WHERE from_local_id=? AND evidence='trade-receipt' LIMIT 1`);
    for (const row of stale) {
      this.db.setItemLocation(accountId, row.local_id, observationId, 'MISSING', location === 'CASKET' ? casketId : null);
      if (traded.get(row.local_id)) this.db.setEndReason(accountId, row.local_id, 'traded');
    }
  }

  /**
   * A fingerprint link for a new individual row: the one ended row on this account with the
   * same tuple, if there is exactly one. Several candidates mean nothing can be said, and saying
   * so is an event rather than a guess (`N-QTY-04`).
   */
  private linkFingerprint(accountId: string, localId: string, fingerprint: string, assetId: string, observationId: number, at: string): void {
    const candidates = this.db.raw().prepare(`
      SELECT local_id FROM item WHERE account_id=? AND stable_key=? AND location='MISSING' AND local_id<>?
    `).all(accountId, fingerprint, localId) as Array<{ local_id: string }>;
    if (candidates.length === 1) this.insertLineage(accountId, candidates[0]!.local_id, localId, 'fingerprint', observationId, at);
    else if (candidates.length > 1) {
      this.db.addEvent(accountId, 'ambiguous-fingerprint', {
        assetId, localId, stableKey: fingerprint, candidateLocalIds: candidates.map((candidate) => candidate.local_id)
      }, at);
    }
  }

  /**
   * A trade line naming `newAssetId` as what `assetId` became, read after the receiving row was
   * already written: the insert found no line to link from, so the line links now. Whichever of
   * the two the engine records second writes the link.
   */
  linkTradeLine(assetId: string, newAssetId: string, observationId: number, at: string): void {
    const received = this.db.raw().prepare(`SELECT account_id, local_id FROM item WHERE current_asset_id=?`).all(newAssetId) as Array<{ account_id: string; local_id: string }>;
    for (const row of received) this.linkReceipt(row.account_id, row.local_id, assetId, observationId, at);
  }

  /**
   * A receipt link into one row from the holding a trade line says it was. Asset ids are unique
   * across Steam, so the giver's row is found on whichever owned account gave it; an ended giver
   * row is explained as traded, and one still live is explained when its sweep ends it.
   */
  private linkReceipt(accountId: string, localId: string, givenAssetId: string, observationId: number, at: string): void {
    const sqlite = this.db.raw();
    const from = sqlite.prepare(`SELECT account_id, local_id FROM item WHERE current_asset_id=? AND local_id<>?`).get(givenAssetId, localId) as { account_id: string; local_id: string } | undefined;
    if (!from) return;
    this.insertLineage(accountId, from.local_id, localId, 'trade-receipt', observationId, at);
    this.db.setEndReason(from.account_id, from.local_id, 'traded');
  }

  insertLineage(accountId: string, fromLocalId: string, toLocalId: string, evidence: ItemLineageRow['evidence'], observationId: number, at: string): void {
    this.db.raw().prepare(`
      INSERT OR IGNORE INTO item_lineage(account_id, from_local_id, to_local_id, evidence, observation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(accountId, fromLocalId, toLocalId, evidence, observationId, at);
  }

  lineage(accountId: string, localId: string): ItemLineageRow[] {
    return this.db.raw().prepare(`SELECT * FROM item_lineage WHERE account_id=? AND (from_local_id=? OR to_local_id=?) ORDER BY created_at, from_local_id`)
      .all(accountId, localId, localId) as ItemLineageRow[];
  }

  private replaceAccessories(accountId: string, localId: string, item: RawEconItem, observationId: number): void {
    const sqlite = this.db.raw();
    sqlite.prepare(`DELETE FROM item_accessory WHERE account_id=? AND local_id=?`).run(accountId, localId);
    const insert = sqlite.prepare(`
      INSERT INTO item_accessory(account_id, local_id, kind, slot, kit_id, wear, scale, rotation, pattern, highlight, observation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const slot of accessorySlots(item)) {
      insert.run(accountId, localId, slot.kind, slot.slot, slot.kitId, slot.wear, slot.scale, slot.rotation, slot.pattern, slot.highlight, observationId);
    }
  }

  accessories(accountId: string, localId: string): ItemAccessoryRow[] {
    return this.db.raw().prepare(`SELECT * FROM item_accessory WHERE account_id=? AND local_id=? ORDER BY kind, slot`).all(accountId, localId) as ItemAccessoryRow[];
  }

  /**
   * A stack, as a read: the fungible units of one group at one location, summed. Nothing stores
   * this any more (holdings plan D2), so a count cannot drift from the rows behind it.
   */
  commodityStacks(accountId: string): CommodityStackRow[] {
    // The staging swap applies; the published-generation predicate does not, as it never did to
    // the stack table. A listed unit is in its MAIN stack: listing is not a place (`db/steam-listing.ts`).
    return this.db.raw().prepare(`
      SELECT account_id, group_key AS stack_key, location, IFNULL(casket_id,'') AS casket_id,
        MIN(def_index) AS def_index, MIN(quality) AS quality, MIN(kit) AS kit,
        SUM(quantity) AS quantity, MAX(last_seen_obs) AS last_seen_obs
      FROM ${this.db.inventoryReadTable('item', accountId)}
      WHERE account_id=? AND unit_kind='fungible' AND location<>'MISSING'
      GROUP BY group_key, location, IFNULL(casket_id,'')
      ORDER BY stack_key, location, casket_id
    `).all(accountId) as CommodityStackRow[];
  }

  /** Units a storage unit holds as this record knows them, counted by quantity. */
  casketQuantity(accountId: string, casketId: string): number {
    return (this.db.raw().prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS n FROM item WHERE account_id=? AND location='CASKET' AND casket_id=?
    `).get(accountId, casketId) as { n: number }).n;
  }

  /** The units of one group, of either kind; without a group, every fungible unit. Ordered by asset id. */
  units(accountId: string, groupKey?: string): ItemRow[] {
    if (groupKey) {
      return this.db.raw().prepare(`SELECT * FROM item WHERE account_id=? AND group_key=? ORDER BY current_asset_id`).all(accountId, groupKey) as ItemRow[];
    }
    return this.db.raw().prepare(`SELECT * FROM item WHERE account_id=? AND unit_kind='fungible' ORDER BY current_asset_id`).all(accountId) as ItemRow[];
  }

  /**
   * Reserves `quantity` unreserved units of one group at one location for a command, or none.
   * Three of ten means three (ITEM-07); a unit already on the market, or otherwise excluded, is
   * not the group's to hand out.
   */
  allocateUnits(accountId: string, groupKey: string, location: ItemRow['location'], casketId: string | null, quantity: number, commandId: string, exclude?: ReadonlySet<string>): ItemRow[] {
    const sqlite = this.db.raw();
    const available = sqlite.prepare(`
      SELECT * FROM item
      WHERE account_id=? AND group_key=? AND location=? AND IFNULL(casket_id,'')=? AND reserved_command IS NULL AND current_asset_id IS NOT NULL
      ORDER BY current_asset_id
    `).all(accountId, groupKey, location, casketId ?? '') as ItemRow[];
    let remaining = quantity;
    const chosen: ItemRow[] = [];
    const reserve = sqlite.prepare(`UPDATE item SET reserved_command=? WHERE local_id=? AND reserved_command IS NULL`);
    for (const unit of available) {
      if (remaining <= 0) break;
      if (unit.quantity > remaining || exclude?.has(unit.current_asset_id!)) continue;
      const updated = reserve.run(commandId, unit.local_id);
      if (updated.changes !== 1) continue;
      chosen.push({ ...unit, reserved_command: commandId });
      remaining -= unit.quantity;
    }
    if (remaining > 0) {
      for (const unit of chosen) sqlite.prepare(`UPDATE item SET reserved_command=NULL WHERE local_id=?`).run(unit.local_id);
      throw new Error(`Not enough unreserved quantity on ${groupKey} (need ${quantity})`);
    }
    return chosen;
  }

  /** A stopped command hands back the one unit its action targeted. */
  releaseUnit(accountId: string, localId: string, commandId: string): void {
    this.db.raw().prepare(`UPDATE item SET reserved_command=NULL WHERE account_id=? AND local_id=? AND reserved_command=?`).run(accountId, localId, commandId);
  }

  releaseCommandReservations(commandId: string): void {
    this.db.raw().prepare(`UPDATE item SET reserved_command=NULL WHERE reserved_command=?`).run(commandId);
    this.db.raw().prepare(`UPDATE reservation SET state='RELEASED' WHERE ref_kind='MAIN_SLOT' AND ref_id IN (SELECT action_id FROM command_member WHERE command_id=? AND action_id IS NOT NULL)`).run(commandId);
  }

  /**
   * A unit stays reserved for its command until its listing is settled either way — seen on the
   * market, or refused for good — and only then may the group hand it out again.
   */
  releaseSettledListingReservations(accountId: string): void {
    this.db.raw().prepare(`UPDATE item SET reserved_command=NULL WHERE account_id=? AND reserved_command IS NOT NULL AND EXISTS (
      SELECT 1 FROM action a JOIN command_member m ON m.action_id=a.id
      WHERE a.account_id=item.account_id AND a.kind='CREATE_SELL_LISTING' AND a.target_id=item.local_id
        AND a.state IN ('DONE','FAILED') AND m.command_id=item.reserved_command)`).run(accountId);
  }
}
