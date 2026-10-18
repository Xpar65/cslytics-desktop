import type { InventorySelection } from './selection.js';

/**
 * Building a command, in one place.
 *
 * This was the body of `InventoryView.submit`. The tile view and the inspector need exactly the
 * same thing, and a second copy of it is how a member comes to carry `sourceCasketId` on one
 * screen and not the other — which the engine would answer with "Item is not available in main
 * inventory" on a crated item that the other screen lists fine.
 *
 * Pure builder, one `invoke`. Nothing here decides *whether* an action is allowed: that is
 * `item-actions.ts`, and behind both of them the engine, which is the only real gate.
 */
export type CommandKind = 'STORE' | 'RETRIEVE' | 'TRANSFER' | 'LIST' | 'REPRICE' | 'DELIST_TO_STORE';

export type CommandOptions = {
  /** Chosen storage unit per account. Absent for an account means "no destination chosen". */
  destinations: Record<string, string>;
  /** Seller-receives cents, already parsed. `null` when the field does not hold a price. */
  priceCents: number | null;
  /**
   * Seller-receives cents for one row, by `accountId:rowKey`. A row named here overrides
   * `priceCents`, which is what lets the listing workspace price ten items ten ways in a single
   * command — the engine already takes a price per member, and one price for the batch was only
   * ever the inspector's simplification.
   *
   * A frozen selection ignores it: the engine holds those members and takes one price for all of
   * them, so there is no row here to name.
   */
  prices?: Readonly<Record<string, number>> | undefined;
  /**
   * What the person agreed to store despite, when the store pre-check named it: an item listed on
   * CSFloat, owed to a CSFloat buyer, or in a pending trade offer (bulk storage plan D9).
   */
  consent?: ReadonlyArray<'csfloat-listed' | 'csfloat-owed' | 'trade-pledged'> | undefined;
};

export type BuiltCommand = {
  type: 'command.submit';
  commandId: string;
  kind: CommandKind;
} & Record<string, unknown>;

/** Which kinds carry a price. `sellitem` cents are what the seller receives, never what a buyer pays. */
const PRICED: ReadonlySet<CommandKind> = new Set<CommandKind>(['LIST', 'REPRICE']);

export function buildCommand(kind: CommandKind, selection: InventorySelection, options: CommandOptions): BuiltCommand {
  const { destinations, priceCents, prices, consent } = options;
  const commandId = crypto.randomUUID();
  const members = Object.values(selection.rows).map(({ row, quantity }) => ({
    accountId: row.accountId,
    quantity,
    localId: row.localId,
    // A crated member names where it is, which is what lets `ListingPlanner` derive the
    // retrieve-then-list chain instead of refusing an item that is not in main inventory.
    ...(row.casketId ? { sourceCasketId: row.casketId } : {}),
    ...(destinations[row.accountId] ? { destinationCasketId: destinations[row.accountId]! } : {}),
    ...(PRICED.has(kind) ? { priceReceiveCents: prices?.[`${row.accountId}:${row.rowKey}`] ?? priceCents ?? 0 } : {})
  }));
  return {
    type: 'command.submit',
    commandId,
    kind,
    ...(consent?.length ? { consent } : {}),
    // A frozen selection travels as its token: the engine resolved those handles once, at a
    // revision, and re-deriving members here would hand it a different set under the same name.
    ...(selection.manifest
      ? { manifestToken: selection.manifest.token, manifestRevision: selection.manifest.revision, destinations, priceReceiveCents: priceCents ?? 0 }
      : { members })
  };
}

/** Build it and send it. The caller owns the message; this throws whatever the engine refused with. */
export async function submitCommand(kind: CommandKind, selection: InventorySelection, options: CommandOptions): Promise<void> {
  await window.trading.invoke(buildCommand(kind, selection, options));
}
