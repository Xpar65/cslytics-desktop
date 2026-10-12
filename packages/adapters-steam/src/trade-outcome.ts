import type { MutationOutcome } from '@cslytics/ports';

/** EResult belongs to the attempt, never to trade_offer_state. */
export function tradeMutationOutcome(operation: 'send' | 'accept' | 'cancel', status: number, body: unknown): MutationOutcome {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  // Keep only response fields, never a request URL, cookie jar or trade token.
  const evidence = Object.fromEntries(['tradeofferid', 'tradeid', 'needs_mobile_confirmation',
    'needs_mobile_app_confirmation', 'needs_email_confirmation', 'success', 'strError']
    .filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
  const ambiguous = (cause: 'transport' | 'malformed' | 'unclassified'): MutationOutcome => ({ kind: 'AMBIGUOUS', cause, raw: evidence });
  if (status === 403 || status === 429) return ambiguous('transport');
  const error = typeof raw.strError === 'string' ? raw.strError.trim() : '';
  const suffix = /\((\d+)\)\s*$/.exec(error);
  const code = suffix ? Number(suffix[1]) : undefined;
  const reject = (reason: string): MutationOutcome => ({ kind: 'DEFINITIVELY_REJECTED', reason, raw: evidence });
  if (operation === 'cancel' && (error || (Number.isInteger(raw.success) && raw.success !== 1))) {
    return reject(`cancel-refused${code === undefined ? '' : `-${code}`}`);
  }
  if (error) {
    if (code === 15 || code === 26) return reject(`trade-rejected-${code}`);
    if (code === 25 || (code === undefined && /sent too many trade offers/i.test(error))) return reject('offer-limit');
    if (code === 16 || code === 20 || (code === undefined && /unable to contact the game's item server/i.test(error))) return ambiguous('transport');
    return ambiguous('unclassified');
  }
  if (Number.isInteger(raw.success) && raw.success !== 1) return ambiguous('unclassified');
  if (status < 200 || status >= 300) return ambiguous('transport');
  const id = operation === 'accept' ? raw.tradeid : raw.tradeofferid;
  const confirmation = raw.needs_mobile_confirmation === true || raw.needs_mobile_app_confirmation === true || raw.needs_email_confirmation === true;
  if ((typeof id === 'string' && /^\d+$/.test(id)) || (operation === 'accept' && confirmation)) {
    return { kind: 'SUBMITTED', evidence: confirmation ? 'awaiting-phone-confirmation' : 'trade-request-submitted', raw: evidence };
  }
  return ambiguous('malformed');
}
