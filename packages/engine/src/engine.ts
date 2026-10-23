import type { AccountId, BuyOrderRequest, ClockPort, CsfloatMePatch, EnginePorts, GcEvent, GcStatus, MutationOutcome } from '@cslytics/ports';
import { EngineDatabase, type AccountRow, type ActionRow, type ItemRow } from './db/database.js';
import { AccountEndpointGovernors } from './kernel/governor.js';
import { AccountLock } from './kernel/support.js';
import { createContext, type EngineContext } from './kernel/context.js';
import { InventoryService } from './surfaces/inventory.js';
import { StorageService } from './surfaces/storage.js';
import { MarketService, type MarketSyncResult } from './surfaces/market.js';
import { BuyOrderService } from './surfaces/buy-orders.js';
import { TradeService, type TradeSyncResult } from './surfaces/trades.js';
import { EngineViews, type AccountHoldings, type MarketView, type PlannedAction } from './read/views.js';
import { ListingPlanner } from './policy/listing-planner.js';
import { ConvergenceService, type ConvergenceServices } from './orchestrate/convergence.js';
import { ReadBroker, type Reading, type ReadOutcome, type ReadServices, type RefreshNotice, type RefreshStatus } from './orchestrate/reads.js';
import { SettleService, type SettleServices, type Settling, type WakeDrivers } from './orchestrate/settle.js';
import { OrderService, STEAM_PROFILE, type VenueProfile } from './surfaces/orders.js';
import type { VenueOrderRow } from './db/orders.js';
import { SessionService } from './surfaces/session.js';
import { CommandService, type CommandProgress, type CommandRequest, type CommandServices, type SelectionCaptureRequest, type SelectionSnapshot } from './orchestrate/command.js';
import { TransferPlanner } from './policy/transfer-planner.js';
import { CsfloatAccountService, type ConnectResult, type MarketplaceStatus } from './surfaces/csfloat-account.js';
import { CsfloatListingService, type StallSyncResult } from './surfaces/csfloat-listings.js';
import { CsfloatInventoryService } from './surfaces/csfloat-inventory.js';
import { CsfloatTradeService } from './surfaces/csfloat-trades.js';
import { CsfloatBuyOrderService, type BuyOrderBookSyncResult } from './surfaces/csfloat-buy-orders.js';
import { CsfloatBuyingService, type CsfloatBuyingServices } from './orchestrate/csfloat-buying.js';
import { CsfloatSellingService, type CsfloatSellingServices } from './orchestrate/csfloat-selling.js';
import { CsfloatSellingPolicy } from './policy/csfloat-selling.js';
import { CsfloatDeliveryService, type CsfloatDeliveryServices } from './orchestrate/csfloat-delivery.js';
import { CsfloatStore } from './db/csfloat.js';
import { HoldingsStore } from './db/holdings.js';
import { AccountPurgeRefused, AccountPurgeStore, type PurgeResult } from './db/account-purge.js';
import { RetentionStore, type SweepResult } from './db/retention.js';
import { TransferService, type TransferServices } from './orchestrate/transfer.js';
import { InGameStoreService, type StorePurchaseRequest } from './surfaces/in-game-store.js';
import { pageStorePurchases, readStorePurchase, readStoreSheet } from './read/queries/in-game-store.js';
import type { BuyOrderVenue } from './read/queries/buy-orders.js';
import type { CommandRow, CommodityStackRow } from './db/database.js';
import { FRESHNESS, type Surface, type SurfaceRef } from './kernel/evidence.js';
import type { ObservationRow } from './db/database.js';
import { proofDemand, type ProofOwner } from './policy/proof.js';
import { RetryService, type RetrySenders } from './orchestrate/retry.js';

export type { MarketSyncResult } from './surfaces/market.js';
export type { TradeSyncResult } from './surfaces/trades.js';

/**
 * Lets a caller substitute a service implementation.
 *
 * This is plain constructor injection of the objects the facade composes — it adds no branch
 * to any execution path. The saboteur suite uses it to build deliberately-wrong engines and
 * prove the scenario library actually catches them.
 */
