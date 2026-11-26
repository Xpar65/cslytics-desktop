/**
 * The identity of one market-history event that both of Steam's history routes can name: the
 * listing and the event type, `<listingId>:<eventType>`, per account. `myhistory/render` also gives
 * a purchase id and `QueryMyHistory` does not, and the two routes give the same event's time in
 * different units, so neither is in the key. A listing created with one unit is sold once and bought
 * once, so the pair names one event; a listing of several units does not, and has no key.
 */
export function marketHistoryEventKey(listingId: string, eventType: number): string {
  if (!/^\S+$/.test(listingId) || listingId.includes(':')) throw new Error('A market-history key needs a listing id with no space or colon');
  if (!Number.isInteger(eventType) || eventType < 0) throw new Error('A market-history key needs an integer event type');
  return `${listingId}:${eventType}`;
}
