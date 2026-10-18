import {
  convert, currencyById, dayOf, unitPrice, valuePositions,
  type Converted, type FillEntry, type FxRates, type Position, type Valuation, type ValuedPosition
} from '@cslytics/market-data';
import type { AccountHoldings, InventoryPositionRow, PositionsEnvelope } from '@cslytics/engine';
import { baseCurrencyOf, type DesktopSettings, type EngineCommand } from '../../shared/api.js';
import type {
  AccountFigures, BaseSum, ItemCurve, ItemHistory, ItemHolding, ItemPage, ItemVariants, ObservedByCurrency, ObservedFigure, ObservedKey, PortfolioValuation
} from '../../shared/market.js';
import type { CatalogueMediator, EnrichedRow } from '../catalogue/mediator.js';
import type { MarketDataHost } from './host.js';

/**
 * The portfolio's figures, assembled in main (portfolio and pricing plan §3): identity and counts
 * from the engine, names from the catalogue, books and rates from the cache, the base from the
 * settings. The window formats what comes back and computes nothing.
 */

export type PortfolioDeps = {
  host: MarketDataHost;
  catalogue: CatalogueMediator;
  settings: () => DesktopSettings;
  /**
   * A read against the engine runtime. Typed to the command schema on purpose: `inventory.positions`
   * once went out as `unknown`, reached a dispatch table with no row for it, and came back as
   * `undefined`, so the valuation crashed reading `.kind` of nothing. A command the schema does
   * not name now fails the typecheck instead.
   */
  invoke: (command: EngineCommand) => Promise<unknown>;
  now?: () => Date;
};

/** The catalogue's def index for a storage unit: held, never priced. */
const STORAGE_UNIT_DEF_INDEX = 1201;

/** An engine positions row with its name attached: what the valuation prices. */
export function toPosition(row: InventoryPositionRow & EnrichedRow): Position {
  const unpriced = row.catalogueMarketable === false ? 'display-only'
    : row.defIndex === STORAGE_UNIT_DEF_INDEX ? 'storage-unit'
      : row.marketHashName === null ? 'unresolved'
        : null;
  return {
    accountId: row.accountId,
    matchKey: row.matchKey,
    wearBand: row.wearBand,
    name: row.marketHashName,
    category: row.category,
    quantity: row.quantity,
    main: row.main,
    storage: row.storage,
    listed: row.listed,
    unpriced
  };
}

function figure(cents: number, currency: string, base: string, fx: FxRates | null): ObservedFigure {
  return { cents, currency, converted: currency === base ? null : convert(cents, currency, base, fx) };
}

type ObservedCents = {
  steam: number; steamPending: number; csfloat: number; csfloatPending: number;
  reserved: number; listed: number; onHold: number; awaiting: number; buyOrders: number;
};

const NO_CENTS: ObservedCents = { steam: 0, steamPending: 0, csfloat: 0, csfloatPending: 0, reserved: 0, listed: 0, onHold: 0, awaiting: 0, buyOrders: 0 };

const OBSERVED_KEYS: readonly ObservedKey[] = [
  'steam', 'steamPending', 'csfloat', 'csfloatPending', 'wallets', 'reserved', 'listed', 'onHold', 'listings', 'awaitingConfirmation', 'buyOrders'
];

/**
 * Observed money grouped by currency, each figure converted to the base when a rate exists.
 *
 * Every Steam figure is in the Steam wallet's currency, and an account whose wallet has never been
 * observed has no currency for them, so they are left out. The CSFloat balance is in its own
 * currency whatever the Steam wallet's, so one account can put money into two groups.
 */