export type ServiceOverrides = {
  /**
   * The rate budgets. Only a test substitutes them: on a frozen virtual clock a bucket never
   * refills, so the scenario harness meters no reads, and a scenario about the budget passes the
   * real one back in.
   */
  governors?: (clock: ClockPort) => AccountEndpointGovernors;
  inventory?: (context: EngineContext) => InventoryService;
  storage?: (context: EngineContext) => StorageService;
  market?: (context: EngineContext, orders: OrderService) => MarketService;
  buyOrders?: (context: EngineContext) => BuyOrderService;
  trades?: (context: EngineContext) => TradeService;
  planner?: (context: EngineContext) => ListingPlanner;
  convergence?: (context: EngineContext, services: ConvergenceServices) => ConvergenceService;
  orders?: (context: EngineContext, profile: VenueProfile) => OrderService;
  /** The read models. Only a saboteur substitutes these; nothing shipped reads a different set. */
  views?: (database: EngineDatabase, now: () => string) => EngineViews;
  /** The venue's data, not a second copy of the reconciler (order-lifecycle.md §2.3). */
  profile?: VenueProfile;
  session?: (context: EngineContext) => SessionService;
  /** The one reader. A saboteur substitutes one that answers each need with its own walk, or starves the late one. */
  reads?: (context: EngineContext, services: ReadServices) => ReadBroker;
  /** The one settler. A saboteur substitutes it to prove a reconciler it forgets is noticed. */
  settle?: (context: EngineContext, services: SettleServices, wake: WakeDrivers) => SettleService;
  command?: (context: EngineContext, services: CommandServices) => CommandService;
  transferPlanner?: (context: EngineContext) => TransferPlanner;
  transfers?: (context: EngineContext, services: TransferServices) => TransferService;
  csfloatAccount?: (context: EngineContext) => CsfloatAccountService;
  csfloatListings?: (context: EngineContext) => CsfloatListingService;
  csfloatInventory?: (context: EngineContext) => CsfloatInventoryService;
  csfloatTrades?: (context: EngineContext) => CsfloatTradeService;
  csfloatBuyOrders?: (context: EngineContext) => CsfloatBuyOrderService;
  csfloatBuying?: (context: EngineContext, services: CsfloatBuyingServices) => CsfloatBuyingService;
  csfloatPolicy?: (context: EngineContext) => CsfloatSellingPolicy;
  csfloatSelling?: (context: EngineContext, services: CsfloatSellingServices) => CsfloatSellingService;
  csfloatDelivery?: (context: EngineContext, services: CsfloatDeliveryServices) => CsfloatDeliveryService;
  inGameStore?: (context: EngineContext) => InGameStoreService;
  /** The account purge. A saboteur substitutes one that leaves rows behind. */
  accountPurge?: (database: EngineDatabase) => AccountPurgeStore;
  /** The retention sweep. A saboteur substitutes one that deletes by age alone. */
  retention?: (database: EngineDatabase) => RetentionStore;
  /** The one resender. A saboteur substitutes one that never sends, to prove a retry is noticed. */
  retry?: (context: EngineContext, senders: RetrySenders) => RetryService;
};

/**
 * The Engine Runtime facade.
 *
 * Owns nothing itself: it wires the four domain services over one database and one set of
 * ports, and coordinates the couple of flows that cross a service boundary. Behaviour lives
 * in `services/`.
 */
export class TradingEngine {
  readonly governors: AccountEndpointGovernors;
  readonly inventoryService: InventoryService;
  readonly storageService: StorageService;
  readonly marketService: MarketService;
  readonly buyOrderService: BuyOrderService;
  readonly tradeService: TradeService;
  readonly views: EngineViews;
  readonly listingPlanner: ListingPlanner;
  readonly convergenceService: ConvergenceService;
  readonly sessions: SessionService;
  readonly commands: CommandService;
  readonly reads: ReadBroker;
  readonly settler: SettleService;
  /**
   * Who answers what a waiting action of each Steam kind needs walked (plan D5). Public so the
   * coverage guard can require a case for every kind here (`tests/unit/settle-coverage.test.ts`).
   */
  readonly proofOwners: Readonly<Partial<Record<string, ProofOwner>>>;
  readonly retry: RetryService;
  readonly transfers: TransferService;
  readonly csfloatAccount: CsfloatAccountService;
  readonly csfloatListings: CsfloatListingService;
  readonly csfloatInventory: CsfloatInventoryService;
  readonly csfloatTrades: CsfloatTradeService;
  readonly csfloatBuyOrders: CsfloatBuyOrderService;
  readonly csfloatBuying: CsfloatBuyingService;
  readonly csfloatSelling: CsfloatSellingService;
  readonly csfloatDelivery: CsfloatDeliveryService;
  readonly inGameStore: InGameStoreService;
  readonly accountPurge: AccountPurgeStore;
  readonly retention: RetentionStore;

  private readonly context: EngineContext;

