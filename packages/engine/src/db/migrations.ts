import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * How an existing database catches up.
 *
 * `schema.ts` declares the **current** shape, and every statement in it is `IF NOT EXISTS`, so a
 * fresh database and an old one both run it. That covers a new table or a new index. It cannot
 * cover a new column on an existing table, because SQLite will not add one to a table that already
 * exists — which is what these migrations are for.
 *
 * Three rules:
 *
 *  1. **Never edit an applied migration.** A database in the field has already run it; changing it
 *     silently gives two different shapes the same version number. Append a new one instead.
 *  2. **Keep each one idempotent.** `PRAGMA table_info` before `ALTER`, `IF NOT EXISTS` on an index.
 *     A migration that half-applied and then crashed must be safe to run again.
 *  3. **Declare the column in `schema.ts` too**, in the same position the `ALTER` would leave it —
 *     at the end of the table. `tests/unit/migrations.test.ts` builds a v1 database, migrates it,
 *     and requires the result to match a freshly created one exactly, so a mismatch fails the build
 *     rather than surfacing as a missing column on someone's machine months later.
 *
 * The versions below predate the split. Version 1 was the original baseline, and version 4's
 * tables come from `schema.ts`. Numbers are not contiguous and must not be reused: a migration
 * has to be numbered **above** every `SCHEMA_VERSION` that has ever shipped, or a database
 * already stamped at that version skips it silently.
 */
