import type { Ambiguous } from '@cslytics/ports';

export type AmbiguityCause = Ambiguous['cause'];

/**
 * Ambiguity classification.
 *
 * Every branch here is still `AMBIGUOUS` — the cause is diagnostic metadata, never a licence
 * to retry (CLAUDE.md rule 1). It exists so the failure atlas and the operator can tell a
 * network drop from a garbled body.
 *
 * Classification reads *structured* fields only: a thrown error class, `error.name`, or
 * `error.code`. It deliberately does not sniff human-readable messages. Prose is not a
 * contract; it changes without notice and differs per locale.
 */

/** A request that never produced a response. The side effect may or may not have landed. */
export class TransportFailure extends Error {
  constructor(message: string, readonly cause: 'timeout' | 'transport') {
    super(message);
    this.name = 'TransportFailure';
  }
}

/** A response arrived but could not be parsed into the port's contract. */
export class MalformedResponse extends Error {
  constructor(message: string, readonly body?: unknown) {
    super(message);
    this.name = 'MalformedResponse';
  }
}

/** Node/undici error codes that unambiguously mean the request did not complete. */
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError', 'HeadersTimeoutError', 'BodyTimeoutError']);
const MALFORMED_NAMES = new Set(['SyntaxError', 'MalformedResponse', 'ZodError']);

function structuredCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyAmbiguity(error: unknown): AmbiguityCause {
  if (error instanceof TransportFailure) return error.cause;
  if (error instanceof MalformedResponse) return 'malformed';

  const name = error instanceof Error ? error.name : undefined;
  if (name && TIMEOUT_NAMES.has(name)) return 'timeout';
  if (name && MALFORMED_NAMES.has(name)) return 'malformed';

  const code = structuredCode(error);
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code && TRANSPORT_CODES.has(code)) return 'transport';

  // An unrecognised failure stays unclassified. Guessing would put a wrong cause in the
  // audit trail, and the retry decision is identical either way.
  return 'unclassified';
}
