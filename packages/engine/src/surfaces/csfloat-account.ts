import type { AccountId, CsfloatMePatch, CsfloatMeResult, CsfloatPorts, CsfloatReadResult, CsfloatStanding, CsfloatUpdateResult } from '@cslytics/ports';
import {
  CSFLOAT_VENUE, MarketplaceStore, csfloatRestriction, csfloatStall, parseFlags, parseRestrictions,
  type ConnectionRow, type ConnectionStatus, type CsfloatRestriction, type CsfloatStall, type CsfloatStandingView, type MarketplaceVenue
} from '../db/marketplace.js';
import type { EngineContext } from '../kernel/context.js';
import { errorMessage } from '../kernel/support.js';

export { CSFLOAT_VENUE } from '../db/marketplace.js';
export const CSFLOAT_STATUS_SURFACE = 'csfloat-account-status';
/** Its own surface: the route can refuse while `/me` answers, and each keeps its own observation. */
export const CSFLOAT_STANDING_SURFACE = 'csfloat-account-standing';

export type ConnectResult =
  | { kind: 'connected'; remoteSteamId: string; generation: number }
  | { kind: 'identity-mismatch'; remoteSteamId: string; expectedSteamId: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string };

export type MarketplaceStatus = {
  venue: MarketplaceVenue;
  status: ConnectionStatus | 'NOT_CONNECTED';
  remoteSteamId: string | null;
  generation: number;
  checkedAt: string | null;
  reason: string | null;
  availableCents: number | null;
  pendingCents: number | null;
  flags: Record<string, unknown>;
  observedAt: string | null;
  /** The venue's ruling on the account, judged against `observedAt` (`csfloatRestriction`). */
  restriction: CsfloatRestriction | null;
  stall: CsfloatStall;
  /** `/me/account-standing` as last read for this connection; null until read, and never from a dead generation. */
  standing: CsfloatStandingView | null;
};

/**
 * Connecting a CSFloat account, and keeping what it says about itself.
 *
 * Three rules shape every method here.
 *
 * **A key is validated before it is stored** (CSF-02). The sequence is verify, write the new
 * vault entry, switch the database reference, and only then delete the entry it replaced. A
 * replacement that fails anywhere in that chain leaves the working credential in place, because
 * the old entry is still there and the reference still points at it.
 *
 * **The key belongs to whoever CSFloat says it does** (CSF-01). The SteamID64 from `/me` is
 * compared with the account's canonical identity, and a mismatch stores nothing, replaces
 * nothing and burns no generation — the connection the user already had is untouched.
 *
 * **Only the venue may end a connection** (CSF-21). A 429 or a dead network says nothing about
 * the key: those mark the connection throttled or unavailable and keep the credential. Only an
 * explicit refusal marks it invalid, and even then the stored secret stays until the user says
 * to forget it, because "CSFloat refused once" and "this key is gone" are different claims.
 */
export class CsfloatAccountService {
  protected readonly store: MarketplaceStore;

  constructor(protected readonly context: EngineContext) {
    this.store = new MarketplaceStore(context.database);
  }

  private ports(): CsfloatPorts {
    const csfloat = this.context.ports.csfloat;
    if (!csfloat) throw new Error('No CSFloat ports are composed in this runtime');
    return csfloat;
  }