export function observedByCurrency(holdings: readonly AccountHoldings[], base: string, fx: FxRates | null): ObservedByCurrency[] {
  const groups = new Map<string, { accounts: Set<string>; cents: ObservedCents }>();
  const groupOf = (currency: number | null, accountId: string): ObservedCents | null => {
    const code = currencyById(currency)?.code;
    if (code === undefined) return null;
    const group = groups.get(code) ?? { accounts: new Set<string>(), cents: { ...NO_CENTS } };
    group.accounts.add(accountId);
    groups.set(code, group);
    return group.cents;
  };
  for (const row of holdings) {
    const steam = groupOf(row.currency, row.accountId);
    if (steam) {
      steam.steam += row.wallet?.balanceCents ?? 0;
      steam.steamPending += row.wallet?.delayedBalanceCents ?? 0;
      steam.reserved += row.reservedCents;
      steam.listed += row.listedReceiveCents;
      steam.onHold += row.onHoldReceiveCents;
      steam.awaiting += row.awaitingConfirmationReceiveCents;
      steam.buyOrders += row.buyOrderOpenCents;
    }
    const csfloat = row.csfloatWallet ? groupOf(row.csfloatWallet.currency, row.accountId) : null;
    if (csfloat && row.csfloatWallet) {
      csfloat.csfloat += row.csfloatWallet.availableCents;
      csfloat.csfloatPending += row.csfloatWallet.pendingCents;
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, { accounts, cents }]) => {
    const at = (value: number): ObservedFigure => figure(value, currency, base, fx);
    return {
      currency,
      accounts: accounts.size,
      steam: at(cents.steam),
      steamPending: at(cents.steamPending),
      csfloat: at(cents.csfloat),
      csfloatPending: at(cents.csfloatPending),
      // What the headline adds to the inventory. Never the listings, whose units the inventory
      // values already, and never buy orders, which are inside the Steam wallet.
      wallets: at(cents.steam + cents.steamPending + cents.csfloat + cents.csfloatPending),
      reserved: at(cents.reserved),
      listed: at(cents.listed),
      onHold: at(cents.onHold),
      listings: at(cents.listed + cents.onHold),
      awaitingConfirmation: at(cents.awaiting),
      buyOrders: at(cents.buyOrders)
    };
  });
}

/** Each observed quantity, every currency converted once and added in the base. */
export function observedInBase(observed: readonly ObservedByCurrency[], base: string): Record<ObservedKey, BaseSum> {
  return Object.fromEntries(OBSERVED_KEYS.map((key) => [key, sumInBase(observed.map((group) => group[key]), base)])) as Record<ObservedKey, BaseSum>;
}

function sumInBase(figures: readonly ObservedFigure[], base: string): BaseSum {
  let cents = 0;
  let any = false;
  const missing: string[] = [];
  for (const entry of figures) {
    // Nothing is nothing in every currency: a zero needs no rate, and must not make a total a floor.
    if (entry.currency === base || entry.cents === 0) { cents += entry.cents; any = true; continue; }
    if (entry.converted === null) { missing.push(entry.currency); continue; }
    cents += entry.converted.cents;
    any = true;
  }
  return { cents: any ? cents : null, complete: missing.length === 0, missingCurrencies: missing };
}

/**
 * Each account's wallets and inventory in the base, and the two added: what the per-account table
 * shows beside the headline. Every subtotal is converted once per currency, as the headline's are.
 */
export function accountFigures(holdings: readonly AccountHoldings[], valuation: Valuation | null, base: string, fx: FxRates | null): AccountFigures[] {
  return holdings.map((row) => {
    const wallets = observedInBase(observedByCurrency([row], base, fx), base).wallets;
    const inventory = valuation === null ? null : inventoryInBase(valuation.positions.filter((position) => position.accountId === row.accountId), base, fx);
    return { accountId: row.accountId, wallets, inventory, total: added(wallets, inventory) };
  });
}

/** Priced positions at the mid price, one subtotal per book currency, each converted once. Nothing priced is nothing. */
function inventoryInBase(positions: readonly ValuedPosition[], base: string, fx: FxRates | null): BaseSum {
  const natives = new Map<string, number>();
  for (const row of positions) {
    if (!row.priced) continue;
    natives.set(row.marketValue.native.currency, (natives.get(row.marketValue.native.currency) ?? 0) + row.marketValue.native.cents);
  }
  if (natives.size === 0) return { cents: 0, complete: true, missingCurrencies: [] };
  return sumInBase([...natives].map(([currency, cents]) => figure(cents, currency, base, fx)), base);
}

/** Two sums in the base. A part that is missing, or was never computed, leaves the result a floor. */
function added(left: BaseSum, right: BaseSum | null): BaseSum {
  const parts = [left.cents, right?.cents ?? null].filter((cents): cents is number => cents !== null);
  return {
    cents: parts.length === 0 ? null : parts.reduce((sum, cents) => sum + cents, 0),
    complete: left.complete && right !== null && right.complete,
    missingCurrencies: [...new Set([...left.missingCurrencies, ...(right?.missingCurrencies ?? [])])].sort()
  };
}

