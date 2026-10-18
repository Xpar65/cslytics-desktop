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
  /**
   * The migration rebuilds a table other tables reference. `applySchema` then switches foreign keys
   * off around it, since SQLite would otherwise cascade or refuse the DROP, and checks before the
   * commit that it left no new row pointing at a missing parent.
   */
  foreignKeysOff?: boolean;
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
        // The holding's asset column under whichever name the record carries: migration 29 renames it,
        // and a fresh record runs this against the declared shape.
        const assetColumn = columnExists(sqlite, 'item', 'current_asset_id') ? 'current_asset_id' : 'asset_id';
        type HandleRow = { account_id: string; asset_id: string; stack_key: string; def_index: number; quality: number; location: string;
          casket_id: string | null; quantity: number | null; reserved_command: string | null; last_seen_obs: number; row_generation: number | null; kit: string | null };
        const handles = sqlite.prepare('SELECT * FROM commodity_handle').all() as unknown as HandleRow[];
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO item(local_id, account_id, def_index, paint_index, paint_wear, paint_seed, quality,
            stable_key, ${assetColumn}, location, casket_id, tradable_after, trade_protected_until,
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
          const retarget = sqlite.prepare(`UPDATE ${table} SET target_id=COALESCE((SELECT i.local_id FROM item i WHERE i.account_id=? AND i.${assetColumn}=?), target_id) WHERE rowid=?`);
          for (const row of rows) retarget.run(row.account_id, row.target_id.slice('asset:'.length), row.r);
        }
        const keyed = sqlite.prepare("SELECT rowid AS r, account_id, resource_key FROM action WHERE resource_key LIKE 'asset:%'").all() as Array<{ r: number; account_id: string; resource_key: string }>;
        const rekey = sqlite.prepare('UPDATE action SET resource_key=? WHERE rowid=?');
        for (const row of keyed) {
          const assetId = row.resource_key.slice(`asset:${row.account_id}:`.length);
          const local = sqlite.prepare(`SELECT local_id FROM item WHERE account_id=? AND ${assetColumn}=?`).get(row.account_id, assetId) as { local_id: string } | undefined;
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
  },
  {
    version: 29,
    name: 'one table per thing: a work step carries a hop, an action carries a goal or a step, a command may be a draft',
    foreignKeysOff: true,
    up(sqlite) {
      // Consolidation plan §6. Written as each stage lands and shipped once (D18); every part is
      // idempotent, so a record that ran an earlier shape of it skips what it already has.
      //
      // Stage 1. `work_step` comes from schema.ts. `action` is rebuilt so a hop's action may carry a
      // step instead of a goal (D3): `desired_id` becomes nullable, `step_id` arrives, and a CHECK
      // holds exactly one of them. `command` is rebuilt so a captured selection can be a draft
      // (§4.4) and so a draft keeps its revision and filter.
      rebuildTable(sqlite, 'action', ACTION_29, 'step_id',
        ['id', 'account_id', 'kind', 'target_id', 'desired_version', 'desired_id', 'state', 'resource_key', 'created_at', 'updated_at', 'error', 'params_json', 'resolved_by_obs', 'resolution']);
      rebuildTable(sqlite, 'command', COMMAND_29, "'DRAFT'",
        ['id', 'correlation_id', 'kind', 'state', 'reject_reason', 'created_at', 'preparing', 'manifest_token', 'observed_completed']);
      // A record that ran an earlier shape of this migration holds `work_step` under a narrower
      // alphabet; the hop kinds a buy order placed or cancelled by hand take arrived later (§4.4).
      rebuildTable(sqlite, 'work_step', WORK_STEP_29, "'BUY_ORDER_CREATE'",
        ['id', 'command_id', 'account_id', 'local_id', 'target_id', 'offer_id', 'ordinal', 'kind', 'state', 'action_id', 'desired_id', 'reason', 'params_json', 'observation_id', 'deadline_at', 'created_at', 'updated_at']);
      // The CSFloat saga: every operation becomes the hops of a command, its actions re-pointed at
      // their hops, the goals minted only to give those actions a goal id deleted (D3), the table
      // dropped (§4.7).
      backfillCsfloatSteps(sqlite);
      // The transfer saga: each source's batch becomes its hops and a `transfer_detail` row beside
      // the send hop; the goals minted for its actions go (D3); the table and its triggers go.
      backfillTransferSteps(sqlite);
      // The store purchase saga: each purchase becomes its command's hops with its lines beside
      // the init hop (`store_line`); the goals minted for its actions go (D3); both tables go.
      backfillStoreSteps(sqlite);
      // The Steam command chains: each member's hops under `work_step`, the actions re-pointed at
      // them (D3), and `command_member` rebuilt without `action_id` and with its alphabet (§4.4).
      backfillCommandSteps(sqlite);
      // Selections: each manifest becomes a command in `DRAFT` with its latest revision's members
      // (§4.4), and the two tables go.
      backfillDrafts(sqlite);
      // Work asked for by hand: a delist, a buy order placed, a buy order cancelled, each a bare
      // action until now, each a command of one hop (§4.4).
      backfillBareSteps(sqlite);
      //
      // Stage 2. Orders: `venue_order` is rebuilt as the parent of every venue's orders, the Steam
      // listing table folded into it with a `steam_order` satellite beside each walked listing (D4).
      foldSteamListings(sqlite);
      foldSteamBuyOrders(sqlite);
      foldCsfloatOrders(sqlite);
      // The history row keeps what its reads ask and loses the body (D15); the name a body carried
      // beside the asset, where one did, is kept.
      rebuildTable(sqlite, 'market_history', MARKET_HISTORY_29, 'hash_name',
        ['account_id', 'event_id', 'listing_id', 'purchase_id', 'event_type', 'occurred_at', 'observation_id', ['hash_name', "json_extract(raw_json, '$.asset.market_hash_name')"]]);
      //
      // Stage 3. The holding row loses the staged write's generation and the location nothing has
      // written since migration 28 (D8), and its asset column takes the name `asset_id` (D14); the
      // backup twin, the journal and the publication marker go.
      // Guarded by the column rather than by the shape, because the migration that added
      // `row_generation` runs on a fresh record too and would put it back after the rebuild.
      if (columnExists(sqlite, 'item', 'row_generation') || columnExists(sqlite, 'item', 'current_asset_id')) rebuildTable(sqlite, 'item', ITEM_29, null,
        ['local_id', 'account_id', 'def_index', 'paint_index', 'paint_wear', 'paint_seed', 'quality', 'stable_key', ['asset_id', columnExists(sqlite, 'item', 'current_asset_id') ? 'current_asset_id' : 'asset_id'],
          ['location', "CASE WHEN location='MARKET' THEN 'MAIN' ELSE location END"], 'casket_id', 'tradable_after', 'trade_protected_until',
          'first_seen_obs', 'last_seen_obs', 'location_obs', 'location_generation', 'kit', 'unit_kind', 'group_key', 'quantity', 'reserved_command', 'attributes_json', 'end_reason']);
      for (const table of ['inventory_backup_item', 'inventory_event_journal', 'inventory_publication']) sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
      // The two per-source asset mirrors become `asset_evidence`, one row per source (D11).
      foldAssetEvidence(sqlite);
      // The checkpoints and the revision counters become `surface_state`, and the triggers go (D9).
      foldSurfaceState(sqlite);
      // A casket observation's surface is the family and its scope the casket (D14); the account's
      // trade token moves onto its row; the capture table nothing ever wrote goes (§4.7).
      sqlite.exec("UPDATE observation SET scope_kind='casket', scope_id=substr(surface, 11), surface='gc-casket' WHERE surface LIKE 'gc-casket:%'");
      addColumn(sqlite, 'account', 'trade_token', 'TEXT');
      addColumn(sqlite, 'account', 'trade_token_obs', 'INTEGER');
      if (tableExists(sqlite, 'account_trade_link')) {
        sqlite.exec(`UPDATE account SET trade_token=(SELECT l.token FROM account_trade_link l WHERE l.account_id=account.id),
          trade_token_obs=(SELECT l.observation_id FROM account_trade_link l WHERE l.account_id=account.id) WHERE id IN (SELECT account_id FROM account_trade_link)`);
        sqlite.exec('DROP TABLE account_trade_link');
      }
      sqlite.exec('DROP TABLE IF EXISTS raw_capture');
      //
      // Stage 4. The ledger names no holding and keeps no candidate set (D12): a sale's holding is
      // its order parent's, and the lot table nothing read goes. The protection switch leaves the
      // record for settings.json (D13).
      if (columnExists(sqlite, 'economic_event', 'candidates_json')) rebuildTable(sqlite, 'economic_event', ECONOMIC_EVENT_29, null,
        ['account_id', 'source_key', 'kind', 'occurred_at', 'quantity', 'amount_cents', 'fee_cents', 'currency', 'amount_basis', 'order_id', 'trade_id',
          'offer_id', 'listing_id', 'corrects_source_key', 'observation_id', 'recorded_at']);
      for (const table of ['acquisition', 'marketplace_policy']) sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
      // Names (D14): a member names its holding's local id; the venue tables are venue tables; a
      // counterparty is a SteamID64; Steam's codes are codes and the record's words have alphabets;
      // the venue's word for a trade is its word, as for a listing.
      if (columnExists(sqlite, 'command_member', 'member_id')) rebuildTable(sqlite, 'command_member', COMMAND_MEMBER_29, null,
        ['command_id', 'account_id', ['local_id', 'member_id'], 'stack_key', 'quantity', 'destination', 'price_receive_cents', 'state', 'input_json']);
      for (const [was, now] of [['marketplace_connection', 'venue_connection'], ['marketplace_conflict', 'venue_conflict']] as const) {
        if (!tableExists(sqlite, was)) continue;
        sqlite.exec(`INSERT OR REPLACE INTO ${now} SELECT * FROM ${was}`);
        sqlite.exec(`DROP TABLE ${was}`);
      }
      if (columnExists(sqlite, 'trade_offer', 'counterparty_id')) rebuildTable(sqlite, 'trade_offer', TRADE_OFFER_29, null,
        ['account_id', 'offer_id', 'trade_id', ['counterparty_steam_id64', steamId64Sql('counterparty_id')], 'direction', ['state_code', 'raw_state'], 'status',
          'confirmation_method', 'escrow_until', 'expires_at', 'created_at', 'updated_at', 'first_seen_obs', 'last_seen_obs', 'message', 'settlement_date']);
      if (columnExists(sqlite, 'trade_status_event', 'raw_state')) rebuildTable(sqlite, 'trade_status_event', TRADE_STATUS_EVENT_29, null,
        ['account_id', 'event_key', 'offer_id', 'trade_id', ['state_code', 'raw_state'], 'status', 'occurred_at', 'observation_id']);
      if (columnExists(sqlite, 'executed_trade', 'raw_status')) rebuildTable(sqlite, 'executed_trade', EXECUTED_TRADE_29, null,
        ['account_id', 'trade_id', 'offer_id', 'counterparty_steam_id64', ['status_code', 'raw_status'], 'status', 'initiated_at', 'updated_at', 'settled_at',
          'reverses_trade_id', 'first_seen_obs', 'last_seen_obs']);
      if (columnExists(sqlite, 'csfloat_trade', 'state')) rebuildTable(sqlite, 'csfloat_trade', CSFLOAT_TRADE_29, null,
        ['account_id', 'trade_id', 'listing_id', 'asset_id', 'local_id', ['state_word', 'state'], 'seller_steam_id', 'data_json', 'observation_id',
          ['offer_id', "json_extract(data_json, '$.offerId')"]]);
      // An evidence row cites its observation and carries no generation beside it, and the
      // reference never cascades (D16, D17).
      if (columnExists(sqlite, 'csfloat_account_status', 'generation')) rebuildTable(sqlite, 'csfloat_account_status', CSFLOAT_ACCOUNT_STATUS_29, null,
        ['account_id', 'observation_id', 'observed_at', 'remote_steam_id', 'available_cents', 'pending_cents', 'flags_json']);
      if (columnExists(sqlite, 'csfloat_account_standing', 'generation')) rebuildTable(sqlite, 'csfloat_account_standing', CSFLOAT_ACCOUNT_STANDING_29, null,
        ['account_id', 'observation_id', 'observed_at', 'standing', 'penalty_progress', 'restrictions_json']);
      // A goal a command set names the command; `basis` said nothing a read asked (D15).
      addColumn(sqlite, 'desired_state', 'command_id', 'TEXT REFERENCES command(id)');
      if (columnExists(sqlite, 'desired_state', 'basis')) {
        sqlite.exec('UPDATE desired_state SET command_id=basis WHERE basis IN (SELECT id FROM command)');
        sqlite.exec('ALTER TABLE desired_state DROP COLUMN basis');
      }
      // The walk notices nothing reads any more (D10): the holding row and its observation are the
      // evidence, and a walk's counts live on `observation`.
      sqlite.exec("DELETE FROM event WHERE kind IN ('gc-added', 'gc-removed', 'gc-updated', 'inventory-snapshot', 'market-snapshot', 'market-snapshot-incomplete')");
      // Statistics for every rebuilt table before the first plan runs over one (D20). The open's
      // `PRAGMA optimize` gathers them again only when SQLite judges them stale, and a record
      // that reached this build without any had five weeks of guessed plans behind it.
      sqlite.exec('ANALYZE');
    }
  }
];

