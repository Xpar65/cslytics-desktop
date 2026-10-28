import type { AccountId, MutationOutcome } from '../kernel.js';

/**
 * Steam's phone confirmation, as an optional port (strategy authority and confirmations plan D7).
 *
 * A listing and an outgoing trade offer each wait for a tap in the Steam mobile app before they
 * reach a buyer. This product's desktop never makes that tap: it never holds what signs one (rule
 * 2), so it composes no implementation of this port, and no shipped adapter has one. A host that
 * does hold it — its own confirmation gateway, outside this repository's public code — composes the
 * port, and the engine then confirms the listings and offers its own hops made, and nothing else.
 *
 * One call confirms several targets, because Steam answers the list of what awaits confirmation
 * once per call and limits how often it may be asked. A target is named by what it confirms: the
 * listing id or the trade offer id, as the engine's walks know them.
 */
export type ConfirmationKind = 'SELL_LISTING' | 'TRADE_OFFER';
export type ConfirmationTarget = { kind: ConfirmationKind; id: string };

/**
 * What one call did.
 *
 * `pressed`: each target's outcome, keyed by its id. An outcome is evidence about an attempt and
 * never proof (rule 1): a reply of success has been seen with the offer still waiting, and a lost
 * reply followed by "not found" on every retry was a confirmation that had applied. A target the
 * answer does not name was pressed or not; the engine treats it as ambiguous.
 *
 * `throttled`: Steam refused to list what awaits confirmation, so nothing was pressed. The engine
 * waits `retryAfterMs` before it asks again, and records no attempt.
 */
export type ConfirmationPress =
  | { kind: 'pressed'; outcomes: Readonly<Record<string, MutationOutcome>> }
  | { kind: 'throttled'; retryAfterMs: number; raw: unknown };

export interface SteamConfirmationPort {
  confirm(accountId: AccountId, targets: readonly ConfirmationTarget[]): Promise<ConfirmationPress>;
}
