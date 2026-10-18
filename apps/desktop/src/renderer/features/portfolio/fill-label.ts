import type { PortfolioValuation } from '../../../shared/market.js';

/**
 * The Prices evidence line: what the fill is doing, and at what rate when the governor has
 * lowered it. The rate is said because a slow fill with no reason given reads as a broken one.
 */
export function fillLabel(answer: Pick<PortfolioValuation, 'fill' | 'status'>): string {
  const { status } = answer;
  const slowed = status.offeredRps < status.fillRps ? ` · slowed to ${status.offeredRps} rps by latency` : '';
  switch (answer.fill) {
    case 'filling': return (status.fillTotal > 0 ? `reading ${status.fillDone.toLocaleString()} of ${status.fillTotal.toLocaleString()} kinds` : 'reading') + slowed;
    case 'complete': return `read · ${status.reads.toLocaleString()} reads this session${slowed}`;
    case 'stopped': return `paused by Steam until ${status.stoppedUntil ? new Date(status.stoppedUntil).toLocaleTimeString() : 'later'}`;
    case 'slowed': return `paused a minute for latency${status.slowedUntil ? `, until ${new Date(status.slowedUntil).toLocaleTimeString()}` : ''}`;
    case 'paused': return 'paused while the window was hidden';
    default: return 'idle';
  }
}

/** What the fill has left to do, said in place of a figure that is not shown yet. */
export function pricingProgress(answer: Pick<PortfolioValuation, 'fill' | 'status'>): string {
  const { status } = answer;
  if (answer.fill === 'stopped') return 'Pricing paused by Steam';
  if (status.fillTotal > 0) return `Pricing ${status.fillDone.toLocaleString()} of ${status.fillTotal.toLocaleString()} kinds`;
  return 'Pricing…';
}
