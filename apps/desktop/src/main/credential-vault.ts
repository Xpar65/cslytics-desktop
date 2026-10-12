import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { CredentialVault } from '@cslytics/adapters-steam';

export type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(buffer: Buffer): string;
};

export type VaultIo = {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
};

const require = createRequire(import.meta.url);

function defaultSafeStorage(): SafeStorage {
  return require('electron').safeStorage as SafeStorage;
}

const defaultIo: VaultIo = {
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  rename: fs.rename,
  readFile: fs.readFile
};

export class ElectronCredentialVault implements CredentialVault {
  constructor(
    private readonly path: string,
    private readonly storage: SafeStorage = defaultSafeStorage(),
    private readonly io: VaultIo = defaultIo
  ) {}

  async get(key: string): Promise<string | null> {
    const values = await this.read();
    const encrypted = values[key];
    if (!encrypted) return null;
    if (!this.storage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.storage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    const values = await this.read();
    values[key] = this.storage.encryptString(value).toString('base64');
    await this.write(values);
  }

  async delete(key: string): Promise<void> {
    const values = await this.read();
    delete values[key];
    await this.write(values);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await this.io.readFile(this.path, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(values: Record<string, string>): Promise<void> {
    await this.io.mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await this.io.writeFile(temporary, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 });
    await this.io.rename(temporary, this.path);
  }
}