/**
 * The frozen shapes migration 29 rebuilds to. Copies of the declaration as it stood when the
 * migration shipped, kept here so a later edit of `schema.ts` cannot change what an applied
 * migration did (rule 1). `migrations.test.ts` proves the rebuilt shape and the declared one agree.
 */
const ACTION_29 = `CREATE TABLE IF NOT EXISTS action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  desired_version INTEGER NOT NULL DEFAULT 0,
  desired_id TEXT REFERENCES desired_state(id),
  state TEXT NOT NULL CHECK(state IN ('READY', 'RUNNING', 'AWAITING_OBSERVATION', 'DONE', 'FAILED')),
  resource_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  params_json TEXT,
  resolved_by_obs INTEGER REFERENCES observation(id),
  resolution TEXT,
  step_id TEXT REFERENCES work_step(id),
  CHECK((step_id IS NULL) <> (desired_id IS NULL))
)`;

const COMMAND_29 = `CREATE TABLE IF NOT EXISTS command (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT', 'REJECTED', 'ADMITTED', 'RUNNING', 'PARTIAL', 'COMPLETE', 'STOPPED')),
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  preparing INTEGER NOT NULL DEFAULT 0,
  manifest_token TEXT,
  observed_completed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  filter_json TEXT
)`;

const VENUE_ORDER_29 = `CREATE TABLE IF NOT EXISTS venue_order (
  account_id TEXT NOT NULL REFERENCES account(id),
  order_id TEXT NOT NULL,
  venue TEXT NOT NULL CHECK(venue IN ('steam', 'csfloat')),
  side TEXT NOT NULL CHECK(side IN ('SELL', 'BUY')),
  local_id TEXT REFERENCES item(local_id),
  asset_id TEXT,
  hash_name TEXT,
  venue_order_id TEXT,
  price_cents INTEGER,
  currency INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  filled INTEGER,
  state TEXT NOT NULL CHECK(state IN ('SUBMITTED', 'OPEN', 'OPEN_UNTRANSACTABLE', 'PENDING_EXTERNAL', 'UNEXPLAINED', 'QUARANTINED', 'ENDED_FILLED', 'ENDED_CANCELLED_BY_US', 'ENDED_CANCELLED_EXTERNALLY', 'ENDED_LAPSED', 'ENDED_EXPIRED', 'ENDED_VOIDED_BY_VENUE', 'ENDED_LOST', 'ENDED_NOT_APPLIED')),
  confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(confidence IN ('proven', 'probable', 'asserted', 'unknown')),
  transactable_after TEXT,
  opened_at TEXT NOT NULL,
  first_seen_obs INTEGER REFERENCES observation(id),
  last_seen_obs INTEGER REFERENCES observation(id),
  gone_obs INTEGER REFERENCES observation(id),
  ended_at TEXT,
  end_reason TEXT,
  end_evidence INTEGER REFERENCES observation(id),
  action_id TEXT REFERENCES action(id),
  PRIMARY KEY(account_id, order_id)
)`;

const STEAM_ORDER_29 = `CREATE TABLE IF NOT EXISTS steam_order (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  buyer_price_cents INTEGER,
  raw_bucket TEXT CHECK(raw_bucket IN ('ACTIVE', 'ON_HOLD', 'PENDING_CONFIRMATION')),
  PRIMARY KEY(account_id, order_id),
  FOREIGN KEY(account_id, order_id) REFERENCES venue_order(account_id, order_id) ON DELETE CASCADE
) STRICT`;

const CSFLOAT_ORDER_29 = `CREATE TABLE IF NOT EXISTS csfloat_order (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  type TEXT,
  state_word TEXT,
  item_json TEXT,
  properties_json TEXT,
  created_at TEXT,
  observation_id INTEGER REFERENCES observation(id),
  PRIMARY KEY(account_id, order_id),
  FOREIGN KEY(account_id, order_id) REFERENCES venue_order(account_id, order_id) ON DELETE CASCADE
) STRICT`;

const ITEM_29 = `CREATE TABLE IF NOT EXISTS item (
  local_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  def_index INTEGER NOT NULL,
  paint_index INTEGER,
  paint_wear REAL,
  paint_seed INTEGER,
  quality INTEGER NOT NULL,
  stable_key TEXT NOT NULL,
  asset_id TEXT,
  location TEXT NOT NULL CHECK(location IN ('MAIN', 'CASKET', 'MISSING')),
  casket_id TEXT,
  tradable_after TEXT,
  trade_protected_until TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  location_obs INTEGER REFERENCES observation(id),
  location_generation INTEGER,
  kit TEXT NOT NULL DEFAULT '',
  unit_kind TEXT NOT NULL DEFAULT 'individual',
  group_key TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  reserved_command TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  end_reason TEXT
)`;

const ECONOMIC_EVENT_29 = `CREATE TABLE IF NOT EXISTS economic_event (
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
  order_id TEXT,
  trade_id TEXT,
  offer_id TEXT,
  listing_id TEXT,
  corrects_source_key TEXT,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(account_id, source_key)
)`;

const TRADE_OFFER_29 = `CREATE TABLE IF NOT EXISTS trade_offer (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  trade_id TEXT,
  counterparty_steam_id64 TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('SENT', 'RECEIVED')),
  state_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('INVALID', 'ACTIVE', 'ACCEPTED', 'COUNTERED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'INVALID_ITEMS', 'PENDING_CONFIRMATION', 'CANCELLED_BY_SECOND_FACTOR', 'ESCROW', 'UNKNOWN')),
  confirmation_method INTEGER,
  escrow_until TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  message TEXT,
  -- When Steam settles an accepted offer: for a trade-protected trade, the end of its reversal period.
  settlement_date TEXT,
  PRIMARY KEY(account_id, offer_id)
)`;

const TRADE_STATUS_EVENT_29 = `CREATE TABLE IF NOT EXISTS trade_status_event (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  offer_id TEXT,
  trade_id TEXT,
  state_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('INVALID', 'ACTIVE', 'ACCEPTED', 'COUNTERED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'INVALID_ITEMS', 'PENDING_CONFIRMATION', 'CANCELLED_BY_SECOND_FACTOR', 'ESCROW', 'UNKNOWN', 'PENDING', 'COMPLETE', 'FAILED', 'ROLLED_BACK', 'REVERSED')),
  occurred_at TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, event_key)
)`;

const EXECUTED_TRADE_29 = `CREATE TABLE IF NOT EXISTS executed_trade (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL,
  offer_id TEXT,
  counterparty_steam_id64 TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'COMPLETE', 'FAILED', 'ROLLED_BACK', 'REVERSED', 'ESCROW', 'UNKNOWN')),
  initiated_at TEXT NOT NULL,
  updated_at TEXT,
  settled_at TEXT,
  reverses_trade_id TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, trade_id)
)`;

const CSFLOAT_TRADE_29 = `CREATE TABLE IF NOT EXISTS csfloat_trade (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  local_id TEXT,
  -- The venue's own word for the trade's state, as csfloat_order keeps a listing's (D14).
  state_word TEXT NOT NULL,
  seller_steam_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  -- The Steam offer the trade is carried by, as the venue reports it (§4.5).
  offer_id TEXT,
  PRIMARY KEY(account_id,trade_id)
)`;

const CSFLOAT_ACCOUNT_STATUS_29 = `CREATE TABLE IF NOT EXISTS csfloat_account_status (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
  remote_steam_id TEXT NOT NULL,
  available_cents INTEGER,
  pending_cents INTEGER,
  flags_json TEXT NOT NULL
)`;

const CSFLOAT_ACCOUNT_STANDING_29 = `CREATE TABLE IF NOT EXISTS csfloat_account_standing (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
  standing TEXT NOT NULL,
  penalty_progress REAL,
  restrictions_json TEXT NOT NULL
)`;

const MARKET_HISTORY_29 = `CREATE TABLE IF NOT EXISTS market_history (
  account_id TEXT NOT NULL REFERENCES account(id),
  event_id TEXT NOT NULL,
  listing_id TEXT,
  purchase_id TEXT,
  event_type INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  hash_name TEXT,
  PRIMARY KEY(account_id, event_id)
)`;

const COMMAND_MEMBER_29 = `CREATE TABLE IF NOT EXISTS command_member (
  command_id TEXT NOT NULL REFERENCES command(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  stack_key TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  destination TEXT,
  price_receive_cents INTEGER,
  state TEXT NOT NULL CHECK(state IN ('DRAFT', 'PREPARED', 'QUEUED', 'REJECTED', 'STOPPED', 'SOLD')),
  input_json TEXT,
  PRIMARY KEY(command_id, account_id, local_id)
)`;

