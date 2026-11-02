import type { PortfolioValuation } from '../../../shared/market.js';

/**
 * The Prices evidence line: where the prices came from and what the fill is doing, with the rate
 * when the governor has lowered it. The rate is said because a slow fill with no reason given reads
 * as a broken one. A snapshot in use is said first, because then the fill is only the remainder.
 * The float curves, which price the float value, are said last.
 */
export function fillLabel(answer: Pick<PortfolioValuation, 'fill' | 'status' | 'prices' | 'curves'>): string {
  const curves = curvesLabel(answer.curves);
  const books = booksLabel(answer);
  return curves === null ? books : `${books}; ${curves}`;
}

/** What the curve fill has done for the held skins, or `null` when nothing held has a float. */
export function curvesLabel(curves: PortfolioValuation['curves']): string | null {
  if (curves === null || curves.skins === 0) return null;
  const { fill } = curves;
  switch (fill.state) {
    case 'no-feature': return 'no float curves in your CSlytics plan';
    case 'filling': return `reading float curves, ${fill.done.toLocaleString()} of ${fill.total.toLocaleString()}`;
    case 'deferred': return `float curves for ${plural(curves.kinds, 'kind')}, the rest paused until ${fill.resumesAt ? time(fill.resumesAt) : 'later'}`;
    default: return `float curves for ${plural(curves.kinds, 'kind')}${curves.withoutCurve.kinds > 0 ? `, none published for ${plural(curves.withoutCurve.kinds, 'kind')}` : ''}`;
  }
}

function booksLabel(answer: Pick<PortfolioValuation, 'fill' | 'status' | 'prices'>): string {
  const { status } = answer;
  const slowed = status.offeredRps < status.fillRps ? ` · slowed to ${status.offeredRps} rps by latency` : '';
  const snapshot = answer.prices ? `CSlytics prices from ${time(answer.prices.generatedAt)} · ${plural(answer.prices.coveredKinds, 'kind')}` : null;
  const rest = (() => {
    switch (answer.fill) {
      case 'filling': return (status.fillTotal > 0 ? `reading ${status.fillDone.toLocaleString()} of ${status.fillTotal.toLocaleString()} kinds` : 'reading') + slowed;
      case 'complete': return `read · ${status.reads.toLocaleString()} reads this session${slowed}`;
      case 'stopped': return `paused by Steam until ${status.stoppedUntil ? time(status.stoppedUntil) : 'later'}`;
      case 'slowed': return `paused a minute for latency${status.slowedUntil ? `, until ${time(status.slowedUntil)}` : ''}`;
      case 'paused': return 'paused while the window was hidden';
      default: return 'idle';
    }
  })();
  if (snapshot === null) return rest;
  if (answer.prices!.bookKinds === 0 && status.fillTotal === 0) return snapshot;
  return `${snapshot}; ${answer.prices!.bookKinds > 0 ? `${plural(answer.prices!.bookKinds, 'kind')} from Steam, ` : ''}${rest}`;
}

/** The Prices chip's few characters: the snapshot's hour when one is in use, else the fill's state. */
export function shortFill(answer: Pick<PortfolioValuation, 'fill' | 'status' | 'prices'>): string {
  if (answer.prices && answer.fill !== 'filling' && answer.fill !== 'stopped') return `CSlytics ${time(answer.prices.generatedAt)}`;
  const { status } = answer;
  switch (answer.fill) {
    case 'filling': return status.fillTotal > 0 ? `${status.fillDone.toLocaleString()} / ${status.fillTotal.toLocaleString()}` : 'reading';
    case 'stopped': return 'paused by Steam';
    case 'slowed': return 'slowed';
    case 'paused': return 'paused';
    case 'complete': return 'read';
    default: return 'idle';
  }
}

/**
 * What the fill has left to do, said in place of a figure that is not shown yet. Only the books: the
 * total never waits for the float curves, whose progress is the Float value card's.
 */
export function pricingProgress(answer: Pick<PortfolioValuation, 'fill' | 'status'>): string {
  const { status } = answer;
  if (answer.fill === 'stopped') return 'Pricing paused by Steam';
  if (status.fillTotal > 0) return `Pricing ${status.fillDone.toLocaleString()} of ${status.fillTotal.toLocaleString()} kinds`;
  return 'Pricing…';
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
