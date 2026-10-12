import type { EngineDatabase } from './database.js';

export type MarketplaceVenue = 'csfloat';
/** The one venue name, here rather than in a surface so two surfaces can share it without
 * importing each other — `check:deps` enforces that levels point downward. */
export const CSFLOAT_VENUE: MarketplaceVenue = 'csfloat';
export type ConnectionStatus =
  | 'CONNECTED' | 'CHECKING' | 'INVALID_KEY' | 'RESTRICTED' | 'THROTTLED' | 'UNAVAILABLE' | 'DISCONNECTED';

export type ConnectionRow = {
  account_id: string; venue: string; remote_steam_id: string | null; credential_ref: string | null;
  credential_version: number; generation: number; status: ConnectionStatus; status_reason: string | null;
  connected_at: string | null; checked_at: string | null;
};

export type StatusRow = {
  account_id: string; observation_id: number; observed_at: string; generation: number;
  remote_steam_id: string; available_cents: number | null; pending_cents: number | null; flags_json: string;
};

export type StandingRow = {
  account_id: string; observation_id: number; observed_at: string; generation: number;
  standing: string; penalty_progress: number | null; restrictions_json: string;
};

/** The venue's rating of the account as last read, for the status read model. */
export type CsfloatStandingView = {
  standing: string;
  penaltyProgress: number | null;
  recentRestrictions: ReadonlyArray<{ createdAt: string; category: string }>;
  observedAt: string;
};

