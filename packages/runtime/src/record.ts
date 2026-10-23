import { EngineDatabase } from '@cslytics/engine';
import type { ClockPort } from '@cslytics/ports';

/** The wall clock, for a runtime that is not a test. */
export class RuntimeClock implements ClockPort {
  now(): Date { return new Date(); }
  async sleep(ms: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
}

/**
 * Opens the trading record at `path`, upgrading it when this build is newer than the one that
 * wrote it, with `now` stamping every row the opening writes.
 *
 * A record a newer build wrote, and an upgrade whose backup could not be written, both leave the
 * record untouched and throw `SchemaNewerThanAppError` or `SchemaBackupError` from the engine.
 * The caller decides how to say so: the desktop relays the sentence to its main process before
 * it exits, a host prints it and stops. Neither opens anything against a record that was refused.
 */
export function openTradingRecord(path: string, now: () => string): EngineDatabase {
  return new EngineDatabase(path, now);
}