export type Migration = {
  version: number;
  name: string;
  up(sqlite: DatabaseSync): void;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: 'action.params_json',
    up(sqlite) {
      addColumn(sqlite, 'action', 'params_json', 'TEXT');
    }
  },
  {
    version: 3,
    name: 'observation scope, item location proof, action resolution, goal authority',
    up(sqlite) {
      // Scope turns "the account was observed" into "this casket was observed", which is what a
      // precondition actually needs to ask.
      addColumn(sqlite, 'observation', 'scope_kind', 'TEXT');
      addColumn(sqlite, 'observation', 'scope_id', 'TEXT');
      // A location is only as good as the observation that proved it, and the generation that
      // observation carried. Legacy rows deliberately get no proof: the next planner tick observes
      // them rather than inheriting a claim nobody witnessed.
      addColumn(sqlite, 'item', 'location_obs', 'INTEGER REFERENCES observation(id)');
      addColumn(sqlite, 'item', 'location_generation', 'INTEGER');
      addColumn(sqlite, 'action', 'resolved_by_obs', 'INTEGER REFERENCES observation(id)');
      addColumn(sqlite, 'action', 'resolution', 'TEXT');
      addColumn(sqlite, 'desired_state', 'authority', "TEXT NOT NULL DEFAULT 'HUMAN'");
      addColumn(sqlite, 'desired_state', 'suspended_reason', 'TEXT');
      addColumn(sqlite, 'desired_state', 'suspended_at', 'TEXT');
      addColumn(sqlite, 'desired_state', 'blocked_until', 'TEXT');
      addColumn(sqlite, 'desired_state', 'expires_at', 'TEXT');
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS observation_scope ON observation(account_id, scope_kind, scope_id, id DESC)'
      );
    }
  },
  {
    version: 5,
    name: 'publication, selection manifests and bounded-read columns',
    up(sqlite) {
      addColumn(sqlite, 'item', 'row_generation', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'commodity_handle', 'row_generation', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'command', 'preparing', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'command', 'manifest_token', 'TEXT');
      addColumn(sqlite, 'command', 'observed_completed', 'INTEGER NOT NULL DEFAULT 0');
    }
  }
  ,{
    version: 6,
    name: 'durable chunked command inputs',
    up(sqlite) { addColumn(sqlite, 'command_member', 'input_json', 'TEXT'); }
  }
  ,{
    version: 8,
    name: 'acquisition records an evidenced amount separately from the order limit',
    up(sqlite) {
      // `price_cents` was being filled with the standing buy-order limit, which BUY-06 forbids
      // treating as what was paid. The limit stays where it is — it is real, and it is what the
      // order asked for — and the money moves to a column that is allowed to be unknown.
      addColumn(sqlite, 'acquisition', 'actual_amount_cents', 'INTEGER');
      addColumn(sqlite, 'acquisition', 'amount_basis', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
    }
  }
  ,{
    version: 10,
    name: 'owned-account transfer evidence and send provenance',
    up(sqlite) { addColumn(sqlite, 'trade_offer', 'message', 'TEXT'); }
  }
  ,{
    version: 13,
    name: 'the catalogue leaves the trading database',
    up(sqlite) {
      // The first removal migration, and it is safe for the reason that justified the move: a
      // catalogue is a rebuildable cache of facts about the world, not a record of what an
      // account owns, owes or attempted. Deleting it makes no trading decision, ledger row or
      // recovery wrong, which is the test for whether a table belongs here at all.
      //
      // The index survives under a truer name. It indexes item *identity* — the same expression
      // the host now sends back as a `matchKeys` filter — and dropping it would turn that filter
      // into a scan of every row for the account.
      sqlite.exec('DROP INDEX IF EXISTS item_catalogue_match');
      sqlite.exec("CREATE INDEX IF NOT EXISTS item_identity_match ON item(account_id,(def_index || ':' || IFNULL(paint_index,'') || ':' || quality),local_id)");
      sqlite.exec('DROP TABLE IF EXISTS catalogue_cache');
    }
  }
  ,{
    version: 14,
    name: 'the identity key gains its kit field',
    up(sqlite) {
      // The catalogue contract's item key is four fields, not three. The fourth separates one
      // sticker from another — every sticker shares a def index and has no paint kit, so without
      // it ten thousand of them collapse into one key and none of them can be named.
      //
      // The engine does not compute the field yet, so it is always empty. The trailing colon
      // lands now because the index expression has to match the query expression exactly, and
      // changing the key format after keys are stored costs a re-derivation rather than a rebuild.
      sqlite.exec('DROP INDEX IF EXISTS item_identity_match');
      sqlite.exec("CREATE INDEX IF NOT EXISTS item_identity_match ON item(account_id,(def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':'),local_id)");
    }
  }
  ,{
    version: 15,
    name: 'the kit field is stored, not just reserved',
    up(sqlite) {
      // Schema 14 reserved the *format* — the trailing colon — and left the value
      // empty. This stores it, which is what makes grouping split one sticker
      // from another instead of showing an account's entire sticker collection
      // as a single row.
      //
      // Existing rows default to '' and are therefore unchanged, which is the
      // same key they have today. They are re-derived on the next complete
      // inventory observation, because `upsertIndividualItem` writes `kit` on
      // every pass and `commodity_stack` is rebuilt wholesale from
      // `commodity_handle`. Nothing needs a backfill and nothing is wrong in the
      // meantime: an empty kit is exactly what the previous generation produced.
      addColumn(sqlite, 'item', 'kit', "TEXT NOT NULL DEFAULT ''");
      addColumn(sqlite, 'commodity_handle', 'kit', "TEXT NOT NULL DEFAULT ''");
      addColumn(sqlite, 'commodity_stack', 'kit', "TEXT NOT NULL DEFAULT ''");
      // The index expression has to match the query expression character for
      // character or `matchKeys IN (…)` degrades to a scan of every row for the
      // account. `IFNULL` is belt and braces: the column is NOT NULL, but the
      // query says `IFNULL(kit,'')` and the two must be the same string.
      sqlite.exec('DROP INDEX IF EXISTS item_identity_match');
      sqlite.exec("CREATE INDEX IF NOT EXISTS item_identity_match ON item(account_id,(def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':' || IFNULL(kit,'')),local_id)");
    }
  }
  ,{
    version: 16,
    name: 'a storage unit label carries its proof',
    up(sqlite) {
      // A rename is proven by an observation carrying the new label, never by the GC's
      // notification (rename plan §3, rule 1). To decide whether the observation that wrote
      // the label started after the attempt, the row has to say which observation that was —
      // exactly what `item.location_obs` does for a location. Existing rows get NULL: their
      // label was observed before this column existed, and the next unit walk stamps it.
      addColumn(sqlite, 'storage_unit', 'label_obs', 'INTEGER REFERENCES observation(id)');
    }
  }
  ,{
    version: 17,
    name: 'the ledger can post an in-game store purchase',
    up(sqlite) {
      // DATA-04 keeps a store purchase distinguishable from a market purchase, which means a
      // new `kind`. The allowed kinds are a CHECK constraint, and SQLite cannot widen one in
      // place, so the table is rebuilt: same columns, same order, every row copied, then
      // renamed back. The indexes come back with the table; `applySchema` recreates them
      // anyway. Idempotent: a table whose CHECK already names the kind is left alone.
      const created = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='economic_event'").get() as { sql: string } | undefined)?.sql ?? '';
      if (created.includes('STORE_PURCHASE')) return;
      sqlite.exec(`CREATE TABLE economic_event_v17 (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('MARKET_SALE', 'BUY_ORDER_FILL', 'EXTERNAL_PURCHASE',
    'TRADE_RECEIPT', 'TRADE_DISPOSAL', 'UNEXPLAINED_MOVEMENT', 'CORRECTION', 'STORE_PURCHASE')),
  occurred_at TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 1),
  amount_cents INTEGER,
  fee_cents INTEGER,
  currency INTEGER,
  amount_basis TEXT NOT NULL CHECK(amount_basis IN ('EVIDENCED', 'UNKNOWN')),
  attribution TEXT NOT NULL CHECK(attribution IN ('ATTRIBUTED', 'UNATTRIBUTED')),
  local_id TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  order_id TEXT,
  trade_id TEXT,
  offer_id TEXT,
  listing_id TEXT,
  corrects_source_key TEXT,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(account_id, source_key)
)`);
      sqlite.exec('INSERT INTO economic_event_v17 SELECT * FROM economic_event');
      sqlite.exec('DROP TABLE economic_event');
      sqlite.exec('ALTER TABLE economic_event_v17 RENAME TO economic_event');
      sqlite.exec('CREATE INDEX IF NOT EXISTS economic_event_page ON economic_event(account_id, occurred_at, source_key)');
      sqlite.exec('CREATE INDEX IF NOT EXISTS economic_event_kind ON economic_event(account_id, kind, occurred_at, source_key)');
      sqlite.exec('CREATE INDEX IF NOT EXISTS economic_event_order ON economic_event(account_id, order_id, occurred_at)');
    }
  }
  ,{
    version: 18,
    name: 'the staging backup tables gain the kit column their originals already have',
    up(sqlite) {
      // Migration 15 added `kit` to `item`, `commodity_handle` and `commodity_stack` and stopped
      // there. `schema.ts` declared it on their three `inventory_backup_*` twins as well, so a
      // fresh database was fine and every test passed — but a database that already had the
      // backup tables got the column on one side only.
      //
      // `beginStaging` copies each table into its twin with `INSERT INTO inventory_backup_x
      // SELECT * FROM x`, which matches by position, not by name. One extra column on the left
      // throws "table inventory_backup_item has 18 columns but 19 values were supplied", the
      // refresh loop backs the surface off, and no observation row is written at all. The
      // symptom is not an error in the window: it is an inventory that silently stops being
      // walked, and rows whose `kit` is therefore never re-derived, because only a complete walk
      // rewrites them.
      //
      // Column for column with `schema.ts`, and at the end of each table, because the
      // fresh-create path and the upgrade path have to converge (migrations.test.ts).
      addColumn(sqlite, 'inventory_backup_item', 'kit', "TEXT NOT NULL DEFAULT ''");
      addColumn(sqlite, 'inventory_backup_commodity_handle', 'kit', "TEXT NOT NULL DEFAULT ''");
      addColumn(sqlite, 'inventory_backup_commodity_stack', 'kit', "TEXT NOT NULL DEFAULT ''");
    }
  }
  ,{
    version: 20,
    name: 'account persona name and avatar hash',
    up(sqlite) {
      // Cached identity for the account face: Steam's current display name and avatar hash.
      // Pixels stay on Steam's CDN; a timeout never clears a previous good hash (rule 1).
      addColumn(sqlite, 'account', 'persona_name', 'TEXT');
      addColumn(sqlite, 'account', 'avatar_hash', 'TEXT');
      addColumn(sqlite, 'account', 'persona_obs', 'INTEGER');
    }
  }
  ,{
    version: 21,
    name: 'a transfer batch names the retrievals it must prove before its send',
    up(sqlite) {
      // "Retrieve from the crate, then trade" is the listing chain's shape on the transfer batch
      // (cross-account-transfer-plan D-04): a crated item is admitted as a retrieval hop, and the
      // batch carries its RETRIEVE_FROM_CASKET action ids so a restart resumes from the actions'
      // own observed state rather than from memory (rule 6). Existing batches were all sent from
      // main inventory, so the default is the empty list.
      addColumn(sqlite, 'transfer_batch', 'retrieve_action_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    }
  }
  ,{
    version: 23,
    name: 'a CSFloat listing can start in a storage unit',
    up(sqlite) {
      // Listing on CSFloat from a unit is retrieve, then wait for CSFloat's copy of the Steam
      // inventory to show the item, then create (fixtures/csfloat/INDEX.md, 2026-09-23: CSFloat
      // lagged Steam by about two minutes). The operation names its retrieve so a restart resumes
      // from that action's observed state. `loose_obs` is the observation that proved the item
      // loose: CSFloat's read must be newer than it, and the deadline counts from it. The deadline
      // is stored so a restart judges the same instant. Existing operations were all admitted from
      // main inventory, so every column is NULL for them.
      addColumn(sqlite, 'csfloat_operation', 'retrieve_action_id', 'TEXT REFERENCES action(id)');
      addColumn(sqlite, 'csfloat_operation', 'loose_obs', 'INTEGER REFERENCES observation(id)');
      addColumn(sqlite, 'csfloat_operation', 'visibility_deadline_at', 'TEXT');
    }
  }
  ,{
    version: 24,
    name: 'a CSFloat operation can be about a buy order',
    up(sqlite) {
      // An edit or cancel of one of the account's own CSFloat buy orders is a csfloat_operation
      // like a listing edit, named by the venue's order id rather than a listing id, and an edit
      // freezes the quantity it asks for beside the price. `csfloat_buy_order` itself is a new
      // table and comes from schema.ts. Existing operations are all listing or delivery work, so
      // both columns are NULL for them.
      addColumn(sqlite, 'csfloat_operation', 'order_id', 'TEXT');
      addColumn(sqlite, 'csfloat_operation', 'quantity', 'INTEGER');
    }
  }
  ,{
    version: 25,
    name: 'one item row per unit: handles fold into item; lineage, accessories, attributes, marketable',
    up(sqlite) {
      // Holdings plan D2–D9. Every unit the account holds becomes an `item` row keyed on its
      // asset id, whichever kind it is; the commodity tables are copied in and then dropped, and
      // the actions that named a unit as `asset:<id>` are re-pointed at the row that now holds it.
      for (const table of ['item', 'inventory_backup_item']) {
        addColumn(sqlite, table, 'unit_kind', "TEXT NOT NULL DEFAULT 'individual'");
        addColumn(sqlite, table, 'group_key', "TEXT NOT NULL DEFAULT ''");
        addColumn(sqlite, table, 'quantity', 'INTEGER NOT NULL DEFAULT 1');
        addColumn(sqlite, table, 'reserved_command', 'TEXT');
        addColumn(sqlite, table, 'attributes_json', "TEXT NOT NULL DEFAULT '{}'");
        addColumn(sqlite, table, 'end_reason', 'TEXT');
      }
      addColumn(sqlite, 'trade_inventory_item', 'marketable', 'INTEGER CHECK(marketable IN (0,1))');
      // An individual row's group is its fingerprint with nothing applied — the next walk derives
      // the real one from the attributes it sees; nothing before this migration kept them.
      sqlite.exec("UPDATE item SET group_key = stable_key || ':-' WHERE group_key = ''");

      if (tableExists(sqlite, 'commodity_handle')) {
        type HandleRow = { account_id: string; asset_id: string; stack_key: string; def_index: number; quality: number; location: string;
          casket_id: string | null; quantity: number | null; reserved_command: string | null; last_seen_obs: number; row_generation: number | null; kit: string | null };
        const handles = sqlite.prepare('SELECT * FROM commodity_handle').all() as unknown as HandleRow[];
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO item(local_id, account_id, def_index, paint_index, paint_wear, paint_seed, quality,
            stable_key, current_asset_id, location, casket_id, tradable_after, trade_protected_until,
            first_seen_obs, last_seen_obs, location_obs, location_generation, row_generation, kit,
            unit_kind, group_key, quantity, reserved_command, attributes_json, end_reason)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, 'fungible', ?, ?, ?, '{}', NULL)`);
        for (const handle of handles) {
          // A handle's stack key was its lock bucket too; the walk re-derives both locks and the
          // group key on the next read, so neither is guessed here from the key's spelling.
          insert.run(randomUUID(), handle.account_id, handle.def_index, handle.quality, handle.stack_key,
            handle.asset_id, handle.location, handle.casket_id ?? null, handle.last_seen_obs, handle.last_seen_obs,
            handle.last_seen_obs, handle.row_generation ?? 0, handle.kit ?? '', handle.stack_key, handle.quantity ?? 1,
            handle.reserved_command ?? null);
        }
        // `asset:<id>` targets and `asset:<account>:<id>` resource keys become the unit's row.
        for (const table of ['action', 'desired_state']) {
          const rows = sqlite.prepare(`SELECT rowid AS r, account_id, target_id FROM ${table} t WHERE target_id LIKE 'asset:%'`).all() as Array<{ r: number; account_id: string; target_id: string }>;
          const retarget = sqlite.prepare(`UPDATE ${table} SET target_id=COALESCE((SELECT i.local_id FROM item i WHERE i.account_id=? AND i.current_asset_id=?), target_id) WHERE rowid=?`);
          for (const row of rows) retarget.run(row.account_id, row.target_id.slice('asset:'.length), row.r);
        }
        const keyed = sqlite.prepare("SELECT rowid AS r, account_id, resource_key FROM action WHERE resource_key LIKE 'asset:%'").all() as Array<{ r: number; account_id: string; resource_key: string }>;
        const rekey = sqlite.prepare('UPDATE action SET resource_key=? WHERE rowid=?');
        for (const row of keyed) {
          const assetId = row.resource_key.slice(`asset:${row.account_id}:`.length);
          const local = sqlite.prepare('SELECT local_id FROM item WHERE account_id=? AND current_asset_id=?').get(row.account_id, assetId) as { local_id: string } | undefined;
          if (local) rekey.run(`item:${local.local_id}`, row.r);
        }
      }
      for (const table of ['commodity_handle', 'commodity_stack', 'fungible_stack', 'inventory_backup_commodity_handle', 'inventory_backup_commodity_stack']) {
        sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  },
  {
    version: 27,
    name: 'an accepted offer keeps the date Steam settles it: the end of its reversal period',
    up(sqlite) {
      addColumn(sqlite, 'trade_offer', 'settlement_date', 'TEXT');
    }
  },
  {
    version: 28,
    name: 'a listed item is in the inventory: MARKET is no longer a location',
    up(sqlite) {
      // The Game Coordinator keeps a listed item in the inventory (`db/steam-listing.ts`), so a row
      // at MARKET is a row the GC still holds, and "listed" is now its open listing. The location
      // moves to MAIN with no proof, the way migration 3 left legacy rows: nobody observed MAIN,
      // and the next inventory walk either proves it or finds the unit gone. Its generation goes
      // too, so that walk is not refused as older than the market's word.
      for (const table of ['item', 'inventory_backup_item']) {
        if (!tableExists(sqlite, table)) continue;
        sqlite.exec(`UPDATE ${table} SET location='MAIN', casket_id=NULL, location_obs=NULL, location_generation=NULL WHERE location='MARKET'`);
      }
    }
  }
];

function tableExists(sqlite: DatabaseSync, table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function addColumn(sqlite: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  // A table a later migration dropped (the commodity tables, migration 25) is absent on a fresh
  // database, where the earlier migration that widened it has nothing to widen. Skipping is the
  // idempotent answer; the alternative is editing an applied migration, which rule 1 forbids.
  if (columns.length === 0) return;
  if (columns.some((existing) => existing.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