  constructor(readonly database: EngineDatabase, readonly ports: EnginePorts, overrides: ServiceOverrides = {}) {
    this.governors = overrides.governors?.(ports.clock) ?? new AccountEndpointGovernors(ports.clock);
    this.context = createContext(database, ports, this.governors, new AccountLock());
    // Resolved at call time: the settler is built last, over services every bag below shares.
    const settling: Settling = {
      settleNow: (accountId) => this.settler.settleNow(accountId),
      settled: (accountId) => this.settler.settled(accountId),
      hold: (accountId, work) => this.settler.hold(accountId, work)
    };
    // Every read is a need of the broker, built further down over services every bag below shares.
    const reading: Reading = {
      need: (accountId, need, signal) => this.reads.need(accountId, need, signal),
      want: (accountId, need) => this.reads.want(accountId, need),
      ensureFresh: (accountId, surfaces, priority) => this.reads.ensureFresh(accountId, surfaces, priority),
      status: (accountId) => this.reads.status(accountId)
    };
    this.inventoryService = overrides.inventory?.(this.context) ?? new InventoryService(this.context);
    this.storageService = overrides.storage?.(this.context) ?? new StorageService(this.context);
    const profile = overrides.profile ?? STEAM_PROFILE;
    const orders = overrides.orders?.(this.context, profile) ?? new OrderService(this.context, profile);
    this.marketService = overrides.market?.(this.context, orders) ?? new MarketService(this.context, orders);
    this.buyOrderService = overrides.buyOrders?.(this.context) ?? new BuyOrderService(this.context);
    this.tradeService = overrides.trades?.(this.context) ?? new TradeService(this.context);
    this.csfloatAccount = overrides.csfloatAccount?.(this.context) ?? new CsfloatAccountService(this.context);
    this.csfloatListings = overrides.csfloatListings?.(this.context) ?? new CsfloatListingService(this.context);
    this.csfloatInventory = overrides.csfloatInventory?.(this.context) ?? new CsfloatInventoryService(this.context);
    this.csfloatTrades = overrides.csfloatTrades?.(this.context) ?? new CsfloatTradeService(this.context);
    this.csfloatBuyOrders = overrides.csfloatBuyOrders?.(this.context) ?? new CsfloatBuyOrderService(this.context);
    const buyingServices = { book: this.csfloatBuyOrders, settle: settling, reads: reading };
    this.csfloatBuying = overrides.csfloatBuying?.(this.context,buyingServices) ?? new CsfloatBuyingService(this.context,buyingServices);
    const csfloatServices = { listings: this.csfloatListings, inventory: this.csfloatInventory, trades: this.csfloatTrades,
      csfloatAccount: this.csfloatAccount, steamInventory: this.inventoryService, steamMarket: this.marketService, steamTrades: this.tradeService,
      policy: overrides.csfloatPolicy?.(this.context) ?? new CsfloatSellingPolicy(this.context), storage: this.storageService, settle: settling, reads: reading };
    this.csfloatSelling = overrides.csfloatSelling?.(this.context,csfloatServices) ?? new CsfloatSellingService(this.context,csfloatServices);
    const deliveryServices = { trades: this.csfloatTrades, steamTrades: this.tradeService, reads: reading };
    this.csfloatDelivery = overrides.csfloatDelivery?.(this.context,deliveryServices) ?? new CsfloatDeliveryService(this.context,deliveryServices);
    this.inGameStore = overrides.inGameStore?.(this.context) ?? new InGameStoreService(this.context);
    this.accountPurge = overrides.accountPurge?.(database) ?? new AccountPurgeStore(database);
    this.retention = overrides.retention?.(database) ?? new RetentionStore(database);
    const transferServices = { planner: overrides.transferPlanner?.(this.context) ?? new TransferPlanner(this.context), trades:this.tradeService, inventory:this.inventoryService, storage:this.storageService, settle: settling, reads: reading };
    this.transfers = overrides.transfers?.(this.context,transferServices) ?? new TransferService(this.context,transferServices);
    const now = (): string => this.context.now();
    this.views = overrides.views?.(database, now) ?? new EngineViews(database, now);
    this.listingPlanner = overrides.planner?.(this.context) ?? new ListingPlanner(this.context);
    const services = { planner: this.listingPlanner, inventory: this.inventoryService, storage: this.storageService, market: this.marketService, settle: settling, reads: reading };
    this.convergenceService = overrides.convergence?.(this.context, services) ?? new ConvergenceService(this.context, services);
    this.sessions = overrides.session?.(this.context) ?? new SessionService(this.context);
    const commandServices = { storage: this.storageService, inventory: this.inventoryService, trades: this.tradeService, market: this.marketService, settle: settling, reads: reading };
    this.commands = overrides.command?.(this.context, commandServices) ?? new CommandService(this.context, commandServices);
    const settleServices: SettleServices = { storage: this.storageService, market: this.marketService, buyOrders: this.buyOrderService, inGameStore: this.inGameStore,
      csfloat: { reconcileSelling: (accountId) => this.csfloatSelling.reconcile(accountId), reconcileBuying: (accountId) => this.csfloatBuying.reconcile(accountId) } };
    const wake: WakeDrivers = (accountId, surfaces) => this.wakeDrivers(accountId, surfaces);
    this.settler = overrides.settle?.(this.context, settleServices, wake) ?? new SettleService(this.context, settleServices, wake);
    // Proof demand comes from the code that settles each kind (plan D5): one owner per kind.
    const proofOwners: Partial<Record<string, ProofOwner>> = this.proofOwners = {
      CREATE_SELL_LISTING: this.marketService, REMOVE_SELL_LISTING: this.marketService,
      CREATE_BUY_ORDER: this.buyOrderService, CANCEL_BUY_ORDER: this.buyOrderService,
      STORE_IN_CASKET: this.storageService, RETRIEVE_FROM_CASKET: this.storageService, RENAME_CASKET: this.storageService,
      CSFLOAT_CANCEL: this.csfloatSelling, CSFLOAT_REPRICE: this.csfloatSelling
    };
    const demand = (accountId: AccountId, provedByDispatch: readonly string[]) => proofDemand(this.database, accountId, proofOwners, [this.marketService.orders], provedByDispatch);
    // One sender per kind whose `RETRY_POLICY` row names the service: the same executor the
    // first send used. `tests/unit/retry-coverage.test.ts` holds the table and this bag together.
    const retrySenders: RetrySenders = {
      REMOVE_SELL_LISTING: (actionId) => this.marketService.executeDelist(actionId),
      CANCEL_BUY_ORDER: (actionId) => this.buyOrderService.executeCancel(actionId)
    };
    this.retry = overrides.retry?.(this.context, retrySenders) ?? new RetryService(this.context, retrySenders);
    const readServices: ReadServices = { inventory: this.inventoryService, storage: this.storageService, market: this.marketService, trades: this.tradeService, session: this.sessions, settle: settling, demand,
      dispatching: () => this.commands.dispatchingCommands(),
      retention: (accountId: AccountId) => this.retention.sweep(accountId, this.context.now()), inGameStore: this.inGameStore,
      ...(ports.csfloat ? { csfloatAccount: this.csfloatAccount, csfloatListings: this.csfloatListings, csfloatInventory: this.csfloatInventory, csfloatTrades: this.csfloatTrades, csfloatBuyOrders: this.csfloatBuyOrders } : {}) };
    this.reads = overrides.reads?.(this.context, readServices) ?? new ReadBroker(this.context, readServices);
    this.sessions.attachRuntime(this.inventoryService, (accountId) => {
      this.convergenceService.start(accountId);
      this.reads.start(accountId);
      // Work the last run queued and never sent. Convergence covers listing goals; a store or a
      // retrieve is only ever sent by `dispatch`, so without this a batch interrupted by a close
      // or a dead Game Coordinator sat queued forever with nothing looking at it. A CSFloat
      // operation is the same story: `submit` admits, and this is who sends what a dead run left.
      void this.commands.resume(accountId).catch(() => undefined);
      this.csfloatSelling.schedule(accountId);
      this.csfloatBuying.schedule(accountId);
      // A resend the last run was counting down to: its schedule is in the rows, so it resumes.
      this.retry.schedule(accountId);
    }, (accountId) => this.reads.start(accountId), (accountId) => { this.reads.stopAccount(accountId); this.retry.stopAccount(accountId); });
    // Wake-ups that follow a session rather than a walk. The ones that follow a walk run after
    // the settle that walk earned (`wakeDrivers`), so no driver starts from unsettled state.
    this.context.signals.subscribe((signal) => {
      if (signal.kind !== 'gc-session') return;
      // A queued CSFloat create needs the Game Coordinator's inventory fresh, so a session coming
      // up is the moment to send what was waiting on one.
      if (signal.state === 'CONNECTED') this.csfloatSelling.schedule(signal.accountId);
      this.transfers.schedule(signal.accountId);
    });
  }

