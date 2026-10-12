/**
 * The declared current shape of the trading database.
 *
 * Every statement is `IF NOT EXISTS`, so this runs against a fresh database and an existing one
 * alike. Adding a table or an index means editing this file and bumping `SCHEMA_VERSION`; adding a
 * column to an existing table means that *and* appending a migration, because SQLite cannot add a
 * column through `CREATE TABLE IF NOT EXISTS`. `migrations.ts` has the rules, `DATA-INDEX.md` the
 * table-by-table map, and `fixtures/schema/current.txt` the shape this produces.
 *
 * Columns that a migration adds are declared at the **end** of their table, in the order the
 * `ALTER` statements add them, so that a freshly created database and a migrated one have their
 * columns in the same positions. `tests/unit/migrations.test.ts` fails if they diverge.
 */
export const SCHEMA_VERSION = 28;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  steam_id64 TEXT NOT NULL,
  account_name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  -- Last on purpose: ALTER TABLE ADD COLUMN appends, and the fresh-create path
  -- and the upgrade path have to converge column for column (migrations.test.ts).
  -- No REFERENCES observation(id): account is created before observation.
  persona_name TEXT,
  avatar_hash TEXT,
  persona_obs INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS account_name_unique ON account(account_name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS account_steam_id64_unique ON account(steam_id64);

CREATE TABLE IF NOT EXISTS credential_ref (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  PRIMARY KEY(account_id, kind)
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  generation INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
  pages_walked INTEGER NOT NULL DEFAULT 0,
  total_expected INTEGER,
  error TEXT,
  scope_kind TEXT,
  scope_id TEXT
);
CREATE INDEX IF NOT EXISTS observation_account_surface ON observation(account_id, surface, id DESC);

-- An item's location is where the Game Coordinator holds it. A listing is not a place: the GC
-- keeps a listed item in the inventory, so a listed unit is MAIN and "listed" is an open
-- market_listing row (db/steam-listing.ts). MARKET stays in the CHECK only because SQLite cannot
-- drop it without rebuilding the table; nothing writes it since migration 28.
CREATE TABLE IF NOT EXISTS item (
  local_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  def_index INTEGER NOT NULL,
  paint_index INTEGER,
  paint_wear REAL,
  paint_seed INTEGER,
  quality INTEGER NOT NULL,
  stable_key TEXT NOT NULL,
  current_asset_id TEXT,
  location TEXT NOT NULL CHECK(location IN ('MAIN', 'CASKET', 'MARKET', 'MISSING')),
  casket_id TEXT,
  tradable_after TEXT,
  trade_protected_until TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  location_obs INTEGER REFERENCES observation(id),
  location_generation INTEGER,
  row_generation INTEGER NOT NULL DEFAULT 0,
  -- Appended by migrations, in ALTER order: the fresh-create path and the upgrade path have to
  -- converge column for column (migrations.test.ts). kit is the catalogue key's fourth field;
  -- the six after it are the holdings plan (D2-D8): one row per unit, of either kind.
  kit TEXT NOT NULL DEFAULT '',
  unit_kind TEXT NOT NULL DEFAULT 'individual',
  group_key TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  reserved_command TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS item_account_location ON item(account_id, location, local_id);
CREATE INDEX IF NOT EXISTS item_account_local_id ON item(account_id, local_id);
CREATE INDEX IF NOT EXISTS item_account_generation ON item(account_id, row_generation, location);
CREATE UNIQUE INDEX IF NOT EXISTS item_current_asset ON item(account_id, current_asset_id) WHERE current_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS item_stable_lookup ON item(account_id, stable_key, location);
-- Allocation takes N unreserved units of one group at one location; the group page lists them.
CREATE INDEX IF NOT EXISTS item_group ON item(account_id, group_key, location, reserved_command);
CREATE INDEX IF NOT EXISTS item_unit_kind ON item(account_id, unit_kind, location);

-- Which holding became which: a trade receipt names the new asset id; a fingerprint (the float
-- tuple) only suggests. Only a receipt may ever carry an intent across (holdings plan D5).
CREATE TABLE IF NOT EXISTS item_lineage (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  from_local_id TEXT NOT NULL,
  to_local_id TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(evidence IN ('trade-receipt', 'fingerprint')),
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, from_local_id, to_local_id)
);
CREATE INDEX IF NOT EXISTS item_lineage_to ON item_lineage(account_id, to_local_id);

-- What an owner applied to a carrier, one row per slot, derived from the row's attributes on
-- every walk (holdings plan D6). A patch on an agent is a sticker slot; the host names the kit.
CREATE TABLE IF NOT EXISTS item_accessory (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('sticker-slot', 'charm-slot')),
  slot INTEGER NOT NULL,
  kit_id INTEGER NOT NULL,
  wear REAL,
  scale REAL,
  rotation REAL,
  pattern INTEGER,
  highlight INTEGER,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, local_id, kind, slot)
);
CREATE INDEX IF NOT EXISTS item_accessory_kit ON item_accessory(account_id, kind, kit_id);

