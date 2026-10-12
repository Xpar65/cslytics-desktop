/**
 * What main says about this build: its version, its updates and the stop switch.
 *
 * Types only. Main computes them (`main/release/`), the window reads them through `release.status`
 * and is told to read again by a `release` change notice. None of it is engine state: the trading
 * record does not know which build is reading it (desktop release plan §4, §5).
 */

/**
 * Where the updater is. `ready` is sticky: a check or an error after a download does not take the
 * downloaded update away, because it still installs when the app quits.
 */
export type UpdateState =
  | { phase: 'disabled'; reason: string }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string; at: string };

/** The stop-switch rules that apply to this version, and nothing about versions they do not. */
export type PolicySummary = {
  retired: { below: string; reason: string } | null;
  paused: Array<{ commands: string[]; below: string; reason: string }>;
  /** When a copy of the policy was last fetched, or null if none ever has been. */
  fetchedAt: string | null;
};

export type ReleaseStatus = {
  version: string;
  packaged: boolean;
  update: UpdateState;
  policy: PolicySummary;
};