const WORK_STEP_29 = `CREATE TABLE IF NOT EXISTS work_step (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES command(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_id TEXT,
  target_id TEXT,
  offer_id TEXT,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('DELIST', 'LIST', 'RETRIEVE', 'STORE', 'BUY_ORDER_CREATE', 'BUY_ORDER_CANCEL', 'SEND', 'ACCEPT', 'CANCEL', 'CSFLOAT_CREATE', 'CSFLOAT_AWAIT_VENUE', 'CSFLOAT_REPRICE', 'CSFLOAT_CANCEL', 'CSFLOAT_ACCEPT', 'CSFLOAT_SEND', 'CSFLOAT_NOTIFY', 'CSFLOAT_CANNOT_DELIVER', 'CSFLOAT_BUY_ORDER_EDIT', 'CSFLOAT_BUY_ORDER_CANCEL', 'STORE_INIT', 'STORE_APPROVE', 'STORE_FINALIZE', 'STORE_CANCEL')),
  state TEXT NOT NULL CHECK(state IN ('QUEUED', 'SENT', 'AWAITING_OBSERVATION', 'RETRYING', 'DONE', 'FAILED', 'STOPPED')),
  action_id TEXT REFERENCES action(id),
  desired_id TEXT REFERENCES desired_state(id),
  reason TEXT,
  params_json TEXT,
  observation_id INTEGER REFERENCES observation(id),
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`;

/** The words a step keeps for an action's state, where the action is the authority (`WorkStore.stateOf`). */
function stepStateOfAction(action: { state: string } | undefined): string {
  if (!action) return 'QUEUED';
  return action.state === 'READY' ? 'QUEUED' : action.state === 'RUNNING' ? 'SENT' : action.state;
}

/**
 * Migration 29, the CSFloat saga (consolidation plan §6 step 4).
 *
 * Each `csfloat_operation` row becomes the hops of one command in `work_step`, under the ids the
 * engine would have given them: a loose create, a reprice or a cancel is one hop under the
 * operation's id; a create from a storage unit is its retrieve, its wait and its listing hop; a
 * delivery is one hop per action it made, by resource key; a buy-order edit or cancel is one hop
 * named by the order. Every action the saga named is re-pointed at its hop and loses the goal it
 * carried, the goals minted for the sagas are deleted, and the table is dropped. An action under
 * one of those goals that no row names gets a hop of its own, so the record keeps every attempt.
 * Idempotent: the table is gone once this has run.
 */
function backfillCsfloatSteps(sqlite: DatabaseSync): void {
  if (!tableExists(sqlite, 'csfloat_operation')) return;
  type Op = {
    id: string; command_id: string; account_id: string; kind: string; local_id: string | null; asset_id: string | null; listing_id: string | null;
    trade_id: string | null; price_cents: number | null; generation: number; policy_version: number; state: string; action_id: string | null;
    offer_id: string | null; created_at: string; updated_at: string; error: string | null; retrieve_action_id: string | null; loose_obs: number | null;
    visibility_deadline_at: string | null; order_id: string | null; quantity: number | null;
  };
  type Act = { id: string; account_id: string; kind: string; target_id: string; state: string; resolved_by_obs: number | null; error: string | null; params_json: string | null; created_at: string; updated_at: string };
  type Hop = {
    id: string; commandId: string; accountId: string; localId: string | null; targetId: string | null; offerId?: string | null; ordinal: number; kind: string;
    state: string; action?: Act | undefined; reason?: string | null; params: unknown; observationId?: number | null; deadlineAt?: string | null; createdAt: string; updatedAt: string;
  };
  const ACTION_COLUMNS = 'id, account_id, kind, target_id, state, resolved_by_obs, error, params_json, created_at, updated_at';
  const actionOf = (id: string | null): Act | undefined => id ? sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE id=?`).get(id) as Act | undefined : undefined;
  const actionsByKey = (accountId: string, key: string): Act[] =>
    sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE account_id=? AND resource_key=? ORDER BY created_at, rowid`).all(accountId, key) as Act[];
  const insertCommand = sqlite.prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed)
    VALUES (?, ?, ?, 'ADMITTED', NULL, ?, 0, NULL, 0)`);
  const insertStep = sqlite.prepare(`INSERT OR IGNORE INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
    reason, params_json, observation_id, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
  const pointAction = sqlite.prepare('UPDATE action SET step_id=?, desired_id=NULL, desired_version=0 WHERE id=?');
  const hop = (input: Hop): void => {
    insertStep.run(input.id, input.commandId, input.accountId, input.localId, input.targetId, input.offerId ?? null, input.ordinal, input.kind, input.state,
      input.action?.id ?? null, input.reason ?? null, JSON.stringify(input.params), input.observationId ?? input.action?.resolved_by_obs ?? null,
      input.deadlineAt ?? null, input.createdAt, input.updatedAt);
    if (input.action) pointAction.run(input.id, input.action.id);
  };
  const NOT_REACHED = 'An earlier hop failed';
  const sagaState = (state: string): string => ['QUEUED', 'AWAITING_OBSERVATION', 'DONE', 'FAILED'].includes(state) ? state : 'QUEUED';
  const DELIVERY_HOPS = ['CSFLOAT_ACCEPT', 'CSFLOAT_SEND', 'CSFLOAT_NOTIFY', 'CSFLOAT_CANNOT_DELIVER'] as const;

  const ops = sqlite.prepare('SELECT * FROM csfloat_operation ORDER BY created_at, id').all() as Op[];
  for (const op of ops) {
    insertCommand.run(op.command_id, randomUUID(), `CSFLOAT_${op.kind}`, op.created_at);
    const base = { commandId: op.command_id, accountId: op.account_id, localId: op.local_id, createdAt: op.created_at, updatedAt: op.updated_at };
    const terms = { operationId: op.id, assetId: op.asset_id, listingId: op.listing_id, priceCents: op.price_cents, generation: op.generation, policyVersion: op.policy_version };
    if (op.kind === 'CREATE' && op.retrieve_action_id) {
      const retrieve = actionOf(op.retrieve_action_id);
      const retrieveState = stepStateOfAction(retrieve);
      const retrieveFailed = retrieveState === 'FAILED';
      const casketId = (retrieve?.params_json ? JSON.parse(retrieve.params_json) as { casketId?: string } : {}).casketId;
      hop({ ...base, id: `${op.id}:retrieve`, targetId: null, ordinal: 0, kind: 'RETRIEVE', state: retrieveState, action: retrieve,
        reason: retrieveFailed ? op.error ?? retrieve?.error ?? null : null, params: { ...terms, casketId } });
      // The wait: queued while retrieving, waiting with its deadline, done once the listing hop
      // had its action, failed on the timeout, never reached after a refused retrieve.
      const listed = op.action_id !== null;
      const awaitState = retrieveFailed ? 'STOPPED' : op.state === 'RETRIEVING' ? 'QUEUED' : op.state === 'AWAITING_VENUE' ? 'AWAITING_OBSERVATION'
        : listed ? 'DONE' : op.state === 'FAILED' ? 'FAILED' : 'QUEUED';
      hop({ ...base, id: `${op.id}:await`, targetId: null, ordinal: 1, kind: 'CSFLOAT_AWAIT_VENUE', state: awaitState,
        reason: awaitState === 'STOPPED' ? NOT_REACHED : awaitState === 'FAILED' ? op.error : awaitState === 'AWAITING_OBSERVATION' ? 'Waiting for CSFloat to see the retrieved item' : null,
        params: terms, observationId: awaitState === 'DONE' ? op.loose_obs : null, deadlineAt: awaitState === 'AWAITING_OBSERVATION' ? op.visibility_deadline_at : null });
      const createState = retrieveFailed || awaitState === 'FAILED' ? 'STOPPED' : listed ? sagaState(op.state) : 'QUEUED';
      hop({ ...base, id: op.id, targetId: op.listing_id, ordinal: 2, kind: 'CSFLOAT_CREATE', state: createState, action: actionOf(op.action_id),
        reason: createState === 'STOPPED' ? NOT_REACHED : createState === 'FAILED' ? op.error : null, params: terms });
      continue;
    }
    if (op.kind === 'CREATE' || op.kind === 'REPRICE' || op.kind === 'CANCEL') {
      hop({ ...base, id: op.id, targetId: op.listing_id, ordinal: 0, kind: `CSFLOAT_${op.kind}`, state: sagaState(op.state), action: actionOf(op.action_id),
        reason: op.state === 'FAILED' ? op.error : null, params: terms });
      continue;
    }
    if (op.kind === 'DELIVER') {
      const params = { operationId: op.id, tradeId: op.trade_id, listingId: op.listing_id, assetId: op.asset_id, generation: op.generation, policyVersion: op.policy_version };
      const made = DELIVERY_HOPS.map((kind, ordinal) => ({ kind, ordinal, actions: actionsByKey(op.account_id, `csfloat-delivery:${op.id}:${kind}`) })).filter((entry) => entry.actions.length);
      if (!made.length) {
        hop({ ...base, id: `${op.id}:CSFLOAT_SEND`, targetId: op.trade_id, ordinal: 1, kind: 'CSFLOAT_SEND', state: 'QUEUED', reason: op.state === 'BLOCKED' ? op.error : null, params });
        continue;
      }
      for (const entry of made) {
        const latest = entry.actions[entry.actions.length - 1]!;
        let state = stepStateOfAction(latest);
        if (entry.kind === 'CSFLOAT_SEND' && op.state === 'DONE') state = 'DONE';
        else if (entry.kind === 'CSFLOAT_SEND' && ['DONE', 'AWAITING_OBSERVATION'].includes(state) && op.state !== 'CANCELLED') state = 'AWAITING_OBSERVATION';
        else if (op.state === 'CANCELLED' && entry.kind !== 'CSFLOAT_CANNOT_DELIVER' && ['QUEUED', 'SENT', 'AWAITING_OBSERVATION'].includes(state)) state = 'STOPPED';
        const last = entry === made[made.length - 1];
        hop({ ...base, id: `${op.id}:${entry.kind}`, targetId: op.trade_id, offerId: entry.kind === 'CSFLOAT_SEND' ? op.offer_id : null, ordinal: entry.ordinal, kind: entry.kind, state, action: latest,
          reason: state === 'FAILED' ? latest.error ?? op.error : state === 'STOPPED' ? op.error : last && op.state === 'BLOCKED' ? op.error : null, params });
        for (const older of entry.actions.slice(0, -1)) pointAction.run(`${op.id}:${entry.kind}`, older.id);
      }
      continue;
    }
    // BUY_ORDER_EDIT and BUY_ORDER_CANCEL: the action already carries the frozen terms.
    const action = actionOf(op.action_id);
    const params = action?.params_json ? JSON.parse(action.params_json) as unknown
      : { operationId: op.id, orderId: op.order_id, maxPriceCents: op.price_cents, quantity: op.quantity, constraints: null, propertiesJson: null, generation: op.generation, policyVersion: op.policy_version };
    hop({ ...base, id: op.id, targetId: op.order_id, ordinal: 0, kind: `CSFLOAT_${op.kind}`, state: sagaState(op.state), action, reason: op.state === 'FAILED' ? op.error : null, params });
  }

  // An action under one of the sagas' goals that no row above named: a hop of its own.
  const orphans = sqlite.prepare(`SELECT ${ACTION_COLUMNS.split(', ').map((column) => `a.${column}`).join(', ')} FROM action a
    JOIN desired_state d ON d.id=a.desired_id WHERE d.target_kind IN ('csfloat-operation','csfloat-delivery') AND a.step_id IS NULL`).all() as Act[];
  for (const orphan of orphans) {
    const kind = orphan.kind === 'RETRIEVE_FROM_CASKET' ? 'RETRIEVE' : orphan.kind;
    const commandKind = orphan.kind === 'RETRIEVE_FROM_CASKET' ? 'CSFLOAT_CREATE' : (DELIVERY_HOPS as readonly string[]).includes(orphan.kind) ? 'CSFLOAT_DELIVER' : orphan.kind;
    const commandId = `recovered:${orphan.id}`;
    insertCommand.run(commandId, randomUUID(), commandKind, orphan.created_at);
    hop({ id: orphan.id, commandId, accountId: orphan.account_id, localId: orphan.target_id, targetId: null, ordinal: 0, kind, state: stepStateOfAction(orphan), action: orphan,
      reason: orphan.state === 'FAILED' ? orphan.error : null, params: orphan.params_json ? JSON.parse(orphan.params_json) as unknown : null, createdAt: orphan.created_at, updatedAt: orphan.updated_at });
  }
  sqlite.exec("DELETE FROM desired_state WHERE target_kind IN ('csfloat-operation','csfloat-delivery')");
  sqlite.exec('DROP TABLE csfloat_operation');
}

