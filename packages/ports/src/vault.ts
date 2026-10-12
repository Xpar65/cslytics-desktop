/**
 * Where a secret lives.
 *
 * Neutral because two venues now need one: Steam stores a refresh token, CSFloat an API key.
 * It sat in `adapters-steam` while Steam was the only venue, which would have made the CSFloat
 * adapter import the Steam adapter to learn what a vault is — the one import the dependency
 * guard exists to prevent.
 *
 * A vault is keyed by an opaque string. Nothing here knows what a key means, and nothing here
 * returns a list: there is no enumerate, because a caller that can enumerate secrets is a caller
 * that can leak all of them.
 */
export interface CredentialVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
