import type { AccountHoldings, SurfaceEvidence } from './types.js';

/**
 * Portfolio arithmetic.
 *
 * A headline figure, an allocation bar split into labelled segments, and a per-account table
 * underneath. What is deliberately *not* here is a valuation: this app has neither a price
 * catalogue nor an FX source, and `cslytics-app-docs/steam/wallet.md` states the rule as *"the engine never
 * values an item"*. So every figure below is a number a venue itself named, and inventory
 * appears as counts.
 *
 * Pure functions on purpose. Vitest runs in a node environment with no DOM, so this is the
 * half of the portfolio that can be tested; the component that renders it is the half that
 * cannot.
 */

export type HoldingsSegmentKey = 'wallet' | 'walletDelayed' | 'listed' | 'onHold' | 'awaitingConfirmation';

export type HoldingsSegment = {
  key: HoldingsSegmentKey;
  label: string;
  /** The token holding this segment's colour. Segments are data, so they are never the accent. */
  variable: string;
  /** Hatched in the bar: money Steam is holding, or a listing that is not live yet. */
  pending: boolean;
  cents: number;
};

type SegmentDefinition = Omit<HoldingsSegment, 'cents'> & { of: (holdings: HoldingsSource) => number };

/** The fields `segments` reads. Both a single account and an aggregate satisfy it. */
type HoldingsSource = {
  wallet: { balanceCents: number; delayedBalanceCents: number } | null;
  listedReceiveCents: number;
  onHoldReceiveCents: number;
  awaitingConfirmationReceiveCents: number;
};

/**
 * One bucket per thing Steam told us a number for, hue per bucket and hatching for the part of
 * it that has not cleared — the incumbent's convention, and the reason the bar reads at a
 * glance without a legend per segment.
 *
 * Buy-order commitments are deliberately absent. A buy order is money reserved *out of* the
 * wallet balance (`cslytics-app-docs/steam/wallet.md`), so adding it as a sixth segment would count the same
 * cents twice. It gets a card of its own instead.
 */
const SEGMENTS: readonly SegmentDefinition[] = [
  {
    key: 'wallet',
    label: 'Wallet',
    variable: '--cs-hold-wallet',
    pending: false,
    of: (holdings) => holdings.wallet?.balanceCents ?? 0
  },
  {
    key: 'walletDelayed',
    label: 'Wallet (delayed)',
    variable: '--cs-hold-wallet',
    pending: true,
    of: (holdings) => holdings.wallet?.delayedBalanceCents ?? 0
  },
  {
    key: 'listed',
    label: 'Listed proceeds',
    variable: '--cs-hold-listed',
    pending: false,
    of: (holdings) => holdings.listedReceiveCents
  },
  {
    key: 'onHold',
    label: 'On hold',
    variable: '--cs-hold-listed',
    pending: true,
    of: (holdings) => holdings.onHoldReceiveCents
  },
  {
    key: 'awaitingConfirmation',
    label: 'Awaiting confirmation',
    variable: '--cs-hold-unconfirmed',
    pending: true,
    of: (holdings) => holdings.awaitingConfirmationReceiveCents
  }
];

export function segments(holdings: HoldingsSource): HoldingsSegment[] {
  return SEGMENTS.map(({ of, ...segment }) => ({ ...segment, cents: of(holdings) }));
}

/** Everything Steam named a figure for, added up. Never includes an appraisal, because there is none. */
export function observedTotalCents(holdings: HoldingsSource): number {
  return segments(holdings).reduce((total, segment) => total + segment.cents, 0);
}

/**
 * Adding one account's cents to another's is only meaningful in one currency.
 *
 * The incumbent solves this with an FX rate; this app has no FX source, so it says so instead
 * of inventing one. `mixed` is what stops a A$ balance and a US$ balance being silently added
 * into a number that means nothing.
 */
export type PortfolioCurrency =
  | { kind: 'none' }
  | { kind: 'single'; code: number }
  | { kind: 'mixed'; codes: number[] };

export type PortfolioTotals = HoldingsSource & {
  accounts: number;
  currency: PortfolioCurrency;
  reservedCents: number;
  buyOrderOpenCents: number;
  counts: AccountHoldings['counts'];
  /** The worst evidence across the accounts: one unfinished walk makes the whole total a floor. */
  inventory: SurfaceEvidence;
  market: SurfaceEvidence;
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
  const totals: PortfolioTotals = {
    accounts: rows.length,
    currency: currencyOf(rows),
    wallet: null,
    reservedCents: 0,
    listedReceiveCents: 0,
    onHoldReceiveCents: 0,
    awaitingConfirmationReceiveCents: 0,
    buyOrderOpenCents: 0,
    counts,
    inventory: NO_EVIDENCE,
    market: NO_EVIDENCE
  };

  for (const row of rows) {
    if (row.wallet) {
      totals.wallet = {
        balanceCents: (totals.wallet?.balanceCents ?? 0) + row.wallet.balanceCents,
        delayedBalanceCents: (totals.wallet?.delayedBalanceCents ?? 0) + row.wallet.delayedBalanceCents
      };
    }
    totals.reservedCents += row.reservedCents;
    totals.listedReceiveCents += row.listedReceiveCents;
    totals.onHoldReceiveCents += row.onHoldReceiveCents;
    totals.awaitingConfirmationReceiveCents += row.awaitingConfirmationReceiveCents;
    totals.buyOrderOpenCents += row.buyOrderOpenCents;
    for (const key of Object.keys(counts) as Array<keyof AccountHoldings['counts']>) {
      counts[key] += row.counts[key];
    }
    inventory = inventory === null ? row.inventory : worse(inventory, row.inventory);
    market = market === null ? row.market : worse(market, row.market);
  }
  totals.inventory = inventory ?? NO_EVIDENCE;
  totals.market = market ?? NO_EVIDENCE;
  return totals;
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

function currencyOf(rows: readonly AccountHoldings[]): PortfolioCurrency {
  const codes = [...new Set(rows.map((row) => row.currency).filter((code): code is number => code !== null))];
  if (codes.length === 0) return { kind: 'none' };
  if (codes.length === 1) return { kind: 'single', code: codes[0]! };
  return { kind: 'mixed', codes: codes.sort((left, right) => left - right) };
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
