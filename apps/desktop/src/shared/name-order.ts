/**
 * The one way this desktop puts item names in order.
 *
 * Main works out the identity-key order a name-sorted tile page walks, and the window orders the
 * grouped summary. Both go through this collator, so the two views of one inventory never disagree
 * about which item comes first. Numeric collation puts "Team 2" before "Team 10", and base
 * sensitivity ignores case and accents. The locale is fixed rather than taken from the machine,
 * because main and the window must agree and the catalogue's names are English.
 */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function compareNames(left: string, right: string): number {
  return COLLATOR.compare(left, right);
}