/**
 * Migration 29, the transfer saga (consolidation plan §6 step 4).
 *
 * Each `transfer_batch` row becomes one source's hops under its command: a `RETRIEVE` per action
 * the batch named, the `SEND` with the batch's offer and reason, an `ACCEPT` under the destination
 * and a `CANCEL` where the batch had those actions, under the ids the engine would have given them
 * (`transferHopId`); what only the send had moves to `transfer_detail`. The send's state is the
 * batch's, folded into the one alphabet: done is done, ended and failed are failed, a batch never
 * sent is queued, anything in flight is awaiting observation, and the words a reader wants come
 * back from the offer (`TransferStore.batches`). Every action named is re-pointed at its hop and
 * loses its goal; the goals minted for the saga are deleted; the table is dropped. An action under
 * one of those goals that no row named gets a hop of its own. Idempotent: the table is gone once
 * this has run.
 */
function backfillTransferSteps(sqlite: DatabaseSync): void {
  if (!tableExists(sqlite, 'transfer_batch')) return;
  type Batch = {
    command_id: string; account_id: string; destination_account_id: string; send_action_id: string; accept_action_id: string | null; cancel_action_id: string | null;
    offer_id: string | null; state: string; reason: string | null; assets_json: string; destination_baseline_json: string; accepted_at: string | null;
    accepted_obs: number | null; completed_source_obs: number | null; completed_destination_obs: number | null; retrieve_action_ids_json: string;
  };
  type Act = { id: string; account_id: string; kind: string; target_id: string; state: string; resolved_by_obs: number | null; error: string | null; params_json: string | null; created_at: string; updated_at: string };
  const ACTION_COLUMNS = 'id, account_id, kind, target_id, state, resolved_by_obs, error, params_json, created_at, updated_at';
  const actionOf = (id: string | null): Act | undefined => id ? sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE id=?`).get(id) as Act | undefined : undefined;
  const insertCommand = sqlite.prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed)
    VALUES (?, ?, 'ACCOUNT_TRANSFER', 'ADMITTED', NULL, ?, 0, NULL, 0)`);
  const insertStep = sqlite.prepare(`INSERT OR IGNORE INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
    reason, params_json, observation_id, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  const insertDetail = sqlite.prepare(`INSERT OR IGNORE INTO transfer_detail(step_id, account_id, destination_account_id, destination_baseline_json, accepted_at, accepted_obs, completed_source_obs, completed_destination_obs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const pointAction = sqlite.prepare('UPDATE action SET step_id=?, desired_id=NULL, desired_version=0 WHERE id=?');
  const hop = (input: { id: string; commandId: string; accountId: string; localId: string | null; targetId: string | null; offerId: string | null; ordinal: number; kind: string;
    state: string; action?: Act | undefined; reason: string | null; params: unknown; observationId?: number | null; createdAt: string; updatedAt: string }): void => {
    insertStep.run(input.id, input.commandId, input.accountId, input.localId, input.targetId, input.offerId, input.ordinal, input.kind, input.state, input.action?.id ?? null,
      input.reason, JSON.stringify(input.params), input.observationId ?? input.action?.resolved_by_obs ?? null, input.createdAt, input.updatedAt);
    if (input.action) pointAction.run(input.id, input.action.id);
  };
  const batches = sqlite.prepare('SELECT * FROM transfer_batch ORDER BY command_id, account_id').all() as Batch[];
  for (const batch of batches) {
    const send = actionOf(batch.send_action_id);
    const createdAt = send?.created_at ?? '1970-01-01T00:00:00.000Z', updatedAt = send?.updated_at ?? createdAt;
    insertCommand.run(batch.command_id, randomUUID(), createdAt);
    const prefix = `${batch.command_id}:${batch.account_id}`;
    const retrieves = (JSON.parse(batch.retrieve_action_ids_json || '[]') as string[]).map(actionOf).filter((action): action is Act => action !== undefined);
    const sendFailed = ['ENDED', 'FAILED'].includes(batch.state);
    retrieves.forEach((retrieve, ordinal) => {
      const state = stepStateOfAction(retrieve);
      const casketId = (retrieve.params_json ? JSON.parse(retrieve.params_json) as { casketId?: string } : {}).casketId;
      hop({ id: `${prefix}:retrieve:${retrieve.target_id}`, commandId: batch.command_id, accountId: batch.account_id, localId: retrieve.target_id, targetId: null, offerId: null,
        ordinal, kind: 'RETRIEVE', state: state === 'QUEUED' && sendFailed ? 'STOPPED' : state, action: retrieve,
        reason: state === 'FAILED' ? retrieve.error : null, params: { casketId, destinationAccountId: batch.destination_account_id }, createdAt: retrieve.created_at, updatedAt: retrieve.updated_at });
    });
    const sendState = batch.state === 'DONE' ? 'DONE' : sendFailed ? 'FAILED' : ['READY', 'RETRIEVING'].includes(batch.state) ? 'QUEUED' : 'AWAITING_OBSERVATION';
    const sendId = `${prefix}:send`;
    hop({ id: sendId, commandId: batch.command_id, accountId: batch.account_id, localId: null, targetId: null, offerId: batch.offer_id, ordinal: retrieves.length, kind: 'SEND',
      state: sendState, action: send, reason: batch.reason, params: { destinationAccountId: batch.destination_account_id },
      observationId: batch.completed_destination_obs, createdAt, updatedAt });
    insertDetail.run(sendId, batch.account_id, batch.destination_account_id, batch.destination_baseline_json, batch.accepted_at, batch.accepted_obs,
      batch.completed_source_obs, batch.completed_destination_obs);
    const accept = actionOf(batch.accept_action_id);
    if (accept) {
      hop({ id: `${prefix}:accept`, commandId: batch.command_id, accountId: batch.destination_account_id, localId: null, targetId: batch.offer_id, offerId: batch.offer_id,
        ordinal: retrieves.length + 1, kind: 'ACCEPT', state: batch.state === 'DONE' ? 'DONE' : sendFailed && stepStateOfAction(accept) !== 'FAILED' ? 'STOPPED' : stepStateOfAction(accept),
        action: accept, reason: accept.state === 'FAILED' ? accept.error : null,
        params: { sourceAccountId: batch.account_id, destinationAccountId: batch.destination_account_id }, createdAt: accept.created_at, updatedAt: accept.updated_at });
    }
    const cancel = actionOf(batch.cancel_action_id);
    if (cancel) {
      hop({ id: `${prefix}:cancel`, commandId: batch.command_id, accountId: batch.account_id, localId: null, targetId: batch.offer_id, offerId: batch.offer_id,
        ordinal: retrieves.length + 2, kind: 'CANCEL', state: stepStateOfAction(cancel), action: cancel,
        reason: cancel.state === 'FAILED' ? 'Cancellation refused; observing the offer' : null,
        params: { sourceAccountId: batch.account_id, destinationAccountId: batch.destination_account_id }, createdAt: cancel.created_at, updatedAt: cancel.updated_at });
    }
  }
  // An action under one of the saga's goals that no row above named: a hop of its own.
  const orphans = sqlite.prepare(`SELECT ${ACTION_COLUMNS.split(', ').map((column) => `a.${column}`).join(', ')} FROM action a
    JOIN desired_state d ON d.id=a.desired_id WHERE d.target_kind IN ('transfer','trade.accept','trade.cancel') AND a.step_id IS NULL`).all() as Act[];
  for (const orphan of orphans) {
    const kind = orphan.kind === 'trade.send' ? 'SEND' : orphan.kind === 'trade.accept' ? 'ACCEPT' : orphan.kind === 'trade.cancel' ? 'CANCEL' : 'RETRIEVE';
    const commandId = `recovered:${orphan.id}`;
    insertCommand.run(commandId, randomUUID(), orphan.created_at);
    hop({ id: orphan.id, commandId, accountId: orphan.account_id, localId: kind === 'RETRIEVE' ? orphan.target_id : null, targetId: kind === 'SEND' ? null : orphan.target_id,
      offerId: null, ordinal: 0, kind, state: stepStateOfAction(orphan), action: orphan, reason: orphan.state === 'FAILED' ? orphan.error : null,
      params: orphan.params_json ? JSON.parse(orphan.params_json) as unknown : null, createdAt: orphan.created_at, updatedAt: orphan.updated_at });
  }
  sqlite.exec("DELETE FROM desired_state WHERE target_kind IN ('transfer','trade.accept','trade.cancel')");
  sqlite.exec('DROP TABLE transfer_batch');
}

/**
 * Migration 29, the store purchase saga (consolidation plan §6 step 4).
 *
 * Each `store_purchase` row becomes the hops of a `STORE_PURCHASE` command under the purchase's
 * command id (one command was always one purchase): the init hop with the frozen terms and the
 * transaction Steam named, an approve hop where the purchase got past the checkout, a finalize hop
 * where one was sent, a cancel hop where one was, each in the state the saga's state and its
 * action imply; the lines go to `store_line` beside the init hop; the wallet reservation is
 * re-keyed to the command id. Every action the saga named is re-pointed at its hop and loses its
 * goal; the goals minted for the saga are deleted; both tables are dropped. An action under one of
 * those goals that no row named gets a hop of its own. Idempotent: the tables are gone once this
 * has run.
 */
function backfillStoreSteps(sqlite: DatabaseSync): void {
  if (!tableExists(sqlite, 'store_purchase')) return;
  type Purchase = {
    id: string; command_id: string; account_id: string; state: string; currency: number; requested_total_cents: number; sheet_version: number;
    txn_id: string | null; init_action_id: string | null; finalize_action_id: string | null; cancel_action_id: string | null; item_ids_json: string;
    resolved_by_obs: number | null; created_at: string; updated_at: string; error: string | null;
  };
  type Line = { purchase_id: string; account_id: string; line_index: number; entry_key: string; def_index: number; quantity: number; unit_price_cents: number; baseline_quantity: number; observed_quantity: number };
  type Act = { id: string; account_id: string; kind: string; target_id: string; state: string; resolved_by_obs: number | null; error: string | null; params_json: string | null; created_at: string; updated_at: string };
  const ACTION_COLUMNS = 'id, account_id, kind, target_id, state, resolved_by_obs, error, params_json, created_at, updated_at';
  const actionOf = (id: string | null): Act | undefined => id ? sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE id=?`).get(id) as Act | undefined : undefined;
  const insertCommand = sqlite.prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed)
    VALUES (?, ?, 'STORE_PURCHASE', 'ADMITTED', NULL, ?, 0, NULL, 0)`);
  const insertStep = sqlite.prepare(`INSERT OR IGNORE INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
    reason, params_json, observation_id, deadline_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  const insertLine = sqlite.prepare(`INSERT OR IGNORE INTO store_line(step_id, account_id, line_index, entry_key, def_index, quantity, unit_price_cents, baseline_quantity, observed_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pointAction = sqlite.prepare('UPDATE action SET step_id=?, desired_id=NULL, desired_version=0 WHERE id=?');
  const hop = (input: { id: string; commandId: string; accountId: string; targetId: string | null; ordinal: number; kind: string; state: string; action?: Act | undefined;
    reason: string | null; params: unknown; observationId?: number | null; createdAt: string; updatedAt: string }): void => {
    insertStep.run(input.id, input.commandId, input.accountId, input.targetId, input.ordinal, input.kind, input.state, input.action?.id ?? null, input.reason,
      JSON.stringify(input.params), input.observationId ?? input.action?.resolved_by_obs ?? null, input.createdAt, input.updatedAt);
    if (input.action) pointAction.run(input.id, input.action.id);
  };
  const purchases = sqlite.prepare('SELECT * FROM store_purchase ORDER BY created_at, id').all() as Purchase[];
  for (const purchase of purchases) {
    const id = purchase.command_id;
    const lines = sqlite.prepare('SELECT * FROM store_purchase_line WHERE purchase_id=? ORDER BY line_index').all(purchase.id) as Line[];
    insertCommand.run(id, randomUUID(), purchase.created_at);
    const hashName = lines.map((line) => line.quantity > 1 ? `${line.entry_key} × ${line.quantity}` : line.entry_key).join(', ');
    const params = { purchaseId: id, currency: purchase.currency, requestedTotalCents: purchase.requested_total_cents, sheetVersion: purchase.sheet_version, hashName };
    const init = actionOf(purchase.init_action_id), finalize = actionOf(purchase.finalize_action_id), cancel = actionOf(purchase.cancel_action_id);
    const ended = purchase.state;
    const initState = ended === 'COMPLETED' ? 'DONE' : ended === 'REJECTED' ? 'FAILED' : ended === 'CANCELLED' ? 'STOPPED'
      : ended === 'ADMITTED' ? 'QUEUED' : ended === 'INITIALISING' ? 'SENT' : ended === 'UNRESOLVED' && !purchase.txn_id ? 'FAILED' : 'AWAITING_OBSERVATION';
    hop({ id: `${id}:STORE_INIT`, commandId: id, accountId: purchase.account_id, targetId: purchase.txn_id, ordinal: 0, kind: 'STORE_INIT', state: initState, action: init,
      reason: initState === 'FAILED' ? purchase.error : initState === 'AWAITING_OBSERVATION' && !purchase.txn_id ? purchase.error : null, params,
      observationId: ['DONE', 'FAILED', 'STOPPED'].includes(initState) ? purchase.resolved_by_obs : null, createdAt: purchase.created_at, updatedAt: purchase.updated_at });
    for (const line of lines) insertLine.run(`${id}:STORE_INIT`, line.account_id, line.line_index, line.entry_key, line.def_index, line.quantity, line.unit_price_cents, line.baseline_quantity, line.observed_quantity);
    const hopParams = { purchaseId: id, txnId: purchase.txn_id, hashName };
    if (purchase.txn_id) {
      const approveState = ended === 'COMPLETED' || ended === 'FINALISING' || finalize ? 'DONE' : ended === 'CANCELLED' ? 'STOPPED'
        : ended === 'AWAITING_APPROVAL' ? (purchase.error ? 'QUEUED' : 'AWAITING_OBSERVATION') : ended === 'CANCELLING' ? 'FAILED' : ended === 'UNRESOLVED' ? 'FAILED' : 'AWAITING_OBSERVATION';
      hop({ id: `${id}:STORE_APPROVE`, commandId: id, accountId: purchase.account_id, targetId: purchase.txn_id, ordinal: 1, kind: 'STORE_APPROVE', state: approveState,
        reason: ['QUEUED', 'FAILED'].includes(approveState) ? purchase.error : null, params: hopParams, createdAt: purchase.created_at, updatedAt: purchase.updated_at });
    }
    if (finalize) {
      const finalizeState = ended === 'COMPLETED' ? 'DONE' : ended === 'CANCELLED' ? 'STOPPED' : ended === 'UNRESOLVED' ? 'FAILED'
        : ended === 'FINALISING' ? stepStateOfAction(finalize) : 'AWAITING_OBSERVATION';
      hop({ id: `${id}:STORE_FINALIZE`, commandId: id, accountId: purchase.account_id, targetId: purchase.txn_id, ordinal: 2, kind: 'STORE_FINALIZE', state: finalizeState, action: finalize,
        reason: finalizeState === 'FAILED' ? purchase.error : finalizeState === 'AWAITING_OBSERVATION' ? purchase.error : null,
        params: { ...hopParams, itemIds: JSON.parse(purchase.item_ids_json || '[]') as unknown },
        observationId: finalizeState === 'DONE' ? purchase.resolved_by_obs : null, createdAt: finalize.created_at, updatedAt: purchase.updated_at });
    }
    if (cancel) {
      const cancelState = ended === 'CANCELLED' ? 'DONE' : ended === 'CANCELLING' ? (stepStateOfAction(cancel) === 'QUEUED' ? 'QUEUED' : 'AWAITING_OBSERVATION') : ended === 'COMPLETED' ? 'STOPPED' : stepStateOfAction(cancel);
      hop({ id: `${id}:STORE_CANCEL`, commandId: id, accountId: purchase.account_id, targetId: purchase.txn_id, ordinal: 3, kind: 'STORE_CANCEL', state: cancelState, action: cancel,
        reason: ['FAILED', 'STOPPED', 'AWAITING_OBSERVATION'].includes(cancelState) ? purchase.error : null, params: hopParams,
        observationId: cancelState === 'DONE' ? purchase.resolved_by_obs : null, createdAt: cancel.created_at, updatedAt: purchase.updated_at });
    }
    // The wallet reservation follows the purchase to the command's id.
    sqlite.prepare(`UPDATE OR IGNORE reservation SET ref_id=? WHERE account_id=? AND ref_kind='STORE_PURCHASE' AND ref_id=?`).run(id, purchase.account_id, purchase.id);
  }
  // An action under one of the saga's goals that no row above named: a hop of its own.
  const orphans = sqlite.prepare(`SELECT ${ACTION_COLUMNS.split(', ').map((column) => `a.${column}`).join(', ')} FROM action a
    JOIN desired_state d ON d.id=a.desired_id WHERE d.target_kind='store-purchase' AND a.step_id IS NULL`).all() as Act[];
  for (const orphan of orphans) {
    const kind = orphan.kind === 'STORE_PURCHASE_INIT' ? 'STORE_INIT' : orphan.kind === 'STORE_PURCHASE_FINALIZE' ? 'STORE_FINALIZE' : 'STORE_CANCEL';
    const commandId = `recovered:${orphan.id}`;
    insertCommand.run(commandId, randomUUID(), orphan.created_at);
    hop({ id: orphan.id, commandId, accountId: orphan.account_id, targetId: null, ordinal: 0, kind, state: stepStateOfAction(orphan), action: orphan,
      reason: orphan.state === 'FAILED' ? orphan.error : null, params: orphan.params_json ? JSON.parse(orphan.params_json) as unknown : null, createdAt: orphan.created_at, updatedAt: orphan.updated_at });
  }
  sqlite.exec("DELETE FROM desired_state WHERE target_kind='store-purchase'");
  sqlite.exec('DROP TABLE store_purchase_line');
  sqlite.exec('DROP TABLE store_purchase');
}

/**
 * Migration 29, the Steam command chains (consolidation plan §6 step 4).
 *
 * Each member of a store, retrieve, list, transfer, reprice or delist-to-store command becomes the
 * hops of its chain under `work_step`, named `<command>:<holding>:<ordinal>` as the engine names
 * them: the action the member pointed at is re-pointed at its hop and loses its goal (D3); the hop
 * before it, where the chain had one, is the earlier action of that kind on the same holding; a hop
 * the chain never reached is queued, or stopped when an earlier hop failed or the member was
 * refused, stopped or sold. A listing member carried by a goal gets the goal's actions as its hops;
 * the goal itself is left as the standing intent it is. A group member expanded into a unit is
 * renamed to the unit's local id, so a member always names a holding. The member's own words are
 * kept and every other word (`SUBMITTED`, `IN_TRANSIT`, a transfer batch's words) becomes
 * `QUEUED`, because what the member is doing is now read from its hops; then the table is rebuilt
 * without `action_id`. Idempotent: the column is gone once this has run.
 */
function backfillCommandSteps(sqlite: DatabaseSync): void {
  const columns = (sqlite.prepare('PRAGMA table_info(command_member)').all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes('action_id')) return;
  type Member = { command_id: string; command_kind: string; account_id: string; member_id: string; stack_key: string | null; state: string; action_id: string | null; price_receive_cents: number | null };
  type Act = { id: string; account_id: string; kind: string; target_id: string; state: string; resolution: string | null; resolved_by_obs: number | null; error: string | null; created_at: string; updated_at: string };
  const ACTION_COLUMNS = 'id, account_id, kind, target_id, state, resolution, resolved_by_obs, error, created_at, updated_at';
  const actionOf = (id: string | null): Act | undefined => id ? sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE id=?`).get(id) as Act | undefined : undefined;
  const earlier = (accountId: string, kind: string, targetId: string, before: string): Act | undefined =>
    sqlite.prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE account_id=? AND kind=? AND target_id=? AND created_at<=? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(accountId, kind, targetId, before) as Act | undefined;
  const insertStep = sqlite.prepare(`INSERT OR IGNORE INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
    reason, params_json, observation_id, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  const pointAction = sqlite.prepare('UPDATE action SET step_id=?, desired_id=NULL, desired_version=0 WHERE id=?');
  const renameMember = sqlite.prepare('UPDATE OR IGNORE command_member SET member_id=? WHERE command_id=? AND account_id=? AND member_id=?');
  const members = sqlite.prepare(`SELECT m.command_id, c.kind AS command_kind, m.account_id, m.member_id, m.stack_key, m.state, m.action_id, m.price_receive_cents
    FROM command_member m JOIN command c ON c.id=m.command_id
    WHERE c.kind IN ('STORE', 'RETRIEVE', 'LIST', 'TRANSFER', 'REPRICE', 'DELIST_TO_STORE') ORDER BY m.rowid`).all() as Member[];
  for (const member of members) {
    const action = actionOf(member.action_id);
    // A LIST member for an individual item pointed at nothing: its listing was a goal, and the
    // goal's actions (a retrieve, then the listing) are its hops.
    const goalActions = member.command_kind === 'LIST' && !action && !member.stack_key
      ? sqlite.prepare(`SELECT ${ACTION_COLUMNS.split(', ').map((column) => `a.${column}`).join(', ')} FROM action a JOIN desired_state d ON d.id=a.desired_id
          WHERE d.account_id=? AND d.target_kind='sell-listing' AND d.target_id=? AND d.intent='LISTED_AT'
            AND json_extract(d.params_json,'$.priceReceiveCents') IS ? ORDER BY a.created_at, a.rowid`).all(member.account_id, member.member_id, member.price_receive_cents) as Act[]
      : [];
    const localId = action?.target_id ?? member.member_id;
    const chain: Array<{ kind: string; action?: Act | undefined; params: unknown }> = [];
    const kind = member.command_kind;
    if (kind === 'STORE') chain.push({ kind: 'STORE', action, params: {} });
    else if (kind === 'RETRIEVE') chain.push({ kind: 'RETRIEVE', action, params: {} });
    else if (kind === 'TRANSFER') {
      const store = action?.kind === 'STORE_IN_CASKET' ? action : undefined;
      const retrieve = store ? earlier(member.account_id, 'RETRIEVE_FROM_CASKET', localId, store.created_at) : action?.kind === 'RETRIEVE_FROM_CASKET' ? action : undefined;
      chain.push({ kind: 'RETRIEVE', action: retrieve, params: {} }, { kind: 'STORE', action: store, params: {} });
    } else if (kind === 'REPRICE' || kind === 'DELIST_TO_STORE') {
      const secondKind = kind === 'REPRICE' ? 'CREATE_SELL_LISTING' : 'STORE_IN_CASKET';
      const second = action?.kind === secondKind ? action : undefined;
      const delist = second ? earlier(member.account_id, 'REMOVE_SELL_LISTING', localId, second.created_at) : action?.kind === 'REMOVE_SELL_LISTING' ? action : undefined;
      chain.push({ kind: 'DELIST', action: delist, params: {} },
        { kind: kind === 'REPRICE' ? 'LIST' : 'STORE', action: second, params: kind === 'REPRICE' ? { priceReceiveCents: member.price_receive_cents } : {} });
    } else {
      // LIST: a group unit's own listing action, or an individual item's goal-carried hops.
      const listing = action ?? goalActions.filter((candidate) => candidate.kind === 'CREATE_SELL_LISTING').at(-1);
      const retrieve = goalActions.filter((candidate) => candidate.kind === 'RETRIEVE_FROM_CASKET').at(-1);
      if (retrieve) chain.push({ kind: 'RETRIEVE', action: retrieve, params: { forListing: true } });
      chain.push({ kind: 'LIST', action: listing, params: { priceReceiveCents: member.price_receive_cents } });
    }
    if (member.state === 'PREPARED' || (member.state === 'REJECTED' && chain.every((hop) => !hop.action))) continue;
    if (localId !== member.member_id) renameMember.run(localId, member.command_id, member.account_id, member.member_id);
    const now = chain.find((hop) => hop.action)?.action?.created_at ?? (sqlite.prepare('SELECT created_at FROM command WHERE id=?').get(member.command_id) as { created_at: string }).created_at;
    let blocked: string | null = member.state === 'REJECTED' ? HOP_NOT_REACHED_29 : member.state === 'STOPPED' ? 'command-stopped' : member.state === 'SOLD' ? 'Sold before the chain reached it' : null;
    chain.forEach((hop, ordinal) => {
      const id = `${member.command_id}:${localId}:${ordinal}`;
      const state = hop.action ? stepStateOfAction(hop.action) : blocked ? 'STOPPED' : 'QUEUED';
      const reason = hop.action ? (state === 'FAILED' ? hop.action.error : null) : blocked;
      const observationId = hop.action && (state === 'DONE' || state === 'FAILED') ? hop.action.resolved_by_obs : null;
      insertStep.run(id, member.command_id, member.account_id, localId, ordinal, hop.kind, state, hop.action?.id ?? null, reason, JSON.stringify(hop.params), observationId,
        hop.action?.created_at ?? now, hop.action?.updated_at ?? now);
      if (hop.action) pointAction.run(id, hop.action.id);
      if (state === 'FAILED') blocked = HOP_NOT_REACHED_29;
    });
  }
  sqlite.exec(`UPDATE command_member SET state='QUEUED' WHERE state NOT IN ('DRAFT', 'PREPARED', 'QUEUED', 'REJECTED', 'STOPPED', 'SOLD')`);
  rebuildTable(sqlite, 'command_member', COMMAND_MEMBER_29, 'CHECK(state IN',
    ['command_id', 'account_id', ['local_id', 'member_id'], 'stack_key', 'quantity', 'destination', 'price_receive_cents', 'state', 'input_json']);
}

/**
 * Migration 29, selections (consolidation plan §4.4). Each `selection_manifest` row becomes a
 * command in `DRAFT` under its token, kind `SELECTION`, keeping its revision and filter; the
 * members of its latest revision become `DRAFT` members with the frozen input the capture wrote.
 * A capture still writing when the record was last closed is `preparing`, and the next open
 * rejects it as an interrupted preparation; a released one is `STOPPED`. Both tables are dropped.
 * Idempotent: the tables are gone once this has run.
 */
function backfillDrafts(sqlite: DatabaseSync): void {
  if (!tableExists(sqlite, 'selection_manifest')) return;
  type Manifest = { token: string; revision: number; state: string; account_ids_json: string; filter_json: string; created_at: string };
  type Member = { account_id: string; member_id: string; stack_key: string | null; location: string | null; casket_id: string | null; quantity: number };
  const insertCommand = sqlite.prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed, revision, filter_json)
    VALUES (?, ?, 'SELECTION', ?, ?, ?, ?, NULL, 0, ?, ?)`);
  const insertMember = sqlite.prepare(`INSERT OR IGNORE INTO command_member(command_id, account_id, local_id, stack_key, quantity, destination, price_receive_cents, state, input_json)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, 'DRAFT', ?)`);
  for (const manifest of sqlite.prepare('SELECT * FROM selection_manifest ORDER BY created_at, token').all() as Manifest[]) {
    const released = manifest.state === 'RELEASED';
    let accountIds: unknown = [];
    let filter: unknown = {};
    try { accountIds = JSON.parse(manifest.account_ids_json); } catch { /* an unreadable list is an empty one */ }
    try { filter = JSON.parse(manifest.filter_json); } catch { /* an unreadable filter is no filter */ }
    insertCommand.run(manifest.token, randomUUID(), released ? 'STOPPED' : 'DRAFT', released ? 'Selection released' : null, manifest.created_at,
      manifest.state === 'DRAFT' ? 1 : 0, manifest.revision, JSON.stringify({ accountIds, filter }));
    const members = sqlite.prepare('SELECT * FROM selection_member WHERE token=? AND revision=? ORDER BY account_id, member_id').all(manifest.token, manifest.revision) as Member[];
    for (const member of members) {
      const input = { accountId: member.account_id, ...(member.stack_key ? { stackKey: member.stack_key } : { localId: member.member_id }),
        quantity: member.quantity, location: member.location, casketId: member.casket_id };
      insertMember.run(manifest.token, member.account_id, member.member_id, member.stack_key, member.quantity, JSON.stringify(input));
    }
  }
  sqlite.exec('DROP TABLE selection_member');
  sqlite.exec('DROP TABLE selection_manifest');
}

/**
 * Migration 29, the work asked for by hand (consolidation plan §4.4): a delist, a buy order placed,
 * a buy order cancelled. Each was a bare action with a goal minted to carry it; each becomes a
 * command of one hop under the action's own id, which is the id the work panel always showed for
 * it, its action re-pointed at the hop (D3). The goal rows stay as the standing intents they are.
 * Idempotent: an action already pointing at a step is left alone.
 */
function backfillBareSteps(sqlite: DatabaseSync): void {
  type Act = { id: string; account_id: string; kind: string; target_id: string; state: string; resolution: string | null; resolved_by_obs: number | null; error: string | null; params_json: string | null; created_at: string; updated_at: string };
  const actions = sqlite.prepare(`SELECT id, account_id, kind, target_id, state, resolution, resolved_by_obs, error, params_json, created_at, updated_at FROM action
    WHERE step_id IS NULL AND kind IN ('REMOVE_SELL_LISTING', 'CREATE_BUY_ORDER', 'CANCEL_BUY_ORDER') ORDER BY created_at, rowid`).all() as Act[];
  const insertCommand = sqlite.prepare(`INSERT OR IGNORE INTO command(id, correlation_id, kind, state, reject_reason, created_at, preparing, manifest_token, observed_completed)
    VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, 0)`);
  const insertStep = sqlite.prepare(`INSERT OR IGNORE INTO work_step(id, command_id, account_id, local_id, target_id, offer_id, ordinal, kind, state, action_id, desired_id,
    reason, params_json, observation_id, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  const pointAction = sqlite.prepare('UPDATE action SET step_id=?, desired_id=NULL, desired_version=0 WHERE id=?');
  // The listing table is still there at this point of the migration (Stage 2 folds it); a fresh record never had it, and has no bare action either.
  const listingOf = tableExists(sqlite, 'market_listing') ? sqlite.prepare('SELECT local_id FROM market_listing WHERE account_id=? AND listing_id=?') : undefined;
  for (const action of actions) {
    let params: Record<string, unknown> = {};
    try { params = (JSON.parse(action.params_json ?? '{}') ?? {}) as Record<string, unknown>; } catch { /* an unreadable request is an empty one */ }
    const kind = action.kind === 'REMOVE_SELL_LISTING' ? 'DELIST' : action.kind === 'CREATE_BUY_ORDER' ? 'BUY_ORDER_CREATE' : 'BUY_ORDER_CANCEL';
    const listingId = typeof params.listingId === 'string' ? params.listingId : null;
    const targetId = kind === 'DELIST' ? listingId : action.target_id;
    const localId = kind === 'DELIST' && listingId ? (listingOf?.get(action.account_id, listingId) as { local_id: string | null } | undefined)?.local_id ?? null : null;
    const state = action.state === 'READY' && action.resolution === 'OBSERVED_NOT_APPLIED' ? 'RETRYING' : stepStateOfAction(action);
    insertCommand.run(action.id, randomUUID(), kind, state === 'DONE' ? 'COMPLETE' : state === 'FAILED' ? 'PARTIAL' : 'ADMITTED', action.created_at);
    insertStep.run(`${action.id}:0`, action.id, action.account_id, localId, targetId, kind, state, action.id, state === 'FAILED' ? action.error : null,
      JSON.stringify(kind === 'BUY_ORDER_CREATE' ? { ...params, hashName: action.target_id } : params),
      state === 'DONE' || state === 'FAILED' ? action.resolved_by_obs : null, action.created_at, action.updated_at);
    pointAction.run(`${action.id}:0`, action.id);
  }
}

