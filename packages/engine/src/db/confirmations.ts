import type { ConfirmationKind } from '@cslytics/ports';
import type { CommandAuthority } from './alphabets.js';
import type { ActionRow, EngineDatabase } from './database.js';
import { OrderStore } from './orders.js';
import { priceChangeConfirmer, priceChangeInEffect } from '../kernel/listing-price.js';
import { OPEN_STEP_STATES_SQL, WorkStore, type WorkStepRow } from './work.js';

/** The command kind, step kind and action kind of the engine's own confirmation (strategy authority and confirmations plan D9). */
export const CONFIRM = 'CONFIRM' as const;

/** A confirmation hop, aliased `alias`, that is not a price change's: what "one per target, ever" counts. */
const notAPriceChange = (alias: string): string => `IFNULL(json_extract(${alias}.params_json, '$.target.kind'), '')<>'LISTING_PRICE_CHANGE'`;
const NOT_A_PRICE_CHANGE_SQL = notAPriceChange('k');

/**
 * A hop of ours whose listing or offer a complete walk shows waiting for a tap, or whose buy order
 * or lower listing price Steam's own answer says waits for one, with no confirmation opened for it yet.
 */
export type OwedConfirmation = {
  stepId: string; commandId: string; accountId: string; localId: string | null;
  kind: ConfirmationKind; targetId: string;
  /** The CSFloat sale a delivery's offer is for: a confirmed offer for an ended sale gives the item away (D11). */
  tradeId: string | null;
  authority: CommandAuthority;
  /**
   * Who Steam said confirms it, where its answer said: a lower listing price waits for the mobile
   * app or for a link sent by e-mail, and only the first can be pressed. `null` for every other kind.
   */
  confirmBy: 'phone' | 'email' | null;
};

/** The kind of confirmation whose identity is the hop it follows, not its target (in-place reprice plan D14). */
export const PRICE_CHANGE_CONFIRMATION: ConfirmationKind = 'LISTING_PRICE_CHANGE';

/** The frozen terms of a confirmation hop: what it confirms, and the hop and command it follows. */
export type ConfirmStepParams = { target: { kind: ConfirmationKind; id: string }; stepId: string; commandId: string; tradeId: string | null };

/**
 * What the record says about a buy order's confirmation (standing buy orders plan D4, D8). A buy
 * order has no row on the book until Steam places it, so the walk proves the tap only by binding
 * the order the create made; the request sent again after a press is what says the tap did not
 * apply, because Steam answers it with the same confirmation again.
 */
