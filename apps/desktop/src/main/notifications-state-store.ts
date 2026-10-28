import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { EMPTY_NOTIFICATIONS_STATE, factCursorSchema, notificationsStateSchema, type FactCursor, type NotificationsState } from '../shared/api.js';

/**
 * `notifications-state.json`: what the bell has told the person, which main owns (notifications
 * plan §7.2). Desktop-owned state beside `settings.json`, never a table in the trading record
 * (AGENTS.md): the record keeps the facts, this file keeps the watermark per account below which
 * every fact the bell carries has been raised. Read once at launch, replaced atomically on each
 * write, validated in both directions; a file that is not this state at all is moved aside and the
 * bell starts over, which on a profile that already holds facts raises none of them, since a
 * profile never looked at treats what it holds as history (`producers/engine.ts`).
 *
 * No Electron import, so the whole of it is testable against a temporary directory.
 */
export class NotificationsStateStore {
  private state: NotificationsState = EMPTY_NOTIFICATIONS_STATE;

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  load(): 'loaded' | 'absent' | 'quarantined' {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return 'absent';
    }
    let read: NotificationsState | null = null;
    try {
      read = stateFrom(JSON.parse(text));
    } catch {
      read = null;
    }
    if (read === null) {
      this.quarantine();
      return 'quarantined';
    }
    this.state = read;
    return 'loaded';
  }

  current(): NotificationsState {
    return this.state;
  }

  /** Moves one account's watermark and answers with what is now stored; a write that misses the disk throws and changes nothing. */
  markSeen(accountId: string, watermark: FactCursor | null): NotificationsState {
    return this.write({ ...this.state, accounts: { ...this.state.accounts, [accountId]: { watermark } } });
  }

  /** Drops what this file holds about one account; removing the account is the only caller. */
  forgetAccount(accountId: string): NotificationsState {
    if (!(accountId in this.state.accounts)) return this.state;
    const accounts = { ...this.state.accounts };
    delete accounts[accountId];
    return this.write({ ...this.state, accounts });
  }

  private write(candidate: NotificationsState): NotificationsState {
    const next = notificationsStateSchema.parse(candidate);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    this.state = next;
    return next;
  }

  private quarantine(): void {
    const aside = `${this.file}.corrupt-${this.now().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(this.file, aside);
      console.warn(`notifications-state.json was not readable; moved to ${aside}`);
    } catch {
      console.warn('notifications-state.json was not readable and could not be moved aside');
    }
  }
}

/** The file read leniently, one account at a time: an entry that is not this shape is dropped, the file is kept. */
function stateFrom(raw: unknown): NotificationsState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const record = raw as Record<string, unknown>;
  if (record['version'] !== 1) throw new Error('unknown version');
  const accounts: NotificationsState['accounts'] = {};
  const stored = record['accounts'];
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [accountId, entry] of Object.entries(stored as Record<string, unknown>)) {
      if (!accountId || accountId === '__proto__' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const watermark = factCursorSchema.nullable().safeParse((entry as Record<string, unknown>)['watermark']);
      if (watermark.success) accounts[accountId] = { watermark: watermark.data };
    }
  }
  return { version: 1, accounts };
}