  async connect(accountId: AccountId, apiKey: string): Promise<ConnectResult> {
    const account = this.context.database.account(accountId);
    if (!account) throw new Error(`Unknown account ${accountId}`);
    const ports = this.ports();
    const existing = this.store.connection(accountId, CSFLOAT_VENUE);

    const result = await ports.account.verifyKey(accountId, apiKey);
    if (result.kind !== 'ok') {
      const outcome = this.failedCheck(accountId, result, existing);
      this.event(accountId, 'marketplace-connect-refused', { venue: CSFLOAT_VENUE, outcome: outcome.kind, reason: describe(result) });
      return outcome;
    }
    if (result.me.steamId64 !== account.steam_id64) {
      // Nothing is written: not the vault, not the reference, not the generation. The user gets
      // told which account the key actually belongs to, which is the only useful next step.
      this.event(accountId, 'marketplace-identity-mismatch', {
        venue: CSFLOAT_VENUE, remoteSteamId: result.me.steamId64, expectedSteamId: account.steam_id64
      });
      return { kind: 'identity-mismatch', remoteSteamId: result.me.steamId64, expectedSteamId: account.steam_id64 };
    }

    const version = (existing?.credential_version ?? 0) + 1;
    const generation = (existing?.generation ?? 0) + 1;
    const credentialRef = credentialRefFor(accountId, version);
    await ports.vault.set(credentialRef, apiKey);
    this.context.database.transaction(() => {
      this.store.connect({
        accountId, venue: CSFLOAT_VENUE, remoteSteamId: result.me.steamId64,
        credentialRef, credentialVersion: version, generation, now: this.context.now()
      });
      this.context.database.addCredentialRef(accountId, `csfloat-api-key`, credentialRef);
      // Deliberately no key, no prefix, no length: an activity row is durable and exportable.
      this.context.database.addEvent(accountId, 'marketplace-connected', {
        venue: CSFLOAT_VENUE, remoteSteamId: result.me.steamId64, generation
      }, this.context.now());
    });
    // Only after the switch is durable. Crashing before this leaves an orphan entry, which
    // recovery cleans; crashing after an early delete would leave no usable credential at all.
    if (existing?.credential_ref && existing.credential_ref !== credentialRef) {
      await ports.vault.delete(existing.credential_ref);
    }
    this.publish(accountId, result, generation, true);
    await this.refreshStanding(accountId);
    return { kind: 'connected', remoteSteamId: result.me.steamId64, generation };
  }

