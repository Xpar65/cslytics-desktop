import type { EngineDatabase } from '../../db/database.js';
import { ATTRIBUTE_CHARM_STICKER } from '../../kernel/attributes.js';
import { MAX_PAGE_SIZE, assertAccountScope, bounded } from './paging.js';

/** As many holdings as the largest page of inventory shows, so one page can be asked about in one read. */
export const ACCESSORY_READ_LIMIT = MAX_PAGE_SIZE;

/**
 * One thing an owner applied to a holding, as the last walk of it recorded (`item_accessory`).
 *
 * Keys and measurements only. The engine never names a kit: a sticker slot holds a sticker on a
 * weapon and a patch on an agent, and which one a kit id is, what it is called and what it looks
 * like are the host's to attach from its catalogue.
 */
export type AppliedAccessory = {
  /** The slot's kind, in the record's own words: a sticker slot holds a sticker or a patch. */
  kind: 'sticker-slot' | 'charm-slot';
  slot: number;
  kitId: number;
  /**
   * How scraped a sticker is, 0 to 1, or `null` when the Game Coordinator named no wear for the
   * slot. That is what it sends for a sticker nobody has scraped: it omits the attribute rather
   * than sending zero, so `null` is kept as observed and never filled in here.
   */
  wear: number | null;
  /** A charm's pattern, for a charm that has one. */
  pattern: number | null;
  /** The tournament highlight a souvenir charm plays. */
  highlight: number | null;
  /** The sticker sealed inside a sticker-slab charm, by its sticker kit id. */
  wrappedKitId: number | null;
};

export type HoldingAccessories = { localId: string; accessories: AppliedAccessory[] };

type Row = AppliedAccessory & { localId: string; wrapped: unknown };

/** Sticker slots in slot order, then the charm. */
function slotOrder(accessory: AppliedAccessory): number {
  return (accessory.kind === 'charm-slot' ? 1_000 : 0) + accessory.slot;
}

/**
 * What is applied to each of these holdings: its stickers or patches in slot order, then its charm.
 *
 * Answered for every holding asked about, in the order asked, with an empty list for one that
 * carries nothing. A holding of another account is not this account's to describe (rule 8), so it
 * answers empty too, as an id the record has never held does.
 *
 * The holdings arrive as one JSON value, so a page of them is one statement and never a list of
 * bound variables, and the join starts from them (`CROSS JOIN` holds SQLite to that order): each
 * holding is one seek of its slots, where the planner left alone walks every slot the account has.
 * A slab's sticker has no column of its own: it is read from the attributes the holding's row
 * keeps, where the walk that wrote the slot wrote it.
 */
export function readAccessories(database: EngineDatabase, request: { accountId: string; localIds: readonly string[] }): HoldingAccessories[] {
  const [accountId] = assertAccountScope(database, [request.accountId]);
  const ids = [...new Set(request.localIds)];
  if (ids.length > ACCESSORY_READ_LIMIT) throw new Error(`Ask about at most ${ACCESSORY_READ_LIMIT} items at once`);
  if (ids.length === 0) return [];
  const rows = database.raw().prepare(`SELECT a.local_id AS localId, a.kind AS kind, a.slot AS slot, a.kit_id AS kitId, a.wear AS wear,
      a.pattern AS pattern, a.highlight AS highlight,
      CASE WHEN a.kind='charm-slot' THEN json_extract(i.attributes_json, '$."${ATTRIBUTE_CHARM_STICKER}"') END AS wrapped
    FROM json_each(?) j CROSS JOIN item_accessory a ON a.account_id=? AND a.local_id=j.value
    JOIN item i ON i.account_id=a.account_id AND i.local_id=a.local_id`).all(JSON.stringify(ids), accountId!) as Row[];
  const byHolding = new Map<string, AppliedAccessory[]>();
  for (const { localId, wrapped, ...accessory } of rows) {
    const list = byHolding.get(localId) ?? [];
    list.push({ ...accessory, wrappedKitId: typeof wrapped === 'number' && Number.isSafeInteger(wrapped) ? wrapped : null });
    byHolding.set(localId, list);
  }
  for (const list of byHolding.values()) list.sort((left, right) => slotOrder(left) - slotOrder(right));
  return bounded(ids.map((localId) => ({ localId, accessories: byHolding.get(localId) ?? [] })));
}
