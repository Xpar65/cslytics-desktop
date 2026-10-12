import { DEFAULT_AVATAR_HASH, type AccountId, type SteamPersona, type SteamPersonaPort } from '@cslytics/ports';
import type { SteamClientSessionPool } from './client-session.js';

const ZERO_AVATAR_HASH = '0000000000000000000000000000000000000000';

/**
 * Persona name and avatar hash through steam-user `getPersonas`.
 *
 * Uses the already-logged-on CM client from the shared pool. Never launches CS2, never calls
 * `gamesPlayed`, never calls `setPersona`. A missing client session fails the call so the
 * engine surface can record an incomplete observation and keep any previous hash.
 */
export class SteamPersonaAdapter implements SteamPersonaPort {
  constructor(private readonly clients: SteamClientSessionPool) {}

  async getPersonas(accountId: AccountId, steamIds: readonly string[]): Promise<SteamPersona[]> {
    if (steamIds.length === 0) return [];
    const { user } = await this.clients.connect(accountId);
    if (typeof user.getPersonas !== 'function') {
      throw new Error(`Steam client for ${accountId} has no getPersonas`);
    }
    const raw = await user.getPersonas([...steamIds]);
    const personas = asPersonas(raw);
    const out: SteamPersona[] = [];
    for (const steamId64 of steamIds) {
      const row = personas[steamId64];
      if (!row || typeof row !== 'object') continue;
      const personaName = typeof row.player_name === 'string' ? row.player_name.trim() : '';
      const avatarHash = normaliseAvatarHash(row.avatar_hash);
      if (!personaName || !avatarHash) continue;
      out.push({ steamId64, personaName, avatarHash });
    }
    return out;
  }
}

function asPersonas(raw: unknown): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as { personas?: Record<string, Record<string, unknown>> };
  if (record.personas && typeof record.personas === 'object') return record.personas;
  return raw as Record<string, Record<string, unknown>>;
}

/** Accepts a Buffer, ByteBuffer-like, or hex string; maps the zero hash to Steam's default. */
export function normaliseAvatarHash(value: unknown): string | null {
  let hex = '';
  if (typeof value === 'string') {
    hex = value.toLowerCase();
  } else if (value && typeof value === 'object' && Buffer.isBuffer(value)) {
    hex = value.toString('hex');
  } else if (value && typeof value === 'object' && typeof (value as { toString?: (enc: string) => string }).toString === 'function') {
    try {
      const asHex = (value as { toString: (enc: string) => string }).toString('hex');
      if (/^[0-9a-f]{40}$/i.test(asHex)) hex = asHex.toLowerCase();
    } catch { /* not a hex-capable buffer */ }
  }
  if (hex === ZERO_AVATAR_HASH) hex = DEFAULT_AVATAR_HASH;
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null;
}
