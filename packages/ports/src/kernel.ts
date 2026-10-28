/**
 * The vocabulary every venue shares.
 *
 * Identifiers are opaque strings on purpose: a Steam id is 17 digits and loses precision as a
 * JavaScript number. The outcome alphabet is the other load-bearing thing here — an adapter may
 * say `SUBMITTED`, `DEFINITIVELY_REJECTED` or `AMBIGUOUS` and nothing else, because deciding what
 * actually happened needs a later observation. That asymmetry is repository rule 1 expressed in
 * the type system, and it is why `ReconciledOutcome` is a separate type only a reconciler produces.
 */
export type AccountId = string;
export type AssetId = string;
export type ListingId = string;
export type BuyOrderId = string;
export type EvidenceGrade = 'captured' | 'own-incident-test' | 'second-witness' | 'hypothesis';

export type DefinitivelyRejected = {
  kind: 'DEFINITIVELY_REJECTED';
  reason: string;
  raw: unknown;
  /**
   * The venue's own word on when the same request may be made again, in milliseconds from the
   * reply: a rate limit read from its headers, a cap on outstanding work. The refusal is of the
   * moment, not of the request. Absent, the refusal stands until a person acts.
   */
  retryAfterMs?: number;
};

export type Submitted = {
  kind: 'SUBMITTED';
  evidence: string;
  raw: unknown;
};

export type Ambiguous = {
  kind: 'AMBIGUOUS';
  cause: 'timeout' | 'transport' | 'malformed' | 'unclassified';
  raw: unknown;
};

/** Adapter outcomes deliberately exclude OBSERVED_*; only reconcilers may produce those. */
export type MutationOutcome = DefinitivelyRejected | Submitted | Ambiguous;
export type ReconciledOutcome =
  | MutationOutcome
  | { kind: 'OBSERVED_APPLIED'; observationId: number }
  | { kind: 'OBSERVED_NOT_APPLIED'; observationId: number };

export interface ClockPort {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
