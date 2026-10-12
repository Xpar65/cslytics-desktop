/**
 * Whether the Game Coordinator would take a storage unit name — decided here, before sending.
 *
 * The GC does not say no. A name it will not accept produces no `NameItem` notification and
 * no SO update, which the adapter can only report as a timeout, and a timeout is `AMBIGUOUS`:
 * an attempt that has to wait for a complete observation before anything can be concluded.
 * Refusing a bad name up front is what keeps a typo from becoming a pending attempt with a
 * conflict card at the end of it.
 *
 * The limits are the game client's Name Tag limits and are **not captured** for a unit
 * (`fixtures/steam/contracts/name-item.json`, rename plan §2). The live probe run in plan §6 is
 * what pins them; until then a name the client would take may still be refused here, which is
 * the safe direction to be wrong in.
 */
export const CASKET_NAME_MAX_LENGTH = 20;

/** The reason a name would be refused, or null when it may be sent. */
export function validateCasketName(name: string): string | null {
  if (name !== name.trim()) return 'A storage unit name cannot start or end with whitespace';
  if (name.length === 0) return 'A storage unit name cannot be empty';
  const length = [...name].length;
  if (length > CASKET_NAME_MAX_LENGTH) {
    return `A storage unit name is at most ${CASKET_NAME_MAX_LENGTH} characters; this one is ${length}`;
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return 'A storage unit name cannot contain control characters';
  return null;
}
