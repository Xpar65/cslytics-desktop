import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineDatabase } from '../db/database.js';

/**
 * Field names whose value never leaves this machine in a log or an export.
 *
 * `apiKey` and `api_key` are listed explicitly because a marketplace credential is not a token
 * and not a cookie, and the matcher silently covered neither (plan §3.8). A bare `key` is
 * deliberately *not* matched: `stackKey`, `keychain_key` and `localId`-shaped fields are what a
 * support bundle is read for, and redacting them would trade a real diagnostic for no secrecy.
 */
const SENSITIVE_KEYS = /password|authorization|cookie|token|credential|api[_-]?key|apikey|secret|passphrase/i;

/**
 * Values that carry a secret regardless of the field they arrived in.
 *
 * A structured field can be matched by name; a serialized transport error cannot, and that is
 * how a header ends up inside a string nobody thought of as sensitive.
 */
const SENSITIVE_VALUES = /\b(authorization|api[_-]?key|x-api-key|token|access_token|trade_offer_access_token)\b\s*[:=]\s*\S+/gi;

export class DiagnosticExporter {
  constructor(private readonly database: EngineDatabase) {}

  async export(accountId: string, outputPath: string): Promise<string> {
    const raw = this.database.raw();
    const bundle = redact({
      format: 'cslytics-diagnostic-v1',
      exportedAt: new Date().toISOString(),
      accountId,
      observations: raw.prepare(`SELECT * FROM observation WHERE account_id=? ORDER BY id DESC LIMIT 500`).all(accountId),
      actions: raw.prepare(`SELECT * FROM action WHERE account_id=? ORDER BY created_at DESC LIMIT 500`).all(accountId),
      attempts: raw.prepare(`SELECT attempt.* FROM attempt JOIN action ON action.id=attempt.action_id WHERE action.account_id=? ORDER BY attempt.started_at DESC LIMIT 500`).all(accountId),
      events: raw.prepare(`SELECT * FROM event WHERE account_id=? ORDER BY at DESC LIMIT 1000`).all(accountId)
    });
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 });
    return outputPath;
  }
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (typeof value === 'string') return value.replace(SENSITIVE_VALUES, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(item)
    ])) as T;
  }
  return value;
}
