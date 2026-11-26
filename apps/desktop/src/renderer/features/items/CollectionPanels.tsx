import React, { useEffect, useMemo, useState } from 'react';
import type { CollectionRef, CollectionTile, SkinTile as Skin } from '../../../shared/market.js';
import { Button, Thumbnail } from '../../components/ui.js';
import { addChip, type FilterChip } from '../../components/filter-grammar.js';
import { engine } from '../../lib/engine.js';
import { collectionLabel } from '../../lib/skin-name.js';
import { collectionSections } from './collection-sections.js';
import { SkinTile, useSkinPages } from './ItemBrowse.js';

/**
 * Collections on the Items page: every one of them before anything is asked for, and the rest of
 * an item's own at the foot of its page.
 *
 * A collection is the way into the catalogue that needs no name remembered: a person knows the
 * case they opened or the map they play before they know what a finish is called. So the page
 * that has not been asked anything lists them all, each behind its emblem, under a heading for
 * what kind of collection it is and the newest release first under each. Pressing one is the same
 * act as picking it from the bar's suggestions: its chip goes in the bar and its skins are the
 * tiles underneath.
 */

/**
 * An emblem comes in two kinds, and one box draws both the same size.
 *
 * The game's raster emblems are pictures 256 by 198, the badge standing the picture's height with
 * clear margins either side. Its vector emblems, every one since late 2024, are a square 32 units
 * across with the badge drawn to its edges, and say they are 32 pixels, which no tile is. So an
 * emblem is never drawn at its own size or into a square: it is fitted whole into a box of the
 * raster shape. A raster fills that box, a vector stands its full height in the middle, and the
 * two badges come out a pixel or two apart (measured 2026-11-23 over all 107 emblems, in a box
 * 50 high: rasters 65 by 50, vectors 50 by 50).
 */
const EMBLEM_ASPECT = 256 / 198;

/** A collection's emblem, `height` pixels tall, or the placeholder a missing picture always is. */
export function CollectionEmblem({ collection, height }: { collection: Pick<CollectionRef, 'name' | 'imageUrl'>; height: number }): React.JSX.Element {
  return (
    <span className="collection-emblem" style={{ width: Math.round(height * EMBLEM_ASPECT), height }}>
      <Thumbnail url={collection.imageUrl} name={collection.name} fill />
    </span>
  );
}

/** The chip a collection is browsed by: the one the bar makes when its suggestion is picked. */
function chipOf(collection: Pick<CollectionRef, 'name'>): FilterChip[] {
  return addChip([], { kind: 'collection', text: collection.name });
}

/**
 * The list last read, kept for as long as the window is. The landing is shown again on every way
 * back to it, and drawing what it showed a moment ago beats drawing it a frame late: main is asked
 * again each time all the same, so a catalogue that has moved on is caught up with.
 */
let lastRead: CollectionTile[] | null = null;

/** Every collection there is something to browse under, or `null` until main has answered once. */
export function useCollections(): CollectionTile[] | null {
  const [collections, setCollections] = useState<CollectionTile[] | null>(lastRead);
  useEffect(() => {
    let live = true;
    engine.catalogueCollections()
      .then((rows) => {
        lastRead = rows;
        if (live) setCollections(rows);
      })
      // No list is no panel; the bar still finds a collection by name.
      .catch(() => { if (live) setCollections((held) => held ?? []); });
    return () => { live = false; };
  }, []);
  return collections;
}

/** Every collection as a tile, a panel to a heading (`collection-sections.ts`). */
export function CollectionTiles({ collections, onBrowse }: {
  collections: readonly CollectionTile[];
  onBrowse: (chips: FilterChip[]) => void;
}): React.JSX.Element {
  return (
    <>
      {collectionSections(collections).map((section) => (
        <section key={section.id} className="panel items-collections" data-testid="items-collections" data-section={section.id}>
          <div className="panel-body">
            <h2 className="holdings-label">{section.title}</h2>
            <div className="items-tiles">
              {section.collections.map((collection) => (
                <button
                  key={collection.id}
                  type="button"
                  className="items-tile items-collection-tile"
                  data-collection={collection.name}
                  data-released={collection.releaseDate ?? undefined}
                  aria-label={collection.name}
                  title={describe(collection)}
                  onClick={() => onBrowse(chipOf(collection))}
                >
                  <CollectionEmblem collection={collection} height={50} />
                  <span className="items-tile-text">
                    <span className="items-tile-title">{collectionLabel(collection.name)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      ))}
    </>
  );
}

/** What a collection's tile says when it is hovered: its whole name, its size and its day. */
function describe(collection: CollectionTile): string {
  const released = collection.releaseDate
    ? new Date(`${collection.releaseDate}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null;
  return [
    collection.name,
    `${collection.skins.toLocaleString()} ${collection.skins === 1 ? 'item' : 'items'}`,
    released ? `released ${released}` : null
  ].filter((part): part is string => part !== null).join(' · ');
}

/**
 * The rest of an item's collection, at the foot of its page: every other skin in it as a tile, in
 * the order the collection's own grid shows them, read a page at a time as the page is scrolled.
 * The item's own skin is left out, since its page is the one being read. Nothing is drawn until
 * there is another skin to show, so an item alone in its collection has no such panel.
 */
export function CollectionSkins({ collection, skin, onOpen }: {
  collection: CollectionRef;
  /** The name this page's own tile carries on a grid. */
  skin: string;
  onOpen: (skin: Skin) => void;
}): React.JSX.Element | null {
  const chips = useMemo(() => chipOf(collection), [collection.name]);
  const { shown, total, failed, retry, panel, end } = useSkinPages(chips, false);
  if (shown === null || total === undefined) return null;
  const others = shown.skins.filter((row) => row.name !== skin);
  if (others.length === 0 && shown.next === null) return null;
  return (
    <section ref={panel} className="panel items-collection" data-testid="item-collection" data-collection={collection.name} data-total={total - (shown.skins.length - others.length)}>
      <div className="panel-body">
        <div className="items-collection-head">
          {collection.imageUrl ? <CollectionEmblem collection={collection} height={24} /> : null}
          <div className="holdings-label">Other items in {collection.name}</div>
        </div>
        <div className="items-tiles">
          {others.map((row) => (
            <SkinTile key={row.name} name={row.name} imageUrl={row.imageUrl} rarity={row.rarity} onOpen={() => onOpen(row)} />
          ))}
        </div>
        {failed ? <div className="items-tiles-more"><Button size="sm" icon="refresh" onClick={retry}>Try again</Button></div> : null}
        <div ref={end} className="items-tiles-end" aria-hidden="true" />
      </div>
    </section>
  );
}
