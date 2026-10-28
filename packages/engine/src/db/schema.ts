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
import { ACTION_STATES, COMMAND_AUTHORITIES, COMMAND_MEMBER_STATES, COMMAND_STATES, EVIDENCE_SOURCES, EXECUTED_TRADE_STATUSES, ORDER_CONFIDENCES, ORDER_SIDES, ORDER_STATES, ORDER_VENUES, RESERVATION_STATES, STEAM_LISTING_BUCKETS, STORAGE_UNIT_STATES, STORE_SHEET_PARSE_STATES, TRADE_OFFER_STATUSES, TRADE_STATUS_EVENT_STATUSES, VENUE_CONNECTION_STATUSES, WORK_STEP_KINDS, WORK_STEP_STATES, sqlList } from './alphabets.js';

export const SCHEMA_VERSION = 31;

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
  persona_obs INTEGER,
  -- Appended by migration 29: the account's own trade token and the read that gave it (D14). The
  -- partner id Steam's trade URL wants is the SteamID64 less the account32 offset, derived at use.
  trade_token TEXT,
  trade_token_obs INTEGER
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

-- One row per account, surface and scope of what the record keeps about its own reads of that
-- surface (consolidation plan D9): a walk's committed coverage (cursor_json, covered_through, the
-- observation that moved it and when), advanced only inside the write that recorded it; and the
-- revision of a paged table, counted by the store that writes it in the same transaction, which
-- a keyset cursor carries and is refused on when it moved. There is no trigger: the engine is the
-- sole writer, and tests/unit/revision-sites.test.ts holds every write site to its count.
CREATE TABLE IF NOT EXISTS surface_state (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  covered_through TEXT,
  observation_id INTEGER REFERENCES observation(id),
  updated_at TEXT,
  PRIMARY KEY(account_id, surface, scope_id),
  CHECK(revision > 0 OR cursor_json IS NOT NULL)
) STRICT;

-- An item's location is where the Game Coordinator holds it. A listing is not a place: the GC
-- keeps a listed item in the inventory, so a listed unit is MAIN and "listed" is an open
-- venue_order row the market walk wrote (db/commitment.ts). A walk writes the scope in one
-- transaction (consolidation plan D8): a reader sees the rows a walk left whole, never a mix.
CREATE TABLE IF NOT EXISTS item (
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
  -- kit is the catalogue key's fourth field; the six after it are the holdings plan (D2-D8):
  -- one row per unit, of either kind.
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
CREATE UNIQUE INDEX IF NOT EXISTS item_asset ON item(account_id, asset_id) WHERE asset_id IS NOT NULL;
-- A trade receipt names the given holding by asset id alone: it lives on whichever owned account gave it.
CREATE INDEX IF NOT EXISTS item_asset_across_accounts ON item(asset_id);
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
-- A swept row asks whether a receipt carried it onward; the receipt may be the receiving account's.
CREATE INDEX IF NOT EXISTS item_lineage_from ON item_lineage(from_local_id);

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

CREATE TABLE IF NOT EXISTS storage_unit (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  casket_id TEXT NOT NULL,
  label TEXT,
  contains_count INTEGER NOT NULL,
  contents_obs INTEGER REFERENCES observation(id),
  state TEXT NOT NULL CHECK(state IN (${sqlList(STORAGE_UNIT_STATES)})),
  -- Last on purpose: ALTER TABLE ADD COLUMN appends, and the fresh-create path
  -- and the upgrade path have to converge column for column (migrations.test.ts).
  -- A label is only as good as the observation that wrote it (rename plan §3).
  label_obs INTEGER REFERENCES observation(id),
  PRIMARY KEY(account_id, casket_id)
);

-- What a source other than the Game Coordinator says about an asset this account holds, one row
-- per source (consolidation plan D11): Steam's Community description (tradable, marketable,
-- quantity, name, class and instance) and CSFloat's inventory read (eligible, and the item as the
-- venue described it, which the identity association reads whole). A row mirrors the source's
-- last complete walk: first_seen_obs is the walk that first showed the asset, last_seen_obs the
-- latest, and a walk sweeps the rows it did not show. A flag the source did not give is NULL:
-- unknown, never "no". marketable is Steam's only answer to "can this be sold on the market at
-- all"; no GC attribute gives it (holdings plan D7).
CREATE TABLE IF NOT EXISTS asset_evidence (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN (${sqlList(EVIDENCE_SOURCES)})),
  tradable INTEGER CHECK(tradable IN (0, 1)),
  marketable INTEGER CHECK(marketable IN (0, 1)),
  quantity INTEGER CHECK(quantity > 0),
  eligible INTEGER CHECK(eligible IN (0, 1)),
  detail_json TEXT,
  name TEXT,
  class_id TEXT,
  instance_id TEXT,
  first_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  last_seen_obs INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, asset_id, source),
  CHECK(source <> 'community' OR (tradable IS NOT NULL AND quantity IS NOT NULL AND name IS NOT NULL AND class_id IS NOT NULL AND instance_id IS NOT NULL)),
  CHECK(source <> 'csfloat' OR detail_json IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  delayed_balance_cents INTEGER NOT NULL,
  currency INTEGER NOT NULL
);
-- The latest balance, asked once per listing row on three pages.
CREATE INDEX IF NOT EXISTS wallet_latest ON wallet_snapshot(account_id, id);

