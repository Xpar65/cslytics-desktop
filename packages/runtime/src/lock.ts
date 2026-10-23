import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Single-writer lock for the Engine Runtime.
 *
 * AUTH-08 is a filesystem lock, not an engine policy, so it has no ServiceOverrides
 * saboteur. This file carries its own counterexample: a live owner is refused *and* a
 * stale owner is reclaimed. An implementation that always reclaims (or never does) fails
 * one of those two assertions.
 *
 * It is its own entry point (`@cslytics/runtime/lock`) because a supervisor reaps a dead
 * runtime's lock without loading the engine, and `node:sqlite` with it, into its own process.
 */
export function acquireRuntimeLock(path: string): number {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stalePid = Number(readFileSync(path, 'utf8'));
    let alive = Number.isInteger(stalePid) && stalePid > 0;
    if (alive) {
      try { process.kill(stalePid, 0); } catch { alive = false; }
    }
    if (alive) throw new Error(`Another Engine Runtime owns ${path}`);
    unlinkSync(path);
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    return fd;
  }
}

export function releaseRuntimeLock(fd: number, path: string): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed — process.exit and an explicit shutdown both land here */
  }
  try {
    if (!existsSync(path)) return;
    if (readFileSync(path, 'utf8').trim() !== String(process.pid)) return;
    unlinkSync(path);
  } catch {
    /* gone, or no longer ours */
  }
}

/**
 * Reaps once the owner is gone, for a supervisor that has just killed the runtime or watched it
 * exit. On Windows a process that has exited still answers `kill(pid, 0)` for a moment while a
 * handle to it is open, so one reap at the exit event raced the death and left the lock behind
 * for the next launch to find (a live close on 2026-10-16). Polls briefly; resolves with the lock
 * gone, or with the owner still genuinely alive after the attempts.
 */
export async function reapRuntimeLockWhenGone(path: string, { attempts = 30, delayMs = 100 }: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    reapRuntimeLock(path);
    if (!existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Removes a lock whose owner is dead, so a killed runtime cannot leave AUTH-08's file behind —
 * `process.on('exit')` does not run on Windows TerminateProcess. A live owner is left alone: that
 * is another runtime, not a leak.
 */
export function reapRuntimeLock(path: string): void {
  if (!existsSync(path)) return;
  let owner = NaN;
  try {
    owner = Number(readFileSync(path, 'utf8'));
  } catch {
    try { unlinkSync(path); } catch { /* gone */ }
    return;
  }
  if (Number.isInteger(owner) && owner > 0) {
    try {
      process.kill(owner, 0);
      return;
    } catch {
      /* process is gone */
    }
  }
  try { unlinkSync(path); } catch { /* gone */ }
}
