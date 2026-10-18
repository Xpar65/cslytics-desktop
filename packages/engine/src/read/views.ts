import type { AccountId } from '@cslytics/ports';
import type { EngineDatabase, ItemRow } from '../db/database.js';
import { steamListedSql } from '../db/commitment.js';
import { pageCsfloat, csfloatOverview, csfloatEligibility, csfloatGroupEligibility, type CsfloatBook, type CsfloatEligibility, type CsfloatGroupEligibility } from './queries/csfloat.js';
import { CSFLOAT_CURRENCY, pageListings as readListingsPage, summariseListings as readListingsSummary, type ListingPageRequest, type ListingPageRow, type ListingsSummary } from './queries/listings.js';
import { pageWaiting as readWaiting, type WaitingPage } from './queries/waiting.js';
import { readBuyOrders as readBuyOrderBook, type BuyOrderBook } from './queries/buy-orders.js';
import type { PageEnvelope, ScopedPageRequest } from './queries/paging.js';
import {
  pageInventory as readInventoryPage,
  pageInventoryGroups as readInventoryGroupPage,
  pageInventoryPositions as readInventoryPositions,
  type InventoryPositionsRequest,
  type PositionsEnvelope,
  pageStorage as readStoragePage,
  type InventoryPageRequest,
  type InventoryPageRow,
  type GroupEnvelope
} from './queries/inventory.js';
import {
  pageActivity as readActivityPage,
  pageHistory as readHistoryPage,
  pageLedger as readLedgerPage,
  pageOrders as readOrdersPage,
  pageTrades as readTradesPage,
  type HistoryPageRequest,
  type HistoryPageRow
} from './queries/records.js';
import { pageOpenWork as readOpenWork, type WorkPage } from './queries/work.js';
import { pageTradeEntries as readTradeEntries, pageTradeItems as readTradeItems, readTradeEntry as readOneTradeEntry, summariseTrades as readTradeSummary, type TradeEntry, type TradeEntryRequest, type TradeItemRow, type TradeItemsRequest, type TradeListRequest, type TradeListRow, type TradeSummary, type TradeSummaryRequest } from './queries/trades.js';
import { LedgerStore } from '../db/ledger.js';
import { MarketplaceStore } from '../db/marketplace.js';


export type PlannedAction = {
  actionId: string;
  kind: string;
  targetId: string;
  desiredVersion: number;
  resourceKey: string;
  params: unknown;
};
export type GoalConflict = { id: string; targetId: string; reason: string; blockedUntil: string | null; suspendedAt: string; resolutions: readonly ['resume', 'adopt'] };

/**
 * How much a set of figures can be trusted, per surface.
 *
 * `settled` is CLAUDE.md rule 5 carried into the read model: a total derived from a walk that
 * did not finish is a *floor*, never a total, and a portfolio that printed one as truth would
 * be the most convincing wrong number in the app. The caller renders the difference.
 */
export type SurfaceEvidence = { observedAt: string | null; settled: boolean };

/** A venue balance: what may be spent now and what the venue is still holding, in `currency`. */
export type VenueWallet = { currency: number; availableCents: number; pendingCents: number; observedAt: string };

/**
 * What one account is observed to be holding.
 *
 * Every money figure here is a number a venue itself named — a wallet balance, the
 * seller-receives price on a listing, the buyer-side total of an open buy order, a reservation
 * this engine made against its own wallet. Nothing is appraised: `cslytics-app-docs/steam/wallet.md` states
 * the rule as *"the engine never values an item"*, and there is no price catalogue in V1. So
 * inventory appears here as counts, and the caller shows it as counts.
 *
 * Individual items and fungible units are counted apart, per place: `itemsCrated` counts
 * individual rows in storage and `commodityCrated` the fungible units beside them. An account
 * whose storage is all cases has no individual items there at all, so a caller that shows how
 * many holdings sit in a place adds the two; one that shows `itemsCrated` alone reports "0".
 */
