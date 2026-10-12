/**
 * The two spellings of one Steam account, converted as strings.
 *
 * `GetTradeOffers` names the other party by `accountid_other`, Steam's 32-bit account id, while
 * `GetTradeHistory` and every account row here use the 64-bit SteamID. The trades page has to say
 * whether the other party of an offer is one of the person's own accounts, so the two have to meet.
 *
 * Strings in, strings out, through `BigInt`: a SteamID64 is above 2^53, and a `Number` silently
 * rounds it to a different account. Anything that is not a plain decimal id is refused with `null`
 * rather than converted into something that looks like an id.
 */
export const STEAM_ID64_BASE = 76561197960265728n;

const ACCOUNT_ID_MAX = 0xffff_ffffn;
const DIGITS = /^[0-9]{1,20}$/;

/** `accountid_other` → SteamID64, or `null` for anything that is not a 32-bit account id. */
export function steamId64FromAccountId(accountId: string): string | null {
  if (!DIGITS.test(accountId)) return null;
  const value = BigInt(accountId);
  if (value < 1n || value > ACCOUNT_ID_MAX) return null;
  return (value + STEAM_ID64_BASE).toString();
}

/** SteamID64 → the 32-bit account id, or `null` for anything outside the individual-account range. */
export function accountIdFromSteamId64(steamId64: string): string | null {
  if (!DIGITS.test(steamId64)) return null;
  const value = BigInt(steamId64) - STEAM_ID64_BASE;
  if (value < 1n || value > ACCOUNT_ID_MAX) return null;
  return value.toString();
}