  /** Stops using the connection. `forget` also deletes the secret; both keep the history. */
  async disconnect(accountId: AccountId, mode: 'disconnect' | 'forget' = 'disconnect'): Promise<void> {
    const existing = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!existing) return;
    const generation = this.context.database.transaction(() => {
      const next = this.store.disconnect(accountId, CSFLOAT_VENUE, mode, this.context.now());
      this.context.database.addEvent(accountId, `marketplace-${mode === 'forget' ? 'forgotten' : 'disconnected'}`, {
        venue: CSFLOAT_VENUE, generation: next
      }, this.context.now());
      return next;
    });
    void generation;
    if (mode === 'forget' && existing.credential_ref) await this.ports().vault.delete(existing.credential_ref);
  }

  /**
   * Deletes every CSFloat key this account ever stored, including the orphans a replace that
   * crashed can leave (versions 1 to `credential_version`). Removing the account is the only
   * caller, and it writes nothing here: the purge that follows deletes the connection itself.
   */
  async forgetKeys(accountId: AccountId): Promise<void> {
    const existing = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!existing || !this.context.ports.csfloat) return;
    for (let version = 1; version <= existing.credential_version; version += 1) {
      await this.ports().vault.delete(credentialRefFor(accountId, version));
    }
  }

  /**
   * Re-reads `/me` for one connected account.
   *
   * The generation is read before the call and checked after it. If the connection was replaced,
   * disconnected or forgotten while the request was in flight, the answer is recorded as an
   * observation and then dropped: it is true about a connection that no longer exists.
   */
  async refreshStatus(accountId: AccountId): Promise<MarketplaceStatus> {
    const before = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!before?.credential_ref || before.status === 'DISCONNECTED') return this.status(accountId);
    const startedAt = this.context.now();
    let result: CsfloatMeResult;
    try {
      result = await this.ports().account.getMe(accountId, before.credential_ref);
    } catch (error) {
      result = { kind: 'unavailable', cause: 'transport', raw: errorMessage(error) };
    }
    const after = this.store.connection(accountId, CSFLOAT_VENUE);
    const current = after?.generation === before.generation;
    if (result.kind === 'ok') {
      this.context.database.insertObservation({
        accountId, surface: CSFLOAT_STATUS_SURFACE, generation: before.generation, startedAt,
        finishedAt: this.context.now(), complete: true, pagesWalked: 1
      });
      if (current) {
        this.publish(accountId, result, before.generation, false);
        // Beside `/me`, the way the profile page reads it. Its outcome cannot touch the connection.
        await this.refreshStanding(accountId);
      }
      return this.status(accountId);
    }
    this.context.database.insertObservation({
      accountId, surface: CSFLOAT_STATUS_SURFACE, generation: before.generation, startedAt,
      finishedAt: this.context.now(), complete: false, error: describe(result)
    });
    if (current) this.failedCheck(accountId, result, before);
    return this.status(accountId);
  }

  /**
   * Reads `/me/account-standing` for the current connection.
   *
   * The route is documented from a session-cookie capture and the key may not open it. So a
   * refusal, a throttle or an outage here is recorded as an incomplete observation of *this*
   * surface and changes nothing else: not the connection's status, not the credential, and not
   * the last standing that was read, which stays with its own time (CSF-29).
   */
  async refreshStanding(accountId: AccountId): Promise<void> {
    const before = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!before?.credential_ref || before.status !== 'CONNECTED') return;
    // Beside the status read the broker made, under the same venue's budget (read broker plan D12).
    await this.context.governors.admitRead(accountId, 'csfloat', CSFLOAT_STANDING_SURFACE);
    const startedAt = this.context.now();
    let result: CsfloatReadResult<CsfloatStanding>;
    try {
      result = await this.ports().account.getStanding(accountId, before.credential_ref);
    } catch (error) {
      result = { kind: 'unavailable', cause: 'transport', raw: errorMessage(error) };
    }
    if (result.kind !== 'ok') {
      this.context.database.insertObservation({
        accountId, surface: CSFLOAT_STANDING_SURFACE, generation: before.generation, startedAt,
        finishedAt: this.context.now(), complete: false, error: describe(result)
      });
      return;
    }
    const observationId = this.context.database.insertObservation({
      accountId, surface: CSFLOAT_STANDING_SURFACE, generation: before.generation, startedAt,
      finishedAt: this.context.now(), complete: true, pagesWalked: 1
    });
    // Replaced while in flight: true of a connection that no longer exists (CSF-04).
    if (this.store.connection(accountId, CSFLOAT_VENUE)?.generation !== before.generation) return;
    this.store.publishStanding({
      account_id: accountId, observation_id: observationId, observed_at: this.context.now(),
      standing: result.value.standing, penalty_progress: result.value.penaltyProgress,
      restrictions_json: JSON.stringify(result.value.recentRestrictions)
    });
  }

  status(accountId: AccountId): MarketplaceStatus {
    const connection = this.store.connection(accountId, CSFLOAT_VENUE);
    const status = this.store.status(accountId);
    const stale = status && connection && this.context.database.observation(accountId, status.observation_id)?.generation !== connection.generation;
    const standingRow = this.store.standing(accountId);
    const standing: CsfloatStandingView | null = standingRow && connection && this.context.database.observation(accountId, standingRow.observation_id)?.generation === connection.generation
      ? {
          standing: standingRow.standing, penaltyProgress: standingRow.penalty_progress,
          recentRestrictions: parseRestrictions(standingRow.restrictions_json), observedAt: standingRow.observed_at
        }
      : null;
    // Money and readiness from a dead generation are not this connection's facts.
    const flags = stale ? {} : parseFlags(status?.flags_json);
    const observedAt = stale ? null : status?.observed_at ?? null;
    return {
      venue: CSFLOAT_VENUE,
      status: connection ? connection.status : 'NOT_CONNECTED',
      remoteSteamId: connection?.remote_steam_id ?? null,
      generation: connection?.generation ?? 0,
      checkedAt: connection?.checked_at ?? null,
      reason: connection?.status_reason ?? null,
      availableCents: stale ? null : status?.available_cents ?? null,
      pendingCents: stale ? null : status?.pending_cents ?? null,
      flags,
      observedAt,
      restriction: csfloatRestriction(flags, observedAt, this.context.now()),
      stall: csfloatStall(flags),
      standing
    };
  }

  /**
   * Changes the stall's away or public setting at the venue.
   *
   * The reply is not the result. CSFloat answers `PATCH /me` with `{"message":"user updated!"}`,
   * which is an acknowledgement of the attempt; `/me` is read again on every path out of here,
   * including a refusal and a lost reply, and the caller shows what came back (rule 1). A
   * refusal is thrown *after* that read, so the window is never left believing the request.
   */
  async updateStall(accountId: AccountId, patch: CsfloatMePatch): Promise<MarketplaceStatus> {
    const connection = this.store.connection(accountId, CSFLOAT_VENUE);
    if (!connection?.credential_ref || connection.status !== 'CONNECTED') throw new Error('Connect CSFloat first');
    let result: CsfloatUpdateResult;
    try {
      result = await this.ports().account.updateMe(accountId, connection.credential_ref, patch);
    } catch (error) {
      result = { kind: 'unavailable', cause: 'transport', raw: errorMessage(error) };
    }
    this.event(accountId, 'csfloat-stall-updated', {
      venue: CSFLOAT_VENUE, patch, outcome: result.kind,
      ...(result.kind === 'rejected' ? { code: result.code, message: result.message } : {})
    });
    const status = await this.refreshStatus(accountId);
    if (result.kind === 'rejected') throw new Error(result.message ? `CSFloat refused: ${result.message}` : `CSFloat refused the change (${result.reason})`);
    if (result.kind === 'throttled') throw new Error('CSFloat asked us to slow down. The setting shows what CSFloat reads back.');
    if (result.kind === 'unavailable') throw new Error('CSFloat did not answer. The setting shows what CSFloat reads back.');
    return status;
  }

  /**
   * Turns a refusal into a connection status.
   *
   * The distinction it exists to keep: `rejected` is CSFloat answering about the key, while
   * `throttled` and `unavailable` are the absence of an answer. Neither of the latter may make a
   * usable connection look invalid, and none of the three deletes a stored secret.
   */
  protected failedCheck(accountId: AccountId, result: CsfloatMeResult, existing: ConnectionRow | undefined): ConnectResult {
    const reason = describe(result);
    const status: ConnectionStatus = result.kind === 'rejected'
      ? (result.reason === 'forbidden' ? 'RESTRICTED' : 'INVALID_KEY')
      : result.kind === 'throttled' ? 'THROTTLED' : 'UNAVAILABLE';
    if (existing) this.store.markStatus(accountId, CSFLOAT_VENUE, status, reason, this.context.now());
    return result.kind === 'rejected' ? { kind: 'rejected', reason } : { kind: 'unavailable', reason };
  }

  private publish(accountId: AccountId, result: CsfloatMeResult & { kind: 'ok' }, generation: number, connecting: boolean): void {
    const observationId = this.context.database.insertObservation({
      accountId, surface: CSFLOAT_STATUS_SURFACE, generation, startedAt: this.context.now(),
      finishedAt: this.context.now(), complete: true, pagesWalked: 1
    });
    const now = this.context.now();
    this.context.database.transaction(() => {
      // The suspension's history is its event rows, not a table: one when a read first carries
      // a future `suspended_until`, one when a later read shows it ended or gone. The lifted
      // event also says whether the stall is still away, because CSFloat sets that during a
      // suspension and never clears it — the one thing the user has to be told to undo.
      const previous = this.store.status(accountId);
      const before = previous && this.context.database.observation(accountId, previous.observation_id)?.generation === generation
        ? csfloatRestriction(parseFlags(previous.flags_json), previous.observed_at, previous.observed_at)
        : null;
      const after = csfloatRestriction(result.me.flags, now, now);
      const wasSuspended = before !== null && before.state !== 'ended';
      const isSuspended = after !== null && after.state !== 'ended';
      this.store.publishStatus({
        account_id: accountId, observation_id: observationId, observed_at: now,
        remote_steam_id: result.me.steamId64, available_cents: result.me.availableCents,
        pending_cents: result.me.pendingCents, flags_json: JSON.stringify(result.me.flags)
      });
      if (!connecting) this.store.markStatus(accountId, CSFLOAT_VENUE, 'CONNECTED', null, now);
      if (isSuspended && !wasSuspended) {
        this.context.database.addEvent(accountId, 'csfloat-suspended', { venue: CSFLOAT_VENUE, until: after.until, observationId }, now);
      } else if (wasSuspended && !isSuspended) {
        this.context.database.addEvent(accountId, 'csfloat-suspension-lifted', {
          venue: CSFLOAT_VENUE, until: before.until, stallAway: csfloatStall(result.me.flags).away === true, observationId
        }, now);
      }
    });
    this.context.signals.emit({
      kind: 'observed', accountId, surface: CSFLOAT_STATUS_SURFACE, complete: true, observationId
    });
  }

  private event(accountId: AccountId, kind: string, payload: Record<string, unknown>): void {
    this.context.database.addEvent(accountId, kind, payload, this.context.now());
  }
}

/** The vault key naming one account's CSFloat credential. Mirrors `adapters-csfloat`. */
export function credentialRefFor(accountId: string, version: number): string {
  return `csfloat-api-key:${accountId}:${version}`;
}

/** A reason a human can act on, and never anything that came out of the key. */
function describe(result: CsfloatMeResult | CsfloatReadResult<unknown>): string {
  if (result.kind === 'rejected') return `csfloat-${result.reason}`;
  if (result.kind === 'throttled') return 'csfloat-throttled';
  if (result.kind === 'unavailable') return `csfloat-${result.cause}`;
  return 'csfloat-ok';
}