export type AccountHoldings = {
  accountId: string;
  accountName: string;
  steamId64: string;
  /**
   * The Steam wallet's currency code — 21 is AUD — and so the currency of every Steam figure below.
   * Null until a wallet is observed. The CSFloat wallet carries its own.
   */
  currency: number | null;
  /** The Steam wallet: `balanceCents` is spendable, `delayedBalanceCents` is what Steam shows as pending. */
  wallet: { balanceCents: number; delayedBalanceCents: number; observedAt: string } | null;
  /**
   * The CSFloat balance as `/me` last named it, for the connection that exists now: spendable and
   * pending, in CSFloat's currency (US dollars). Null when no key is connected or none has been
   * read, and from the moment a disconnect replaces the generation it was read under (CSF-04).
   */
  csfloatWallet: VenueWallet | null;
  /** Wallet money already committed to buy orders this engine submitted (`cslytics-app-docs/steam/wallet.md`). */
  reservedCents: number;
  /**
   * Wallet money committed by buy orders this app did not open.
   *
   * Kept apart from `reservedCents` because they answer different questions: one is what this
   * app has promised, the other is what the account has promised elsewhere. Adding them into a
   * single "committed" figure would hide the case where the two disagree (BUY-09, N-BUY-05).
   */
  externalCommitmentCents: number;
  /**
   * Balance minus both commitments: what a new order may actually spend.
   *
   * Null until a wallet has been observed, because "available" is not zero when the balance is
   * simply unknown — that is the difference between an empty wallet and an unread one.
   */
  availableToCommitCents: number | null;
  /** Seller-receives across listings Steam showed as live. */
  listedReceiveCents: number;
  /** Seller-receives across listings Steam is holding. */
  onHoldReceiveCents: number;
  /** Seller-receives across listings waiting on a phone confirmation this app never makes. */
  awaitingConfirmationReceiveCents: number;
  /** Buyer-side money in buy orders Steam showed as active. */
  buyOrderOpenCents: number;
  counts: {
    itemsMain: number;
    itemsCrated: number;
    itemsListed: number;
    commodityMain: number;
    commodityCrated: number;
    /**
     * Of `itemsMain` and `commodityMain`, the units an open Steam listing names. A share of main
     * inventory, never a third place: the Game Coordinator keeps a listed item there until it
     * sells (`db/commitment.ts`), so adding these to the other two counts a listed unit twice.
     */
    commodityListed: number;
    fungibleUnits: number;
    listingsActive: number;
    listingsOnHold: number;
    listingsAwaitingConfirmation: number;
    buyOrdersActive: number;
    /** Open orders in the account's own CSFloat book. A count, so it needs no currency. */
    csfloatBuyOrdersActive: number;
    storageUnits: number;
    storedItems: number;
  };
  inventory: SurfaceEvidence;
  market: SurfaceEvidence;
};

export type MarketView = {
  listings: unknown[];
  buyOrders: unknown[];
  wallet: unknown | null;
  latestObservation: ReturnType<EngineDatabase['latestObservation']>;
};

/**
 * Read models for the renderer.
 *
 * Separated from the services so nothing that mutates state and nothing the UI reads share a
 * class. These are pure queries: they never write and never call a port.
 */
export class EngineViews {
  /**
   * `now` is the engine's clock. A trade's stage turns on whether its reversal period has ended, and
   * a read that took the wall clock would disagree with the engine that wrote the row under test.
   */
  constructor(private readonly database: EngineDatabase, private readonly now: () => string = () => new Date().toISOString()) {}
  csfloatPage(accountId: string, book: CsfloatBook, cursor?: string) { return pageCsfloat(this.database,accountId,book,cursor); }
  csfloatOverview(accountId: string) { return csfloatOverview(this.database,accountId); }
  /** Can these items be listed on CSFloat? `unknown` is not a refusal, and `absent` is a complete read without them. */
  csfloatEligibility(accountId: string, localIds: readonly string[]): CsfloatEligibility[] {
    return csfloatEligibility(this.database,accountId,localIds);
  }
  /** The same for groups, with how many of each group's loose units CSFloat would take. */
  csfloatGroupEligibility(accountId: string, stackKeys: readonly string[]): CsfloatGroupEligibility[] {
    return csfloatGroupEligibility(this.database,accountId,stackKeys);
  }