CREATE TABLE IF NOT EXISTS reservation (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  state TEXT NOT NULL CHECK(state IN (${sqlList(RESERVATION_STATES)})),
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
  created_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES desired_state(id),
  authority TEXT NOT NULL DEFAULT 'HUMAN',
  suspended_reason TEXT,
  suspended_at TEXT,
  blocked_until TEXT,
  expires_at TEXT,
  -- Appended by migration 29: the command that set the goal, when one did (consolidation plan D15).
  command_id TEXT REFERENCES command(id),
  UNIQUE(account_id, target_kind, target_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS desired_current ON desired_state(account_id, target_kind, target_id)
  WHERE superseded_by IS NULL;

-- An action carries a standing intent (desired_id) or one hop of a command (step_id), never both
-- and never neither (consolidation plan D3). Migration 29 rebuilt the table to let desired_id be null.
CREATE TABLE IF NOT EXISTS action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  desired_version INTEGER NOT NULL DEFAULT 0,
  desired_id TEXT REFERENCES desired_state(id),
  state TEXT NOT NULL CHECK(state IN (${sqlList(ACTION_STATES)})),
  resource_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  params_json TEXT,
  resolved_by_obs INTEGER REFERENCES observation(id),
  resolution TEXT,
  step_id TEXT REFERENCES work_step(id),
  CHECK((step_id IS NULL) <> (desired_id IS NULL))
);
-- A goal's latest action: the member-state carrier join and the planners ask it per goal.
CREATE INDEX IF NOT EXISTS action_goal ON action(desired_id, created_at) WHERE desired_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS action_ready ON action(account_id, state, created_at);
CREATE INDEX IF NOT EXISTS observation_scope ON observation(account_id, scope_kind, scope_id, id DESC);

CREATE TABLE IF NOT EXISTS attempt (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES action(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  request_ref TEXT,
  response_ref TEXT,
  -- The venue's own wait before the same request may be made again, as an instant on the engine's
  -- clock: a rate limit read from its headers, a cap on outstanding offers. Set by finishAttempt
  -- from the refusal's retryAfterMs; null for every other answer (delivery retries plan D1, D2).
  retry_after TEXT
);
-- An action's attempts: how many were made and the latest, asked per waiting row and per retry
-- decision (kernel/not-applied.ts, read/queries/waiting.ts; strategy authority and confirmations plan D13).
CREATE INDEX IF NOT EXISTS attempt_action ON attempt(action_id);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_page ON event(account_id, at, id);
-- A write-once event is looked up by its kind before it is written (addEventOnce).
CREATE INDEX IF NOT EXISTS event_kind ON event(account_id, kind, at);

-- price_cents is the order LIMIT that was standing when the fill was observed. It is not a paid
-- price and never becomes one (BUY-06): what was actually paid lives in actual_amount_cents, and
-- amount_basis says whether anything evidenced it.

-- One row per order on any venue and either side, ours or the account owner's, from the request
-- that opened it to the observation that explained its end (consolidation plan D4). It is the only
-- row that binds a holding to a venue object, by its row and by its asset id, and the walk
-- re-derives the binding from the asset id every time. What only one venue has is a satellite
-- keyed like the parent (steam_order, csfloat_order). "Is this holding committed, or listed?" is
-- asked of these rows by db/commitment.ts, by row through order_resource and by asset id through
-- order_asset, and nowhere else.
CREATE TABLE IF NOT EXISTS venue_order (
  account_id TEXT NOT NULL REFERENCES account(id),
  order_id TEXT NOT NULL,
  venue TEXT NOT NULL CHECK(venue IN (${sqlList(ORDER_VENUES)})),
  side TEXT NOT NULL CHECK(side IN (${sqlList(ORDER_SIDES)})),
  local_id TEXT REFERENCES item(local_id),
  asset_id TEXT,
  hash_name TEXT,
  venue_order_id TEXT,
  price_cents INTEGER,
  currency INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  filled INTEGER,
  state TEXT NOT NULL CHECK(state IN (${sqlList(ORDER_STATES)})),
  confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(confidence IN (${sqlList(ORDER_CONFIDENCES)})),
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
);
CREATE UNIQUE INDEX IF NOT EXISTS order_attempt ON venue_order(account_id, action_id) WHERE action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_venue_id ON venue_order(account_id, venue, venue_order_id) WHERE venue_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_resource ON venue_order(account_id, local_id, state);
CREATE INDEX IF NOT EXISTS order_asset ON venue_order(account_id, asset_id, state);

-- What only Steam says about a listing: the price a buyer sees beside the seller-receives figure
-- the parent keeps (rule 4), and the bucket of mylistings the listing was last seen in, which the
-- parent's state is derived from and which a quarantine does not overwrite.
CREATE TABLE IF NOT EXISTS steam_order (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  buyer_price_cents INTEGER,
  raw_bucket TEXT CHECK(raw_bucket IN (${sqlList(STEAM_LISTING_BUCKETS)})),
  PRIMARY KEY(account_id, order_id),
  FOREIGN KEY(account_id, order_id) REFERENCES venue_order(account_id, order_id) ON DELETE CASCADE
) STRICT;

-- What only CSFloat says about an order: a listing's kind and the venue's own word for its state
-- (the parent's state is derived from it; a word this app has never seen is kept for a person to
-- read), the item as the venue described it, verbatim, because the identity association reads the
-- whole tuple; a buy order's constraints as sent; when the venue says it was created; and the read
-- that last stated a listing, which an edit's admission and its proof are judged against.
CREATE TABLE IF NOT EXISTS csfloat_order (
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
) STRICT;

-- A command is one submission: a bulk Steam command, a CSFloat edit, a transfer, a store purchase,
-- or a captured selection no kind has been chosen for yet (DRAFT). Its hops are work_step rows.
CREATE TABLE IF NOT EXISTS command (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (${sqlList(COMMAND_STATES)})),
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  preparing INTEGER NOT NULL DEFAULT 0,
  manifest_token TEXT,
  observed_completed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  filter_json TEXT,
  -- Appended by migration 30: whose the command is, a person or a strategy acting for one (strategy
  -- authority and confirmations plan D1). What a person said about a holding stands (D3).
  authority TEXT NOT NULL DEFAULT 'HUMAN' CHECK(authority IN (${sqlList(COMMAND_AUTHORITIES)}))
);

-- A member names the holding a command is about (local_id is its local id once a group member
-- has been expanded into units), keeps the terms it was admitted with, and carries only the words
-- no hop can say for it (db/alphabets.ts); what it is doing is its hops in work_step
-- (consolidation plan §4.4). Migration 29 rebuilt it without action_id.
CREATE TABLE IF NOT EXISTS command_member (
  command_id TEXT NOT NULL REFERENCES command(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  stack_key TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  destination TEXT,
  price_receive_cents INTEGER,
  state TEXT NOT NULL CHECK(state IN (${sqlList(COMMAND_MEMBER_STATES)})),
  input_json TEXT,
  PRIMARY KEY(command_id, account_id, local_id)
);
-- The resume after a restart and the purge ask for an account's members by state.
CREATE INDEX IF NOT EXISTS command_member_account ON command_member(account_id, state);
-- Who may act on a holding asks which commands named it (db/authority.ts, strategy authority plan D2).
CREATE INDEX IF NOT EXISTS command_member_account_local ON command_member(account_id, local_id);

-- One row per hop of a command (consolidation plan D2): the holding or the remote object it is
-- about, the one action that carries it when one exists, the observation that settled it, and the
-- terms it was admitted with. Its state is the one work alphabet; what the venue shows meanwhile
-- is read from the venue's rows and never copied here.
CREATE TABLE IF NOT EXISTS work_step (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES command(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_id TEXT,
  target_id TEXT,
  offer_id TEXT,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(WORK_STEP_KINDS)})),
  state TEXT NOT NULL CHECK(state IN (${sqlList(WORK_STEP_STATES)})),
  action_id TEXT REFERENCES action(id),
  desired_id TEXT REFERENCES desired_state(id),
  reason TEXT,
  params_json TEXT,
  observation_id INTEGER REFERENCES observation(id),
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS work_step_command ON work_step(command_id, ordinal);
CREATE INDEX IF NOT EXISTS work_step_account_state ON work_step(account_id, state, updated_at);
CREATE INDEX IF NOT EXISTS work_step_account_local ON work_step(account_id, local_id);
CREATE INDEX IF NOT EXISTS work_step_target ON work_step(account_id, kind, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS work_step_action ON work_step(action_id) WHERE action_id IS NOT NULL;
-- Which hop sent an offer: whose an offer waiting on the phone is (read/queries/waiting.ts, strategy
-- authority and confirmations plan D13).
CREATE INDEX IF NOT EXISTS work_step_offer ON work_step(account_id, offer_id) WHERE offer_id IS NOT NULL;
-- A cursor into a page of work is bound to these marks (read/queries/paging.ts); a hop that moves
-- invalidates it, as a transfer's row did before the hops.

-- What only a transfer's send hop has (consolidation plan D2, §4.4): where it goes, what the
-- destination held before it, when the offer was seen accepted, and the two walks that proved
-- delivery. Keyed by the hop; the hop's own row says where the transfer is.
CREATE TABLE IF NOT EXISTS transfer_detail (
  step_id TEXT PRIMARY KEY REFERENCES work_step(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  destination_account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  destination_baseline_json TEXT NOT NULL,
  accepted_at TEXT,
  accepted_obs INTEGER REFERENCES observation(id),
  completed_source_obs INTEGER REFERENCES observation(id),
  completed_destination_obs INTEGER REFERENCES observation(id),
  CHECK(account_id<>destination_account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS transfer_detail_destination ON transfer_detail(destination_account_id);

-- The frozen lines of a store purchase, beside its init hop (consolidation plan D2, §4.4): entry
-- key, def index, quantity, unit price, the main-inventory baseline at admission and what has been
-- observed since. The baseline is what makes an id-less delivery countable.
CREATE TABLE IF NOT EXISTS store_line (
  step_id TEXT NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  def_index INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  baseline_quantity INTEGER NOT NULL DEFAULT 0,
  observed_quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(step_id, line_index)
) STRICT;


-- One row per myhistory event, deduplicated by Steam's event id, with what a read asks of it and
-- no body (consolidation plan D15): the money an event named is the ledger row keyed by the
-- event, and the name is what the venue called the item when its body said, else the order's.
CREATE TABLE IF NOT EXISTS market_history (
  account_id TEXT NOT NULL REFERENCES account(id),
  event_id TEXT NOT NULL,
  listing_id TEXT,
  purchase_id TEXT,
  event_type INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  hash_name TEXT,
  PRIMARY KEY(account_id, event_id)
);
CREATE INDEX IF NOT EXISTS market_history_page ON market_history(account_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS venue_order_page ON venue_order(account_id, opened_at, order_id);
CREATE INDEX IF NOT EXISTS item_casket_page ON item(account_id,location,casket_id,local_id);
CREATE INDEX IF NOT EXISTS item_identity_match ON item(account_id,(def_index || ':' || IFNULL(paint_index,'') || ':' || quality || ':' || IFNULL(kit,'')),local_id);
-- The filter bar's float predicates (f > 0.15, nf < 0.01) range over paint_wear per account.
-- Without this they are a scan of every item the account holds, on every keystroke.
CREATE INDEX IF NOT EXISTS item_account_paint_wear ON item(account_id, paint_wear);
CREATE INDEX IF NOT EXISTS history_listing_page ON market_history(account_id,listing_id,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS history_type_page ON market_history(account_id,event_type,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS order_state_page ON venue_order(account_id,state,opened_at,order_id);
-- The cross-venue listings page is keyset-paged over both books at once, so a cursor has to stop
-- being valid when either book changes. Without these, a walk that only moved a listing between
-- buckets bumped no revision at all, and a half-turned page kept paging a set that had moved.
-- Trade observation and the ledger (requirements §3.7, §4.1, §4.2). Trade *actions* are
-- deferred; these rows only ever record what was observed.
CREATE TABLE IF NOT EXISTS trade_offer (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  trade_id TEXT,
  counterparty_steam_id64 TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('SENT', 'RECEIVED')),
  state_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${sqlList(TRADE_OFFER_STATUSES)})),
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
  state_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${sqlList(TRADE_STATUS_EVENT_STATUSES)})),
  occurred_at TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id, event_key)
);

CREATE TABLE IF NOT EXISTS executed_trade (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL,
  offer_id TEXT,
  counterparty_steam_id64 TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${sqlList(EXECUTED_TRADE_STATUSES)})),
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
-- A new holding asks for its receipt by the asset it became (holdings.upsertUnit).
CREATE INDEX IF NOT EXISTS trade_line_new_asset ON trade_line(new_asset_id);
-- An offer and the executed trade it became are one trade, joined on the trade id the offer carries
-- (trades page, read/queries/trades.ts), and the history walk asks the same question per trade.
CREATE INDEX IF NOT EXISTS trade_offer_trade ON trade_offer(account_id, trade_id);
CREATE INDEX IF NOT EXISTS trade_status_event_offer ON trade_status_event(account_id, offer_id, occurred_at);
CREATE INDEX IF NOT EXISTS trade_status_event_trade ON trade_status_event(account_id, trade_id, occurred_at);

CREATE TABLE IF NOT EXISTS transfer_hold (
  account_id TEXT NOT NULL REFERENCES account(id),
  destination_account_id TEXT NOT NULL REFERENCES account(id),
  my_seconds INTEGER NOT NULL,
  their_seconds INTEGER NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  PRIMARY KEY(account_id,destination_account_id)
);
CREATE TABLE IF NOT EXISTS venue_connection (
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
  CHECK(status IN (${sqlList(VENUE_CONNECTION_STATUSES)}))
);
CREATE INDEX IF NOT EXISTS venue_connection_venue ON venue_connection(venue, status);

CREATE TABLE IF NOT EXISTS csfloat_account_status (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
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
  observation_id INTEGER NOT NULL REFERENCES observation(id),
  observed_at TEXT NOT NULL,
  standing TEXT NOT NULL,
  penalty_progress REAL,
  restrictions_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS csfloat_trade (
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
);
CREATE INDEX IF NOT EXISTS csfloat_trade_asset ON csfloat_trade(account_id,asset_id,state_word);
-- Which CSFloat trade a Steam offer carried.
CREATE INDEX IF NOT EXISTS csfloat_trade_offer ON csfloat_trade(account_id,offer_id);
CREATE TABLE IF NOT EXISTS venue_conflict (
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
  parse_state TEXT NOT NULL CHECK(parse_state IN (${sqlList(STORE_SHEET_PARSE_STATES)}))
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
`;
