/**
 * A market name, as a tile shows it.
 *
 * A tile stands for a skin, and the wear is one of the things its page switches between, so a tile
 * never says it: `AK-47 | Redline (Field-Tested)` and `(Minimal Wear)` are one tile. The name is
 * also read in two parts, what the thing is and which one, so a grid of one weapon does not spend
 * every tile's first line saying `AWP`.
 */

const WEAR_SUFFIX = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;

/** `AK-47 | Redline (Field-Tested)` → `AK-47 | Redline`. A name that ends in no wear is itself. */
export function withoutWear(name: string): string {
  return name.replace(WEAR_SUFFIX, '');
}

/**
 * A tile's two lines: `lead` is what comes before the first bar (the weapon, or `Sticker`), and
 * `title` is the rest. A name with no bar (`Revolution Case`, a knife with no finish) is all title.
 */
export function skinParts(name: string): { lead: string | null; title: string } {
  const plain = withoutWear(name);
  const bar = plain.indexOf(' | ');
  return bar === -1 ? { lead: null, title: plain } : { lead: plain.slice(0, bar), title: plain.slice(bar + 3) };
}

/**
 * A collection's name as its tile says it, under a heading that already says `Collections`:
 * `The Huntsman Collection` → `Huntsman`. A name that is not shaped that way is itself, and a kind
 * the name carries stays: `Sugarface 2 Sticker Collection` → `Sugarface 2 Sticker`.
 */
export function collectionLabel(name: string): string {
  const short = name.replace(/^The /, '').replace(/ Collection$/, '').trim();
  return short === '' ? name : short;
}