  /**
   * Everything in flight for a scope, in observation-honest states.
   *
   * There was no read that listed open commands for a scope — `command.read` answers about one
   * command by id — and the work indicator cannot be built honestly without one: it would have to
   * infer that something is happening from the absence of a completion, which is exactly the
   * inference rule 1 forbids.
   */
  pageOpenWork(request: { accountIds: readonly string[] }): WorkPage {
    return readOpenWork(this.database, request);
  }

  /**
   * Everything observed to be waiting on the person, not on this app.
   *
   * The counterpart to `pageOpenWork`, and deliberately a separate read rather than a filter over
   * it: open work drains by itself and these rows never do. This app cannot hold the secret that
   * would let it confirm anything (rule 2), so a pending confirmation is a hand-off that stays
   * until a human taps a phone. `queries/waiting.ts` has why the two sources are one list.
   */
  pageWaiting(request: { accountIds: readonly string[] }): WaitingPage {
    return readWaiting(this.database, request);
  }

  inventory(accountId: AccountId): ItemRow[] {
    return this.database.items(accountId);
  }

  async pageInventory(request: InventoryPageRequest): Promise<PageEnvelope<InventoryPageRow>> {
    return readInventoryPage(this.database, request, this.now());
  }

  /** The default inventory view. Names are the host's job; this returns identity and counts. */
  async pageInventoryGroups(request: InventoryPageRequest): Promise<GroupEnvelope> {
    return readInventoryGroupPage(this.database, request, this.now());
  }

  /** Holdings by market kind, for a valuation the host computes. Identity and counts only. */
  async pageInventoryPositions(request: InventoryPositionsRequest): Promise<PositionsEnvelope> {
    return readInventoryPositions(this.database, request, this.now());
  }

  async pageHistory(request: HistoryPageRequest): Promise<PageEnvelope<HistoryPageRow>> {
    return readHistoryPage(this.database, request);
  }

  async pageStorage(request: ScopedPageRequest) {
    return readStoragePage(this.database, request);
  }

  async pageOrders(request: ScopedPageRequest) {
    return readOrdersPage(this.database, request);
  }

  async pageActivity(request: ScopedPageRequest) {
    return readActivityPage(this.database, request);
  }

  /** Executed trades and still-open offers, one list, each row saying which it is. */
  async pageTrades(request: ScopedPageRequest) {
    return readTradesPage(this.database, request);
  }

  /**
   * The trades page: one entry per trade, newest first, an offer and the trade it became merged.
   * `queries/trades.ts` has the four refusals it makes, and why what a trade was for is joined
   * at read time rather than stored.
   */
  pageTradeEntries(request: TradeListRequest): PageEnvelope<TradeListRow> {
    return readTradeEntries(this.database, request, this.now());
  }

  /** How many trades each stage and origin holds in a scope, for the filters' counts. */
  summariseTrades(request: TradeSummaryRequest): TradeSummary {
    return readTradeSummary(this.database, request, this.now());
  }

  /** One trade: its facts, its origin and the evidence for it, the walks it rests on, and its item groups. */
  readTradeEntry(request: TradeEntryRequest): TradeEntry | null {
    return readOneTradeEntry(this.database, request, this.now());
  }

  /** One side of one trade, a page at a time, each line with the identity it resolved to. */
  pageTradeItems(request: TradeItemsRequest): PageEnvelope<TradeItemRow> {
    return readTradeItems(this.database, request, this.now());
  }

