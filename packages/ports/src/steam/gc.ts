import type { AccountId, AssetId, MutationOutcome } from '../kernel.js';

/**
 * The CS2 Game Coordinator: inventory, storage units, crates, terminals, and the item events
 * that follow.
 *
 * Raw econ items are passed through uninterpreted. What an attribute *means*, and whether a read
 * is complete enough to conclude anything, are the engine's decisions rather than the port's.
 */
/**
 * How an attribute's `value_bytes` are stored, per Valve's `items_game.txt` `stored_as_integer`.
 * `floored-float` is a float32 that names an integer (paint index and seed); `string` is UTF-8
 * after a two-byte prefix (a custom name); `vector` is three float32s.
 */
export type EconAttributeKind = 'uint32' | 'float' | 'floored-float' | 'string' | 'vector';

/**
 * One econ attribute as the Game Coordinator sent it, plus what the adapter could make of it.
 *
 * The GC fills `valueBytes` and leaves `value` null. An adapter that knows the schema sets `kind`
 * and the decoded `value`; an attribute the schema does not name arrives with bytes only, and the
 * engine keeps those bytes rather than dropping the row. A test double may set `value` directly.
 */
export type RawEconAttribute = {
  defIndex: number;
  valueBytes?: Uint8Array;
  value?: number | string | null;
  kind?: EconAttributeKind;
};

export type RawEconItem = {
  id: AssetId;
  defIndex: number;
  quality: number;
  quantity?: number;
  paintIndex?: number;
  paintWear?: number;
  paintSeed?: number;
  rarity?: number;
  tradableAfter?: string;
  /**
   * The container this item sits inside, or null when loose. A storage unit is the usual
   * owner, but an *activated terminal* also parents its current offer this way: the offer
   * arrives as an SO item whose casket attributes point at the terminal
   * (`cslytics-app-docs/steam/crates-and-terminals.md`). A reader that treats every parent as
   * a storage unit will count an unbought offer as owned.
   */
  casketId?: AssetId | null;
  casketContainsCount?: number;
  customName?: string | null;
  /** Attribute 183, as ISO time. An activated terminal carries it; a sealed one does not. */
  expiresAt?: string;
  /**
   * Attribute 169, raw. On an activated terminal this is how many offers remain; the GC uses
   * `4294967291` (`0xFFFFFFFB`) to mean the final offer rather than zero. Left uninterpreted.
   */
  pointsRemaining?: number;
  /**
   * Attribute 316, raw. Carried by a terminal's offer item: what the GC store would charge for
   * it, in the store's base units. The unit is unverified against a live wallet, so nothing
   * downstream may render it as money until a probe pins it (`[P]`).
   */
  purchasePrice?: number;
  attributes?: RawEconAttribute[];
  /**
   * Valve `CEconItem` flags, when the Game Coordinator sent them. Bit 3 (`8`) is
   * NonEconomy: the object is not in the Steam inventory and cannot be traded.
   * Documented in `cslytics-app-docs/steam/gc-inventory.md`.
   */
  flags?: number;
  /** Valve origin enum, when sent. The generated stock objects arrive as `8` (FoundInCrate). */
  origin?: number;
};

export type GcEvent =
  | { kind: 'added'; item: RawEconItem; generation: number }
  | { kind: 'updated'; previousItem: RawEconItem; item: RawEconItem; generation: number }
  | { kind: 'removed'; itemId: AssetId; generation: number }
  | { kind: 'disconnected'; reason: string; generation: number };

export type StorageUnit = {
  casketId: AssetId;
  label: string | null;
  containsCount: number;
  generation: number;
};

export type CasketRead = {
  casketId: AssetId;
  items: RawEconItem[];
  containsCount: number;
  countGeneration: number;
  itemsGeneration: number;
  completeness: 'complete' | 'incomplete' | 'stale-count';
  /**
   * What the read cost. `cache` answered from the session's object cache and sent the Game
   * Coordinator nothing; `wire` sent `CasketItemLoadContents`, which the GC answers with every
   * child as an object create. The engine budgets the second and not the first.
   */
  transport: 'cache' | 'wire';
};

/**
 * One terminal as the GC currently describes it, plus the offer it is presenting.
 *
 * `SEALED` has never been activated. `ACTIVE` carries an expiry and a points counter; its
 * offer is the single item parented to it, or null when no offer has been loaded yet — a
 * terminal is activated empty and is primed by the first `advanceTerminalOffer`.
 *
 * `completeness` says where the offer came from. `loaded` means the GC answered this read
 * with a `CasketContents` notification for this terminal; `cached` means the adapter found
 * an offer already in its SO cache and asked Steam nothing. Both are legitimate; only the
 * caller knows whether a cached answer is fresh enough for what it is about to do.
 */
export type TerminalRead = {
  terminalId: AssetId;
  state: 'SEALED' | 'ACTIVE';
  offer: RawEconItem | null;
  pointsRemaining: number | null;
  expiresAt: string | null;
  generation: number;
  completeness: 'loaded' | 'cached';
};