export async function portfolioValuation(deps: PortfolioDeps, accountIds: readonly string[]): Promise<PortfolioValuation> {
  const settings = deps.settings();
  const base = baseCurrencyOf(settings);
  const fx = deps.host.store.latestFx() ?? null;
  const [positions, holdings] = await Promise.all([
    deps.invoke({ type: 'inventory.positions', accountIds: [...accountIds] }) as Promise<PositionsEnvelope>,
    deps.invoke({ type: 'portfolio.read', accountIds: [...accountIds] }) as Promise<AccountHoldings[]>
  ]);
  const observed = observedByCurrency(holdings, base, fx);
  const inBase = observedInBase(observed, base);
  const wallet = inBase.wallets;
  const lastSnapshotDay = deps.host.store.valuationSnapshots(accountIds).reduce<string | null>((latest, row) => (latest === null || row.day > latest ? row.day : latest), null);

  if (positions.kind !== 'positions') {
    // Nothing is held for pricing, so there is nothing to wait for: the page shows the observed
    // money and says the scope is too large to appraise, rather than "pricing" for ever.
    return {
      base, settings: settings.currency, valuation: null, needsFilter: { groups: positions.groups, cap: positions.cap }, observed, observedInBase: inBase, wallet,
      total: { cents: null, complete: false, missingCurrencies: wallet.missingCurrencies }, accounts: accountFigures(holdings, null, base, fx),
      status: deps.host.status(), fill: deps.host.fill(), valued: true, lastSnapshotDay, observedIn: null
    };
  }

  const rows = deps.catalogue.enrich(positions.rows).map(toPosition);
  const names = [...new Set(rows.map((row) => row.name).filter((name): name is string => name !== null))];
  const books = deps.host.store.books(names);
  const statuses = deps.host.store.statuses(names);
  const valuation = valuePositions({ positions: rows, books, statuses, fx, base });

  // What the scheduler should keep fresh, heaviest first: a stack's value, as far as it is known.
  const weights = new Map<string, number>();
  for (const row of valuation.positions) {
    if (row.name === null) continue;
    const cents = row.priced ? row.marketValue.native.cents : 0;
    weights.set(row.name, (weights.get(row.name) ?? 0) + cents);
  }
  const held: FillEntry[] = names.map((name) => ({ name, weightCents: weights.get(name) ?? 0 }));
  deps.host.hold(held);
  // Read after `hold`, so the progress and the gate describe the fill these figures are part of.
  const status = deps.host.status();
  const valued = deps.host.valued();

  const total = totalInBase(wallet, valuation, base);
  const observedIn = newestBookCurrency(valuation);

  // The day's snapshot, only over a finished fill and settled walks (plan D12, §8 e): a figure taken
  // mid-fill or over an unfinished walk is a floor, and a floor must not become history.
  if (deps.host.filled() && holdings.every((row) => row.inventory.settled && row.market.settled)) {
    writeSnapshots(deps, holdings, rows, books, statuses, fx, base);
  }

  return {
    base, settings: settings.currency, valuation, needsFilter: null, observed, observedInBase: inBase, wallet, total,
    accounts: accountFigures(holdings, valuation, base, fx), status, fill: deps.host.fill(), valued, lastSnapshotDay, observedIn
  };
}

function totalInBase(wallet: PortfolioValuation['wallet'], valuation: Valuation, base: string): PortfolioValuation['total'] {
  const missing = [...new Set([...wallet.missingCurrencies, ...valuation.marketValue.missingCurrencies])].sort();
  const parts = [wallet.cents, valuation.marketValue.cents].filter((cents): cents is number => cents !== null);
  return { cents: parts.length === 0 ? null : parts.reduce((sum, cents) => sum + cents, 0), complete: wallet.complete && valuation.marketValue.complete && valuation.base === base, missingCurrencies: missing };
}

function newestBookCurrency(valuation: Valuation): string | null {
  let newest: { at: string; currency: number } | null = null;
  for (const row of valuation.positions) {
    if (!row.priced) continue;
    if (newest === null || row.observedAt > newest.at) newest = { at: row.observedAt, currency: row.bookCurrency };
  }
  return newest === null ? null : currencyById(newest.currency)?.code ?? null;
}