/** `HOP_NOT_REACHED` as this migration wrote it, frozen so the record never changes under a later wording. */
const HOP_NOT_REACHED_29 = 'An earlier hop failed';

/**
 * The Steam listing table folded into the order parent (consolidation plan D4, §4.3).
 *
 * The parent is rebuilt to its Stage 2 shape: the asset id a column instead of a JSON field, the
 * price under the one name both sides use, `first_open_obs` renamed to what every mirror row calls
 * it, `gone_obs` for the walk that first failed to show the order, and the provenance columns
 * gone (an order is ours when an attempt of ours created it, `action_id`). Then each listing row
 * finds its parent by Steam's listing id, which every adopted listing already carried, and gives it
 * the walk's evidence the parent never kept; a listing with no parent (one that ended before the
 * order record existed) becomes a parent under its listing id, open if the last walk showed it and
 * `UNEXPLAINED` if not, because nothing in the record says why it ended (D7 is the exit). The
 * satellite takes the buyer price and the bucket. The listing table and its revision rows go.
 */
function foldSteamListings(sqlite: DatabaseSync): void {
  rebuildTable(sqlite, 'venue_order', VENUE_ORDER_29, 'gone_obs', [
    'account_id', 'order_id', ['venue', "CASE WHEN venue IN ('steam', 'csfloat') THEN venue ELSE 'steam' END"], 'side', 'local_id',
    ['asset_id', "json_extract(venue_detail_json, '$.assetId')"], 'hash_name', 'venue_order_id',
    ['price_cents', 'price_receive_cents'], 'state', 'confidence', 'transactable_after', 'opened_at',
    ['first_seen_obs', 'first_open_obs'], 'last_seen_obs', 'ended_at', 'end_reason', 'end_evidence', 'action_id'
  ]);
  sqlite.exec(STEAM_ORDER_29);
  if (!tableExists(sqlite, 'market_listing')) return;
  const bucketState: Record<string, string> = { ACTIVE: 'OPEN', ON_HOLD: 'OPEN_UNTRANSACTABLE', PENDING_CONFIRMATION: 'PENDING_EXTERNAL' };
  const parentOf = sqlite.prepare("SELECT order_id FROM venue_order WHERE account_id=? AND venue='steam' AND venue_order_id=?");
  const adoptColumns = `asset_id=COALESCE(asset_id, ?), hash_name=COALESCE(hash_name, ?), price_cents=COALESCE(price_cents, ?),
      local_id=COALESCE(local_id, ?), first_seen_obs=COALESCE(first_seen_obs, ?), transactable_after=COALESCE(transactable_after, ?)`;
  const adoptOpen = sqlite.prepare(`UPDATE venue_order SET ${adoptColumns}, last_seen_obs=?, gone_obs=NULL WHERE account_id=? AND order_id=?`);
  // A gone listing's parent kept the last walk that showed it; the listing row's last walk is the one that did not.
  const adoptGone = sqlite.prepare(`UPDATE venue_order SET ${adoptColumns}, last_seen_obs=COALESCE(last_seen_obs, ?), gone_obs=? WHERE account_id=? AND order_id=?`);
  const insert = sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, local_id, asset_id, hash_name, venue_order_id, price_cents,
      state, confidence, transactable_after, opened_at, first_seen_obs, last_seen_obs, gone_obs, end_reason)
    VALUES (?, ?, 'steam', 'SELL', ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT finished_at FROM observation WHERE id=?), ''), ?, ?, ?, ?)`);
  const satellite = sqlite.prepare('INSERT OR IGNORE INTO steam_order(account_id, order_id, buyer_price_cents, raw_bucket) VALUES (?, ?, ?, ?)');
  const listings = sqlite.prepare('SELECT * FROM market_listing ORDER BY account_id, listing_id').all() as Array<{
    account_id: string; listing_id: string; local_id: string | null; asset_id: string; hash_name: string; price_receive_cents: number;
    buyer_price_cents: number; status: string; hold_until: string | null; first_seen_obs: number; last_seen_obs: number;
  }>;
  for (const listing of listings) {
    const gone = listing.status === 'ABSENT';
    const parent = parentOf.get(listing.account_id, listing.listing_id) as { order_id: string } | undefined;
    const orderId = parent?.order_id ?? listing.listing_id;
    if (parent) {
      const evidence = [listing.asset_id, listing.hash_name, listing.price_receive_cents, listing.local_id, listing.first_seen_obs, listing.hold_until];
      if (gone) adoptGone.run(...evidence, listing.first_seen_obs, listing.last_seen_obs, listing.account_id, orderId);
      else adoptOpen.run(...evidence, listing.last_seen_obs, listing.account_id, orderId);
    } else {
      insert.run(listing.account_id, orderId, listing.local_id, listing.asset_id, listing.hash_name, listing.listing_id, listing.price_receive_cents,
        gone ? 'UNEXPLAINED' : bucketState[listing.status] ?? 'QUARANTINED', gone ? 'unknown' : 'proven', listing.hold_until,
        listing.first_seen_obs, listing.first_seen_obs, gone ? listing.first_seen_obs : listing.last_seen_obs, gone ? listing.last_seen_obs : null,
        gone ? 'Listing ended before the order record was kept' : null);
    }
    satellite.run(listing.account_id, orderId, listing.buyer_price_cents, gone ? null : bucketState[listing.status] ? listing.status : null);
  }
  sqlite.exec('DROP TABLE market_listing');
  if (tableExists(sqlite, 'read_revision')) sqlite.exec("DELETE FROM read_revision WHERE surface='market_listing'");
}

/**
 * The Steam buy-order table folded into the order parent (consolidation plan D4, §4.3): one BUY
 * row per order under Steam's id, its count so far as `filled`, open while the last walk showed
 * it active, else ended on what the counts say: filled when every unit was bought, cancelled by us
 * when a cancel of ours names it, else cancelled at the venue, provisionally. Reservations keep
 * naming the order by Steam's id, which is the order id here.
 */
function foldSteamBuyOrders(sqlite: DatabaseSync): void {
  if (!tableExists(sqlite, 'buy_order')) return;
  const rows = sqlite.prepare('SELECT * FROM buy_order ORDER BY account_id, buy_order_id').all() as Array<{
    account_id: string; buy_order_id: string; hash_name: string; price_cents: number; quantity: number; purchased: number; active: number;
    first_seen_obs: number; last_seen_obs: number;
  }>;
  const cancelled = sqlite.prepare(`SELECT 1 FROM action a JOIN attempt t ON t.action_id=a.id
    WHERE a.account_id=? AND a.kind='CANCEL_BUY_ORDER' AND json_extract(a.params_json,'$.buyOrderId')=? LIMIT 1`);
  const exists = sqlite.prepare("SELECT 1 FROM venue_order WHERE account_id=? AND venue='steam' AND venue_order_id=?");
  const insert = sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, hash_name, venue_order_id, price_cents, quantity, filled,
      state, confidence, opened_at, first_seen_obs, last_seen_obs, end_reason)
    VALUES (?, ?, 'steam', 'BUY', ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT finished_at FROM observation WHERE id=?), ''), ?, ?, ?)`);
  for (const row of rows) {
    if (exists.get(row.account_id, row.buy_order_id)) continue;
    const ended = row.active === 0;
    const filled = row.purchased >= row.quantity;
    const ours = ended && !filled && cancelled.get(row.account_id, row.buy_order_id);
    const state = !ended ? 'OPEN' : filled ? 'ENDED_FILLED' : ours ? 'ENDED_CANCELLED_BY_US' : 'ENDED_CANCELLED_EXTERNALLY';
    const confidence = !ended || filled || ours ? 'proven' : 'probable';
    const reason = !ended ? null : filled ? 'The book reports every unit bought' : ours ? 'Gone from the book after a cancel of ours'
      : 'Gone from the book with units left to buy; cancellation is provisional';
    insert.run(row.account_id, row.buy_order_id, row.hash_name, row.buy_order_id, row.price_cents, row.quantity, row.purchased,
      state, confidence, row.first_seen_obs, row.first_seen_obs, row.last_seen_obs, reason);
  }
  sqlite.exec('DROP TABLE buy_order');
}