  /**
   * What a settled walk wakes — the rules the signal subscription had when it also settled,
   * unchanged (settling and read path plan §3).
   *
   * Convergence is woken by a Game Coordinator event only. Widening it to every complete GC walk
   * looks harmless and is not: a walk the tick started would wake the tick again, and a twenty-goal
   * convergence went from one reconcile to forty — each re-evaluating every goal's evidence. An
   * *unsolicited* item sighting is the case that needs it.
   */
  private wakeDrivers(accountId: AccountId, surfaces: ReadonlySet<string>): void {
    const seen = [...surfaces];
    // The inline send used to end in a full `refresh`, which judged conflicts too. The stall walk
    // that proves a listing now arrives through the loop, so the judgement follows it here.
    if (seen.some((surface) => surface.startsWith('csfloat-'))) this.csfloatSelling.observeConflicts(accountId);
    // A CSFloat listing from a unit moves on walks: a Game Coordinator walk resolves its retrieve,
    // and a CSFloat inventory read is what it waits for. `advance` with nothing retrieving or
    // waiting is two SELECTs.
    if (seen.some((surface) => ['gc-inventory', 'gc-casket', 'gc-event', 'csfloat-inventory'].includes(surface))) this.csfloatSelling.schedule(accountId);
    this.transfers.schedule(accountId);
    // A resend waits on a proof, and a proof is a settle: whatever this one decided, the resender
    // looks once. A command's chain whose hop it proved continues from here too: a reprice whose
    // cancel landed, a transfer whose retrieve a unit walk showed, a store the walk showed done.
    this.retry.schedule(accountId);
    // A Game Coordinator item event too: a retrieve is proved by its own SO create, and the panel's
    // hop must move when it lands rather than at the next walk (bulk storage plan D5, BULK-06).
    if (seen.some((surface) => ['steam-market', 'steam-market-history', 'gc-inventory', 'gc-casket', 'gc-event'].includes(surface))) this.commands.advanceSteps(accountId);
    if (surfaces.has('gc-event') && this.database.currentGoals(accountId, 'sell-listing', 'LISTED_AT').length) {
      this.convergenceService.schedule(accountId);
    }
  }

  /**
   * Resolves once everything observed for the account so far is settled (plan D3). A read's own
   * promise is not that: the settle it earned runs on the next turn, once per burst.
   */
  settled(accountId: AccountId): Promise<void> {
    return this.settler.settled(accountId);
  }

  /**
   * The window's read of one surface: a person need of the broker, answered once it is settled
   * with the walk that answers it, or with nothing when the broker refused (read broker plan D1,
   * D12). Without `startedAfter` it is a walk begun now. The `syncX` methods below are the
   * scenarios' direct reads, and the desktop may not call them (`tests/unit/read-path.test.ts`).
   */
  async observe(accountId: AccountId, surface: Surface, options: { scopeId?: string; startedAfter?: string } = {}): Promise<ObservationRow | undefined> {
    const outcome = await this.observeOutcome(accountId, surface, options);
    return outcome.kind === 'observed' ? outcome.observation : undefined;
  }

