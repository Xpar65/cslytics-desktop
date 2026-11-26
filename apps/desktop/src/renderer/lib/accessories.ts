import type { AppliedValue, NamedAccessory } from '../../shared/accessories.js';
import { formatFigure } from './money.js';

/**
 * How scraped a sticker is, as a whole percentage. No wear named is a sticker nobody has scraped,
 * which is how the Game Coordinator sends one. A trace of wear is never rounded away to 0%: a
 * sticker that has been scraped at all is no longer an unscraped one.
 */
export function scrapedPercent(wear: number | null): number {
  if (wear === null || !(wear > 0)) return 0;
  return Math.min(100, Math.max(1, Math.round(wear * 100)));
}

/** What an accessory is called: its catalogue name, or its kind and kit id when the catalogue does not hold it. */
export function accessoryName(accessory: NamedAccessory): string {
  if (accessory.name !== null) return accessory.name;
  return accessory.kind === 'charm-slot' ? `Charm ${accessory.kitId}` : `Sticker or patch ${accessory.kitId}`;
}

/**
 * The lines under an accessory's name in its tip, one fact each. A sticker says how scraped it is,
 * a patch says nothing (a patch is removed, never scraped), and a charm names its pattern. Last,
 * when main had one, its reference price: what one sells for as an item of its own, an estimate
 * marked as every estimate is, and not what it adds to the item it is on. One that nobody lists on
 * Steam says that, with the highest buy order, because that figure is a floor and not a reference
 * price. A tip is read at a glance, so each line is a few words.
 */
export function accessoryFacts(accessory: NamedAccessory): string[] {
  const facts: string[] = [];
  if (accessory.kind === 'sticker-slot' && accessory.family !== 'patch') {
    const percent = scrapedPercent(accessory.wear);
    facts.push(percent === 0 ? 'Not scraped' : `${percent}% scraped`);
  }
  if (accessory.kind === 'charm-slot' && accessory.pattern !== null) facts.push(`Pattern ${accessory.pattern}`);
  const reference = accessory.referencePrice;
  if (reference) {
    facts.push(reference.basis === 'bid-only'
      ? `Not listed on Steam, bid ${formatFigure(reference.figure)}`
      : `Reference price ${formatFigure(reference.figure)}`);
  }
  return facts;
}

/** A share as it was set: `10%`, `7.5%`. */
function share(percent: number): string {
  return `${Number(percent.toFixed(2))}%`;
}

/** The figure beside the strip: what the stickers and the charm are estimated to add to the item. */
export function appliedValueLabel(value: AppliedValue): string {
  return `+ ${formatFigure(value.added)}`;
}

/**
 * The lines of the tip on that figure: the working and nothing else. The share counted of the
 * stickers' reference price, the same for the charm, and how many had none. What the estimate is
 * and where its shares are set is said once, in Settings, not on every hover.
 */
export function appliedValueLines(value: AppliedValue): string[] {
  const lines: string[] = [];
  if (value.stickers) {
    const { count, same, reference, percent } = value.stickers;
    const what = same ? 'Stickers (4 same)' : count === 1 ? 'Sticker' : 'Stickers';
    lines.push(`${what} ${share(percent)} of ${formatFigure(reference)}`);
  }
  if (value.charm) {
    const { reference, percent } = value.charm;
    lines.push(`Charm ${share(percent)} of ${formatFigure(reference)}`);
  }
  if (value.unpriced > 0) lines.push(`${value.unpriced} unpriced`);
  return lines;
}