/**
 * The three CSFloat tables folded into the order parent with `csfloat_order` beside each row
 * (consolidation plan D4, §4.3). Every advertisement (`csfloat_contract`) becomes a SELL row
 * under its listing id, its state from the venue's word and its binding as recorded; the stall
 * mirror (`csfloat_listing`) says which are on the book and when they were first and last shown.
 * Every buy order becomes a BUY row under its id, open, because the mirror held only what the
 * last complete walk showed. The venue's bodies move to the satellite.
 */
function foldCsfloatOrders(sqlite: DatabaseSync): void {
  sqlite.exec(CSFLOAT_ORDER_29);
  const ours = sqlite.prepare(`SELECT 1 FROM work_step WHERE account_id=? AND kind=? AND target_id=? AND action_id IS NOT NULL LIMIT 1`);
  const exists = sqlite.prepare("SELECT 1 FROM venue_order WHERE account_id=? AND venue='csfloat' AND venue_order_id=?");
  if (tableExists(sqlite, 'csfloat_contract')) {
    const mirror = tableExists(sqlite, 'csfloat_listing')
      ? sqlite.prepare('SELECT created_at, first_seen_obs, last_seen_obs FROM csfloat_listing WHERE account_id=? AND listing_id=?') : undefined;
    const insert = sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, local_id, asset_id, hash_name, venue_order_id, price_cents, currency,
        state, confidence, opened_at, first_seen_obs, last_seen_obs, ended_at, end_reason, end_evidence)
      VALUES (?, ?, 'csfloat', 'SELL', ?, ?, ?, ?, ?, 1, ?, ?, COALESCE(NULLIF(?, ''), (SELECT finished_at FROM observation WHERE id=?), ''), ?, ?, ?, ?, ?)`);
    const satellite = sqlite.prepare(`INSERT OR IGNORE INTO csfloat_order(account_id, order_id, type, state_word, item_json, created_at, observation_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const contracts = sqlite.prepare('SELECT * FROM csfloat_contract ORDER BY account_id, listing_id').all() as Array<{
      account_id: string; listing_id: string; asset_id: string; local_id: string | null; state: string; price_cents: number; item_json: string; type: string; observation_id: number;
    }>;
    for (const contract of contracts) {
      if (exists.get(contract.account_id, contract.listing_id)) continue;
      let item: { marketHashName?: string } = {};
      try { item = JSON.parse(contract.item_json) as { marketHashName?: string }; } catch { /* an unreadable body names nothing */ }
      const shown = mirror?.get(contract.account_id, contract.listing_id) as { created_at: string | null; first_seen_obs: number; last_seen_obs: number } | undefined;
      const word = contract.state;
      const state = word === 'listed' ? 'OPEN' : word === 'sold' ? 'ENDED_FILLED' : word === 'refunded' ? 'ENDED_VOIDED_BY_VENUE'
        : word === 'delisted' || word === 'cancelled'
          ? (ours.get(contract.account_id, 'CSFLOAT_CANCEL', contract.listing_id) ? 'ENDED_CANCELLED_BY_US' : 'ENDED_CANCELLED_EXTERNALLY')
          : 'UNEXPLAINED';
      const ended = state.startsWith('ENDED_');
      const endedAt = ended ? (sqlite.prepare('SELECT finished_at FROM observation WHERE id=?').get(contract.observation_id) as { finished_at: string } | undefined)?.finished_at ?? null : null;
      insert.run(contract.account_id, contract.listing_id, contract.local_id, contract.asset_id, item.marketHashName ?? '', contract.listing_id, contract.price_cents,
        state, state === 'UNEXPLAINED' ? 'unknown' : 'proven', shown?.created_at ?? '', contract.observation_id,
        shown?.first_seen_obs ?? null, shown?.last_seen_obs ?? null, endedAt, ended ? `CSFloat reports the listing ${word}` : null, ended ? contract.observation_id : null);
      satellite.run(contract.account_id, contract.listing_id, contract.type, word, contract.item_json, shown?.created_at ?? null, contract.observation_id);
    }
    sqlite.exec('DROP TABLE csfloat_contract');
  }
  if (tableExists(sqlite, 'csfloat_listing')) sqlite.exec('DROP TABLE csfloat_listing');
  if (tableExists(sqlite, 'csfloat_buy_order')) {
    const insert = sqlite.prepare(`INSERT INTO venue_order(account_id, order_id, venue, side, hash_name, venue_order_id, price_cents, currency, quantity, filled,
        state, confidence, opened_at, first_seen_obs, last_seen_obs)
      VALUES (?, ?, 'csfloat', 'BUY', ?, ?, ?, 1, ?, ?, 'OPEN', 'proven', COALESCE(NULLIF(?, ''), (SELECT finished_at FROM observation WHERE id=?), ''), ?, ?)`);
    const satellite = sqlite.prepare('INSERT OR IGNORE INTO csfloat_order(account_id, order_id, properties_json, created_at) VALUES (?, ?, ?, ?)');
    const orders = sqlite.prepare('SELECT * FROM csfloat_buy_order ORDER BY account_id, order_id').all() as Array<{
      account_id: string; order_id: string; hash_name: string; price_cents: number; quantity: number; bought: number | null; properties_json: string | null;
      created_at: string | null; first_seen_obs: number; last_seen_obs: number;
    }>;
    for (const order of orders) {
      if (exists.get(order.account_id, order.order_id)) continue;
      insert.run(order.account_id, order.order_id, order.hash_name, order.order_id, order.price_cents, order.quantity, order.bought,
        order.created_at ?? '', order.first_seen_obs, order.first_seen_obs, order.last_seen_obs);
      satellite.run(order.account_id, order.order_id, order.properties_json, order.created_at);
    }
    sqlite.exec('DROP TABLE csfloat_buy_order');
  }
  if (tableExists(sqlite, 'read_revision')) sqlite.exec("DELETE FROM read_revision WHERE surface='csfloat_listing'");
}

