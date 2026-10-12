import type { AccountId } from '../kernel.js';

/** Steam's published default avatar when the account has none set. */
export const DEFAULT_AVATAR_HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';

/**
 * One Steam persona observation.
 *
 * `avatarHash` is the 40-character hex Steam avatar hash. The zero hash Steam sometimes
 * returns is normalised to the documented default (`fef49e7…`) before it leaves the adapter.
 * The engine stores the hash; the desktop composes the CDN URL. A caller-supplied URL never
 * crosses this boundary.
 */
export type SteamPersona = {
  steamId64: string;
  /** Current display name (`player_name` / `personaname`). Not the login username. */
  personaName: string;
  /** 40 lowercase hex characters. */
  avatarHash: string;
};

/**
 * Persona name and avatar hash for one or more SteamIDs, via the logged-on client session.
 *
 * Evidence: Offline `getPersonas` on a client CM logon returns name + avatar URLs with no
 * Web API key and no `setPersona`
 * (`fixtures/steam/contracts/personas-getpersonas-offline-live.json`). Do not ship a
 * `STEAM_API_KEY` for this.
 */
export interface SteamPersonaPort {
  getPersonas(accountId: AccountId, steamIds: readonly string[]): Promise<SteamPersona[]>;
}
