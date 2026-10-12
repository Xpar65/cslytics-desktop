import { createHash } from 'node:crypto';
import type { MatchKey } from './types.js';

/**
 * The identity a catalogue entry is filed under is spelled once, in `@cslytics/ports` (`item-key.ts`),
 * and the engine keys its rows with the same functions. Only the file naming is the catalogue's own.
 */
export { KIT_ATTRIBUTES_BY_ITEM, KIT_ATTRIBUTES_BY_QUALITY, attributeValue, commodityMatchKey, kitToken, matchKey } from '@cslytics/ports';

/**
 * The filename a single-key lookup lives at, matching `free_export.market_name_hash`'s convention
 * of a lowercase SHA-256 over the exact UTF-8 bytes.
 */
export function keyHash(key: MatchKey): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
