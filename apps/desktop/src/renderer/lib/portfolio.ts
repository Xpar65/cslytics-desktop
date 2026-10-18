import type { BaseSum, ObservedKey, PortfolioValuation } from '../../shared/market.js';
import { conversionNote } from './money.js';
import type { AccountHoldings, SurfaceEvidence } from './types.js';

/**
 * Portfolio presentation over figures main has already assembled.
 *
 * Every money figure on the page comes from main's valuation (`main/market-data/portfolio.ts`,
 * portfolio and pricing plan §3): the observed money grouped by its own currency, each group
 * converted once, and the inventory at the mid price. This file decides how those figures *read*:
 * which one is printed large, what sits quietly beside it, which segments the bar draws. It adds
 * nothing across currencies itself, and it never values an item.
 *
 * What it does compute from the engine's holdings is what is not money: counts, and how old and how
 * complete the evidence behind them is.
 *
 * Pure functions on purpose. Vitest runs in a node environment with no DOM, so this is the half of
 * the portfolio that can be tested; the component that renders it is the half that cannot.
 */

/** One amount to print, in its own currency. `approx` marks a figure that went through FX. */
export type Amount = { cents: number; currency: string; approx: boolean };

/**
 * How one observed quantity reads.
 *
 * One part, in one currency: that native figure, with its base equivalent beside it when it was
 * converted. Several parts: their sum in the base, marked `≈` when any part was converted, with the
 * natives beside it; when nothing converts, the natives themselves, side by side, never added.
 */
export type QuantityView = {
  /** Printed large. Empty when the scope holds none of it. */
  main: Amount[];
  /** Printed quietly under it. */
  beside: Amount[];
  /** Currencies holding some of it that have no rate: left out of a converted sum, which is then a floor. */
  missing: string[];
  /** Each conversion's rate and date, for the hover. */
  notes: string[];
};

export function quantity(answer: Pick<PortfolioValuation, 'base' | 'observed' | 'observedInBase'>, key: ObservedKey): QuantityView {
  const parts = answer.observed.map((group) => group[key]).filter((figure) => figure.cents !== 0);
  const notes = parts.flatMap((figure) => (figure.converted ? [conversionNote(figure.converted)] : []));
  const natives = parts.map((figure) => ({ cents: figure.cents, currency: figure.currency, approx: false }));
  if (parts.length === 0) return { main: [], beside: [], missing: [], notes };
  if (parts.length === 1) {
    const converted = parts[0]!.converted;
    return { main: natives, beside: converted ? [{ cents: converted.cents, currency: converted.currency, approx: true }] : [], missing: [], notes };
  }
  const sum = answer.observedInBase[key];
  if (sum.cents === null) return { main: natives, beside: [], missing: sum.missingCurrencies, notes };
  return {
    main: [{ cents: sum.cents, currency: answer.base, approx: parts.some((figure) => figure.currency !== answer.base) }],
    beside: natives,
    missing: sum.missingCurrencies,
    notes
  };
}

export type HoldingsSegmentKey = 'steam' | 'steamPending' | 'csfloat' | 'csfloatPending' | 'inventory';

export type HoldingsSegment = {
  key: HoldingsSegmentKey;
  label: string;
  /** The token holding this segment's colour. Segments are data, so they are never the accent. */
  variable: string;
  /** Hatched in the bar: money a venue is holding and has not let the account spend yet. */
  pending: boolean;
  cents: number;
};

/**
 * The wallet parts of the bar: each venue's spendable money, solid, and its pending money, hatched
 * in the same hue. Listings are not segments, because a listed item stays a holding until it sells
 * and is inside the appraisal already (N-SELL-06); nor are buy orders, which are inside the Steam
 * wallet. Either would count the same cents twice.
 */
const WALLET_SEGMENTS: ReadonlyArray<Omit<HoldingsSegment, 'cents'> & { key: Extract<ObservedKey, HoldingsSegmentKey> }> = [
  { key: 'steam', label: 'Steam wallet', variable: '--cs-hold-wallet', pending: false },
  { key: 'steamPending', label: 'Steam pending', variable: '--cs-hold-wallet', pending: true },
  { key: 'csfloat', label: 'CSFloat balance', variable: '--cs-hold-csfloat', pending: false },
  { key: 'csfloatPending', label: 'CSFloat pending', variable: '--cs-hold-csfloat', pending: true }
];

/**
 * The holdings bar, in the base: every wallet part as main converted it, then the inventory at the
 * mid price, solid, because an appraisal is not money a venue holds. A part with no rate is left
 * out at zero width; the headline names it and calls the figure a floor. `null` inventory draws no
 * inventory segment, for a scope that could not be valued.
 */
export function holdingsSegments(inBase: Readonly<Record<ObservedKey, BaseSum>>, inventoryCents: number | null): HoldingsSegment[] {
  const out: HoldingsSegment[] = WALLET_SEGMENTS.map((segment) => ({ ...segment, cents: inBase[segment.key].cents ?? 0 }));
  if (inventoryCents !== null) out.push({ key: 'inventory', label: 'Inventory', variable: '--cs-hold-inventory', pending: false, cents: inventoryCents });
  return out;
}

