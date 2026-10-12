import type { CredentialVault } from '@cslytics/ports';

export type { CredentialVault } from '@cslytics/ports';

/**
 * `CredentialVault` itself now lives in `@cslytics/ports`, because CSFloat needs one too and an
 * adapter may not import another adapter. This file keeps the Steam-shaped helpers: the key
 * naming convention, and the in-memory implementation a probe or contract test uses.
 */
export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function refreshTokenKey(accountId: string): string {
  return `steam-refresh-token:${accountId}`;
}