/**
 * The two per-source asset mirrors become `asset_evidence`, one row per source (D11). Neither
 * mirror recorded when an asset first appeared, so the one observation each row held is both its
 * first and its last sighting; the counts are asserted by source before the mirrors go.
 */
function foldAssetEvidence(sqlite: DatabaseSync): void {
  const count = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;
  const fold = (table: string, source: string, insert: string): void => {
    if (!tableExists(sqlite, table)) return;
    sqlite.exec(insert);
    const folded = count(`SELECT COUNT(*) AS n FROM asset_evidence WHERE source='${source}'`), had = count(`SELECT COUNT(*) AS n FROM ${table}`);
    if (folded !== had) throw new Error(`Migration 29: ${folded} ${source} evidence rows for ${had} rows of ${table}`);
    sqlite.exec(`DROP TABLE ${table}`);
  };
  fold('trade_inventory_item', 'community', `INSERT INTO asset_evidence(account_id, asset_id, source, tradable, marketable, quantity, name, class_id, instance_id, first_seen_obs, last_seen_obs)
    SELECT account_id, asset_id, 'community', tradable, marketable, quantity, name, class_id, instance_id, observation_id, observation_id FROM trade_inventory_item`);
  fold('csfloat_inventory', 'csfloat', `INSERT INTO asset_evidence(account_id, asset_id, source, eligible, detail_json, first_seen_obs, last_seen_obs)
    SELECT account_id, asset_id, 'csfloat',
      CASE WHEN json_extract(item_json, '$.tradable') IS NULL THEN NULL WHEN json_extract(item_json, '$.tradable')=1 THEN 1 ELSE 0 END,
      item_json, observation_id, observation_id FROM csfloat_inventory`);
}