export function parseRestrictions(json: string | undefined): Array<{ createdAt: string; category: string }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const row = entry as Record<string, unknown>;
      return typeof row['createdAt'] === 'string' && typeof row['category'] === 'string'
        ? [{ createdAt: row['createdAt'], category: row['category'] }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * What CSFloat has ruled about the account, read from the last `/me`.
 *
 * `suspended` is the only kind the venue has been seen to send, as `user.suspended_until`
 * (`fixtures/csfloat/contracts/me-suspended.json`). Its three states are judged against the
 * observation, never the wall clock alone:
 *
 * - `suspended`: the timestamp is after the observation and still ahead of now.
 * - `stale`: now has passed the timestamp but nothing has been read since. The venue has not
 *   said it ended; only a later `/me` can, so admission stays shut until one arrives.
 * - `ended`: a read made after the timestamp still carries it. CSFloat keeps the key with its
 *   past value, so this is the venue's own statement that the suspension is over.
 */
export type CsfloatRestriction = { kind: 'suspended'; until: string; state: 'suspended' | 'stale' | 'ended' };

/** The stall settings `/me` reports. Null is unread, never off. */
export type CsfloatStall = { away: boolean | null; public: boolean | null };

export function csfloatRestriction(flags: Readonly<Record<string, unknown>>, observedAt: string | null, now: string): CsfloatRestriction | null {
  const until = flags['suspended_until'];
  if (typeof until !== 'string' || !observedAt) return null;
  const untilMs = Date.parse(until), observedMs = Date.parse(observedAt), nowMs = Date.parse(now);
  if (!Number.isFinite(untilMs) || !Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return null;
  const iso = new Date(untilMs).toISOString();
  if (untilMs <= observedMs) return { kind: 'suspended', until: iso, state: 'ended' };
  return { kind: 'suspended', until: iso, state: nowMs >= untilMs ? 'stale' : 'suspended' };
}

export function csfloatStall(flags: Readonly<Record<string, unknown>>): CsfloatStall {
  return {
    away: typeof flags['away'] === 'boolean' ? flags['away'] : null,
    public: typeof flags['stall_public'] === 'boolean' ? flags['stall_public'] : null
  };
}

export function parseFlags(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Durable marketplace connection state. No secret ever passes through here.
 *
 * `credential_ref` is a vault key, `credential_version` is which one is current, and `generation`
 * increments on every connect, replace, disconnect and forget. Generation is what makes a late
 * reply attributable: a `/me` that started under generation 3 cannot publish as the truth of
 * generation 4, however successful it was (CSF-04).
 */
export class MarketplaceStore {
  constructor(readonly db: EngineDatabase) {}

  connection(accountId: string, venue: MarketplaceVenue): ConnectionRow | undefined {
    return this.db.raw().prepare('SELECT * FROM marketplace_connection WHERE account_id=? AND venue=?')
      .get(accountId, venue) as ConnectionRow | undefined;
  }

  connections(venue: MarketplaceVenue): ConnectionRow[] {
    return this.db.raw().prepare('SELECT * FROM marketplace_connection WHERE venue=? ORDER BY account_id')
      .all(venue) as ConnectionRow[];
  }

  /**
   * Points an account's venue at a credential and marks it connected.
   *
   * One statement, inside the caller's transaction: the reference and the generation move
   * together or not at all, because a stored reference with a stale generation is precisely the
   * state that lets an old reply look current.
   */
  connect(input: {
    accountId: string; venue: MarketplaceVenue; remoteSteamId: string; credentialRef: string;
    credentialVersion: number; generation: number; now: string;
  }): void {
    this.db.raw().prepare(`
      INSERT INTO marketplace_connection(account_id, venue, remote_steam_id, credential_ref, credential_version,
        generation, status, status_reason, connected_at, checked_at)
      VALUES (@accountId, @venue, @remoteSteamId, @credentialRef, @credentialVersion, @generation, 'CONNECTED', NULL, @now, @now)
      ON CONFLICT(account_id, venue) DO UPDATE SET remote_steam_id=excluded.remote_steam_id,
        credential_ref=excluded.credential_ref, credential_version=excluded.credential_version,
        generation=excluded.generation, status='CONNECTED', status_reason=NULL,
        connected_at=COALESCE(marketplace_connection.connected_at, excluded.connected_at), checked_at=excluded.checked_at
    `).run({ ...input });
  }

  /** Records what the venue or the network said, without touching which credential is current. */
  markStatus(accountId: string, venue: MarketplaceVenue, status: ConnectionStatus, reason: string | null, now: string): void {
    this.db.raw().prepare(`
      UPDATE marketplace_connection SET status=?, status_reason=?, checked_at=? WHERE account_id=? AND venue=?
    `).run(status, reason, now, accountId, venue);
  }

  /**
   * Ends the connection and burns its generation.
   *
   * `forget` clears the reference as well, because the secret is going with it. Both keep the row:
   * a venue this profile has linked before is an *unavailable* venue, not an unknown one, and
   * protection has to be able to tell those apart (plan §4.1).
   */
  disconnect(accountId: string, venue: MarketplaceVenue, mode: 'disconnect' | 'forget', now: string): number {
    const row = this.connection(accountId, venue);
    const generation = (row?.generation ?? 0) + 1;
    this.db.raw().prepare(`
      UPDATE marketplace_connection
      SET status='DISCONNECTED', status_reason=?, generation=?, checked_at=?,
          credential_ref=CASE WHEN ?='forget' THEN NULL ELSE credential_ref END
      WHERE account_id=? AND venue=?
    `).run(mode === 'forget' ? 'forgotten' : 'disconnected', generation, now, mode, accountId, venue);
    return generation;
  }

  status(accountId: string): StatusRow | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_account_status WHERE account_id=?')
      .get(accountId) as StatusRow | undefined;
  }

  /**
   * The current connection's restriction, or null. A status row from a dead generation says
   * nothing about the connection that replaced it (CSF-04), so it reads as unknown here and the
   * freshness checks around admission are what refuse an unread account.
   */
  restriction(accountId: string, now: string): CsfloatRestriction | null {
    const connection = this.connection(accountId, CSFLOAT_VENUE);
    const status = this.status(accountId);
    if (!connection || !status || status.generation !== connection.generation) return null;
    return csfloatRestriction(parseFlags(status.flags_json), status.observed_at, now);
  }

  standing(accountId: string): StandingRow | undefined {
    return this.db.raw().prepare('SELECT * FROM csfloat_account_standing WHERE account_id=?')
      .get(accountId) as StandingRow | undefined;
  }

  publishStanding(row: StandingRow): void {
    this.db.raw().prepare(`
      INSERT INTO csfloat_account_standing(account_id, observation_id, observed_at, generation, standing, penalty_progress, restrictions_json)
      VALUES (@account_id, @observation_id, @observed_at, @generation, @standing, @penalty_progress, @restrictions_json)
      ON CONFLICT(account_id) DO UPDATE SET observation_id=excluded.observation_id, observed_at=excluded.observed_at,
        generation=excluded.generation, standing=excluded.standing, penalty_progress=excluded.penalty_progress,
        restrictions_json=excluded.restrictions_json
    `).run({ ...row });
  }

  publishStatus(row: StatusRow): void {
    this.db.raw().prepare(`
      INSERT INTO csfloat_account_status(account_id, observation_id, observed_at, generation, remote_steam_id,
        available_cents, pending_cents, flags_json)
      VALUES (@account_id, @observation_id, @observed_at, @generation, @remote_steam_id, @available_cents, @pending_cents, @flags_json)
      ON CONFLICT(account_id) DO UPDATE SET observation_id=excluded.observation_id, observed_at=excluded.observed_at,
        generation=excluded.generation, remote_steam_id=excluded.remote_steam_id, available_cents=excluded.available_cents,
        pending_cents=excluded.pending_cents, flags_json=excluded.flags_json
    `).run({ ...row });
  }
}