  /**
   * Every open advertisement in a scope, on every venue, one page.
   *
   * Cross-venue and cross-account, and it stays honest about both: money is grouped by venue and
   * currency rather than added, and CSFloat rows carry no seller-receives figure because CSFloat
   * never named one. See `queries/listings.ts` for why each of those is a refusal rather than a gap.
   */
  async pageListings(request: ListingPageRequest): Promise<PageEnvelope<ListingPageRow>> {
    return readListingsPage(this.database, request);
  }

  /** The figures above that list, and the walks they rest on. Never a single converted total. */
  async listingsSummary(request: ListingPageRequest): Promise<ListingsSummary> {
    return readListingsSummary(this.database, request);
  }

  /**
   * Every buy order Steam is showing as open in a scope, with the money each still commits and
   * the walk it rests on. A cancel that was sent keeps its order here until a walk shows it gone;
   * `queries/buy-orders.ts` has why that is a refusal rather than a delay.
   */
  async buyOrders(request: { accountIds: readonly string[] }): Promise<BuyOrderBook> {
    return readBuyOrderBook(this.database, request);
  }

  /** The ledger. Rows carry `amountBasis`; a renderer may not print an UNKNOWN as a number. */
  async pageLedger(request: ScopedPageRequest) {
    return readLedgerPage(this.database, request);
  }

  storage(accountId: AccountId): unknown[] {
    return this.database.raw().prepare(`SELECT * FROM storage_unit WHERE account_id=? ORDER BY casket_id`).all(accountId);
  }

  /** Everything currently READY: the dry-run plan, before anything touches Steam. */
  dryRunPlan(accountId: AccountId): PlannedAction[] {
    return this.database.actions(accountId, 'READY').map((action) => ({
      actionId: action.id,
      kind: action.kind,
      targetId: action.target_id,
      desiredVersion: action.desired_version,
      resourceKey: action.resource_key,
      params: this.database.actionParams(action)
    }));
  }

  market(accountId: AccountId): MarketView {
    const raw = this.database.raw();
    return {
      // Steam's own view of its book: the walked rows of the order table in the walk's words, one per listing ever seen.
      listings: raw.prepare(`SELECT v.venue_order_id AS listing_id, v.order_id, v.local_id, v.asset_id, v.hash_name,
          v.price_cents AS price_receive_cents, s.buyer_price_cents, v.currency,
          CASE WHEN v.gone_obs IS NULL THEN s.raw_bucket ELSE 'ABSENT' END AS status, v.state,
          v.transactable_after AS hold_until, CASE WHEN v.gone_obs IS NULL AND s.raw_bucket='PENDING_CONFIRMATION' THEN 1 ELSE 0 END AS awaiting_confirmation,
          v.first_seen_obs, v.last_seen_obs, v.gone_obs
        FROM venue_order v JOIN steam_order s ON s.account_id=v.account_id AND s.order_id=v.order_id
        WHERE v.account_id=? AND v.venue='steam' AND v.side='SELL' AND v.venue_order_id IS NOT NULL ORDER BY v.venue_order_id`).all(accountId),
      buyOrders: raw.prepare(`SELECT v.venue_order_id AS buy_order_id, v.order_id, v.hash_name, v.price_cents, v.quantity, v.quantity - v.filled AS quantity_remaining,
          v.filled AS purchased, CASE WHEN v.state NOT LIKE 'ENDED_%' THEN 1 ELSE 0 END AS active, v.state, v.first_seen_obs, v.last_seen_obs, v.gone_obs
        FROM venue_order v WHERE v.account_id=? AND v.venue='steam' AND v.side='BUY' AND v.venue_order_id IS NOT NULL ORDER BY v.venue_order_id`).all(accountId),
      wallet: raw.prepare(`
        SELECT observed_at, balance_cents, delayed_balance_cents, currency
        FROM wallet_snapshot WHERE account_id=? ORDER BY id DESC LIMIT 1
      `).get(accountId) ?? null,
      latestObservation: this.database.latestObservation(accountId, 'steam-market')
    };
  }

