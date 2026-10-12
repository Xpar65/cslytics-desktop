import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogueCollection, CatalogueEntry, MatchKey, UnresolvedReason } from './types.js';

/**
 * Where the catalogue is kept between runs.
 *
 * Deliberately **not** SQLite, and deliberately not the trading database. This is a rebuildable
 * cache of ~20,000 rows describing what items are called; it has no migrations, no schema snapshot
 * and no place in a backup, because losing it costs one fetch. Putting it in the file whose schema
 * is versioned and whose restore has to reconcile before mutations resume would give a cosmetic
 * cache the ceremony owed to a ledger.
 *
 * The publication discipline is borrowed from the API that serves it: write a complete generation
 * to a temporary name, then rename into place. A rename is atomic on every filesystem this ships
 * to, so a process that dies mid-write leaves the previous generation current rather than a
 * half-written one — `N-CAT-03` at rest.
 */

export type StoredGeneration = {
  revision: string;
  fetchedAt: string;
  etag: string | null;
  entries: readonly CatalogueEntry[];
  collections: readonly CatalogueCollection[];
};

/** A key the server did not know, and when it is worth asking again. */
export type Miss = { key: MatchKey; firstSeen: string; lastAttempt: string; attempts: number; reason: UnresolvedReason };

const GENERATION = 'generation.json';
const MISSES = 'misses.json';

export class CatalogueStore {
  constructor(private readonly directory: string) {}

  /**
   * Load the current generation, or `null`.
   *
   * A corrupt generation is discarded rather than served: half a catalogue attaches names to some
   * items and not others, which reads as "Valve never released these" instead of "our file is
   * damaged". Returning null makes the next sync rebuild it.
   */
  async load(): Promise<StoredGeneration | null> {
    try {
      const raw = await fs.readFile(join(this.directory, GENERATION), 'utf8');
      const parsed = JSON.parse(raw) as StoredGeneration;
      if (typeof parsed?.revision !== 'string' || !Array.isArray(parsed?.entries)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(generation: StoredGeneration): Promise<void> {
    await this.writeAtomic(GENERATION, JSON.stringify(generation));
  }

  async loadMisses(): Promise<Miss[]> {
    try {
      const raw = await fs.readFile(join(this.directory, MISSES), 'utf8');
      const parsed = JSON.parse(raw) as Miss[];
      return Array.isArray(parsed) ? parsed.filter((miss) => typeof miss?.key === 'string') : [];
    } catch {
      return [];
    }
  }

  async saveMisses(misses: readonly Miss[]): Promise<void> {
    await this.writeAtomic(MISSES, JSON.stringify(misses));
  }

  private async writeAtomic(name: string, body: string): Promise<void> {
    const target = join(this.directory, name);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, body, 'utf8');
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

/** An in-memory store, for tests and for a host that would rather not touch a disk. */
export class MemoryCatalogueStore {
  private generation: StoredGeneration | null = null;
  private misses: Miss[] = [];
  async load(): Promise<StoredGeneration | null> { return this.generation; }
  async save(generation: StoredGeneration): Promise<void> { this.generation = generation; }
  async loadMisses(): Promise<Miss[]> { return this.misses.slice(); }
  async saveMisses(misses: readonly Miss[]): Promise<void> { this.misses = misses.slice(); }
}

export type CatalogueStoreLike = CatalogueStore | MemoryCatalogueStore;
