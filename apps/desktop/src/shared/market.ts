import type {
  Converted, DailyTop, NameStatus, SchedulerStatus, StoredBook, StoredCurve, StoredHistory, Valuation, ValuationSnapshotRow
} from '@cslytics/market-data';
import type { CurrencySettings } from './api.js';

/**
 * What main answers about prices (portfolio and pricing plan §3). Types only: the window formats
 * these and computes nothing; main assembles them from the engine's reads, the catalogue and the
 * market-data cache. Every amount is integer hundredths beside its ISO code.
 */

/** One figure a venue named, in its own currency, and its conversion to the base when one exists. */
export type ObservedFigure = { cents: number; currency: string; converted: Converted | null };

/**
 * Observed money in one currency. A figure lands in the group of its own currency, not its
 * account's: an AUD account's CSFloat balance is US dollars, so it is in the USD group.
 */
export type ObservedByCurrency = {
  currency: string;
  /** Accounts with a figure in this currency: a Steam wallet in it, or a CSFloat balance. */
  accounts: number;
  /** Steam wallet, spendable. */
  steam: ObservedFigure;
  /** Steam wallet, pending: Steam's delayed balance. */
  steamPending: ObservedFigure;
  /** CSFloat balance, spendable. */
  csfloat: ObservedFigure;
  /** CSFloat balance, pending. */
  csfloatPending: ObservedFigure;
  /** Every wallet, spendable and pending: the money the headline adds to the inventory. */
  wallets: ObservedFigure;
  /** Held back out of the Steam wallet by this app's own pending buys. */
  reserved: ObservedFigure;
  /** Seller-receives on live listings. */
  listed: ObservedFigure;
  /** Seller-receives on listings Steam is holding. */
  onHold: ObservedFigure;
  /** Seller-receives across live and on-hold listings. Never added to a total: the units are valued in inventory. */
  listings: ObservedFigure;
  awaitingConfirmation: ObservedFigure;
  /** Inside the Steam wallet already: never added to it. */
  buyOrders: ObservedFigure;
};

/** The observed quantities a page shows, each one per currency above. */
export type ObservedKey = Exclude<keyof ObservedByCurrency, 'currency' | 'accounts'>;

/** One account's holdings in the base: its wallets, its inventory at the mid price, and the two added. */
export type AccountFigures = {
  accountId: string;
  wallets: BaseSum;
  /** `null` when the scope was too large to value. */
  inventory: BaseSum | null;
  total: BaseSum;
};

/**
 * Figures in several currencies, each converted once and added in the base. `cents` is `null` when
 * nothing could be converted; `missingCurrencies` names what was left out, which makes the figure a
 * floor rather than a total.
 */
export type BaseSum = { cents: number | null; complete: boolean; missingCurrencies: string[] };

/**
 * What the price fill is doing: `slowed` is the latency governor holding the queues for a minute,
 * `paused` the window hidden past its grace, `stopped` a 429 or a run of failures.
 */
export type FillState = 'idle' | 'filling' | 'complete' | 'stopped' | 'slowed' | 'paused';

export type PortfolioValuation = {
  base: string;
  settings: CurrencySettings;
  /** `null` when the engine asked for a filter first: the scope holds more kinds than it will summarise. */
  valuation: Valuation | null;
  needsFilter: { groups: number; cap: number } | null;
  observed: ObservedByCurrency[];
  /**
   * Each observed quantity across every currency, converted to the base and added: what the
   * portfolio page shows when its accounts hold different wallet currencies (plan §5.2).
   */
  observedInBase: Record<ObservedKey, BaseSum>;
  /** Every wallet, Steam and CSFloat, spendable and pending, converted to the base and added. */
  wallet: BaseSum;
  /** Wallets plus inventory market value, in the base. A floor when either part is incomplete. */
  total: BaseSum;
  /** The same figures for each account in the scope, in the order the scope named them. */
  accounts: AccountFigures[];
  status: SchedulerStatus;
  fill: FillState;
  /**
   * Every held name has been asked this fill, whatever it answered. Until then no total is shown:
   * a figure over half the books is a floor, and a floor shown as a total is the one that moves.
   */
  valued: boolean;
  /** The newest day a valuation snapshot was written for any of these accounts. */
  lastSnapshotDay: string | null;
  /** Where the order book's prices were observed from: the currency of the newest book, by code. */
  observedIn: string | null;
};

export type ItemHolding = {
  accountId: string;
  quantity: number;
  main: number;
  storage: number;
  listed: number;
  minWear: number | null;
};

/**
 * What `item.page` answers at once, from the cache: the holding, the newest book and the days this
 * desktop kept. The series and the curve may need the network, so each is its own command
 * (`item.history`, `item.curve`) and its panel waits for it alone.
 */
export type ItemPage = {
  name: string;
  holdings: ItemHolding[];
  book: StoredBook | null;
  status: NameStatus | null;
  daily: DailyTop[];
  base: string;
  /** The book's figures converted to the page's currency, when a rate exists. */
  converted: { mid: Converted | null; ask: Converted | null; bid: Converted | null };
};

export type ItemHistory = StoredHistory | null;
export type ItemCurve = StoredCurve | null;

/** One market name an item is sold under, with how many units of it the scope holds. */
export type ItemVariant = {
  name: string;
  /** `FN` … `BS`, or `null` for an item with no wear. */
  tier: string | null;
  label: string | null;
  /** Units held across the scope; `null` when the scope is too large to count without a filter. */
  held: number | null;
};

/** The Items page's header: the item's kind and picture, and every market name it is sold under. */
export type ItemVariants = {
  base: string;
  known: boolean;
  category: string | null;
  rarity: { id: string; name: string; colour: string } | null;
  imageUrl: string | null;
  marketable: boolean | null;
  minFloat: number | null;
  maxFloat: number | null;
  variants: ItemVariant[];
};

export type MarketHistoryRow = ValuationSnapshotRow;
