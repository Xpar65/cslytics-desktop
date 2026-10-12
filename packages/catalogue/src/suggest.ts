/**
 * Scored subsequence matching, for the filter bar's suggestion list.
 *
 * CSFloat's spotlight uses `fuzzysort` over `prepare()`d names. This does the same job in about
 * eighty lines, because a dependency that ships in the main process for one function is more
 * surface than the function. If the home-grown scorer ever proves worse on the real name set,
 * swapping it for the library is a one-file change.
 *
 * Nothing here decides what a command acts on. A suggestion becomes a chip, a chip becomes
 * `matchKeys`, and identity is what reaches the engine — the same rule the rest of this package
 * lives under.
 */

/** A name with the work that does not depend on the needle done once, at index-build time. */
export type Prepared = {
  /** The name as it is shown. */
  text: string;
  /** Case- and accent-folded, which is what the needle is matched against. */
  folded: string;
  /** Indices in `folded` that begin a word, so a match there can be rewarded. */
  starts: ReadonlySet<number>;
};

/** Below this, a hit is noise: the needle's characters appear, but not as anything a reader meant. */
export const SUGGEST_THRESHOLD = 0;

const WORD_START = /[^a-z0-9]/;

export function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function prepare(text: string): Prepared {
  const folded = fold(text);
  const starts = new Set<number>();
  for (let index = 0; index < folded.length; index += 1) {
    const previous = index === 0 ? ' ' : folded[index - 1]!;
    if (WORD_START.test(previous)) starts.add(index);
  }
  return { text, folded, starts };
}

/**
 * How well `needle` matches `target`, or `null` when its characters do not appear in order.
 *
 * Greedy left-to-right, which is not the optimal alignment but is the one that ranks the way a
 * reader expects: `redline` lands on the word start in `AK-47 | Redline` and on the stray `r` of
 * `Sticker | Redline`, so the skin outscores the sticker without either being special-cased.
 */
export function score(needle: string, target: Prepared): number | null {
  const wanted = fold(needle);
  if (!wanted) return null;
  if (wanted.length > target.folded.length) return null;

  let total = 0;
  let at = 0;
  let previous = -2;
  for (const character of wanted) {
    const found = target.folded.indexOf(character, at);
    if (found === -1) return null;
    total += 1;
    if (target.starts.has(found)) total += 8;
    if (found === previous + 1) total += 6;
    else if (previous >= 0) total -= Math.min(6, found - previous - 1);
    previous = found;
    at = found + 1;
  }
  // A whole-string prefix is the strongest signal there is, and a shorter name carrying the same
  // hit is the more likely answer — `AK-47 | Redline` before `Sticker | Redline (Holo)`.
  if (target.folded.startsWith(wanted)) total += 12;
  total -= (target.folded.length - wanted.length) * 0.1;
  return total;
}

/** The best `limit` matches, highest score first, ties broken by the shorter name then by name. */
export function rank<T>(
  needle: string,
  rows: Iterable<{ prepared: Prepared; value: T }>,
  limit = 8,
  threshold = SUGGEST_THRESHOLD
): T[] {
  const hits: Array<{ score: number; length: number; text: string; value: T }> = [];
  for (const row of rows) {
    const result = score(needle, row.prepared);
    if (result === null || result < threshold) continue;
    hits.push({ score: result, length: row.prepared.folded.length, text: row.prepared.text, value: row.value });
  }
  hits.sort((left, right) => right.score - left.score || left.length - right.length || left.text.localeCompare(right.text));
  return hits.slice(0, Math.max(0, limit)).map((hit) => hit.value);
}