CREATE TABLE IF NOT EXISTS storage_unit (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  casket_id TEXT NOT NULL,
  label TEXT,
  contains_count INTEGER NOT NULL,
  contents_obs INTEGER REFERENCES observation(id),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'FULL', 'DISABLED')),
  -- Last on purpose: ALTER TABLE ADD COLUMN appends, and the fresh-create path
  -- and the upgrade path have to converge column for column (migrations.test.ts).
  -- A label is only as good as the observation that wrote it (rename plan §3).
  label_obs INTEGER REFERENCES observation(id),
  PRIMARY KEY(account_id, casket_id)
);

CREATE TABLE IF NOT EXISTS market_listing (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,
  local_id TEXT REFERENCES item(local_id),
  asset_id TEXT NOT NULL,
  hash_name TEXT NOT NULL,
  price_receive_cents INTEGER NOT NULL,
  buyer_price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  hold_until TEXT,
  awaiting_confirmation INTEGER NOT NULL DEFAULT 0 CHECK(awaiting_confirmation IN (0, 1)),
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, listing_id)
);
-- Raw observations may contradict one another. Quarantine them instead of losing the walk.
DROP INDEX IF EXISTS one_active_listing_per_item;
-- "Is this item listed?" is asked of every inventory row (db/steam-listing.ts), by bound row and
-- by asset id. Only open listings are ever asked, so only they are indexed.
CREATE INDEX IF NOT EXISTS market_listing_open_local ON market_listing(account_id, local_id)
  WHERE status IN ('ACTIVE','ON_HOLD','PENDING_CONFIRMATION');
CREATE INDEX IF NOT EXISTS market_listing_open_asset ON market_listing(account_id, asset_id)
  WHERE status IN ('ACTIVE','ON_HOLD','PENDING_CONFIRMATION');

CREATE TABLE IF NOT EXISTS buy_order (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  buy_order_id TEXT NOT NULL,
  hash_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  quantity_remaining INTEGER NOT NULL,
  purchased INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0, 1)),
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, buy_order_id)
);

CREATE TABLE IF NOT EXISTS wallet_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  delayed_balance_cents INTEGER NOT NULL,
  currency INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservation (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'SUBMITTED_UNOBSERVED', 'RELEASED', 'CONSUMED')),
  PRIMARY KEY(account_id, ref_kind, ref_id)
);

