import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Single-writer lock for the Engine Runtime.
 *
 * AUTH-08 is a filesystem lock, not an engine policy, so it has no ServiceOverrides
 * saboteur. This file carries its own counterexample: a live owner is refused *and* a
 * stale owner is reclaimed. An implementation that always reclaims (or never does) fails
 * one of those two assertions.
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
 * Removes a lock whose owner is dead. Main calls this after the Engine Runtime exits so a
 * killed child cannot leave AUTH-08's file behind — `process.on('exit')` does not run on
 * Windows TerminateProcess.
 *
 * A live owner is left alone: that is another runtime, not a leak.
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