/** The holdings bar added up, in the bar's one currency. */
export function totalHoldingsCents(bar: readonly HoldingsSegment[]): number {
  return bar.reduce((total, segment) => total + segment.cents, 0);
}

/** What the portfolio counts across accounts, and how far its evidence can be trusted. Never money. */
export type PortfolioTotals = {
  accounts: number;
  counts: AccountHoldings['counts'];
  /** The worst evidence across the accounts: one unfinished walk makes the whole total a floor. */
  inventory: SurfaceEvidence;
  market: SurfaceEvidence;
  /** Accounts whose CSFloat balance is known for the key connected now, and the oldest of those reads. */
  csfloat: { accounts: number; observedAt: string | null };
};

const ZERO_COUNTS: AccountHoldings['counts'] = {
  itemsMain: 0,
  itemsCrated: 0,
  itemsListed: 0,
  commodityMain: 0,
  commodityCrated: 0,
  commodityListed: 0,
  fungibleUnits: 0,
  listingsActive: 0,
  listingsOnHold: 0,
  listingsAwaitingConfirmation: 0,
  buyOrdersActive: 0,
  csfloatBuyOrdersActive: 0,
  storageUnits: 0,
  storedItems: 0
};

const NO_EVIDENCE: SurfaceEvidence = { observedAt: null, settled: false };

export function aggregate(rows: readonly AccountHoldings[]): PortfolioTotals {
  const counts = { ...ZERO_COUNTS };
  // Evidence folds from the first row rather than from a seed. A `null` seed would make
  // `worse` return "never observed" for every portfolio, since a null timestamp beats every
  // real one — which is how a total quietly loses the age it was supposed to be reporting.
  let inventory: SurfaceEvidence | null = null;
  let market: SurfaceEvidence | null = null;
  for (const row of rows) {
    for (const key of Object.keys(counts) as Array<keyof AccountHoldings['counts']>) {
      counts[key] += row.counts[key];
    }
    inventory = inventory === null ? row.inventory : worse(inventory, row.inventory);
    market = market === null ? row.market : worse(market, row.market);
  }
  // A balance nobody has read adds no money, so it adds no age either: the oldest of the reads there are.
  const csfloatReads = rows.flatMap((row) => (row.csfloatWallet ? [row.csfloatWallet.observedAt] : [])).sort();
  return {
    accounts: rows.length,
    counts,
    inventory: inventory ?? NO_EVIDENCE,
    market: market ?? NO_EVIDENCE,
    csfloat: { accounts: csfloatReads.length, observedAt: csfloatReads[0] ?? null }
  };
}

/** Holdings by place, both kinds added together, and how many of those in main inventory are listed. */
export type HeldCounts = { main: number; crated: number; listed: number; total: number };

/**
 * How many holdings sit in each place, individual items and stackable units together.
 *
 * The engine counts the two kinds apart (`itemsCrated` beside `commodityCrated`), but the
 * inventory lists one row per holding of either kind, so any count shown beside it adds them.
 * Reading `itemsCrated` alone is how a storage unit full of cases read "0 in storage".
 *
 * `listed` is a share of `main`, never a third place: the Game Coordinator keeps a listed item in
 * main inventory until it sells, so the engine already counts it there. Adding it to the total
 * would count every listed item twice.
 */
export function heldCounts(counts: AccountHoldings['counts']): HeldCounts {
  const main = counts.itemsMain + counts.commodityMain;
  const crated = counts.itemsCrated + counts.commodityCrated;
  const listed = counts.itemsListed + counts.commodityListed;
  return { main, crated, listed, total: main + crated };
}

/**
 * The weaker of two pieces of evidence.
 *
 * Unsettled wins, and the older timestamp wins, because a total is only as current as the
 * least current account inside it. Reporting the freshest one would say the portfolio is up to
 * date when half of it has not been walked since yesterday.
 */
function worse(left: SurfaceEvidence, right: SurfaceEvidence): SurfaceEvidence {
  const observedAt = left.observedAt === null || right.observedAt === null
    ? null
    : (left.observedAt < right.observedAt ? left.observedAt : right.observedAt);
  return { observedAt, settled: left.settled && right.settled };
}

/**
 * How old an observation is, in the three bands the incumbent's `StaleDataIndicator` uses.
 *
 * `none` is not "0 seconds old" — it is *nothing has been observed*, which is the state a
 * freshly signed-in account is in until the first sync, and it must not read as fresh.
 */
export type Freshness = { tone: 'fresh' | 'aging' | 'stale' | 'none'; label: string };

export function freshness(observedAt: string | null, now = new Date()): Freshness {
  if (!observedAt) return { tone: 'none', label: 'not synced' };
  const at = new Date(observedAt).getTime();
  if (!Number.isFinite(at)) return { tone: 'none', label: 'not synced' };

  const minutes = Math.floor((now.getTime() - at) / 60_000);
  const label = minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes}m ago`
    : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ago`
    : `${Math.floor(minutes / 1_440)}d ago`;
  const tone = minutes > 4_320 ? 'stale' : minutes > 1_440 ? 'aging' : 'fresh';
  return { tone, label };
}

/** Percentage of `total`, clamped so a negative or absent figure cannot draw a bar. */
export function share(cents: number, total: number): number {
  if (total <= 0) return 0;
  return (Math.max(0, cents) / total) * 100;
}
