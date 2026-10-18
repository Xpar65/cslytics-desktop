import { createHash, randomBytes } from 'node:crypto';

/**
 * Proof key for code exchange (RFC 7636). The desktop is a public client and can keep no secret,
 * so each sign-in makes one: the browser carries only its hash, and the code it brings back is
 * worthless to anyone who does not also hold the verifier.
 */

/** 32 random bytes as base64url: 43 characters, inside RFC 7636's 43 to 128. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** The S256 challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
