/**
 * The two judgements the checkout window makes, kept free of Electron so a unit test can hold
 * them to their word: which pages may be shown at all, and what the approve POST said.
 *
 * The POST's shape — `approved=1` plus `transaction_id` on the checkout host — is unconfirmed;
 * the first live purchase probe confirms or corrects it, and this is the one place to correct.
 */
export type CheckoutOutcome =
  | { kind: 'approved'; transactionId: string | null }
  | { kind: 'declined' }
  | { kind: 'closed' }
  | { kind: 'timeout' };

const STEAM_HOST = /(^|\.)steampowered\.com$|(^|\.)steamcommunity\.com$/;

/** Only a Steam host over TLS may be shown, whatever a response said. */
export function isAllowedCheckoutUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && STEAM_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** The approve form's fields, as the window reads them off the POST body. Null when the body is something else. */
export function readApproval(body: string): CheckoutOutcome | null {
  const params = new URLSearchParams(body);
  if (!params.has('approved') && !params.has('transaction_id')) return null;
  return params.get('approved') === '1'
    ? { kind: 'approved', transactionId: params.get('transaction_id') }
    : { kind: 'declined' };
}

/** Cookie pairs from `name=value; attributes` strings, attributes dropped; malformed pairs skipped. */
export function cookiePairs(cookies: readonly string[]): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    pairs.push({ name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() });
  }
  return pairs;
}