function writeSnapshots(deps: PortfolioDeps, holdings: readonly AccountHoldings[], rows: readonly Position[], books: ReadonlyMap<string, import('@cslytics/market-data').StoredBook>, statuses: ReadonlyMap<string, import('@cslytics/market-data').NameStatus>, fx: FxRates | null, base: string): void {
  const day = dayOf((deps.now ?? (() => new Date()))().toISOString());
  for (const account of holdings) {
    const own = rows.filter((row) => row.accountId === account.accountId);
    if (own.length === 0) continue;
    const valuation = valuePositions({ positions: own, books, statuses, fx, base });
    for (const basis of ['mid', 'liquidation'] as const) {
      const total = basis === 'mid' ? valuation.marketValue : valuation.liquidation;
      for (const subtotal of total.subtotals) {
        deps.host.store.putValuationSnapshot({
          accountId: account.accountId, day, basis, currency: subtotal.currency, cents: subtotal.cents,
          namesPriced: valuation.kinds.priced, namesUnpriced: valuation.kinds.unpriced, unitsUnpriced: valuation.units.unpriced, fxAsOf: fx?.asOf ?? null
        });
      }
    }
  }
}

export async function itemPage(deps: PortfolioDeps, name: string, accountIds: readonly string[]): Promise<ItemPage> {
  const settings = deps.settings();
  const base = baseCurrencyOf(settings);
  const fx = deps.host.store.latestFx() ?? null;
  const book = deps.host.watch(name);
  const positions = await deps.invoke({ type: 'inventory.positions', accountIds: [...accountIds] }) as PositionsEnvelope;
  const holdings: ItemHolding[] = positions.kind === 'positions'
    ? deps.catalogue.enrich(positions.rows).filter((row) => row.marketHashName === name)
      .map((row) => ({ accountId: row.accountId, quantity: row.quantity, main: row.main, storage: row.storage, listed: row.listed, minWear: row.minWear }))
    : [];
  // The series and the curve are not awaited here: either may be a network fetch, and the book,
  // the holding and the kept days are already in the cache. Each has its own command.
  const status = deps.host.store.status(name) ?? null;
  const daily = book ? deps.host.store.bookDaily(name, book.currency) : [];
  const code = book ? currencyById(book.currency)?.code ?? null : null;
  const convertTo = (cents: number | null): Converted | null => (cents === null || code === null || code === base ? null : convert(cents, code, base, fx));
  const mid = book ? unitPrice(book) : null;
  return {
    name, holdings, book, status, daily, base,
    converted: { mid: convertTo(mid?.cents ?? null), ask: convertTo(book?.lowestAskCents ?? null), bid: convertTo(book?.highestBidCents ?? null) }
  };
}

/** The Steam series for a name: from the cache, or fetched once when it is missing or a day old. */
export function itemHistory(deps: PortfolioDeps, name: string): Promise<ItemHistory> {
  return deps.host.ensureHistory(name);
}

/** The published float curve for a name on a venue, with a recorded absence when there is none. */
export function itemCurve(deps: PortfolioDeps, name: string, venue: 'steam' | 'csfloat'): Promise<ItemCurve> {
  return deps.host.ensureCurve(venue, name);
}

/**
 * The market names an item is sold under, each with the units the scope holds of it: the
 * catalogue's tiers, counted over the same positions read the valuation makes, by catalogue key
 * and wear band. A scope too large to summarise answers `held: null`, never zero.
 */
export async function itemVariants(deps: PortfolioDeps, name: string, accountIds: readonly string[]): Promise<ItemVariants> {
  const answer = deps.catalogue.variantsOf(name);
  const positions = accountIds.length === 0 ? null : await deps.invoke({ type: 'inventory.positions', accountIds: [...accountIds] }) as PositionsEnvelope;
  const rows = positions?.kind === 'positions' ? positions.rows : null;
  return {
    ...answer,
    variants: answer.variants.map(({ keys, band, ...variant }) => {
      if (rows === null) return { ...variant, held: null };
      const wanted = new Set(keys);
      const held = rows.reduce((sum, row) => (wanted.has(row.matchKey) && (band === null || row.wearBand === band) ? sum + row.quantity : sum), 0);
      return { ...variant, held };
    })
  };
}
