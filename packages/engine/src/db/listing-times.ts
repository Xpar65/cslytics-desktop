import type { MarketHistoryAction } from '@cslytics/ports';
import type { EngineDatabase } from './database.js';

/** The surface whose walks write this table. */
export const LISTING_TIMES_SURFACE = 'steam-market-listing-times';

/**
 * What one walk of `QueryMyHistory` made of the events it read (listing times plan D3, D4).
 *
 * `stored` are new rows; `known` events the table already held with the same times; `conflicts`
 * rows this walk quarantined, because it read another time for a key the table holds (the row is
 * marked, never written over, and a row already marked is not counted again); `differs` new rows whose time disagrees with the old route's row for the same listing and type;
 * `unmatched` new rows the old route's walk has not read (yet); `multiUnit` events skipped because
 * their listing was not created with one unit; `otherType` events of a type other than a sale or a
 * purchase, skipped.
 */
export type ListingTimesTally = {
  events: number; stored: number; known: number; conflicts: number; differs: number; unmatched: number; multiUnit: number; otherType: number;
};

export function emptyTally(): ListingTimesTally {
  return { events: 0, stored: 0, known: 0, conflicts: 0, differs: 0, unmatched: 0, multiUnit: 0, otherType: 0 };
}

/** The money an event named: what was paid (the amount and Steam's fee) or received, and its wallet currency. */
export type ActionMoney = { amountCents: number | null; currency: number | null };

/**
 * `QueryMyHistory` carries money as strings of minor units and the currency as the wallet's code
 * plus 2000 (corpus `steamcommunity.market.query-my-history`). A purchase is `paid_amount` plus
 * `paid_fee`, what the buyer's wallet paid; a sale is `received_amount`. A figure that is absent or
 * not an integer is null, never zero.
 */
export function actionMoney(event: MarketHistoryAction): ActionMoney {
  const purchase = ((event.raw ?? {}) as { purchase?: Record<string, unknown> | null }).purchase ?? {};
  const integer = (value: unknown): number | null => {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  };
  const sold = event.eventType === 3;
  const amount = sold ? integer(purchase['received_amount']) : (() => {
    const paid = integer(purchase['paid_amount']);
    const fee = integer(purchase['paid_fee']);
    return paid === null || fee === null ? null : paid + fee;
  })();
  const code = integer(sold ? purchase['received_currencyid'] : purchase['currencyid']);
  return { amountCents: amount, currency: code === null ? null : code >= 2000 ? code - 2000 : code };
}

type StoredTime = { occurred_at: string; listed_at: string | null; amount_cents: number | null; currency: number | null; hash_name: string | null; conflict_obs: number | null };

/**
 * `market_history_time`: one row per sale or purchase as `QueryMyHistory` reported it, keyed by
 * what both history routes can name, the listing and the event type (listing times plan D2). The
 * first walk to see an event writes it; a later walk that reports another time for the same key
 * marks the row quarantined, with its observation and what it said, and never writes over it. A
 * figure the first walk lacked (a listing time, an amount) is filled in when a later one has it.
 */
export class ListingTimesStore {
  constructor(readonly db: EngineDatabase) {}