CREATE TABLE IF NOT EXISTS desired_state (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  intent TEXT NOT NULL,
  params_json TEXT NOT NULL,
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES desired_state(id),
  authority TEXT NOT NULL DEFAULT 'HUMAN',
  suspended_reason TEXT,
  suspended_at TEXT,
  blocked_until TEXT,
  expires_at TEXT,
  UNIQUE(account_id, target_kind, target_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS desired_current ON desired_state(account_id, target_kind, target_id)
  WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  desired_version INTEGER NOT NULL,
  desired_id TEXT NOT NULL REFERENCES desired_state(id),
  state TEXT NOT NULL CHECK(state IN ('READY', 'RUNNING', 'AWAITING_OBSERVATION', 'DONE', 'FAILED')),
  resource_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  params_json TEXT,
  resolved_by_obs INTEGER REFERENCES observation(id),
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS action_ready ON action(account_id, state, created_at);
CREATE INDEX IF NOT EXISTS observation_scope ON observation(account_id, scope_kind, scope_id, id DESC);

CREATE TABLE IF NOT EXISTS attempt (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES action(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  request_ref TEXT,
  response_ref TEXT
);

CREATE TABLE IF NOT EXISTS raw_capture (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  captured_at TEXT NOT NULL,
  body_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_page ON event(account_id, at, id);

-- price_cents is the order LIMIT that was standing when the fill was observed. It is not a paid
-- price and never becomes one (BUY-06): what was actually paid lives in actual_amount_cents, and
-- amount_basis says whether anything evidenced it.
CREATE TABLE IF NOT EXISTS acquisition (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  buy_order_id TEXT,
  quantity INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  attribution TEXT NOT NULL CHECK(attribution IN ('ATTRIBUTED', 'UNATTRIBUTED')),
  candidates_json TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  actual_amount_cents INTEGER,
  amount_basis TEXT NOT NULL DEFAULT 'UNKNOWN'
);


CREATE TABLE IF NOT EXISTS venue_order (
  account_id TEXT NOT NULL REFERENCES account(id),
  order_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('SELL','BUY')),
  local_id TEXT REFERENCES item(local_id),
  hash_name TEXT,
  venue_order_id TEXT,
  price_receive_cents INTEGER,
  opened_at TEXT NOT NULL,
  opened_from_intent TEXT REFERENCES desired_state(id),
  intent_version INTEGER,
  action_id TEXT REFERENCES action(id),
  managed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  first_open_obs INTEGER REFERENCES observation(id),
  last_seen_obs INTEGER REFERENCES observation(id),
  transactable_after TEXT,
  ended_at TEXT,
  end_reason TEXT,
  end_evidence INTEGER REFERENCES observation(id),
  confidence TEXT NOT NULL DEFAULT 'unknown',
  venue_detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(account_id, order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS order_attempt ON venue_order(account_id, action_id) WHERE action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_venue_id ON venue_order(account_id, venue, venue_order_id) WHERE venue_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_resource ON venue_order(account_id, local_id, state);

CREATE TABLE IF NOT EXISTS command (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('REJECTED', 'ADMITTED', 'RUNNING', 'PARTIAL', 'COMPLETE', 'STOPPED')),
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  preparing INTEGER NOT NULL DEFAULT 0,
  manifest_token TEXT,
  observed_completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS command_manifest ON command(manifest_token, created_at);

CREATE TABLE IF NOT EXISTS command_member (
  command_id TEXT NOT NULL REFERENCES command(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  stack_key TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  destination TEXT,
  price_receive_cents INTEGER,
  state TEXT NOT NULL,
  action_id TEXT,
  input_json TEXT,
  PRIMARY KEY(command_id, account_id, member_id)
);

CREATE TABLE IF NOT EXISTS selection_manifest (
  token TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT', 'COMPLETE', 'RELEASED')),
  account_ids_json TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  handle_count INTEGER NOT NULL DEFAULT 0,
  quantity_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS selection_member (
  token TEXT NOT NULL REFERENCES selection_manifest(token) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  stack_key TEXT,
  location TEXT,
  casket_id TEXT,
  quantity INTEGER NOT NULL,
  PRIMARY KEY(token, revision, account_id, member_id)
);
CREATE INDEX IF NOT EXISTS selection_member_account ON selection_member(token, revision, account_id);

CREATE TABLE IF NOT EXISTS inventory_publication (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  published_generation INTEGER,
  staging_generation INTEGER,
  staging_state TEXT NOT NULL DEFAULT 'INACTIVE',
  published_at TEXT,
  PRIMARY KEY(account_id, surface, scope_id)
);

CREATE TABLE IF NOT EXISTS inventory_event_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_event_journal_scope ON inventory_event_journal(account_id, surface, scope_id, id);

CREATE TABLE IF NOT EXISTS market_history (
  account_id TEXT NOT NULL REFERENCES account(id),
  event_id TEXT NOT NULL,
  listing_id TEXT,
  purchase_id TEXT,
  event_type INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, event_id)
);
CREATE INDEX IF NOT EXISTS market_history_page ON market_history(account_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS venue_order_page ON venue_order(account_id, opened_at, order_id);
CREATE INDEX IF NOT EXISTS item_casket_page ON item(account_id,location,casket_id,local_id);
CREATE INDEX IF NOT EXISTS item_identity_match ON item(account_id,(def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':' || IFNULL(kit,'')),local_id);
-- The filter bar's float predicates (f > 0.15, nf < 0.01) range over paint_wear per account.
-- Without this they are a scan of every item the account holds, on every keystroke.
CREATE INDEX IF NOT EXISTS item_account_paint_wear ON item(account_id, paint_wear);
CREATE INDEX IF NOT EXISTS item_group_contents ON item(account_id,group_key,location,casket_id,current_asset_id);
CREATE INDEX IF NOT EXISTS history_listing_page ON market_history(account_id,listing_id,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS history_type_page ON market_history(account_id,event_type,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS order_state_page ON venue_order(account_id,state,opened_at,order_id);
CREATE TABLE IF NOT EXISTS read_revision (
  account_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(account_id,surface)
);
CREATE TRIGGER IF NOT EXISTS item_revision_insert AFTER INSERT ON item BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'item',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS item_revision_update AFTER UPDATE ON item BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'item',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS item_revision_delete AFTER DELETE ON item BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'item',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS storage_unit_revision_insert AFTER INSERT ON storage_unit BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'storage_unit',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS storage_unit_revision_update AFTER UPDATE ON storage_unit BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'storage_unit',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS storage_unit_revision_delete AFTER DELETE ON storage_unit BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'storage_unit',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS market_history_revision_insert AFTER INSERT ON market_history BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'market_history',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS market_history_revision_update AFTER UPDATE ON market_history BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'market_history',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS market_history_revision_delete AFTER DELETE ON market_history BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'market_history',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS venue_order_revision_insert AFTER INSERT ON venue_order BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'venue_order',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS venue_order_revision_update AFTER UPDATE ON venue_order BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'venue_order',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS venue_order_revision_delete AFTER DELETE ON venue_order BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'venue_order',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
-- The cross-venue listings page is keyset-paged over both books at once, so a cursor has to stop
-- being valid when either book changes. Without these, a walk that only moved a listing between
-- buckets bumped no revision at all, and a half-turned page kept paging a set that had moved.
CREATE TRIGGER IF NOT EXISTS market_listing_revision_insert AFTER INSERT ON market_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'market_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS market_listing_revision_update AFTER UPDATE ON market_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'market_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS market_listing_revision_delete AFTER DELETE ON market_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'market_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS csfloat_listing_revision_insert AFTER INSERT ON csfloat_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'csfloat_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS csfloat_listing_revision_update AFTER UPDATE ON csfloat_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'csfloat_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS csfloat_listing_revision_delete AFTER DELETE ON csfloat_listing BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'csfloat_listing',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS event_revision_insert AFTER INSERT ON event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS event_revision_update AFTER UPDATE ON event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS event_revision_delete AFTER DELETE ON event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS command_member_revision_insert AFTER INSERT ON command_member BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'command_member',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS command_member_revision_update AFTER UPDATE ON command_member BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'command_member',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS command_member_revision_delete AFTER DELETE ON command_member BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'command_member',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
-- Trade observation and the ledger (requirements §3.7, §4.1, §4.2). Trade *actions* are
-- deferred; these rows only ever record what was observed.
CREATE TABLE IF NOT EXISTS trade_offer (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  trade_id TEXT,
  counterparty_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('SENT', 'RECEIVED')),
  raw_state INTEGER NOT NULL,
  status TEXT NOT NULL,
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
);

CREATE TABLE IF NOT EXISTS trade_status_event (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  offer_id TEXT,
  trade_id TEXT,
  raw_state INTEGER NOT NULL,
  status TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, event_key)
);

CREATE TABLE IF NOT EXISTS executed_trade (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL,
  offer_id TEXT,
  counterparty_steam_id64 TEXT NOT NULL,
  raw_status INTEGER NOT NULL,
  status TEXT NOT NULL,
  initiated_at TEXT NOT NULL,
  updated_at TEXT,
  settled_at TEXT,
  reverses_trade_id TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, trade_id)
);

CREATE TABLE IF NOT EXISTS trade_line (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  trade_id TEXT,
  offer_id TEXT,
  side TEXT NOT NULL CHECK(side IN ('GIVE', 'RECEIVE')),
  app_id INTEGER NOT NULL,
  context_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  new_asset_id TEXT,
  class_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 1),
  market_hash_name TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  local_id TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, line_key)
);

CREATE TABLE IF NOT EXISTS observation_checkpoint (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  cursor_json TEXT NOT NULL,
  covered_through TEXT,
  observation_id INTEGER REFERENCES observation(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, surface, scope_id)
);

CREATE TABLE IF NOT EXISTS economic_event (
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
);
-- An unknown amount is NULL and says so; nothing may sum it as zero (DATA-04).
CREATE INDEX IF NOT EXISTS economic_event_page ON economic_event(account_id, occurred_at, source_key);
CREATE INDEX IF NOT EXISTS economic_event_kind ON economic_event(account_id, kind, occurred_at, source_key);
CREATE INDEX IF NOT EXISTS economic_event_order ON economic_event(account_id, order_id, occurred_at);
CREATE INDEX IF NOT EXISTS trade_offer_page ON trade_offer(account_id, updated_at, offer_id);
CREATE INDEX IF NOT EXISTS trade_offer_open ON trade_offer(account_id, status, offer_id);
CREATE INDEX IF NOT EXISTS executed_trade_page ON executed_trade(account_id, initiated_at, trade_id);
CREATE INDEX IF NOT EXISTS trade_line_trade ON trade_line(account_id, trade_id, side, line_key);
CREATE INDEX IF NOT EXISTS trade_line_offer ON trade_line(account_id, offer_id, side, line_key);
CREATE INDEX IF NOT EXISTS trade_line_asset ON trade_line(account_id, asset_id);
-- An offer and the executed trade it became are one trade, joined on the trade id the offer carries
-- (trades page, read/queries/trades.ts), and the history walk asks the same question per trade.
CREATE INDEX IF NOT EXISTS trade_offer_trade ON trade_offer(account_id, trade_id);
CREATE INDEX IF NOT EXISTS trade_status_event_offer ON trade_status_event(account_id, offer_id, occurred_at);
CREATE TRIGGER IF NOT EXISTS trade_offer_revision_insert AFTER INSERT ON trade_offer BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'trade_offer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS trade_offer_revision_update AFTER UPDATE ON trade_offer BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'trade_offer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS trade_offer_revision_delete AFTER DELETE ON trade_offer BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'trade_offer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS executed_trade_revision_insert AFTER INSERT ON executed_trade BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'executed_trade',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS executed_trade_revision_update AFTER UPDATE ON executed_trade BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'executed_trade',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS executed_trade_revision_delete AFTER DELETE ON executed_trade BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'executed_trade',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS economic_event_revision_insert AFTER INSERT ON economic_event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'economic_event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS economic_event_revision_update AFTER UPDATE ON economic_event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'economic_event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS economic_event_revision_delete AFTER DELETE ON economic_event BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'economic_event',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE IF NOT EXISTS inventory_backup_item (
  local_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  def_index INTEGER NOT NULL,
  paint_index INTEGER,
  paint_wear REAL,
  paint_seed INTEGER,
  quality INTEGER NOT NULL,
  stable_key TEXT NOT NULL,
  current_asset_id TEXT,
  location TEXT NOT NULL CHECK(location IN ('MAIN', 'CASKET', 'MARKET', 'MISSING')),
  casket_id TEXT,
  tradable_after TEXT,
  trade_protected_until TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  location_obs INTEGER REFERENCES observation(id),
  location_generation INTEGER,
  row_generation INTEGER NOT NULL DEFAULT 0,
  -- Appended by migrations, in ALTER order, mirroring item exactly: beginStaging copies with
  -- SELECT *, which matches by position (migrations.test.ts).
  kit TEXT NOT NULL DEFAULT '',
  unit_kind TEXT NOT NULL DEFAULT 'individual',
  group_key TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  reserved_command TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS account_trade_link (
  account_id TEXT PRIMARY KEY REFERENCES account(id),
  partner_account_id TEXT NOT NULL,
  token TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id)
);
CREATE TABLE IF NOT EXISTS trade_inventory_item (
  account_id TEXT NOT NULL REFERENCES account(id),
  asset_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity>0),
  tradable INTEGER NOT NULL CHECK(tradable IN (0,1)),
  name TEXT NOT NULL,
  class_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  -- Appended by migration 25. Steam's own answer to "can this be sold on the market at all",
  -- which no GC attribute gives (holdings plan D7). NULL is unknown, never "no".
  marketable INTEGER CHECK(marketable IN (0,1)),
  PRIMARY KEY(account_id,asset_id)
);
CREATE TABLE IF NOT EXISTS transfer_hold (
  account_id TEXT NOT NULL REFERENCES account(id),
  destination_account_id TEXT NOT NULL REFERENCES account(id),
  my_seconds INTEGER NOT NULL,
  their_seconds INTEGER NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id,destination_account_id)
);
CREATE TABLE IF NOT EXISTS transfer_batch (
  command_id TEXT NOT NULL REFERENCES command(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  destination_account_id TEXT NOT NULL REFERENCES account(id),
  send_action_id TEXT NOT NULL UNIQUE REFERENCES action(id),
  accept_action_id TEXT REFERENCES action(id),
  cancel_action_id TEXT REFERENCES action(id),
  offer_id TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  assets_json TEXT NOT NULL,
  destination_baseline_json TEXT NOT NULL,
  accepted_at TEXT,
  accepted_obs INTEGER REFERENCES observation(id),
  completed_source_obs INTEGER REFERENCES observation(id),
  completed_destination_obs INTEGER REFERENCES observation(id),
  retrieve_action_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(command_id,account_id),
  UNIQUE(account_id,offer_id),
  CHECK(account_id<>destination_account_id)
);
CREATE INDEX IF NOT EXISTS transfer_batch_destination ON transfer_batch(destination_account_id,state);
CREATE TRIGGER IF NOT EXISTS transfer_revision_insert AFTER INSERT ON transfer_batch BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'transfer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.destination_account_id,'transfer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS transfer_revision_update AFTER UPDATE ON transfer_batch BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'transfer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.destination_account_id,'transfer',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS trade_inventory_revision_insert AFTER INSERT ON trade_inventory_item BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'trade_inventory',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS trade_inventory_revision_delete AFTER DELETE ON trade_inventory_item BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (OLD.account_id,'trade_inventory',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE IF NOT EXISTS marketplace_connection (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  venue TEXT NOT NULL,
  remote_steam_id TEXT,
  credential_ref TEXT,
  credential_version INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  status_reason TEXT,
  connected_at TEXT,
  checked_at TEXT,
  PRIMARY KEY(account_id, venue),
  CHECK(status IN ('CONNECTED','CHECKING','INVALID_KEY','RESTRICTED','THROTTLED','UNAVAILABLE','DISCONNECTED'))
);
CREATE INDEX IF NOT EXISTS marketplace_connection_venue ON marketplace_connection(venue, status);

CREATE TABLE IF NOT EXISTS csfloat_account_status (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  generation INTEGER NOT NULL,
  remote_steam_id TEXT NOT NULL,
  available_cents INTEGER,
  pending_cents INTEGER,
  flags_json TEXT NOT NULL
);
-- The venue's rating of the account (GET /me/account-standing), beside the readiness /me carries.
-- Its own observation: the route can refuse while /me answers, and a refusal there says nothing
-- about the key (CSF-29). restrictions_json is the venue's recent list, raw category and time.
CREATE TABLE IF NOT EXISTS csfloat_account_standing (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  generation INTEGER NOT NULL,
  standing TEXT NOT NULL,
  penalty_progress REAL,
  restrictions_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS marketplace_connection_revision AFTER UPDATE ON marketplace_connection BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'marketplace',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS marketplace_connection_revision_insert AFTER INSERT ON marketplace_connection BEGIN
  INSERT INTO read_revision(account_id,surface,revision) VALUES (NEW.account_id,'marketplace',1)
  ON CONFLICT(account_id,surface) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE IF NOT EXISTS csfloat_listing (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  def_index INTEGER NOT NULL,
  hash_name TEXT NOT NULL,
  paint_index INTEGER,
  paint_seed INTEGER,
  paint_wear REAL,
  quality INTEGER,
  stattrak INTEGER,
  tradable INTEGER,
  created_at TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id, listing_id)
);
CREATE INDEX IF NOT EXISTS csfloat_listing_asset ON csfloat_listing(account_id, asset_id);
CREATE INDEX IF NOT EXISTS csfloat_listing_state ON csfloat_listing(account_id, state);

CREATE TABLE IF NOT EXISTS csfloat_buy_order (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  hash_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  bought INTEGER,
  properties_json TEXT,
  created_at TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id, order_id)
);

