import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `cslytics-account.json`: the account as last verified, so the desktop can say who is signed in
 * at launch before the website answers. It holds no token — the refresh token is in the vault and
 * the access token only in memory — and it is a desktop file, never a row in the trading record,
 * because a CSlytics account is a fact about the person at this desktop and not about any Steam
 * account.
 */
export type StoredAccount = {
  format: 1;
  userId: string;
  steamId64: string | null;
  persona: string | null;
  tier: string;
  features: string[];
  featureMapVersion: number;
  sessionId: string;
  verifiedAt: string;
};

export type AccountFileIo = {
  readFile(path: string, encoding: 'utf8'): string;
  writeFile(path: string, data: string, options: { encoding: 'utf8'; mode: number }): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mkdir(path: string, options: { recursive: true }): unknown;
};

const defaultIo: AccountFileIo = {
  readFile: (path, encoding) => readFileSync(path, encoding),
  writeFile: (path, data, options) => writeFileSync(path, data, options),
  rename: renameSync,
  unlink: unlinkSync,
  mkdir: mkdirSync
};

export class AccountFile {
  constructor(readonly path: string, private readonly io: AccountFileIo = defaultIo) {}

  /** The stored account, or null when there is none or it cannot be trusted. */
  read(): StoredAccount | null {
    let text: string;
    try {
      text = this.io.readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    try {
      return parseStored(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Written whole, then renamed into place, so a crash leaves the old file or the new one. */
  write(account: StoredAccount): void {
    const exact: StoredAccount = {
      format: 1,
      userId: account.userId,
      steamId64: account.steamId64,
      persona: account.persona,
      tier: account.tier,
      features: [...account.features],
      featureMapVersion: account.featureMapVersion,
      sessionId: account.sessionId,
      verifiedAt: account.verifiedAt
    };
    if (parseStored(exact) === null) throw new Error('Refusing to write an account record that would not read back');
    this.io.mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    this.io.writeFile(temporary, `${JSON.stringify(exact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.io.rename(temporary, this.path);
  }

  remove(): void {
    try {
      this.io.unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function parseStored(value: unknown): StoredAccount | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): boolean => typeof record[key] === 'string' && (record[key] as string).length > 0;
  const nullableText = (key: string): boolean => record[key] === null || typeof record[key] === 'string';
  if (record['format'] !== 1) return null;
  if (!text('userId') || !text('tier') || !text('sessionId') || !text('verifiedAt')) return null;
  if (!nullableText('steamId64') || !nullableText('persona')) return null;
  if (!Number.isFinite(Date.parse(record['verifiedAt'] as string))) return null;
  const features = record['features'];
  if (!Array.isArray(features) || !features.every((key) => typeof key === 'string')) return null;
  if (typeof record['featureMapVersion'] !== 'number' || !Number.isInteger(record['featureMapVersion'])) return null;
  return {
    format: 1,
    userId: record['userId'] as string,
    steamId64: record['steamId64'] as string | null,
    persona: record['persona'] as string | null,
    tier: record['tier'] as string,
    features: features as string[],
    featureMapVersion: record['featureMapVersion'] as number,
    sessionId: record['sessionId'] as string,
    verifiedAt: record['verifiedAt'] as string
  };
}