  conflicts(accountId: AccountId): GoalConflict[] {
    const rows = this.database.raw().prepare(`SELECT id, target_id, suspended_reason, blocked_until, suspended_at FROM desired_state
      WHERE account_id=? AND superseded_by IS NULL AND suspended_reason IS NOT NULL ORDER BY suspended_at, id`).all(accountId) as Array<{
        id: string; target_id: string; suspended_reason: string; blocked_until: string | null; suspended_at: string;
      }>;
    return rows.map((row) => ({ id: row.id, targetId: row.target_id, reason: row.suspended_reason, blockedUntil: row.blocked_until,
      suspendedAt: row.suspended_at, resolutions: ['resume', 'adopt'] }));
  }

  orders(accountId: AccountId): unknown[] {
    return this.database.raw().prepare(`SELECT * FROM venue_order WHERE account_id=? ORDER BY opened_at, order_id`).all(accountId);
  }

  /**
   * One account's observed holdings. Every query below is keyed by `accountId` (rule 8).
   *
   * Read `AccountHoldings` before adding a figure here: money may only be a number a venue
   * named, and a count may only be a count.
   */
  holdings(accountId: AccountId): AccountHoldings {
    const raw = this.database.raw();
    const account = this.database.account(accountId);
    const wallet = raw.prepare(`
      SELECT observed_at, balance_cents, delayed_balance_cents, currency
      FROM wallet_snapshot WHERE account_id=? ORDER BY id DESC LIMIT 1
    `).get(accountId) as
      { observed_at: string; balance_cents: number; delayed_balance_cents: number; currency: number } | undefined;

    // One pass per table rather than one per figure: these are all narrow, account-keyed
    // aggregates and a portfolio refresh reads them for every signed-in account.
    const listings = raw.prepare(`
      SELECT s.raw_bucket AS status, COUNT(*) AS count, COALESCE(SUM(v.price_cents), 0) AS receive
      FROM venue_order v JOIN steam_order s ON s.account_id=v.account_id AND s.order_id=v.order_id
      WHERE v.account_id=? AND v.venue='steam' AND v.side='SELL' AND v.first_seen_obs IS NOT NULL AND v.gone_obs IS NULL
      GROUP BY s.raw_bucket
    `).all(accountId) as Array<{ status: string; count: number; receive: number }>;
    const listing = (status: string): { count: number; receive: number } =>
      listings.find((row) => row.status === status) ?? { count: 0, receive: 0 };

    const buyOrders = raw.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(price_cents * (quantity - filled)), 0) AS open
      FROM venue_order WHERE account_id=? AND venue='steam' AND side='BUY' AND first_seen_obs IS NOT NULL AND state NOT LIKE 'ENDED_%'
    `).get(accountId) as { count: number; open: number };
    // Counted beside Steam's, never summed into its money: a CSFloat order is US dollars.
    const csfloatBuyOrders = raw.prepare(`SELECT COUNT(*) AS count FROM venue_order WHERE account_id=? AND venue='csfloat' AND side='BUY'
      AND first_seen_obs IS NOT NULL AND gone_obs IS NULL`).get(accountId) as { count: number };
    // A balance `/me` did not name is unknown, not zero; an absent pending figure is nothing pending.
    const csfloat = new MarketplaceStore(this.database).currentStatus(accountId);
    const csfloatWallet: VenueWallet | null = csfloat && csfloat.available_cents !== null
      ? { currency: CSFLOAT_CURRENCY, availableCents: csfloat.available_cents, pendingCents: csfloat.pending_cents ?? 0, observedAt: csfloat.observed_at }
      : null;

    // The same arithmetic buy-order admission uses (cslytics-app-docs/steam/wallet.md): money the engine
    // has committed but Steam has not yet shown back to it is still spent.
    const reservedCents = new LedgerStore(this.database).reservedWalletCents(accountId);
    const externalCommitmentCents = new LedgerStore(this.database).externalOrderCommitmentCents(accountId);

    const items = raw.prepare(`
      SELECT location, COUNT(*) AS count FROM item
      WHERE account_id=? AND unit_kind='individual'
      GROUP BY location
    `).all(accountId) as Array<{ location: string; count: number }>;
    const located = (location: string): number => items.find((row) => row.location === location)?.count ?? 0;

    const commodities = raw.prepare(`
      SELECT location, COALESCE(SUM(quantity), 0) AS units FROM item
      WHERE account_id=? AND unit_kind='fungible' AND location<>'MISSING' GROUP BY location
    `).all(accountId) as Array<{ location: string; units: number }>;
    const commodityAt = (location: string): number => commodities.find((row) => row.location === location)?.units ?? 0;
    const listedOf = (kind: 'individual' | 'fungible'): number => (raw.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS units FROM item AS held
      WHERE account_id=? AND unit_kind=? AND location<>'MISSING' AND ${steamListedSql('held')}
    `).get(accountId, kind) as { units: number }).units;
    const storage = raw.prepare(`
      SELECT COUNT(*) AS units, COALESCE(SUM(contains_count), 0) AS stored
      FROM storage_unit WHERE account_id=?
    `).get(accountId) as { units: number; stored: number };

    return {
      accountId,
      accountName: account?.account_name ?? accountId,
      steamId64: account?.steam_id64 ?? '',
      currency: wallet?.currency ?? null,
      wallet: wallet
        ? { balanceCents: wallet.balance_cents, delayedBalanceCents: wallet.delayed_balance_cents, observedAt: wallet.observed_at }
        : null,
      csfloatWallet,
      reservedCents,
      externalCommitmentCents,
      availableToCommitCents: wallet ? wallet.balance_cents - reservedCents - externalCommitmentCents : null,
      listedReceiveCents: listing('ACTIVE').receive,
      onHoldReceiveCents: listing('ON_HOLD').receive,
      awaitingConfirmationReceiveCents: listing('PENDING_CONFIRMATION').receive,
      buyOrderOpenCents: buyOrders.open,
      counts: {
        itemsMain: located('MAIN'),
        itemsCrated: located('CASKET'),
        itemsListed: listedOf('individual'),
        commodityMain: commodityAt('MAIN'),
        commodityCrated: commodityAt('CASKET'),
        commodityListed: listedOf('fungible'),
        fungibleUnits: commodityAt('MAIN') + commodityAt('CASKET'),
        listingsActive: listing('ACTIVE').count,
        listingsOnHold: listing('ON_HOLD').count,
        listingsAwaitingConfirmation: listing('PENDING_CONFIRMATION').count,
        buyOrdersActive: buyOrders.count,
        csfloatBuyOrdersActive: csfloatBuyOrders.count,
        storageUnits: storage.units,
        storedItems: storage.stored
      },
      inventory: evidenceOf(this.database.latestObservation(accountId, 'gc-inventory')),
      market: evidenceOf(this.database.latestObservation(accountId, 'steam-market'))
    };
  }

  /**
   * Holdings for exactly the accounts the caller named.
   *
   * There is no "all accounts" form on purpose. Rule 8 forbids an ambient current account, and
   * the same reasoning forbids an ambient *set* of them: the window that is showing two signed-in
   * accounts is the only thing that knows which two, so it says so.
   */
  portfolio(accountIds: readonly AccountId[]): AccountHoldings[] {
    return accountIds.map((accountId) => this.holdings(accountId));
  }
}

function evidenceOf(observation: { finished_at: string; complete: number } | undefined): SurfaceEvidence {
  if (!observation) return { observedAt: null, settled: false };
  return { observedAt: observation.finished_at, settled: observation.complete === 1 };
}