/**
 * The record's own bookkeeping becomes `surface_state` (D9): a walk's committed coverage from
 * `observation_checkpoint`, and each paged surface's revision from `read_revision`, which the
 * stores count from here on. The triggers that counted it go first, because they name a table
 * that is about to go, and the counts are asserted before each table does.
 */
/** The surfaces the stores count on `surface_state` as migration 29 ships (`tests/unit/revision-sites.test.ts`). */
const COUNTED_SURFACES_29 = "('work', 'item', 'storage_unit', 'market_history', 'venue_order', 'event', 'command_member', 'trade_offer', 'executed_trade', 'economic_event', 'marketplace')";

function foldSurfaceState(sqlite: DatabaseSync): void {
  const count = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%read_revision%'").all() as Array<{ name: string }>) {
    sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  if (tableExists(sqlite, 'observation_checkpoint')) {
    sqlite.exec(`INSERT INTO surface_state(account_id, surface, scope_id, cursor_json, covered_through, observation_id, updated_at)
      SELECT account_id, surface, scope_id, cursor_json, covered_through, observation_id, updated_at FROM observation_checkpoint`);
    const folded = count('SELECT COUNT(*) AS n FROM surface_state WHERE cursor_json IS NOT NULL'), had = count('SELECT COUNT(*) AS n FROM observation_checkpoint');
    if (folded !== had) throw new Error(`Migration 29: ${folded} coverage rows for ${had} checkpoints`);
    sqlite.exec('DROP TABLE observation_checkpoint');
  }
  if (tableExists(sqlite, 'read_revision')) {
    // A counter for a table that is gone carries nothing: only the surfaces the stores count now.
    sqlite.exec(`INSERT INTO surface_state(account_id, surface, scope_id, revision) SELECT account_id, surface, '', revision FROM read_revision
      WHERE revision>0 AND surface IN ${COUNTED_SURFACES_29} ON CONFLICT(account_id, surface, scope_id) DO UPDATE SET revision=excluded.revision`);
    const folded = count('SELECT COUNT(*) AS n FROM surface_state WHERE revision>0'), had = count(`SELECT COUNT(*) AS n FROM read_revision WHERE revision>0 AND surface IN ${COUNTED_SURFACES_29}`);
    if (folded !== had) throw new Error(`Migration 29: ${folded} revision rows for ${had} counters`);
    sqlite.exec('DROP TABLE read_revision');
  }
}

/** A SteamID64 from a column that may hold Steam's 32-bit account id instead (D14). */
function steamId64Sql(column: string): string {
  return `CASE WHEN ${column} GLOB '[1-9]*' AND NOT ${column} GLOB '*[^0-9]*' AND length(${column}) <= 10 THEN CAST(CAST(${column} AS INTEGER) + 76561197960265728 AS TEXT) ELSE ${column} END`;
}

function columnExists(sqlite: DatabaseSync, table: string, column: string): boolean {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function tableExists(sqlite: DatabaseSync, table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * Rebuilds a table to a frozen shape, keeping every row and copying each column by name or from
 * an expression over the old row (`[column, expression]`): the only way SQLite changes a CHECK, a
 * NOT NULL or a column's place. Idempotent on `marker`, a fragment only the new shape's
 * declaration contains, or `null` when the caller decides by another test, as the `item` rebuild
 * does by its column. Runs with foreign keys off (`Migration.foreignKeysOff`), because the DROP
 * would otherwise cascade into, or be refused by, the tables that reference this one; the
 * references they hold by name survive the rename. Indexes come back with `applySchema`.
 */
function rebuildTable(sqlite: DatabaseSync, table: string, createSql: string, marker: string | null, columns: ReadonlyArray<string | readonly [string, string]>): void {
  const current = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined)?.sql;
  if (!current || (marker !== null && current.includes(marker))) return;
  const scratch = `${table}_v29`;
  sqlite.exec(`DROP TABLE IF EXISTS ${scratch}`);
  sqlite.exec(createSql.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${scratch} (`));
  const targets = columns.map((column) => (typeof column === 'string' ? column : column[0])).join(', ');
  const sources = columns.map((column) => (typeof column === 'string' ? column : column[1])).join(', ');
  sqlite.exec(`INSERT INTO ${scratch}(${targets}) SELECT ${sources} FROM ${table}`);
  sqlite.exec(`DROP TABLE ${table}`);
  sqlite.exec(`ALTER TABLE ${scratch} RENAME TO ${table}`);
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