CREATE TABLE IF NOT EXISTS marketplace_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  prevent_duplicates INTEGER NOT NULL DEFAULT 1 CHECK(prevent_duplicates IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS csfloat_inventory (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id,asset_id)
);
CREATE TABLE IF NOT EXISTS csfloat_contract (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  local_id TEXT,
  state TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  type TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id,listing_id)
);
CREATE INDEX IF NOT EXISTS csfloat_contract_asset ON csfloat_contract(account_id,asset_id,state);
CREATE INDEX IF NOT EXISTS csfloat_contract_local ON csfloat_contract(account_id,local_id,state);
CREATE TABLE IF NOT EXISTS csfloat_trade (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  local_id TEXT,
  state TEXT NOT NULL,
  seller_steam_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id,trade_id)
);
CREATE INDEX IF NOT EXISTS csfloat_trade_asset ON csfloat_trade(account_id,asset_id,state);
-- Which CSFloat trade a Steam offer carried. The expression must be spelled exactly as a query uses it.
CREATE INDEX IF NOT EXISTS csfloat_trade_offer ON csfloat_trade(account_id,json_extract(data_json,'$.offerId'));
CREATE TABLE IF NOT EXISTS csfloat_operation (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  local_id TEXT,
  asset_id TEXT,
  listing_id TEXT,
  trade_id TEXT,
  price_cents INTEGER,
  generation INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  action_id TEXT REFERENCES action(id),
  offer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  retrieve_action_id TEXT REFERENCES action(id),
  loose_obs INTEGER REFERENCES observation(id),
  visibility_deadline_at TEXT,
  order_id TEXT,
  quantity INTEGER
);
CREATE INDEX IF NOT EXISTS csfloat_operation_account ON csfloat_operation(account_id,state);
CREATE INDEX IF NOT EXISTS csfloat_operation_item ON csfloat_operation(account_id,local_id,state);
CREATE INDEX IF NOT EXISTS csfloat_operation_command ON csfloat_operation(command_id);
CREATE TABLE IF NOT EXISTS marketplace_conflict (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  conflict_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(account_id,conflict_key)
);
CREATE TABLE IF NOT EXISTS store_price_sheet (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  version INTEGER NOT NULL,
  currency INTEGER NOT NULL,
  currency_label TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  parse_state TEXT NOT NULL CHECK(parse_state IN ('PARSED', 'UNPARSEABLE'))
);
CREATE TABLE IF NOT EXISTS store_price_entry (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  category_tags TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  sale_price_cents INTEGER,
  PRIMARY KEY(account_id, entry_key)
);
CREATE TABLE IF NOT EXISTS store_purchase (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('ADMITTED', 'INITIALISING', 'AWAITING_APPROVAL', 'FINALISING', 'AWAITING_OBSERVATION',
    'COMPLETED', 'REJECTED', 'CANCELLING', 'CANCELLED', 'UNRESOLVED')),
  currency INTEGER NOT NULL,
  requested_total_cents INTEGER NOT NULL CHECK(requested_total_cents >= 0),
  sheet_version INTEGER NOT NULL,
  txn_id TEXT,
  init_action_id TEXT REFERENCES action(id),
  finalize_action_id TEXT REFERENCES action(id),
  cancel_action_id TEXT REFERENCES action(id),
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  resolved_by_obs INTEGER REFERENCES observation(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS store_purchase_account ON store_purchase(account_id, state, created_at);
CREATE INDEX IF NOT EXISTS store_purchase_command ON store_purchase(command_id);
CREATE TABLE IF NOT EXISTS store_purchase_line (
  purchase_id TEXT NOT NULL REFERENCES store_purchase(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  def_index INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  baseline_quantity INTEGER NOT NULL DEFAULT 0,
  observed_quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(purchase_id, line_index)
);
`;
