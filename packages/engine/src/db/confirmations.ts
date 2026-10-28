import type { ConfirmationKind } from '@cslytics/ports';
import type { CommandAuthority } from './alphabets.js';
import type { EngineDatabase } from './database.js';
import { OPEN_STEP_STATES_SQL, type WorkStepRow } from './work.js';

/** The command kind, step kind and action kind of the engine's own confirmation (strategy authority and confirmations plan D9). */
export const CONFIRM = 'CONFIRM' as const;

/** A hop of ours whose listing or offer a complete walk shows waiting for a tap, with no confirmation opened for it yet. */
export type OwedConfirmation = {
  stepId: string; commandId: string; accountId: string; localId: string | null;
  kind: ConfirmationKind; targetId: string;
  /** The CSFloat sale a delivery's offer is for: a confirmed offer for an ended sale gives the item away (D11). */
  tradeId: string | null;
  authority: CommandAuthority;
};

/** The frozen terms of a confirmation hop: what it confirms, and the hop and command it follows. */
export type ConfirmStepParams = { target: { kind: ConfirmationKind; id: string }; stepId: string; commandId: string; tradeId: string | null };

/** What the record's last walks say about a target. */
export type TargetSighting = {
  /** `confirmed` once Steam shows it past the tap, `waiting` while it shows it waiting, `ended` once it left without one. */
  state: 'confirmed' | 'waiting' | 'ended';
  /** The observation that showed it. */
  observationId: number;
  /** For an ending, what it was. */
  words: string | null;
};

/**
 * The confirmation's SQL (D8–D11). It finds what only the engine's own hops made — a listing a
 * `LIST` hop's attempt opened, an offer a send hop names — so a listing or an offer from anywhere
 * else is never owed a press; and it reads what the walks say about each target.
 */
export class ConfirmationStore {
  constructor(readonly db: EngineDatabase) {}

  /**
   * Every listing or offer an open hop of ours made that the last walk shows waiting for a tap,
   * and that has no confirmation yet. A listing is matched by the hop's own attempt
   * (`order_attempt`), never by its item: an item listed by hand elsewhere is not ours to confirm.
   */
  owed(accountId: string): OwedConfirmation[] {
    return this.db.raw().prepare(`
      SELECT s.id AS stepId, s.command_id AS commandId, s.account_id AS accountId, s.local_id AS localId,
        'SELL_LISTING' AS kind, v.venue_order_id AS targetId, NULL AS tradeId, c.authority AS authority
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN venue_order v INDEXED BY order_attempt ON v.account_id=s.account_id AND v.action_id=s.action_id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind='LIST'
        AND v.venue='steam' AND v.side='SELL' AND v.state='PENDING_EXTERNAL' AND v.gone_obs IS NULL AND v.venue_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}' AND k.target_id=v.venue_order_id)
      UNION ALL
      SELECT s.id, s.command_id, s.account_id, s.local_id,
        'TRADE_OFFER', o.offer_id, CASE WHEN s.kind='CSFLOAT_SEND' THEN s.target_id END, c.authority
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN trade_offer o ON o.account_id=s.account_id AND o.offer_id=s.offer_id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind IN ('SEND','CSFLOAT_SEND') AND s.offer_id IS NOT NULL
        AND o.direction='SENT' AND o.status='PENDING_CONFIRMATION'
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}' AND k.target_id=o.offer_id)
    `).all(accountId, accountId) as OwedConfirmation[];
  }

  /** The account's confirmations still open, oldest first. */
  open(accountId: string): WorkStepRow[] {
    return this.db.raw().prepare(`SELECT * FROM work_step INDEXED BY work_step_account_state
      WHERE account_id=? AND state IN ${OPEN_STEP_STATES_SQL} AND kind='${CONFIRM}' ORDER BY created_at, id`).all(accountId) as WorkStepRow[];
  }

  /**
   * What the last complete walk of its surface says about a target, or `null` while none has
   * said anything decisive. Shown past the tap is decisive whichever walk showed it, because only a
   * tap — ours or the person's — puts it there; shown waiting counts only from the latest complete
   * walk, which is what a proof of "not applied" needs (D10).
   */
  sighting(accountId: string, target: { kind: ConfirmationKind; id: string }): TargetSighting | null {
    if (target.kind === 'SELL_LISTING') {
      const row = this.db.raw().prepare(`SELECT state, gone_obs, last_seen_obs FROM venue_order INDEXED BY order_venue_id
        WHERE account_id=? AND venue='steam' AND venue_order_id=?`).get(accountId, target.id) as { state: string; gone_obs: number | null; last_seen_obs: number | null } | undefined;
      if (!row || row.last_seen_obs === null) return null;
      // A listing that sold was confirmed, whether or not a walk caught it live in between.
      if (row.state === 'ENDED_FILLED' || ((row.state === 'OPEN' || row.state === 'OPEN_UNTRANSACTABLE') && row.gone_obs === null)) {
        return { state: 'confirmed', observationId: row.last_seen_obs, words: null };
      }
      if (row.state.startsWith('ENDED_')) return { state: 'ended', observationId: row.gone_obs ?? row.last_seen_obs, words: 'The listing ended before it was confirmed' };
      const latest = this.db.latestCompleteObservationForScope(accountId, 'account', null, 'steam-market');
      if (row.state === 'PENDING_EXTERNAL' && row.gone_obs === null && latest && row.last_seen_obs === latest.id) return { state: 'waiting', observationId: latest.id, words: null };
      // Gone and not yet explained: the order's own lifecycle says what ended it, and nothing is pressed meanwhile.
      return null;
    }
    const offer = this.db.raw().prepare('SELECT status, last_seen_obs FROM trade_offer WHERE account_id=? AND offer_id=?')
      .get(accountId, target.id) as { status: string; last_seen_obs: number | null } | undefined;
    if (!offer || offer.last_seen_obs === null) return null;
    // Past the tap: active, and anything only an active offer can become.
    if (['ACTIVE', 'ACCEPTED', 'DECLINED', 'COUNTERED', 'ESCROW'].includes(offer.status)) return { state: 'confirmed', observationId: offer.last_seen_obs, words: null };
    if (offer.status === 'PENDING_CONFIRMATION') {
      const latest = this.db.latestCompleteObservationForScope(accountId, 'account', null, 'steam-trade-offers');
      return latest && offer.last_seen_obs === latest.id ? { state: 'waiting', observationId: latest.id, words: null } : null;
    }
    if (offer.status === 'UNKNOWN') return null;
    return { state: 'ended', observationId: offer.last_seen_obs, words: `The offer ended (${offer.status.toLowerCase().replace(/_/g, ' ')}) before it was confirmed` };
  }

  /** The confirmation opened for a target, if any: one per target, ever. */
  forTarget(accountId: string, targetId: string): WorkStepRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM work_step INDEXED BY work_step_target WHERE account_id=? AND kind='${CONFIRM}' AND target_id=? ORDER BY created_at LIMIT 1`)
      .get(accountId, targetId) as WorkStepRow | undefined;
  }
}
