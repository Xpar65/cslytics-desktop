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

/**
 * Every operation is a read of the whole file followed, for a write, by a rename over it. Two
 * writers at once — the Engine Runtime storing a Steam token while main rotates the CSlytics one —
 * would each read the old file and the second rename would drop the first one's key. One queue
 * per vault makes each operation see the one before it complete.
 */
export class ElectronCredentialVault implements CredentialVault {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly storage: SafeStorage = defaultSafeStorage(),
    private readonly io: VaultIo = defaultIo
  ) {}

  get(key: string): Promise<string | null> {
    return this.serial(() => this.getNow(key));
  }

  set(key: string, value: string): Promise<void> {
    return this.serial(() => this.setNow(key, value));
  }

  delete(key: string): Promise<void> {
    return this.serial(() => this.deleteNow(key));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async getNow(key: string): Promise<string | null> {
    const values = await this.read();
    const encrypted = values[key];
    if (!encrypted) return null;
    if (!this.storage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  private async setNow(key: string, value: string): Promise<void> {
    if (!this.storage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    const values = await this.read();
    values[key] = this.storage.encryptString(value).toString('base64');
    await this.write(values);
  }

  private async deleteNow(key: string): Promise<void> {
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
