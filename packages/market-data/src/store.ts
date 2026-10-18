import { DatabaseSync } from 'node:sqlite';
import type { CurveDoc, FxRates, OrderBook, PriceHistory } from './types.js';

/**
 * `market.sqlite`: the desktop's cache of what the market said, and its journal of estimates.
 *
 * Desktop-owned, beside `settings.json`, with main as its only writer and the engine runtime never
 * opening it (portfolio and pricing plan D3). It is not the trading record: deleting it loses the
 * daily history and nothing else, and no trading decision, ledger row or recovery reads it.
 *
 * Every row that carries money carries its currency beside it, and a book in another currency is
 * another row, never an overwrite: an egress that changes mid-session (a VPN) must not make an
 * AUD figure read as USD. Nothing is ever stored converted.
 */

export const MARKET_SCHEMA_VERSION = 1;

export class MarketSchemaNewerError extends Error {
  constructor(readonly found: number) {
    super(`market.sqlite is schema ${found}; this build knows ${MARKET_SCHEMA_VERSION}`);
    this.name = 'MarketSchemaNewerError';
  }
}

export type StoredBook = OrderBook & { name: string; observedAt: string };
export type NameStatusKind = 'ok' | 'absent' | 'unknown';
export type NameStatus = {
  name: string;
  kind: NameStatusKind;
  lastAttempt: string;
  attempts: number;
  /** Not before this time may the name be read again; `null` means whenever it is due. */
  notBefore: string | null;
  detail: string | null;
};
export type DailyTop = {
  day: string;
  currency: number;
  highestBidCents: number | null;
  lowestAskCents: number | null;
  bidUnits: number;
  askUnits: number;
};
export type StoredHistory = PriceHistory & { name: string; fetchedAt: string };
export type StoredCurve = {
  venue: 'csfloat' | 'steam';
  name: string;
  fetchedAt: string;
  etag: string | null;
  /** `null` is a recorded absence: the CDN answered 404 at `fetchedAt`. */
  doc: CurveDoc | null;
};
export type StoredFx = FxRates & { fetchedAt: string };
export type ValuationSnapshotRow = {
  accountId: string;
  day: string;
  basis: 'mid' | 'liquidation';
  /** ISO code of the native currency the cents are in. Never a converted figure. */
  currency: string;
  cents: number;
  namesPriced: number;
  namesUnpriced: number;
  unitsUnpriced: number;
  fxAsOf: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS book(
  name TEXT NOT NULL, currency INTEGER NOT NULL, observed_at TEXT NOT NULL, etag TEXT,
  highest_bid_cents INTEGER, lowest_ask_cents INTEGER, bid_units INTEGER NOT NULL, ask_units INTEGER NOT NULL,
  bids_json TEXT NOT NULL, asks_json TEXT NOT NULL,
  PRIMARY KEY(name, currency));
CREATE INDEX IF NOT EXISTS book_observed ON book(observed_at);
CREATE TABLE IF NOT EXISTS book_daily(
  name TEXT NOT NULL, currency INTEGER NOT NULL, day TEXT NOT NULL,
  highest_bid_cents INTEGER, lowest_ask_cents INTEGER, bid_units INTEGER NOT NULL, ask_units INTEGER NOT NULL,
  PRIMARY KEY(name, currency, day));
CREATE TABLE IF NOT EXISTS name_status(
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, last_attempt TEXT NOT NULL, attempts INTEGER NOT NULL, not_before TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS history(name TEXT PRIMARY KEY, currency INTEGER NOT NULL, fetched_at TEXT NOT NULL, points_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS curve(venue TEXT NOT NULL, name TEXT NOT NULL, fetched_at TEXT NOT NULL, etag TEXT, doc_json TEXT, PRIMARY KEY(venue, name));
CREATE TABLE IF NOT EXISTS fx_snapshot(as_of TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, stale INTEGER NOT NULL, rates_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS valuation_snapshot(
  account_id TEXT NOT NULL, day TEXT NOT NULL, basis TEXT NOT NULL, currency TEXT NOT NULL, cents INTEGER NOT NULL,
  names_priced INTEGER NOT NULL, names_unpriced INTEGER NOT NULL, units_unpriced INTEGER NOT NULL, fx_as_of TEXT,
  PRIMARY KEY(account_id, day, basis, currency));
`;

/** `YYYY-MM-DD` in UTC, the day a daily row and a snapshot are keyed by. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

type BookRow = {
  name: string; currency: number; observed_at: string; etag: string | null;
  highest_bid_cents: number | null; lowest_ask_cents: number | null; bid_units: number; ask_units: number;
  bids_json: string; asks_json: string;
};

export class MarketDataStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens or creates the file. A file stamped above this build's version is refused before any
   * statement runs, for the reason the trading record refuses one: an older build would recreate
   * what a newer one changed. The caller decides what to do with a refused cache.
   */
  static open(path: string): MarketDataStore {
    const db = new DatabaseSync(path);
    const hasVersionTable = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as { n: number };
    const version = hasVersionTable.n === 0 ? 0 : (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as { v: number }).v;
    if (version > MARKET_SCHEMA_VERSION) {
      db.close();
      throw new MarketSchemaNewerError(version);
    }
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA);
    if (version === 0) db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(MARKET_SCHEMA_VERSION);
    return new MarketDataStore(db);
  }

  /** An in-memory store, for tests and for a profile whose file could not be opened. */
  static memory(): MarketDataStore {
    return MarketDataStore.open(':memory:');
  }

  close(): void {
    this.db.close();
  }

  // ── books ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Replaces the book for `(name, currency)` and, if this is the day's first observation of it,
   * writes the day's top of book. The name's status becomes `ok` with its attempt count reset:
   * a parsed 200 is the end of any backoff.
   */
  putBook(name: string, book: OrderBook, observedAt: string): void {
    const write = this.db.prepare(`INSERT INTO book(name, currency, observed_at, etag, highest_bid_cents, lowest_ask_cents, bid_units, ask_units, bids_json, asks_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name, currency) DO UPDATE SET observed_at=excluded.observed_at, etag=excluded.etag,
        highest_bid_cents=excluded.highest_bid_cents, lowest_ask_cents=excluded.lowest_ask_cents,
        bid_units=excluded.bid_units, ask_units=excluded.ask_units, bids_json=excluded.bids_json, asks_json=excluded.asks_json`);
    const daily = this.db.prepare(`INSERT OR IGNORE INTO book_daily(name, currency, day, highest_bid_cents, lowest_ask_cents, bid_units, ask_units) VALUES (?,?,?,?,?,?,?)`);
    const status = this.db.prepare(`INSERT INTO name_status(name, kind, last_attempt, attempts, not_before, detail) VALUES (?,'ok',?,0,NULL,NULL)
      ON CONFLICT(name) DO UPDATE SET kind='ok', last_attempt=excluded.last_attempt, attempts=0, not_before=NULL, detail=NULL`);
    this.db.exec('BEGIN');
    try {
      write.run(name, book.currency, observedAt, book.etag, book.highestBidCents, book.lowestAskCents, book.bidUnits, book.askUnits,
        JSON.stringify(book.bids.map((level) => [level.priceCents, level.quantity])), JSON.stringify(book.asks.map((level) => [level.priceCents, level.quantity])));
      daily.run(name, book.currency, dayOf(observedAt), book.highestBidCents, book.lowestAskCents, book.bidUnits, book.askUnits);
      status.run(name, observedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The newest book for a name in any currency, or in one currency when asked. */
  book(name: string, currency?: number): StoredBook | undefined {
    const row = currency === undefined
      ? this.db.prepare('SELECT * FROM book WHERE name=? ORDER BY observed_at DESC LIMIT 1').get(name) as BookRow | undefined
      : this.db.prepare('SELECT * FROM book WHERE name=? AND currency=?').get(name, currency) as BookRow | undefined;
    return row ? toStoredBook(row) : undefined;
  }

  /** The newest book per name, for a batch, in one query per 500 names. */
  books(names: readonly string[]): Map<string, StoredBook> {
    const out = new Map<string, StoredBook>();
    for (let start = 0; start < names.length; start += 500) {
      const chunk = names.slice(start, start + 500);
      const rows = this.db.prepare(`SELECT * FROM book WHERE name IN (${chunk.map(() => '?').join(',')}) ORDER BY observed_at ASC`).all(...chunk) as BookRow[];
      for (const row of rows) out.set(row.name, toStoredBook(row));
    }
    return out;
  }

  markAbsent(name: string, at: string, notBefore: string): void {
    this.db.prepare(`INSERT INTO name_status(name, kind, last_attempt, attempts, not_before, detail) VALUES (?,'absent',?,1,?,NULL)
      ON CONFLICT(name) DO UPDATE SET kind='absent', last_attempt=excluded.last_attempt, attempts=attempts+1, not_before=excluded.not_before, detail=NULL`).run(name, at, notBefore);
  }

  markUnknown(name: string, at: string, detail: string, notBefore: string): void {
    this.db.prepare(`INSERT INTO name_status(name, kind, last_attempt, attempts, not_before, detail) VALUES (?,'unknown',?,1,?,?)
      ON CONFLICT(name) DO UPDATE SET kind='unknown', last_attempt=excluded.last_attempt, attempts=attempts+1, not_before=excluded.not_before, detail=excluded.detail`).run(name, at, notBefore, detail);
  }

  status(name: string): NameStatus | undefined {
    const row = this.db.prepare('SELECT * FROM name_status WHERE name=?').get(name) as { name: string; kind: NameStatusKind; last_attempt: string; attempts: number; not_before: string | null; detail: string | null } | undefined;
    return row ? { name: row.name, kind: row.kind, lastAttempt: row.last_attempt, attempts: row.attempts, notBefore: row.not_before, detail: row.detail } : undefined;
  }

  statuses(names: readonly string[]): Map<string, NameStatus> {
    const out = new Map<string, NameStatus>();
    for (let start = 0; start < names.length; start += 500) {
      const chunk = names.slice(start, start + 500);
      const rows = this.db.prepare(`SELECT * FROM name_status WHERE name IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ name: string; kind: NameStatusKind; last_attempt: string; attempts: number; not_before: string | null; detail: string | null }>;
      for (const row of rows) out.set(row.name, { name: row.name, kind: row.kind, lastAttempt: row.last_attempt, attempts: row.attempts, notBefore: row.not_before, detail: row.detail });
    }
    return out;
  }

  /** When each name's newest book was observed; a name with no book is left out. */
  observedAt(names: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let start = 0; start < names.length; start += 500) {
      const chunk = names.slice(start, start + 500);
      const rows = this.db.prepare(`SELECT name, MAX(observed_at) AS observed_at FROM book WHERE name IN (${chunk.map(() => '?').join(',')}) GROUP BY name`).all(...chunk) as Array<{ name: string; observed_at: string }>;
      for (const row of rows) out.set(row.name, row.observed_at);
    }
    return out;
  }

  /** The day-by-day top of book for one name and currency, oldest first. */
  bookDaily(name: string, currency: number, sinceDay?: string): DailyTop[] {
    const rows = (sinceDay === undefined
      ? this.db.prepare('SELECT * FROM book_daily WHERE name=? AND currency=? ORDER BY day').all(name, currency)
      : this.db.prepare('SELECT * FROM book_daily WHERE name=? AND currency=? AND day>=? ORDER BY day').all(name, currency, sinceDay)
    ) as Array<{ day: string; currency: number; highest_bid_cents: number | null; lowest_ask_cents: number | null; bid_units: number; ask_units: number }>;
    return rows.map((row) => ({ day: row.day, currency: row.currency, highestBidCents: row.highest_bid_cents, lowestAskCents: row.lowest_ask_cents, bidUnits: row.bid_units, askUnits: row.ask_units }));
  }

  // ── history ────────────────────────────────────────────────────────────────────────────────

  putHistory(name: string, history: PriceHistory, fetchedAt: string): void {
    this.db.prepare(`INSERT INTO history(name, currency, fetched_at, points_json) VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET currency=excluded.currency, fetched_at=excluded.fetched_at, points_json=excluded.points_json`)
      .run(name, history.currency, fetchedAt, JSON.stringify(history.points.map((point) => [point.time, point.medianCents, point.purchases])));
  }

  history(name: string): StoredHistory | undefined {
    const row = this.db.prepare('SELECT * FROM history WHERE name=?').get(name) as { name: string; currency: number; fetched_at: string; points_json: string } | undefined;
    if (!row) return undefined;
    const points = (JSON.parse(row.points_json) as Array<[number, number, number]>).map(([time, medianCents, purchases]) => ({ time, medianCents, purchases }));
    return { name: row.name, currency: row.currency, fetchedAt: row.fetched_at, points };
  }

  // ── curves ─────────────────────────────────────────────────────────────────────────────────

  putCurve(venue: 'csfloat' | 'steam', name: string, doc: CurveDoc | null, fetchedAt: string, etag: string | null): void {
    this.db.prepare(`INSERT INTO curve(venue, name, fetched_at, etag, doc_json) VALUES (?,?,?,?,?)
      ON CONFLICT(venue, name) DO UPDATE SET fetched_at=excluded.fetched_at, etag=excluded.etag, doc_json=excluded.doc_json`)
      .run(venue, name, fetchedAt, etag, doc === null ? null : JSON.stringify(doc));
  }

  curve(venue: 'csfloat' | 'steam', name: string): StoredCurve | undefined {
    const row = this.db.prepare('SELECT * FROM curve WHERE venue=? AND name=?').get(venue, name) as { venue: 'csfloat' | 'steam'; name: string; fetched_at: string; etag: string | null; doc_json: string | null } | undefined;
    if (!row) return undefined;
    return { venue: row.venue, name: row.name, fetchedAt: row.fetched_at, etag: row.etag, doc: row.doc_json === null ? null : JSON.parse(row.doc_json) as CurveDoc };
  }

  // ── fx ─────────────────────────────────────────────────────────────────────────────────────

  putFx(rates: FxRates, fetchedAt: string): void {
    this.db.prepare(`INSERT INTO fx_snapshot(as_of, fetched_at, stale, rates_json) VALUES (?,?,?,?)
      ON CONFLICT(as_of) DO UPDATE SET fetched_at=excluded.fetched_at, stale=excluded.stale, rates_json=excluded.rates_json`)
      .run(rates.asOf, fetchedAt, rates.stale ? 1 : 0, JSON.stringify(rates.rates));
  }

  latestFx(): StoredFx | undefined {
    const row = this.db.prepare('SELECT * FROM fx_snapshot ORDER BY as_of DESC LIMIT 1').get() as { as_of: string; fetched_at: string; stale: number; rates_json: string } | undefined;
    return row ? toStoredFx(row) : undefined;
  }

  /** The newest snapshot at or before `asOf`, so a past valuation converts at its own day's rate. */
  fxAt(asOf: string): StoredFx | undefined {
    const row = this.db.prepare('SELECT * FROM fx_snapshot WHERE as_of<=? ORDER BY as_of DESC LIMIT 1').get(asOf) as { as_of: string; fetched_at: string; stale: number; rates_json: string } | undefined;
    return row ? toStoredFx(row) : undefined;
  }

  // ── valuation snapshots ────────────────────────────────────────────────────────────────────

  /**
   * One row per account, day, basis and native currency. A later write on the same day replaces
   * only when it priced at least as many names: a valuation taken mid-fill, or over an unfinished
   * walk, must never overwrite a fuller one and leave a dip in the history that nothing explains.
   */
  putValuationSnapshot(row: ValuationSnapshotRow): void {
    this.db.prepare(`INSERT INTO valuation_snapshot(account_id, day, basis, currency, cents, names_priced, names_unpriced, units_unpriced, fx_as_of) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, day, basis, currency) DO UPDATE SET cents=excluded.cents, names_priced=excluded.names_priced,
        names_unpriced=excluded.names_unpriced, units_unpriced=excluded.units_unpriced, fx_as_of=excluded.fx_as_of
      WHERE excluded.names_priced >= valuation_snapshot.names_priced`)
      .run(row.accountId, row.day, row.basis, row.currency, row.cents, row.namesPriced, row.namesUnpriced, row.unitsUnpriced, row.fxAsOf);
  }

  valuationSnapshots(accountIds: readonly string[], sinceDay?: string): ValuationSnapshotRow[] {
    if (accountIds.length === 0) return [];
    const marks = accountIds.map(() => '?').join(',');
    const rows = (sinceDay === undefined
      ? this.db.prepare(`SELECT * FROM valuation_snapshot WHERE account_id IN (${marks}) ORDER BY day, account_id, basis, currency`).all(...accountIds)
      : this.db.prepare(`SELECT * FROM valuation_snapshot WHERE account_id IN (${marks}) AND day>=? ORDER BY day, account_id, basis, currency`).all(...accountIds, sinceDay)
    ) as Array<{ account_id: string; day: string; basis: 'mid' | 'liquidation'; currency: string; cents: number; names_priced: number; names_unpriced: number; units_unpriced: number; fx_as_of: string | null }>;
    return rows.map((row) => ({ accountId: row.account_id, day: row.day, basis: row.basis, currency: row.currency, cents: row.cents, namesPriced: row.names_priced, namesUnpriced: row.names_unpriced, unitsUnpriced: row.units_unpriced, fxAsOf: row.fx_as_of }));
  }

  /** Row counts per table, for a status line and for tests. */
  counts(): Record<'book' | 'book_daily' | 'name_status' | 'history' | 'curve' | 'fx_snapshot' | 'valuation_snapshot', number> {
    const count = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { book: count('book'), book_daily: count('book_daily'), name_status: count('name_status'), history: count('history'), curve: count('curve'), fx_snapshot: count('fx_snapshot'), valuation_snapshot: count('valuation_snapshot') };
  }
}

function toStoredBook(row: BookRow): StoredBook {
  const levels = (json: string): Array<{ priceCents: number; quantity: number }> =>
    (JSON.parse(json) as Array<[number, number]>).map(([priceCents, quantity]) => ({ priceCents, quantity }));
  return {
    name: row.name,
    currency: row.currency,
    observedAt: row.observed_at,
    etag: row.etag,
    highestBidCents: row.highest_bid_cents,
    lowestAskCents: row.lowest_ask_cents,
    bidUnits: row.bid_units,
    askUnits: row.ask_units,
    bids: levels(row.bids_json),
    asks: levels(row.asks_json)
  };
}

function toStoredFx(row: { as_of: string; fetched_at: string; stale: number; rates_json: string }): StoredFx {
  return { base: 'USD', asOf: row.as_of, fetchedAt: row.fetched_at, stale: row.stale === 1, rates: JSON.parse(row.rates_json) as Record<string, number> };
}
