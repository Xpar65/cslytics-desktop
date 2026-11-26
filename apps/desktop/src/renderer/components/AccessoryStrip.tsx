import React from 'react';
import { resizedImageUrl } from '@cslytics/catalogue';
import type { AppliedValue, NamedAccessory } from '../../shared/accessories.js';
import { Thumbnail } from './ui.js';
import { Tip } from './Tip.js';
import { accessoryFacts, accessoryName, appliedValueLabel, appliedValueLines, scrapedPercent } from '../lib/accessories.js';

/**
 * The stickers, patches and charm applied to an item, in two sizes: the inspector's, to read, and
 * the compact one a tile, a group's item row or a listing tile carries, to scan.
 *
 * Both draw the same thing the same way. Stickers or patches come in slot order, then the charm a
 * little apart; a sticker fades as its wear rises, down to a floor that keeps a fully scraped one
 * recognisable, because which sticker it was still matters. Each comes off the row it describes
 * (`attachAccessories` in main), so neither size asks for anything.
 */

/** A sticker, which can be scraped; a patch or a charm never is. */
function isScrapable(accessory: NamedAccessory): boolean {
  return accessory.kind === 'sticker-slot' && accessory.family !== 'patch';
}

/**
 * How far a hovered sticker reaches above its slot, in pixels, at the slot's widest: it grows to
 * 1.56 of a 44 px slot from its foot (`app.css`), so 0.56 of 44. Its tip opens that much higher.
 */
const ACCESSORY_RISE = 25;

/** How scraped a slot is, as a whole percentage; zero for a charm or a patch, which are never scraped. */
function percentOf(accessory: NamedAccessory): number {
  return isScrapable(accessory) ? scrapedPercent(accessory.wear) : 0;
}

/**
 * The inspector's strip, inside the item's picture tile along its foot, as CSFloat's item card lays
 * its stickers on the picture. Each sticker has a slot of its own, up to 44 px, and is drawn a little
 * smaller than it. Hovered or focused, it grows to twice the size it rests at, upward from the foot
 * of its slot, so it can be read; its wear comes up centred beneath it, and its tip opens above the
 * grown picture (`ACCESSORY_RISE`). At rest the strip carries no figures,
 * so the picture reads clean. The name, and anything else known about each one, is in its tip
 * (`accessoryFacts`). Nothing at all for an item that carries none.
 *
 * Each is drawn from a 256 px picture, so the grown one stays sharp on a high-density display, with
 * the row's own 128 px picture standing in until that arrives, as the inspector's preview does.
 *
 * Pressed, one that is sold as an item of its own opens on the Items page (`onOpen`): its book, its
 * sales and what the scope holds of it, which is where someone who has just read its reference price
 * goes next. One the catalogue cannot name, or that has no market, is not a control.
 *
 * After the last one, when main had reference prices, sits what the stickers and the charm are
 * estimated to add to the item (`value`): one quiet figure, smaller and fainter than anything it
 * follows, whose tip carries the working. Nothing is there when nothing applied has one.
 */
export function InspectorAccessories({ accessories, value, onOpen }: {
  accessories: readonly NamedAccessory[] | undefined;
  /** What the row's stickers and charm add, as main estimated it (`appliedValue` on the row). */
  value?: AppliedValue | null | undefined;
  /** Opens one market name on the Items page; without it nothing on the strip is pressed. */
  onOpen?: ((marketHashName: string) => void) | undefined;
}): React.JSX.Element | null {
  if (!accessories || accessories.length === 0) return null;
  return (
    <ul className="inspector-accessories" aria-label="Applied stickers and charms" data-testid="inspector-accessories">
      {accessories.map((accessory) => {
        const name = accessoryName(accessory);
        const percent = percentOf(accessory);
        const market = accessory.marketHashName;
        const open = onOpen && market !== null ? () => onOpen(market) : undefined;
        return (
          <li className="accessory" key={`${accessory.kind}:${accessory.slot}`} data-kind={accessory.kind} data-opens={open ? 'item-page' : undefined}>
            <Tip
              content={<>
                <span className="tip-line">{name}</span>
                {accessoryFacts(accessory).map((fact) => <span className="tip-line" key={fact}>{fact}</span>)}
              </>}
              onPress={open}
              pressLabel={open ? `Open ${name} on the Items page` : undefined}
              rise={ACCESSORY_RISE}
            >
              <span className="accessory-art" style={{ '--wear': percent / 100 } as React.CSSProperties}>
                <Thumbnail url={resizedImageUrl(accessory.imageUrl, 256) ?? accessory.imageUrl} standIn={accessory.imageUrl} name={name} fill />
              </span>
              {/* A sticker's wear, clean ones included; a patch or a charm has none to show. */}
              {isScrapable(accessory) ? <span className="accessory-wear num">{percent}%</span> : null}
            </Tip>
          </li>
        );
      })}
      {value ? (
        <li className="accessory-value" data-testid="applied-value" data-cents={value.added.native.cents} data-currency={value.added.native.currency}>
          <Tip wide content={<>{appliedValueLines(value).map((line) => <span className="tip-line" key={line}>{line}</span>)}</>}>
            <span className="num">{appliedValueLabel(value)}</span>
          </Tip>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The compact strip, for a tile or a row. Each one shrinks to fit the space it is given, a scraped
 * sticker carries a thin bar filled to its wear, and the name and figures are its title.
 *
 * A title rather than a tip, and no focus stop: a tile is one grid cell the keys move between and
 * a group's row is one button, and a control inside either would be a second target where a person
 * means the item. The inspector's strip is the one to read with a keyboard or a screen reader;
 * this one says what it shows in its label.
 */
export function CompactAccessories({ accessories }: { accessories: readonly NamedAccessory[] | undefined }): React.JSX.Element | null {
  if (!accessories || accessories.length === 0) return null;
  const said = accessories.map((accessory) => [accessoryName(accessory), ...accessoryFacts(accessory)].join(', '));
  return (
    <span className="accessory-strip-compact" role="img" aria-label={`Applied: ${said.join('; ')}`} data-testid="accessory-strip">
      {accessories.map((accessory, index) => {
        const percent = percentOf(accessory);
        return (
          <span
            className="accessory-mini"
            key={`${accessory.kind}:${accessory.slot}`}
            data-kind={accessory.kind}
            data-scraped={percent > 0 ? percent : undefined}
            title={said[index]}
            style={{ '--wear': percent / 100 } as React.CSSProperties}
          >
            <span className="accessory-mini-art"><Thumbnail url={accessory.imageUrl} name={accessoryName(accessory)} fill /></span>
            {percent > 0 ? <span className="accessory-mini-bar"><span style={{ width: `${percent}%` }} /></span> : null}
          </span>
        );
      })}
    </span>
  );
}
