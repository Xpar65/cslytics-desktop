import { OPEN_STEP_STATES_SQL } from './work.js';

/**
 * What a command member is doing, read from its hops.
 *
 * A member's row keeps the terms it was admitted with and only the words no hop can say for it
 * (`COMMAND_MEMBER_STATES` in `db/alphabets.ts`): refused before any hop existed, stopped before
 * any was sent, sold out from under its chain. Everything else is its hops in `work_step`
 * (consolidation plan D2): a store is one hop, a transfer between units a retrieve then a store, a
 * reprice a delist then a listing, a listing from a unit a retrieve then the listing. The hop a
 * member is on is its earliest open hop, else its latest failed one (the hops after it were never
 * reached, and the failure is what there is to say), else its last settled one.
 *
 * These fragments are shared by `read/queries/work.ts` and `orchestrate/command.ts`, so the work
 * panel and `command.read` cannot disagree. They expect the command aliased `c` and the member
 * aliased `m`; `MEMBER_HOP_JOINS` adds `s` (the hop the member is on), `own` (that hop's action)
 * and `a` (the action the row is drawn on: the hop's own, or the last action an earlier hop had,
 * so a hop waiting with no action of its own is drawn on the retrieve it follows).
 *
 * The hop's stored state is the one truth: its driver reflects its action onto it as the action
 * moves (`WorkStore.reflectAction`), and what the venue shows meanwhile (a listing waiting on the
 * phone, an offer waiting on the phone or the buyer, a retrieved item CSFloat has not seen yet) is
 * read from the venue's rows here and never copied onto the hop. A queued hop with a reason is one
 * nothing will send until a person acts on the reason: `BLOCKED` (OP-08). A hop proved not
 * applied reads `RETRYING` until its resend goes out, and the resend's own state from then on.
 */

/** The action the row is drawn on: the hop's own, or the last an earlier hop of the member had. */
export const STEP_ACTION_SQL = `COALESCE(s.action_id, (
        SELECT p.action_id FROM work_step p WHERE p.command_id=s.command_id AND p.account_id=s.account_id AND p.local_id IS s.local_id
          AND p.ordinal<s.ordinal AND p.action_id IS NOT NULL ORDER BY p.ordinal DESC LIMIT 1))`;

/** The hop's state, with a resend that has gone out read from its action (`own`). */
const EFFECTIVE_STATE_SQL = `(CASE
      WHEN s.state='RETRYING' AND own.state='RUNNING' THEN 'SENT'
      WHEN s.state='RETRYING' AND own.state='AWAITING_OBSERVATION' THEN 'AWAITING_OBSERVATION'
      ELSE s.state END)`;

/** What the panel says about a hop. Expects `s` (the hop) and `own` (its action). */
export const STEP_STATE_SQL = `CASE
      WHEN s.state='DONE' THEN 'COMPLETE'
      WHEN s.state IN ('FAILED','STOPPED') THEN s.state
      WHEN ${EFFECTIVE_STATE_SQL}='RETRYING' THEN 'RETRYING'
      WHEN s.state='QUEUED' AND s.reason IS NOT NULL THEN 'BLOCKED'
      WHEN s.kind='RETRIEVE' AND ${EFFECTIVE_STATE_SQL} IN ('SENT','AWAITING_OBSERVATION') AND EXISTS (
        SELECT 1 FROM work_step n WHERE n.command_id=s.command_id AND n.account_id=s.account_id AND n.local_id IS s.local_id AND n.ordinal>s.ordinal) THEN 'RETRIEVING'
      WHEN s.kind='CSFLOAT_AWAIT_VENUE' THEN 'AWAITING_VENUE'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind IN ('SEND','CSFLOAT_SEND') AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.status='PENDING_CONFIRMATION') THEN 'AWAITING_CONFIRMATION'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='CSFLOAT_SEND' AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code=3) THEN 'AWAITING_VERIFICATION'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='CSFLOAT_SEND' AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code IN (2,11)) THEN 'AWAITING_BUYER'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='SEND' AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code=3) THEN 'AWAITING_DELIVERY'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='SEND' AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code=11) THEN 'ESCROW'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='SEND' AND s.offer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_offer o WHERE o.account_id=s.account_id AND o.offer_id=s.offer_id AND o.state_code=2) THEN 'ACTIVE'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' AND s.kind='LIST' AND EXISTS (
        SELECT 1 FROM venue_order l WHERE l.account_id=s.account_id AND l.local_id=s.local_id AND l.venue='steam' AND l.side='SELL'
          AND l.state='PENDING_EXTERNAL' AND l.gone_obs IS NULL) THEN 'AWAITING_CONFIRMATION'
      WHEN ${EFFECTIVE_STATE_SQL}='SENT' THEN 'RUNNING'
      WHEN ${EFFECTIVE_STATE_SQL}='AWAITING_OBSERVATION' THEN 'AWAITING_OBSERVATION'
      ELSE 'QUEUED'
    END`;

/** Why a hop is failed or waiting, when it is: its own reason, else the refusal its action recorded. */
export const STEP_REASON_SQL = `CASE
      WHEN s.state='FAILED' THEN COALESCE(s.reason, own.error)
      WHEN s.state IN ${OPEN_STEP_STATES_SQL} THEN s.reason
    END`;

/**
 * The hop a member is on. A transfer's send and cancel hops are about every member of their
 * source and name no holding, so they are each member's too; the destination's accept hop is under
 * another account and is nobody's row here.
 */
export const MEMBER_HOP_SQL = `(
      SELECT h.id FROM work_step h
      WHERE h.command_id=m.command_id AND h.account_id=m.account_id
        AND (h.local_id=m.local_id OR (h.local_id IS NULL AND c.kind='ACCOUNT_TRANSFER'))
      ORDER BY CASE WHEN h.state IN ${OPEN_STEP_STATES_SQL} THEN 0 WHEN h.state='FAILED' THEN 1 ELSE 2 END,
               CASE WHEN h.state IN ${OPEN_STEP_STATES_SQL} THEN h.ordinal ELSE -h.ordinal END
      LIMIT 1)`;

/** Joins `s`, `own` and `a` onto `command c JOIN command_member m`. */
export const MEMBER_HOP_JOINS = `
    LEFT JOIN work_step s ON s.id=${MEMBER_HOP_SQL}
    LEFT JOIN action own ON own.id=s.action_id
    LEFT JOIN action a ON a.id=${STEP_ACTION_SQL}`;

/**
 * The member's state, in the words `work.open` and `command.read` share: the member's own word
 * when it has one, `QUEUED` while it waits for its hops to be written, else its hop's.
 */
export const MEMBER_STATE_SQL = `CASE
      WHEN m.state IN ('REJECTED','STOPPED','SOLD') THEN m.state
      WHEN s.id IS NULL THEN 'QUEUED'
      ELSE ${STEP_STATE_SQL}
    END`;

/** Why a member is failed or waiting, when it is. */
export const MEMBER_REASON_SQL = `CASE WHEN s.id IS NULL THEN NULL ELSE ${STEP_REASON_SQL} END`;