  /** `observe` with the refusal kept: what a sync button is told when there was no walk to show. */
  async observeOutcome(accountId: AccountId, surface: Surface, options: { scopeId?: string; startedAfter?: string } = {}): Promise<ReadOutcome> {
    const ref: SurfaceRef = options.scopeId === undefined
      ? { surface, scope: { kind: 'account' } }
      : { surface, scope: { kind: FRESHNESS[surface].scope, id: options.scopeId } };
    return this.reads.need(accountId, { ref, startedAfter: options.startedAfter ?? this.context.now(), priority: 'person' });
  }

  /**
   * The window's storage read: the unit list, then every unit's contents, each a person need.
   * Answers with the observations it made, as `syncStorageUnits` does.
   */
  async observeStorage(accountId: AccountId): Promise<number[]> {
    const made: number[] = [];
    const units = await this.observe(accountId, 'gc-storage-units');
    if (units) made.push(units.id);
    const caskets = this.database.raw().prepare(`SELECT casket_id FROM storage_unit WHERE account_id=?`).all(accountId) as Array<{ casket_id: string }>;
    for (const { casket_id: casketId } of caskets) {
      const contents = await this.observe(accountId, 'gc-casket', { scopeId: casketId });
      if (contents) made.push(contents.id);
    }
    return made;
  }

  /** A direct read, answered once what it observed is settled. */
  private async settledAfter<T>(accountId: AccountId, read: Promise<T>): Promise<T> {
    const result = await read;
    await this.settler.settled(accountId);
    return result;
  }

  addAccount(accountId: AccountId, steamId64: string, accountName: string): void {
    this.database.addAccount(accountId, steamId64, accountName, this.context.now());
  }

  ensureAccount(preferredId: AccountId, steamId64: string, accountName: string): AccountId {
    return this.database.ensureAccount(preferredId, steamId64, accountName, this.context.now());
  }

  findAccountByName(username: string): AccountRow | undefined {
    return this.database.findAccountByName(username);
  }

  listAccounts(): AccountRow[] {
    return this.database.listAccounts();
  }

  /**
   * Takes one account off this computer: its saved Steam sign-in, every CSFloat key it stored,
   * then every row (`db/account-purge.ts`). The sign-ins go first, so a purge that fails leaves
   * an account that asks to be signed in again rather than credentials nothing lists.
   *
   * Only before any loop has started — the runtime calls it between opening the record and
   * answering requests. A running loop would write the account's rows straight back.
   */
  async removeAccount(accountId: AccountId): Promise<PurgeResult> {
    this.assertClearable(accountId);
    await this.ports.auth.forgetSignIn(accountId);
    await this.csfloatAccount.forgetKeys(accountId);
    return this.accountPurge.purge(accountId, 'remove');
  }

  /**
   * Empties one account and keeps it: the row, the Steam sign-in and the CSFloat connection stay,
   * and the next walks read everything again. The same rule about loops applies.
   */
  resetAccount(accountId: AccountId): PurgeResult {
    this.assertClearable(accountId);
    return this.accountPurge.purge(accountId, 'reset');
  }

  /**
   * Why the account cannot be removed or reset right now, or null (`AccountPurgeStore.refusal`).
   * The window asks before it offers the button, and main asks before it restarts anything.
   */
  accountClearRefusal(accountId: AccountId): string | null {
    return this.accountPurge.refusal(accountId);
  }

  private assertClearable(accountId: AccountId): void {
    if (this.reads.keptCurrent().length > 0) {
      throw new Error('An account can only be removed or reset before any account is being kept current; the Engine Runtime does it as it starts.');
    }
    const refused = this.accountPurge.refusal(accountId);
    if (refused) throw new AccountPurgeRefused(refused);
  }

  /** Stops background loops. Call before disposing the runtime. */
  shutdown(): void {
    this.commands.shutdown();
    this.retry.stop();
    this.transfers.stop();
    this.csfloatSelling.stop();
    this.csfloatBuying.stop();
    this.reads.stop();
    this.sessions.stopSupervising();
    this.convergenceService.stop();
    this.inventoryService.stopAllEventLoops();
    this.settler.stop();
    this.context.signals.clear();
  }

  // --- Automatic freshness -------------------------------------------------

  /** The daily sweep of evidence nothing cites (consolidation plan D22), on the engine's clock. */
  sweepRetention(accountId: AccountId): SweepResult {
    return this.retention.sweep(accountId, this.context.now());
  }

  /**
   * `Refresh now` for one account: a person need for every scope, past every hold but not past
   * the budget. This is what the window's button became. It is no longer the only path to current
   * data — the broker keeps every signed-in account current on its own — which is the whole point
   * of the continuous-freshness plan.
   */
  async refreshNow(accountId: AccountId) {
    const surfaces = await this.reads.refreshNow(accountId);
    await this.settler.settled(accountId);
    return surfaces;
  }

  /**
   * The machine woke up: `Refresh now` for every account already being kept current, one at a
   * time, and for nothing else (`ReadBroker.keptCurrent`).
   */
  async refreshResumed(): Promise<Record<AccountId, readonly Surface[]>> {
    const refreshed: Record<AccountId, readonly Surface[]> = {};
    for (const accountId of this.reads.keptCurrent()) refreshed[accountId] = await this.refreshNow(accountId);
    return refreshed;
  }