export type BuyOrderConfirmationSighting =
  /** A walk bound the order the create made: placed, whoever tapped. */
  | { state: 'confirmed'; observationId: number }
  /** The create ended without an order, or no longer waits for a tap: nothing is left to confirm. */
  | { state: 'ended'; observationId: number | null; words: string }
  /** The request sent again after the latest press answered with this same confirmation: the press did not apply. */
  | { state: 'asked-again' }
  /** The request sent again named a different confirmation: this one is spent, and the new one is owed its own. */
  | { state: 'asked-anew' };

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
   * `now` is the engine's clock, which a lower price's deadline is read against.
   */
  owed(accountId: string, now: string): OwedConfirmation[] {
    return [...this.owedHops(accountId), ...this.owedPriceChanges(accountId, now), ...this.owedBuyOrders(accountId)];
  }

  /**
   * The listings and offers of `owed`. A listing's own confirmation is one per listing, ever; the
   * confirmations of its later price changes carry the same id and are not it, so they never count.
   */
  private owedHops(accountId: string): OwedConfirmation[] {
    return this.db.raw().prepare(`
      SELECT s.id AS stepId, s.command_id AS commandId, s.account_id AS accountId, s.local_id AS localId,
        'SELL_LISTING' AS kind, v.venue_order_id AS targetId, NULL AS tradeId, c.authority AS authority, NULL AS confirmBy
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN venue_order v INDEXED BY order_attempt ON v.account_id=s.account_id AND v.action_id=s.action_id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind='LIST'
        AND v.venue='steam' AND v.side='SELL' AND v.state='PENDING_EXTERNAL' AND v.gone_obs IS NULL AND v.venue_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}' AND k.target_id=v.venue_order_id
          AND ${NOT_A_PRICE_CHANGE_SQL})
      UNION ALL
      SELECT s.id, s.command_id, s.account_id, s.local_id,
        'TRADE_OFFER', o.offer_id, CASE WHEN s.kind='CSFLOAT_SEND' THEN s.target_id END, c.authority, NULL
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN trade_offer o ON o.account_id=s.account_id AND o.offer_id=s.offer_id
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind IN ('SEND','CSFLOAT_SEND') AND s.offer_id IS NOT NULL
        AND o.direction='SENT' AND o.status='PENDING_CONFIRMATION'
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}' AND k.target_id=o.offer_id)
    `).all(accountId, accountId) as OwedConfirmation[];
  }

  /**
   * Every lower listing price of ours Steam's answer said it holds for a confirmation, whose
   * confirmation has no hop yet (in-place reprice plan D14). Its identity is the price change's own
   * hop, not the listing: a listing confirmed when it went live, or lowered before, has the same id,
   * and neither of those confirmations is this one. The target is the listing, which Steam keys the
   * confirmation by. Who confirms it is read from that answer, never copied; one confirmed by an
   * e-mailed link is returned too, and the caller does not press it. A stopped command's change is
   * never owed one: Stop withdraws it (D16, D21). Nor is one past its deadline at `now`, though the
   * wake that withdraws it has not run yet: a press then could confirm what is about to be taken
   * back (D15, D29).
   */
  owedPriceChanges(accountId: string, now: string): OwedConfirmation[] {
    const rows = this.db.raw().prepare(`
      SELECT s.id AS stepId, s.command_id AS commandId, s.account_id AS accountId, s.local_id AS localId,
        '${PRICE_CHANGE_CONFIRMATION}' AS kind, s.target_id AS targetId, NULL AS tradeId, c.authority AS authority, t.response_ref AS response
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN action a ON a.id=s.action_id
      JOIN attempt t ON t.id=(SELECT p.id FROM attempt p WHERE p.action_id=a.id ORDER BY p.rowid DESC LIMIT 1)
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind='EDIT_PRICE' AND s.target_id IS NOT NULL
        AND a.state='AWAITING_OBSERVATION' AND a.resolution='AWAITING_CONFIRMATION' AND c.state<>'STOPPED'
        AND (s.deadline_at IS NULL OR s.deadline_at > ?)
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}' AND k.target_id=s.target_id
          AND json_extract(k.params_json, '$.stepId')=s.id)
    `).all(accountId, now) as Array<Omit<OwedConfirmation, 'confirmBy'> & { response: string | null }>;
    return rows.map(({ response, ...owed }) => ({ ...owed, confirmBy: priceChangeConfirmer(response) ?? 'phone' }));
  }

  /**
   * Every buy order of ours Steam answered with a confirmation to tap (`success: 22`), waiting `READY`
   * for the request to go again, whose confirmation has no hop yet. The target is the id the
   * create's latest answer named, read from that attempt and never copied into a table.
   */
  owedBuyOrders(accountId: string): OwedConfirmation[] {
    return this.db.raw().prepare(`
      SELECT s.id AS stepId, s.command_id AS commandId, s.account_id AS accountId, NULL AS localId,
        'BUY_ORDER' AS kind, CAST(json_extract(t.response_ref, '$.confirmation.confirmation_id') AS TEXT) AS targetId, NULL AS tradeId, c.authority AS authority,
        NULL AS confirmBy
      FROM work_step s INDEXED BY work_step_account_state
      JOIN command c ON c.id=s.command_id
      JOIN action a ON a.id=s.action_id
      JOIN attempt t ON t.id=(SELECT p.id FROM attempt p WHERE p.action_id=a.id ORDER BY p.rowid DESC LIMIT 1)
      WHERE s.account_id=? AND s.state IN ${OPEN_STEP_STATES_SQL} AND s.kind='BUY_ORDER_CREATE'
        AND a.state='READY' AND a.resolution='AWAITING_CONFIRMATION'
        AND json_extract(t.response_ref, '$.confirmation.confirmation_id') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM work_step k INDEXED BY work_step_target WHERE k.account_id=s.account_id AND k.kind='${CONFIRM}'
          AND k.target_id=CAST(json_extract(t.response_ref, '$.confirmation.confirmation_id') AS TEXT))
    `).all(accountId) as OwedConfirmation[];
  }

  /** The confirmation id an action's latest answer asked to be tapped, or `null` when it asked for none. */
  requestedConfirmation(actionId: string): string | null {
    const attempt = this.db.latestAttempt(actionId);
    if (!attempt?.response_ref) return null;
    try {
      const raw = JSON.parse(attempt.response_ref) as { need_confirmation?: unknown; confirmation?: { confirmation_id?: unknown } } | null;
      const id = raw?.confirmation?.confirmation_id;
      return raw?.need_confirmation === true && (typeof id === 'string' || typeof id === 'number') ? String(id) : null;
    } catch {
      return null;
    }
  }

  /** A create whose answer asked for a tap waits `READY` for its request to go again (D2). Only from a returned attempt. */
  awaitConfirmation(actionId: string, now: string): void {
    this.db.raw().prepare(`UPDATE action SET state='READY', resolution='AWAITING_CONFIRMATION', updated_at=? WHERE id=? AND state='AWAITING_OBSERVATION'`)
      .run(now, actionId);
  }

  /**
   * A create that waited for its tap and will not be sent again: back to awaiting the walks that
   * settle any create, which place it if the tap alone did, and end it as never placed otherwise.
   */
  stopAwaitingConfirmation(actionId: string, now: string): void {
    this.db.raw().prepare(`UPDATE action SET state='AWAITING_OBSERVATION', resolution=NULL, updated_at=? WHERE id=? AND state='READY' AND resolution='AWAITING_CONFIRMATION'`)
      .run(now, actionId);
  }

  /** The account's creates waiting for a tap, oldest first. */
  awaitingConfirmation(accountId: string): ActionRow[] {
    return this.db.raw().prepare(`SELECT * FROM action WHERE account_id=? AND state='READY' AND kind='CREATE_BUY_ORDER' AND resolution='AWAITING_CONFIRMATION' ORDER BY created_at, id`)
      .all(accountId) as ActionRow[];
  }

  /**
   * A buy order's press the request sent after it proved did not apply: `READY` again, so the
   * confirmation schedule presses it once more. The proof is Steam's answer to that request, the
   * only place Steam says whether a buy order's tap applied (D8).
   */
  pressNotApplied(actionId: string, now: string): void {
    this.db.raw().prepare(`UPDATE action SET state='READY', resolution='OBSERVED_NOT_APPLIED', updated_at=? WHERE id=? AND state='AWAITING_OBSERVATION'`)
      .run(now, actionId);
  }

  /** What the record says about a buy order's confirmation, from the create hop it follows; `null` while nothing is decisive. */
  buyOrderSighting(accountId: string, params: ConfirmStepParams, press: ActionRow | undefined): BuyOrderConfirmationSighting | null {
    const hop = new WorkStore(this.db).step(params.stepId);
    const create = hop?.action_id ? this.db.action(hop.action_id) : undefined;
    if (!hop || !create) return { state: 'ended', observationId: null, words: 'The buy order it confirms is gone' };
    const order = new OrderStore(this.db).byAction(accountId, create.id);
    if (order?.venue_order_id && order.first_seen_obs !== null) return { state: 'confirmed', observationId: order.first_seen_obs };
    if (create.state === 'DONE' || create.state === 'FAILED') {
      return { state: 'ended', observationId: create.resolved_by_obs, words: create.error ?? 'The buy order ended before it was confirmed' };
    }
    if (create.state !== 'READY' || create.resolution !== 'AWAITING_CONFIRMATION') return null;
    const asked = this.requestedConfirmation(create.id);
    if (asked !== null && asked !== params.target.id) return { state: 'asked-anew' };
    // The same confirmation again: only an answer to a request sent after the press finished says so.
    const pressed = press ? this.db.latestAttempt(press.id) : undefined;
    const sent = this.db.latestAttempt(create.id);
    if (pressed?.finished_at && sent && sent.started_at >= pressed.finished_at) return { state: 'asked-again' };
    return null;
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
  sighting(accountId: string, target: { kind: ConfirmationKind; id: string }, stepId?: string): TargetSighting | null {
    if (target.kind === PRICE_CHANGE_CONFIRMATION) return stepId ? this.priceChangeSighting(accountId, target.id, stepId) : null;
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

  /**
   * What the record says about a lower price's confirmation, from the price change it follows
   * (in-place reprice plan D14). Confirmed is the change seen applied: its hop's action done by the
   * complete walk that showed the listing at the price asked for, begun after the answer
   * (`MarketService.reconcilePriceChanges`), whoever tapped. The listing merely being open says
   * nothing, because it is open before the tap and after it. Ended is the change ended any other
   * way. Waiting is the latest complete walk still showing the listing at the price it had.
   */
  private priceChangeSighting(accountId: string, listingId: string, stepId: string): TargetSighting | null {
    const work = new WorkStore(this.db);
    const hop = work.step(stepId);
    const change = hop?.action_id ? this.db.action(hop.action_id) : undefined;
    const latest = this.db.latestCompleteObservationForScope(accountId, 'account', null, 'steam-market');
    if (!hop || !change) return latest ? { state: 'ended', observationId: latest.id, words: 'The price change it confirms is gone' } : null;
    if (change.state === 'DONE') {
      const shown = change.resolved_by_obs ?? hop.observation_id;
      return shown === null ? null : { state: 'confirmed', observationId: shown, words: null };
    }
    if (change.state === 'FAILED' || hop.state === 'FAILED' || hop.state === 'STOPPED') {
      const seen = change.resolved_by_obs ?? hop.observation_id ?? latest?.id ?? null;
      return seen === null ? null : { state: 'ended', observationId: seen, words: hop.reason ?? change.error ?? 'The price change ended before it was confirmed' };
    }
    // The price still current is what Steam's answer said it was as it held the lower one, which
    // may not be the price the change was admitted on: the listing can move in between.
    const current = priceChangeInEffect(this.db.latestAttempt(change.id)?.response_ref) ?? work.params<{ fromPriceCents?: number } | null>(hop)?.fromPriceCents;
    const listing = new OrderStore(this.db).steamListing(accountId, listingId);
    if (listing && latest && listing.gone_obs === null && listing.last_seen_obs === latest.id && listing.price_cents === current) {
      return { state: 'waiting', observationId: latest.id, words: null };
    }
    return null;
  }

  /**
   * The confirmation opened for a listing, an offer or a buy order, if any: one per target, ever.
   * A price change's confirmation names the listing too and is never this one (`forPriceChange`).
   */
  forTarget(accountId: string, targetId: string): WorkStepRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM work_step INDEXED BY work_step_target WHERE account_id=? AND kind='${CONFIRM}' AND target_id=?
      AND ${notAPriceChange('work_step')} ORDER BY created_at LIMIT 1`)
      .get(accountId, targetId) as WorkStepRow | undefined;
  }

  /** The confirmation opened for one price change: one per hop, however many the listing has had. */
  forPriceChange(accountId: string, listingId: string, stepId: string): WorkStepRow | undefined {
    return this.db.raw().prepare(`SELECT * FROM work_step INDEXED BY work_step_target WHERE account_id=? AND kind='${CONFIRM}' AND target_id=?
      AND json_extract(params_json, '$.stepId')=? LIMIT 1`)
      .get(accountId, listingId, stepId) as WorkStepRow | undefined;
  }

  /** Whether a confirmation was ever opened for what is owed, by that kind's identity: the hop for a price change, the target for the rest. */
  opened(accountId: string, owed: Pick<OwedConfirmation, 'kind' | 'targetId' | 'stepId'>): boolean {
    return (owed.kind === PRICE_CHANGE_CONFIRMATION
      ? this.forPriceChange(accountId, owed.targetId, owed.stepId)
      : this.forTarget(accountId, owed.targetId)) !== undefined;
  }
}
