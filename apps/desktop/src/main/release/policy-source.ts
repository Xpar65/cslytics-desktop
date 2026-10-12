import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { releasePolicySchema, type ReleasePolicy } from './policy.js';

/**
 * The stop switch as this machine last heard it.
 *
 * `release-policy.json` in the profile is desktop-owned state (AGENTS.md): versioned, validated on
 * read, replaced atomically. A copy that arrives valid replaces it; one that does not arrive, or
 * arrives malformed, leaves the last good copy in force. That is what makes a retirement stick on a
 * machine that later cannot reach the host, and it is safe because every rule is bounded by version
 * (`policy.ts`): updating always escapes a stale copy.
 *
 * With no copy at all, nothing is refused. Failing closed would turn every blocked network — web
 * filters that refuse unrated hosts are common — into an app that cannot trade.
 *
 * A 404 is treated as unreachable, not as "no rules": a rule is lifted by publishing the file
 * without it, and a missing file is far more often a deploy mistake than an instruction.
 *
 * No Electron import. The fetch is injected (`net.fetch` pinned to the policy URL, in main).
 */
export type PolicyFetch = (url: string, init: RequestInit) => Promise<Response>;

export type PolicyRefresh = 'applied' | 'unchanged' | 'unreachable' | 'invalid';

const cacheSchema = z.object({
  format: z.literal(1),
  fetchedAt: z.string().min(1),
  policy: releasePolicySchema
});

export class ReleasePolicySource {
  private policy: ReleasePolicy | null = null;
  private fetchedAt: string | null = null;

  constructor(
    private readonly file: string,
    private readonly url: string,
    private readonly fetcher: PolicyFetch,
    private readonly userAgent: string,
    private readonly timeoutMs = 15_000
  ) {}

  /** Reads the cached copy. A missing or corrupt file is no copy, never an error. */
  load(): void {
    try {
      const cached = cacheSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (cached.success) {
        this.policy = cached.data.policy;
        this.fetchedAt = cached.data.fetchedAt;
      }
    } catch {
      // No copy yet, or one this build cannot read; either way there is nothing to apply.
    }
  }

  current(): ReleasePolicy | null {
    return this.policy;
  }

  lastFetchedAt(): string | null {
    return this.fetchedAt;
  }

  async refresh(now: Date): Promise<PolicyRefresh> {
    let body: unknown;
    try {
      const response = await this.fetcher(this.url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.status !== 200) return 'unreachable';
      body = await response.json();
    } catch {
      return 'unreachable';
    }
    const parsed = releasePolicySchema.safeParse(body);
    if (!parsed.success) return 'invalid';
    const changed = JSON.stringify(parsed.data) !== JSON.stringify(this.policy);
    const fetchedAt = now.toISOString();
    try {
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ format: 1, fetchedAt, policy: parsed.data }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // The copy in memory still applies for this run; the next launch falls back to the last one
      // that was written, which is the same rule set or an older one bounded by version.
    }
    this.policy = parsed.data;
    this.fetchedAt = fetchedAt;
    return changed ? 'applied' : 'unchanged';
  }
}