  /** A person need for each named surface whose latest complete walk is older than its trust window, awaited and settled. */
  async ensureFresh(accountId: AccountId, surfaces: readonly import('./kernel/evidence.js').Surface[]) {
    await this.reads.ensureFresh(accountId, surfaces, 'person');
    await this.settler.settled(accountId);
  }

  refreshStatus(accountId: AccountId): RefreshStatus {
    return this.reads.refreshStatus(accountId);
  }

  /** Tells the broker which account the window is showing; `null` is the all-accounts scope. */
  setActiveAccount(accountId: AccountId | null): void {
    this.reads.setActiveAccount(accountId);
  }

  set onChanged(listener: ((notice: RefreshNotice) => void) | undefined) {
    this.reads.onChanged = listener;
  }

  // --- Inventory -----------------------------------------------------------

  connectGc(accountId: AccountId, timeoutMs = 30_000): Promise<void> {
    return this.inventoryService.connectGc(accountId, timeoutMs);
  }

  /**
   * What the GC port currently believes about one account. Local state, not a network call —
   * the window polls it, and a read that reached out would make the indicator its own load.
   */
  gcStatus(accountId: AccountId): GcStatus {
    return this.ports.gc.connectionStatus(accountId);
  }

  syncInventory(accountId: AccountId): Promise<number> {
    return this.settledAfter(accountId, this.inventoryService.sync(accountId));
  }

  startGcEventLoop(accountId: AccountId): () => void {
    this.convergenceService.start(accountId);
    return this.inventoryService.startEventLoop(accountId);
  }

  applyGcEvent(accountId: AccountId, event: GcEvent): void {
    this.inventoryService.applyEvent(accountId, event);
  }

  // --- Storage units -------------------------------------------------------

  syncStorageUnits(accountId: AccountId): Promise<number[]> {
    return this.settledAfter(accountId, this.storageService.syncUnits(accountId));
  }

  syncCasket(accountId: AccountId, casketId: string): Promise<number> {
    return this.settledAfter(accountId, this.storageService.syncCasket(accountId, casketId).then((walk) => walk.observationId));
  }

  /** The unit list alone — labels and counts — without walking any unit's contents. */
  syncStorageUnitList(accountId: AccountId): Promise<number[]> {
    return this.settledAfter(accountId, this.storageService.syncUnits(accountId, false));
  }

  queueRename(accountId: AccountId, casketId: string, name: string, commandId: string | null = null): ActionRow {
    return this.storageService.queueRename(accountId, casketId, name, commandId);
  }

  queueStore(accountId: AccountId, localId: string, casketId: string, commandId: string | null = null): ActionRow {
    return this.storageService.queueStore(accountId, localId, casketId, commandId);
  }

  queueRetrieve(accountId: AccountId, localId: string, casketId: string, commandId: string | null = null): ActionRow {
    return this.storageService.queueRetrieve(accountId, localId, casketId, commandId);
  }

  executeCasketAction(actionId: string): Promise<MutationOutcome> {
    return this.storageService.execute(actionId);
  }

  executeCasketBatch(actionIds: readonly string[]): Promise<MutationOutcome[]> {
    return this.storageService.executeBatch(actionIds);
  }

  reconcileStorageActions(accountId: AccountId): void {
    this.settler.settleNow(accountId);
  }

  // --- Market --------------------------------------------------------------

  setListingGoal(accountId: AccountId, localId: string, priceReceiveCents: number, commandId: string | null = null) {
    return this.listingPlanner.setListingGoal(accountId, localId, priceReceiveCents, commandId);
  }

  planListing(accountId: AccountId, localId: string) { return this.listingPlanner.next(accountId, localId); }
  previewPlan(accountId: AccountId) { return this.listingPlanner.preview(accountId); }
  conflicts(accountId: AccountId) { return this.views.conflicts(accountId); }
  /**
   * Attaches a CSFloat developer key to one Steam account.
   *
   * The key is a parameter and never a stored field: it goes to the port for validation and to
   * the vault if it passes, and no branch of this call writes it to SQLite, an event or a log.
   */
  connectMarketplace(accountId: AccountId, apiKey: string): Promise<ConnectResult> {
    return this.csfloatAccount.connect(accountId, apiKey);
  }

  disconnectMarketplace(accountId: AccountId, mode: 'disconnect' | 'forget' = 'disconnect'): Promise<void> {
    return this.csfloatAccount.disconnect(accountId, mode);
  }

  marketplaceStatus(accountId: AccountId): MarketplaceStatus {
    return this.csfloatAccount.status(accountId);
  }

  /** Settings *Check now*: a person need for `/me`, then what the connection says. A refusal — no venue, a breaker — reads what is there. */
  async refreshMarketplaceStatus(accountId: AccountId): Promise<MarketplaceStatus> {
    await this.reads.need(accountId, { ref: { surface: 'csfloat-account-status', scope: { kind: 'account' } }, startedAfter: this.context.now(), priority: 'person' });
    return this.csfloatAccount.status(accountId);
  }

  /** Changes the CSFloat stall's away or public setting; the answer is `/me` read back, not the request. */
  updateMarketplaceStall(accountId: AccountId, patch: CsfloatMePatch): Promise<MarketplaceStatus> {
    return this.csfloatAccount.updateStall(accountId, patch);
  }