  /** Writes what one walk read, inside the caller's transaction, and says what it made of it. */
  record(accountId: string, events: readonly MarketHistoryAction[], observationId: number): ListingTimesTally {
    const tally = emptyTally();
    const sqlite = this.db.raw();
    const stored = sqlite.prepare(`SELECT occurred_at, listed_at, amount_cents, currency, hash_name, conflict_obs FROM market_history_time
      WHERE account_id=? AND listing_id=? AND event_type=?`);
    const insert = sqlite.prepare(`INSERT INTO market_history_time
      (account_id, listing_id, event_type, occurred_at, listed_at, amount_cents, currency, hash_name, observation_id) VALUES (?,?,?,?,?,?,?,?,?)`);
    const fill = sqlite.prepare(`UPDATE market_history_time SET listed_at=COALESCE(listed_at, ?), amount_cents=COALESCE(amount_cents, ?),
      currency=COALESCE(currency, ?), hash_name=COALESCE(hash_name, ?) WHERE account_id=? AND listing_id=? AND event_type=?`);
    const quarantine = sqlite.prepare(`UPDATE market_history_time SET conflict_obs=?, conflict_occurred_at=?, conflict_listed_at=?
      WHERE account_id=? AND listing_id=? AND event_type=? AND conflict_obs IS NULL`);
    // By the listing (`history_listing_page`): `+event_type` keeps the planner off `history_type_page`,
    // which would walk every purchase of the account for each event.
    const history = sqlite.prepare(`SELECT occurred_at FROM market_history WHERE account_id=? AND listing_id=? AND +event_type=?`);
    let changed = false;
    for (const event of events) {
      tally.events += 1;
      if (event.eventType !== 3 && event.eventType !== 4) { tally.otherType += 1; continue; }
      // A listing of several units can be bought several times, so its listing and type name more
      // than one event; only a listing created with one unit is a key.
      if (event.listingUnits !== 1) { tally.multiUnit += 1; continue; }
      const money = actionMoney(event);
      const listedAt = event.listedAt ?? null;
      const hashName = event.hashName ?? null;
      const held = stored.get(accountId, event.listingId, event.eventType) as StoredTime | undefined;
      if (held) {
        const disagrees = held.occurred_at !== event.occurredAt || (held.listed_at !== null && listedAt !== null && held.listed_at !== listedAt);
        if (disagrees) {
          // The first disagreement is the one kept; a row already quarantined stays as it is.
          if (held.conflict_obs === null) {
            quarantine.run(observationId, event.occurredAt, listedAt, accountId, event.listingId, event.eventType);
            tally.conflicts += 1;
            changed = true;
          }
          continue;
        }
        tally.known += 1;
        const fills = (held.listed_at === null && listedAt !== null) || (held.amount_cents === null && money.amountCents !== null)
          || (held.currency === null && money.currency !== null) || (held.hash_name === null && hashName !== null);
        if (fills) {
          fill.run(listedAt, money.amountCents, money.currency, hashName, accountId, event.listingId, event.eventType);
          changed = true;
        }
        continue;
      }
      insert.run(accountId, event.listingId, event.eventType, event.occurredAt, listedAt, money.amountCents, money.currency, hashName, observationId);
      changed = true;
      tally.stored += 1;
      // The old route's word on the same event, counted here and judged again at every read: a row
      // the old walk reads later is matched then (`read/queries/records.ts`).
      const old = history.all(accountId, event.listingId, event.eventType) as Array<{ occurred_at: string }>;
      if (!old.length) tally.unmatched += 1;
      else if (!old.some((row) => row.occurred_at === event.occurredAt)) tally.differs += 1;
    }
    if (changed) this.db.touch(accountId, 'market_history_time');
    return tally;
  }

  /** Whether the table holds this event: what tells a walk its newest page joined what earlier walks read. */
  holds(accountId: string, event: MarketHistoryAction): boolean {
    return this.db.raw().prepare(`SELECT 1 FROM market_history_time WHERE account_id=? AND listing_id=? AND event_type=?`)
      .get(accountId, event.listingId, event.eventType) !== undefined;
  }

  /** The newest event the table holds for the account, or null when it holds none. */
  newest(accountId: string): string | null {
    return (this.db.raw().prepare(`SELECT MAX(occurred_at) AS at FROM market_history_time WHERE account_id=?`).get(accountId) as { at: string | null }).at;
  }

  /** How many rows the table holds for the account. */
  count(accountId: string): number {
    return (this.db.raw().prepare(`SELECT COUNT(*) AS n FROM market_history_time WHERE account_id=?`).get(accountId) as { n: number }).n;
  }
}
