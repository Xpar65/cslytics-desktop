/** Row shapes as the engine's read models return them. Snake_case mirrors the SQLite columns. */

export type ItemRow = {
  local_id: string;
  account_id: string;
  def_index: number;
  paint_index: number | null;
  paint_wear: number | null;
  paint_seed: number | null;
  quality: number;
  stable_key: string;
  asset_id: string | null;
  location: 'MAIN' | 'CASKET' | 'MISSING';
  casket_id: string | null;
  tradable_after: string | null;
  trade_protected_until: string | null;
};

export type ListingRow = {
  listing_id: string;
  local_id: string | null;
  hash_name: string;
  price_receive_cents: number;
  buyer_price_cents: number;
  status: 'ACTIVE' | 'ON_HOLD' | 'PENDING_CONFIRMATION' | 'ABSENT';
  hold_until: string | null;
  awaiting_confirmation: number;
};

export type BuyOrderRow = {
  buy_order_id: string;
  hash_name: string;
  price_cents: number;
  quantity: number;
  quantity_remaining: number;
  purchased: number;
  active: number;
};

export type WalletRow = {
  observed_at: string;
  balance_cents: number;
  delayed_balance_cents: number;
  /** Steam's currency id, or null for a wallet whose currency no read has named: never assumed. */
  currency: number | null;
};

export type StorageUnitRow = {
  casket_id: string;
  label: string | null;
  contains_count: number;
  state: 'ACTIVE' | 'FULL' | 'DISABLED';
};

export type MarketState = {
  listings: ListingRow[];
  buyOrders: BuyOrderRow[];
  wallet: WalletRow | null;
  latestObservation: { id: number; complete: number; finished_at: string; total_expected: number | null } | undefined;
};


export type GoalConflict = { id: string; targetId: string; reason: string; blockedUntil: string | null; suspendedAt: string };
export type GoalPreview = { localId: string; kind: string; action?: string; reason?: string; because?: unknown; surface?: string; scope?: { kind: string; id?: string } };

/**
 * Holdings as `EngineViews.holdings` returns them — camelCase, because this one is shaped by
 * the read model rather than by a SQLite row.
 *
 * `settled` is the part that matters: it is false whenever the walk behind these figures did
 * not finish, and the portfolio must then present them as a floor rather than as a total.
 */
export type SurfaceEvidence = { observedAt: string | null; settled: boolean };

/** A venue balance: spendable now, and what the venue is still holding, in `currency`. */
export type VenueWallet = { currency: number; availableCents: number; pendingCents: number; observedAt: string };

export type AccountHoldings = {
  accountId: string;
  accountName: string;
  steamId64: string;
  /** The Steam wallet's currency, and so every Steam figure's. The CSFloat wallet carries its own. */
  currency: number | null;
  /** The Steam wallet: `balanceCents` is spendable, `delayedBalanceCents` is pending. */
  wallet: { balanceCents: number; delayedBalanceCents: number; observedAt: string } | null;
  /** The CSFloat balance for the connection that exists now; null with no key or no read (CSF-04). */
  csfloatWallet: VenueWallet | null;
  reservedCents: number;
  /** An order opened on the Steam website commits the same balance; counted, never reserved (BUY-02). */
  externalCommitmentCents?: number;
  /** Null when no wallet has been observed: unknown is not zero (BUY-09). */
  availableToCommitCents?: number | null;
  listedReceiveCents: number;
  onHoldReceiveCents: number;
  awaitingConfirmationReceiveCents: number;
  buyOrderOpenCents: number;
  counts: {
    itemsMain: number;
    itemsCrated: number;
    itemsListed: number;
    commodityMain: number;
    commodityCrated: number;
    commodityListed: number;
    fungibleUnits: number;
    listingsActive: number;
    listingsOnHold: number;
    listingsAwaitingConfirmation: number;
    buyOrdersActive: number;
    csfloatBuyOrdersActive: number;
    storageUnits: number;
    storedItems: number;
  };
  inventory: SurfaceEvidence;
  market: SurfaceEvidence;
};

/**
 * Connection state for one account, as `session.status` returns it.
 *
 * Two independent facts, and the window must not merge them. Being signed in to Steam does not
 * mean the CS2 Game Coordinator is reachable — a second computer playing CS2 on the same
 * account takes that session away while the Steam login stays perfectly healthy — and telling
 * a user "disconnected" when only half of it is down sends them to reconnect the wrong thing.
 */
export type SteamSessionState =
  | { kind: 'signed-out' }
  | { kind: 'authenticating' }
  | { kind: 'authenticated'; steamId64: string; accountName: string }
  | { kind: 'expired'; reason: string };

export type GcConnectionState = 'DISCONNECTED' | 'CONNECTED' | 'BLOCKED_ELSEWHERE';

export type GcStatus = {
  state: GcConnectionState;
  generation: number | null;
  detail: string | null;
  observedAt: string | null;
};

export type ConnectionPhase =
  | 'CONNECTED' | 'CONNECTING' | 'STEAM_ONLY' | 'BLOCKED_ELSEWHERE'
  | 'DISCONNECTED' | 'SIGNED_OUT' | 'EXPIRED';

export type AccountConnection = {
  accountId: string;
  phase: ConnectionPhase;
  steam: SteamSessionState;
  gc: GcStatus;
  hasSavedCredential: boolean;
  lastError: string | null;
  observedAt: string;
};

/**
 * What `session.connect` and `session.signOut` answer with: the connection as it is now.
 */
export type ConnectionReport = AccountConnection;