  /** Walks the account's own CSFloat stall. Completeness is the result's own claim, not a boolean. */
  syncCsfloatStall(accountId: AccountId): Promise<StallSyncResult> {
    return this.settledAfter(accountId, this.csfloatListings.syncStall(accountId));
  }
  /** Walks the account's own CSFloat buy-order book. Completeness is the result's own claim. */
  syncCsfloatBuyOrders(accountId: AccountId): Promise<BuyOrderBookSyncResult> {
    return this.settledAfter(accountId, this.csfloatBuyOrders.sync(accountId));
  }
  /**
   * The Buy orders page's refresh: one venue's book begun now, or both, as person needs of the
   * broker, through its budget and the breaker like any other read and never past them.
   *
   * Steam's book is the market walk; the settle that follows it runs the buy-order reconciler
   * over the walk just made. CSFloat's is asked only of an account whose connection is live: the
   * broker refuses a read the venue cannot answer rather than counting it against the surface.
   * The account's `/me` is read beside the book, because its available balance is what the page
   * warns an edit against, and a stale one warns wrongly. Each venue answers whether a book read
   * was made at all, not whether it completed — the book itself says that (rule 5).
   */
  async refreshBuyOrders(accountId: AccountId, venue: BuyOrderVenue | null): Promise<Partial<Record<BuyOrderVenue, boolean>>> {
    const read: Partial<Record<BuyOrderVenue, boolean>> = {};
    const now = (surface: Surface) => this.reads.need(accountId, { ref: { surface, scope: { kind: 'account' } }, startedAfter: this.context.now(), priority: 'person' })
      .then((outcome) => outcome.kind === 'observed' || outcome.reason === 'incomplete');
    if (venue !== 'CSFLOAT') {
      read.STEAM = await now('steam-market');
      await this.settler.settled(accountId);
    }
    if (venue !== 'STEAM') {
      const status = this.csfloatAccount.status(accountId).status;
      if (status === 'NOT_CONNECTED' || status === 'DISCONNECTED') read.CSFLOAT = false;
      else {
        await now('csfloat-account-status');
        read.CSFLOAT = await now('csfloat-buy-orders');
      }
    }
    return read;
  }
  setMarketplaceProtection(enabled: boolean): void {
    new CsfloatStore(this.database).setPolicy(enabled);
  }

  resolveGoalConflict(accountId: AccountId, desiredId: string, resolution: 'resume' | 'adopt') {
    return this.database.resolveGoalConflict(accountId, desiredId, resolution, this.context.now());
  }
  converge(accountId: AccountId) { return this.convergenceService.converge(accountId); }
  syncMarketHistory(accountId: AccountId, pageSize?: number) {
    return this.settledAfter(accountId, this.marketService.orders.syncHistory(accountId, pageSize));
  }

  /**
   * One market walk, answered once it is settled. The walk decides listing *and* buy-order
   * actions in the same settle, so both see the same snapshot — as does every other path that
   * walks the market, which is the point (settling and read path plan D1).
   */
  syncMarket(accountId: AccountId, pageSize = 500): Promise<MarketSyncResult> {
    return this.settledAfter(accountId, this.marketService.sync(accountId, pageSize));
  }

  syncWallet(accountId: AccountId): Promise<number> {
    return this.settledAfter(accountId, this.marketService.syncWallet(accountId));
  }

  // ---------------------------------------------------------------- in-game store
  /**
   * The Store screen's refresh: a person need for the price sheet. Answers with the walk's
   * observation id; a sheet that could not be read or parsed throws the surface's own words, as
   * the surface itself does, and a refusal the broker made throws its reason.
   */
  async syncStorePriceSheet(accountId: AccountId): Promise<number> {
    const outcome = await this.reads.need(accountId, { ref: { surface: 'gc-store-price-sheet', scope: { kind: 'account' } }, startedAfter: this.context.now(), priority: 'person' });
    if (outcome.kind === 'observed') return outcome.observation.id;
    throw new Error(outcome.detail ?? `Store price sheet not read: ${outcome.reason}`);
  }
  queueStorePurchase(request: StorePurchaseRequest) { return this.inGameStore.queue(request); }
  advanceStorePurchase(purchaseId: string): Promise<void> { return this.inGameStore.advance(purchaseId); }
  cancelStorePurchase(purchaseId: string): Promise<void> { return this.inGameStore.cancel(purchaseId); }
  reconcileStorePurchases(accountId: AccountId): void { this.settler.settleNow(accountId); }
  storeSheet(accountId: AccountId) { return readStoreSheet(this.database, accountId); }
  storePurchases(accountId: AccountId, cursor?: string) { return pageStorePurchases(this.database, accountId, cursor); }
  storePurchase(accountId: AccountId, id: string) { return readStorePurchase(this.database, accountId, id); }

  queueSellListing(accountId: AccountId, localId: string, priceReceiveCents: number, commandId: string | null = null): ActionRow {
    return this.marketService.queueSellListing(accountId, localId, priceReceiveCents, commandId);
  }

  executeSellListing(actionId: string): Promise<MutationOutcome> {
    return this.marketService.executeSellListing(actionId);
  }

  queueDelist(accountId: AccountId, listingId: string): ActionRow {
    return this.marketService.queueDelist(accountId, listingId);
  }

  executeDelist(actionId: string): Promise<MutationOutcome> {
    return this.marketService.executeDelist(actionId);
  }

  // --- Buy orders ----------------------------------------------------------

