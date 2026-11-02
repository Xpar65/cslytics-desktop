import type { CslyticsStatus } from '@cslytics/cslytics-account';
import { FEATURE_PORTFOLIO, hasFeature } from '../../shared/command-access.js';
import type { MarketDataHost } from './host.js';

/**
 * What the market cache does when the CSlytics grant changes (pricing behind sign-in plan §7.5).
 *
 * The portfolio's fill reads Steam once per held name, and only the walled Portfolio page shows
 * what it reads. A grant without `portfolio` empties the held set at once, so the scheduler stops
 * reading for it and no daily valuation is written; the next valuation, once the grant holds the
 * key again, hands the scheduler the held names afresh. Cached books and curves stay: main's gate
 * sits in front of them (plan D13).
 */
export function holdForGrant(status: Pick<CslyticsStatus, 'features'>, host: Pick<MarketDataHost, 'hold'>): void {
  if (!hasFeature(status, FEATURE_PORTFOLIO)) host.hold([]);
}