/**
 * Whether the CS2 Game Coordinator is reachable for one account, and why not when it is not.
 *
 * A GC session is *exclusive per account*: Steam lets exactly one client at a time be the one
 * playing CS2. Another machine signed into the same account therefore takes the session away,
 * and this app sees a connect that never completes. That is not a network fault and no amount
 * of retrying fixes it while the other client is still playing, so it gets its own state —
 * the only useful thing to tell the user is *which* problem they have.
 *
 * `DISCONNECTED` is the ordinary case a retry does fix: never connected, or dropped.
 */
export type GcConnectionState = 'DISCONNECTED' | 'CONNECTED' | 'BLOCKED_ELSEWHERE';

export type GcStatus = {
  state: GcConnectionState;
  /** The generation the live session is on; null when there is no session to speak of. */
  generation: number | null;
  /** The last thing observed about this state — a disconnect reason, or what is playing. */
  detail: string | null;
  observedAt: string | null;
};

export interface SteamGcPort {
  connect(accountId: AccountId, timeoutMs: number): Promise<{ connected: true; generation: number }>;
  /**
   * Local state, never a network call. Callers poll this to decide whether to reconnect, so it
   * must be cheap and must never itself be the thing that keeps a dead session looking alive.
   *
   * Not `status`: an implementation is free to serve several of these ports, and `SteamAuthPort`
   * already owns that name for a different question with a different shape.
   */
  connectionStatus(accountId: AccountId): GcStatus;
  getInventorySnapshot(accountId: AccountId): Promise<{ items: RawEconItem[]; generation: number }>;
  events(accountId: AccountId): AsyncIterable<GcEvent>;
  /**
   * Every event the queue holds now, in order, without waiting for one. The engine's event loop
   * takes them with the event it was woken by and applies the batch in one turn, so a unit's
   * contents load, which the GC answers with every child as an object create, is one settle and
   * not one per child.
   */
  drainEvents(accountId: AccountId): GcEvent[];
  listStorageUnits(accountId: AccountId): Promise<StorageUnit[]>;
  getCasketContents(accountId: AccountId, casketId: AssetId): Promise<CasketRead>;
  addToCasket(accountId: AccountId, casketId: AssetId, itemId: AssetId): Promise<MutationOutcome>;
  removeFromCasket(accountId: AccountId, casketId: AssetId, itemId: AssetId): Promise<MutationOutcome>;

  // --- Crates and terminals ----------------------------------------------------------------
  //
  // All four ride one GC message family (`OpenCrate`, `VolatileItemLoadContents`) and answer
  // through `ItemCustomizationNotification`. The evidence and its grades are in
  // `cslytics-app-docs/steam/crates-and-terminals.md`; none of these has a live capture yet.

  /**
   * Opens `crateId` with `keyId`. Both are consumed and one new item is created — an action
   * that cannot be undone and cannot be retried safely, because a lost response leaves the
   * crate already gone. `SUBMITTED` carries the notified item ids in `raw`; the new item is
   * *proven* only by a later inventory observation or SO event, never by this return.
   */
  openCrate(accountId: AccountId, crateId: AssetId, keyId: AssetId): Promise<MutationOutcome>;
  /**
   * Activates a sealed terminal: the same message as `openCrate` with no key. The terminal
   * keeps its asset id and gains an expiry and a points counter; its first offer is not
   * loaded until `advanceTerminalOffer` runs. Starts a real-time expiry clock, so it is a
   * mutation even though nothing is spent.
   */
  activateTerminal(accountId: AccountId, terminalId: AssetId): Promise<MutationOutcome>;
  /** Reads a terminal's current offer without spending anything. */
  readTerminalOffer(accountId: AccountId, terminalId: AssetId): Promise<TerminalRead>;
  /**
   * Asks the terminal for its next offer. On a freshly activated terminal this loads the
   * first one; afterwards it declines the current offer for good and spends one point, which
   * is why it is a mutation. `SUBMITTED` carries the offer's item id in `raw`.
   */
  advanceTerminalOffer(accountId: AccountId, terminalId: AssetId): Promise<MutationOutcome>;

  /**
   * Names an item. `nameTagId` is the Name Tag the rename consumes; `null` — the default — is
   * the free rename CS2 allows for exactly one item, a storage unit, and is the only form
   * anything here sends today. The GC answers a `NameItem` notification and then an SO update
   * carrying attribute 111. An invalid name gets **no answer at all**, so a caller that has not
   * validated the name first will only ever learn about a typo as a timeout. Evidence:
   * `fixtures/steam/contracts/name-item.json`; the design that rests on it is
   * `cslytics-app-docs/plans/storage-unit-rename-plan.md`.
   */
  nameItem(accountId: AccountId, itemId: AssetId, name: string, nameTagId?: AssetId | null): Promise<MutationOutcome>;

  /** Drops this account's GC session without discarding its event queue or generation. */
  disconnect(accountId: AccountId): void;
}
