import type { CsfloatStandingView } from '@cslytics/engine';
import type { IconName } from '../../components/Icon.js';
import { formatDate, humanize, type Tone } from '../../lib/labels.js';

/**
 * The CSFloat profile, read out of `/me`'s readiness fields for the account page.
 *
 * Everything here is display. None of it gates anything: `know_your_customer` does not block
 * trading (confirmed live, 2026-09-22), and two-factor is not a precondition for the key. The
 * engine reads `suspended_until`, `away` and `stall_public` for itself; this module labels the
 * rest. Unknown stays unknown — a field CSFloat did not send is `—`, never "off".
 */
export type ReadinessTone = 'ok' | 'attention' | 'off' | 'unknown';
export type ReadinessRow = { key: string; icon: IconName; label: string; value: string; tone: ReadinessTone };

const KYC_OK = new Set(['approved', 'verified', 'completed', 'complete']);
const KYC_ATTENTION = new Set(['expired', 'rejected', 'failed', 'denied']);
const KYC_OFF = new Set(['unsubmitted', 'none', 'not_started', 'unverified']);

function onOff(value: unknown, on: string, off: string): { value: string; tone: ReadinessTone } {
  if (value === true) return { value: on, tone: 'ok' };
  if (value === false) return { value: off, tone: 'off' };
  return { value: '—', tone: 'unknown' };
}

export function readinessRows(flags: Readonly<Record<string, unknown>>): ReadinessRow[] {
  const kyc = flags['know_your_customer'];
  const kycRow: { value: string; tone: ReadinessTone } = typeof kyc !== 'string' || !kyc
    ? { value: '—', tone: 'unknown' }
    : KYC_OK.has(kyc) ? { value: 'Verified', tone: 'ok' }
      : KYC_ATTENTION.has(kyc) ? { value: humanize(kyc), tone: 'attention' }
        : KYC_OFF.has(kyc) ? { value: 'Not started', tone: 'off' }
          : { value: humanize(kyc), tone: 'unknown' };
  const stripe = flags['stripe_connect'];
  const payouts = typeof stripe === 'object' && stripe !== null ? (stripe as Record<string, unknown>)['payouts_enabled'] : undefined;
  const extension = flags['extension_setup_at'];
  const extensionRow: { value: string; tone: ReadinessTone } = typeof extension === 'string' && Number.isFinite(Date.parse(extension))
    ? { value: formatDate(extension), tone: 'ok' }
    : extension === null ? { value: 'Not set up', tone: 'off' } : { value: '—', tone: 'unknown' };
  return [
    { key: 'kyc', icon: 'shield-check', label: 'Verification', ...kycRow },
    { key: '2fa', icon: 'smartphone', label: 'Two-factor', ...onOff(flags['has_2fa'], 'On', 'Off') },
    { key: 'payouts', icon: 'coins', label: 'Payouts', ...onOff(payouts, 'Enabled', 'Off') },
    { key: 'extension', icon: 'globe', label: 'Extension', ...extensionRow },
    { key: 'api-key', icon: 'key', label: 'API key', ...onOff(flags['has_api_key'], 'On', 'Off') }
  ];
}

const STATISTICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'total_sales', label: 'Sales' },
  { key: 'total_purchases', label: 'Purchases' },
  { key: 'total_trades', label: 'Trades' },
  { key: 'total_verified_trades', label: 'Verified' },
  { key: 'total_failed_trades', label: 'Failed' },
  { key: 'total_avoided_trades', label: 'Avoided' }
];

/** Counts CSFloat keeps about the account. Only the ones that arrived, in a fixed order. */
export function statisticRows(flags: Readonly<Record<string, unknown>>): Array<{ key: string; label: string; value: number }> {
  const statistics = flags['statistics'];
  if (typeof statistics !== 'object' || statistics === null) return [];
  const source = statistics as Record<string, unknown>;
  return STATISTICS.flatMap(({ key, label }) => {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? [{ key, label, value }] : [];
  });
}

/** A CSFloat rate (`0.02`) as the percentage a person reads. Null when the venue did not send one. */
export function feeRate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** Trades and offers the account owner has to act on, as `/me` counts them. */
export function pendingCounts(flags: Readonly<Record<string, unknown>>): { offers: number | null; trades: number | null } {
  const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
  return { offers: count(flags['pending_offers']), trades: count(flags['actionable_trades']) };
}

/**
 * The venue's scale, in the venue's order, with the profile's own copy for what comes next
 * (csfloat-general-endpoints.md, "Profile copy for each standing").
 */
export const STANDING_SCALE: ReadonlyArray<{ value: string; label: string; tone: Tone; nextPenalty: string | null }> = [
  { value: 'excellent', label: 'Excellent', tone: 'positive', nextPenalty: 'Receive a pardon' },
  { value: 'good', label: 'Good', tone: 'positive', nextPenalty: '1 day suspension' },
  { value: 'poor', label: 'Poor', tone: 'warn', nextPenalty: '4 day suspension' },
  { value: 'at_risk', label: 'At risk', tone: 'warn', nextPenalty: 'Permanent ban' },
  { value: 'banned', label: 'Banned', tone: 'negative', nextPenalty: null }
];

const IMPROVEMENT_WINDOW_MS = 60 * 86_400_000;

export type StandingSummary = {
  label: string;
  tone: Tone;
  /** Position on the scale, or null for a value the venue added since. */
  index: number | null;
  nextPenalty: string | null;
  /** When the standing improves, as the profile counts it: 60 days from the oldest recent suspension. */
  improvesAt: string | null;
  daysToImprove: number | null;
  /** The venue's own progress toward the next penalty, `0..1`, or null when it sent none. */
  penaltyProgress: number | null;
  restrictions: ReadonlyArray<{ category: string; createdAt: string }>;
  observedAt: string;
};

/**
 * What the profile page would show, from what `/me/account-standing` said.
 *
 * The countdown is the profile's rule, reproduced: hidden when banned, hidden when no recent
 * restriction is a suspension, otherwise sixty days from the oldest suspension. An unknown
 * standing keeps the venue's word and takes no place on the scale — the scale is the venue's,
 * and a fifth-and-a-half step invented here would be a guess drawn as a fact.
 */
export function standingView(standing: CsfloatStandingView | null | undefined, now = new Date()): StandingSummary | null {
  if (!standing) return null;
  const index = STANDING_SCALE.findIndex((step) => step.value === standing.standing);
  const step = index >= 0 ? STANDING_SCALE[index]! : null;
  const suspensions = standing.recentRestrictions
    .filter((row) => row.category === 'suspension' && Number.isFinite(Date.parse(row.createdAt)))
    .map((row) => Date.parse(row.createdAt));
  const improvesAtMs = standing.standing === 'banned' || suspensions.length === 0 ? null : Math.min(...suspensions) + IMPROVEMENT_WINDOW_MS;
  const restrictions = [...standing.recentRestrictions]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 4);
  return {
    label: step?.label ?? humanize(standing.standing),
    tone: step?.tone ?? 'quiet',
    index: step ? index : null,
    nextPenalty: step?.nextPenalty ?? null,
    improvesAt: improvesAtMs === null ? null : new Date(improvesAtMs).toISOString(),
    daysToImprove: improvesAtMs === null ? null : Math.max(0, Math.ceil((improvesAtMs - now.getTime()) / 86_400_000)),
    penaltyProgress: standing.penaltyProgress === null ? null : Math.min(1, Math.max(0, standing.penaltyProgress)),
    restrictions,
    observedAt: standing.observedAt
  };
}