  createBuyOrder(accountId: AccountId, request: BuyOrderRequest): Promise<ActionRow> {
    return this.buyOrderService.create(accountId, request);
  }

  executeBuyOrder(actionId: string): Promise<MutationOutcome> {
    return this.buyOrderService.execute(actionId);
  }

  queueCancelBuyOrder(accountId: AccountId, buyOrderId: string): ActionRow {
    return this.buyOrderService.queueCancel(accountId, buyOrderId);
  }

  executeCancelBuyOrder(actionId: string): Promise<MutationOutcome> {
    return this.buyOrderService.executeCancel(actionId);
  }

  syncBuyOrderStatuses(accountId: AccountId): Promise<void> {
    return this.buyOrderService.syncStatuses(accountId);
  }

  // --- Orders --------------------------------------------------------------

  /** A person's exit from an unexplained order (consolidation plan D7): closed as cancelled or sold, on their word, as a correction beside what was observed. */
  closeOrder(accountId: AccountId, orderId: string, as: 'cancelled' | 'sold'): VenueOrderRow {
    return this.marketService.orders.close(accountId, orderId, as);
  }

  // --- Trade observation ---------------------------------------------------

  /**
   * Reads the offer book. Nothing here sends, accepts or cancels an offer: trade actions are
   * deferred (requirements §1.2), and an offer is evidence about a commitment, never a delivery.
   */
  syncTradeOffers(accountId: AccountId): Promise<TradeSyncResult> {
    return this.settledAfter(accountId, this.tradeService.syncOffers(accountId));
  }

  /** Walks executed trade history from its committed checkpoint, with an overlap window. */
  syncTradeHistory(accountId: AccountId): Promise<TradeSyncResult> {
    return this.settledAfter(accountId, this.tradeService.syncHistory(accountId));
  }

  // --- Read models ---------------------------------------------------------

  submitCommand(request: CommandRequest): CommandRow {
    return this.commands.submit(request);
  }

  dispatchCommand(commandId: string): Promise<MutationOutcome[]> {
    return this.commands.dispatch(commandId);
  }

  stopCommand(commandId: string): CommandRow {
    return this.commands.stop(commandId);
  }

  captureSelection(request: SelectionCaptureRequest): SelectionSnapshot {
    return this.commands.captureSelection(request);
  }

  updateSelection(token: string, revision: number, patch: { exclude?: SelectionCaptureRequest['members'] }): SelectionSnapshot {
    return this.commands.updateSelection(token, revision, patch.exclude ? { exclude: patch.exclude } : {});
  }

  readSelection(token: string): SelectionSnapshot {
    return this.commands.readSelection(token);
  }

  commandProgress(commandId: string): CommandProgress {
    return this.commands.commandProgress(commandId);
  }

  pageInventory(request: import('./read/queries/inventory.js').InventoryPageRequest) {
    return this.views.pageInventory(request);
  }

  /** The default inventory view. Identity and counts; the host attaches names. */
  pageInventoryGroups(request: import('./read/queries/inventory.js').InventoryPageRequest) {
    return this.views.pageInventoryGroups(request);
  }

  pageInventoryPositions(request: import('./read/queries/inventory.js').InventoryPositionsRequest) {
    return this.views.pageInventoryPositions(request);
  }

  pageHistory(request: import('./read/queries/records.js').HistoryPageRequest) {
    return this.views.pageHistory(request);
  }

  pageStorage(request: import('./read/queries/paging.js').ScopedPageRequest) {
    return this.views.pageStorage(request);
  }

  pageOrders(request: import('./read/queries/paging.js').ScopedPageRequest) {
    return this.views.pageOrders(request);
  }

  pageActivity(request: import('./read/queries/paging.js').ScopedPageRequest) {
    return this.views.pageActivity(request);
  }

  pageTrades(request: import('./read/queries/paging.js').ScopedPageRequest) {
    return this.views.pageTrades(request);
  }

  /** Every open listing in a scope, across accounts and venues. Money grouped, never converted. */
  pageListings(request: import('./read/queries/listings.js').ListingPageRequest) {
    return this.views.pageListings(request);
  }

  listingsSummary(request: import('./read/queries/listings.js').ListingPageRequest) {
    return this.views.listingsSummary(request);
  }

  pageLedger(request: import('./read/queries/paging.js').ScopedPageRequest) {
    return this.views.pageLedger(request);
  }

  /** Stacks as a read: the fungible units of each group at each location, summed (`db/holdings.ts`). */
  commodities(accountId: AccountId): CommodityStackRow[] {
    return new HoldingsStore(this.database).commodityStacks(accountId);
  }

  inventory(accountId: AccountId): ItemRow[] {
    return this.views.inventory(accountId);
  }

  storageView(accountId: AccountId): unknown[] {
    return this.views.storage(accountId);
  }

  dryRunPlan(accountId: AccountId): PlannedAction[] {
    return this.views.dryRunPlan(accountId);
  }

  marketView(accountId: AccountId): MarketView {
    return this.views.market(accountId);
  }

  /**
   * Observed holdings for exactly the accounts named.
   *
   * The caller names them because nothing here has a current account to fall back on (rule 8).
   */
  portfolio(accountIds: readonly AccountId[]): AccountHoldings[] {
    return this.views.portfolio(accountIds);
  }
}
