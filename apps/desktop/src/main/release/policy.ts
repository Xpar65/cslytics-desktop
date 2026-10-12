import { z } from 'zod';
import { COMMAND_EFFECTS, type CommandType } from '../../shared/command-effects.js';
import type { PolicySummary } from '../../shared/release.js';

/**
 * The stop switch (desktop release plan §5): a file on the release host that can refuse, in a
 * named range of versions, the commands that change something at a venue.
 *
 * Two rules and one principle. `retire` refuses every `venue` command below a version; `pause`
 * refuses named commands in a range. **Every rule is bounded by `below`**, so installing a newer
 * version always escapes it — including a copy of the file cached long ago by a machine that can no
 * longer reach the host. Reads, sign-in and the window are never refused, and `always` commands
 * (stopping unsent work, the release commands themselves) are refused by nothing.
 *
 * The format only ever grows: an old copy ignores a field it does not know, and `schema` stays 1.
 * A breaking change would be a file every installed copy rejects, which is a stop switch that no
 * longer reaches the copies it exists for.
 *
 * Pure, so the decision is testable without Electron; `policy-source.ts` fetches and caches it.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const version = z.string().regex(VERSION, 'a version is MAJOR.MINOR.PATCH, optionally -prerelease');
const reason = z.string().min(1).max(500);

export const releasePolicySchema = z.object({
  schema: z.literal(1),
  retire: z.object({ below: version, reason }).optional(),
  pause: z.array(z.object({
    commands: z.array(z.string().min(1).max(64)).min(1).max(100),
    from: version.optional(),
    below: version,
    reason
  })).max(50).optional()
});

export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

export type Refusal =
  | { refused: false }
  | { refused: true; rule: 'retire' | 'pause'; message: string };

/**
 * Orders two versions the way semver does for the part this app uses: numbers numerically, and a
 * prerelease before the release it precedes (`0.2.0-beta.1` < `0.2.0`). Throws on a malformed
 * version, which the schema has already refused for a policy and `DESKTOP_VERSION` never is.
 */
export function compareVersions(left: string, right: string): number {
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! < b.numbers[index]! ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const aParts = a.pre.split('.'), bParts = b.pre.split('.');
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const x = aParts[index], y = bParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number(x) : null, yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) return xn < yn ? -1 : 1;
    if (xn !== null) return -1;
    if (yn !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parse(value: string): { numbers: [number, number, number]; pre: string | null } {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`not a version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function inRange(current: string, from: string | undefined, below: string): boolean {
  return (from === undefined || compareVersions(current, from) >= 0) && compareVersions(current, below) < 0;
}

/**
 * Whether this build may send this command, under this policy.
 *
 * No policy refuses nothing: the switch stops known defects, and a machine that has never reached
 * the release host has been told of none.
 */
export function decide(policy: ReleasePolicy | null, current: string, type: CommandType): Refusal {
  if (!policy) return { refused: false };
  const effect = COMMAND_EFFECTS[type];
  if (effect === 'always') return { refused: false };
  if (effect === 'venue' && policy.retire && compareVersions(current, policy.retire.below) < 0) {
    return {
      refused: true,
      rule: 'retire',
      message: `CSlytics ${current} can no longer change anything on Steam or CSFloat. ${policy.retire.reason} `
        + `Update to ${policy.retire.below} or later to continue.`
    };
  }
  for (const rule of policy.pause ?? []) {
    if (rule.commands.includes(type) && inRange(current, rule.from, rule.below)) {
      return {
        refused: true,
        rule: 'pause',
        message: `This action is paused in CSlytics ${current}. ${rule.reason} Update to ${rule.below} or later to use it again.`
      };
    }
  }
  return { refused: false };
}

/** The rules that apply to this version, for the window. A rule about other versions is not news. */
export function summarize(policy: ReleasePolicy | null, current: string, fetchedAt: string | null): PolicySummary {
  if (!policy) return { retired: null, paused: [], fetchedAt };
  const retired = policy.retire && compareVersions(current, policy.retire.below) < 0 ? { ...policy.retire } : null;
  const paused = (policy.pause ?? [])
    .filter((rule) => inRange(current, rule.from, rule.below))
    .map((rule) => ({ commands: [...rule.commands], below: rule.below, reason: rule.reason }));
  return { retired, paused, fetchedAt };
}
