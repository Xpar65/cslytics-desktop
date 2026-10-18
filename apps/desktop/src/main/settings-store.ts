import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_CSFLOAT, DEFAULT_CURRENCY,
  DEFAULT_LAUNCH,
  DEFAULT_SETTINGS,
  settingsSchema,
  type AccountLaunch,
  type AppearanceSettings,
  type CurrencySettings,
  type DesktopSettings
} from '../shared/api.js';
import { THEME_PREFERENCES } from '../shared/themes/index.js';

/**
 * `settings.json`: this desktop's preferences, which main owns (notifications plan §5.1).
 *
 * Desktop-owned state, never a table in the trading record (AGENTS.md): read once at launch,
 * replaced atomically on each write, and validated in both directions. What comes in over IPC is
 * held to the strict `settingsSchema`; what comes off disk is read leniently, one setting at a
 * time, so a value this build does not know — a theme a newer build added — costs that one
 * setting its default rather than costing the file. Unknown keys are dropped.
 *
 * A file that is not settings at all is renamed to `settings.json.corrupt-<time>` and the defaults
 * apply; a person who looks finds what was there. A version 2 would add its migration in
 * `settingsFrom`, before the sections are read.
 *
 * No Electron import, so the whole of it is testable against a temporary directory.
 */
export class SettingsStore {
  private settings: DesktopSettings = DEFAULT_SETTINGS;

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  load(): 'loaded' | 'absent' | 'quarantined' {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return 'absent';
    }
    let read: DesktopSettings | null = null;
    try {
      read = settingsFrom(JSON.parse(text));
    } catch {
      read = null;
    }
    if (read === null) {
      this.quarantine();
      return 'quarantined';
    }
    this.settings = read;
    return 'loaded';
  }

  current(): DesktopSettings {
    return this.settings;
  }

  /**
   * Replaces the appearance section and answers with what is now stored. A write that does not
   * reach the disk throws and changes nothing, so the window never shows a choice that will be
   * gone at the next launch.
   */
  writeAppearance(appearance: AppearanceSettings): DesktopSettings {
    return this.write({ ...this.settings, appearance });
  }

  /** Replaces one account's launch preferences, the same way. */
  writeLaunch(accountId: string, launch: AccountLaunch): DesktopSettings {
    return this.write({ ...this.settings, accounts: { ...this.settings.accounts, [accountId]: launch } });
  }

  /** The duplicate-protection switch, the same way (consolidation plan D13). */
  writeCsfloatProtection(enabled: boolean): DesktopSettings {
    return this.write({ ...this.settings, csfloat: { ...this.settings.csfloat, protection: enabled } });
  }

  /** Replaces the currency section, the same way. A chosen base is recorded as chosen. */
  writeCurrency(currency: CurrencySettings): DesktopSettings {
    return this.write({ ...this.settings, currency });
  }

  /**
   * Pins the base currency from the first account's wallet, once. A base already pinned or
   * chosen is left alone, so adding or removing accounts later never moves the figures.
   */
  pinBaseCurrency(code: string): DesktopSettings {
    if (this.settings.currency.base !== null) return this.settings;
    return this.write({ ...this.settings, currency: { ...this.settings.currency, base: code, baseSource: 'first-account' } });
  }

  /**
   * Drops everything this file holds about one account. Removing the account is the only caller:
   * its preferences are data about it on this computer, and go with the rest.
   */
  forgetAccount(accountId: string): DesktopSettings {
    if (!(accountId in this.settings.accounts)) return this.settings;
    const accounts = { ...this.settings.accounts };
    delete accounts[accountId];
    return this.write({ ...this.settings, accounts });
  }

  private write(candidate: DesktopSettings): DesktopSettings {
    const next = settingsSchema.parse(candidate);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    this.settings = next;
    return next;
  }

  private quarantine(): void {
    const aside = `${this.file}.corrupt-${this.now().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(this.file, aside);
      console.warn(`settings.json was not readable; moved to ${aside} and the defaults apply`);
    } catch {
      console.warn('settings.json was not readable and could not be moved aside; the defaults apply');
    }
  }
}

const storedAppearance = z.object({
  theme: z.enum(THEME_PREFERENCES).catch(DEFAULT_SETTINGS.appearance.theme)
}).catch(DEFAULT_SETTINGS.appearance);

const storedLaunch = z.object({
  signIn: z.boolean().catch(DEFAULT_LAUNCH.signIn),
  cs2: z.boolean().catch(DEFAULT_LAUNCH.cs2)
});

/** Each account's entry on its own: one that is not an object is dropped, a bad field defaults on. */
function storedAccounts(raw: unknown): DesktopSettings['accounts'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const accounts: DesktopSettings['accounts'] = {};
  for (const [accountId, entry] of Object.entries(raw as Record<string, unknown>)) {
    // `__proto__` would set the record's prototype rather than add an entry; it cannot be kept.
    if (!accountId || accountId === '__proto__' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    accounts[accountId] = storedLaunch.parse(entry);
  }
  return accounts;
}

const storedCurrency = z.object({
  base: z.string().regex(/^[A-Z]{3}$/).nullable().catch(DEFAULT_CURRENCY.base),
  baseSource: z.enum(['first-account', 'chosen']).catch(DEFAULT_CURRENCY.baseSource),
  showAccountPagesInBase: z.boolean().catch(DEFAULT_CURRENCY.showAccountPagesInBase)
}).catch(DEFAULT_CURRENCY);

const storedCsfloat = z.object({
  protection: z.boolean().catch(DEFAULT_CSFLOAT.protection)
}).catch(DEFAULT_CSFLOAT);

/** A parsed file as settings, or null when it is not a settings file at all. */
export function settingsFrom(raw: unknown): DesktopSettings | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (typeof file.version !== 'number') return null;
  return {
    version: 1,
    appearance: storedAppearance.parse(file.appearance ?? {}),
    accounts: storedAccounts(file.accounts),
    currency: storedCurrency.parse(file.currency ?? {}),
    csfloat: storedCsfloat.parse(file.csfloat ?? {})
  };
}
