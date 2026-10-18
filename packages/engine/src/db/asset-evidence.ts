import type { CsfloatListingItem, TradeInventoryItem } from '@cslytics/ports';
import type { EngineDatabase } from './database.js';
import type { EvidenceSource } from './alphabets.js';

/** What Steam's Community description last said about one asset of this account. */
export type CommunityEvidence = {
  account_id: string; asset_id: string; quantity: number; tradable: number;
  /** Steam's own answer to "can this be sold on the market at all" (holdings plan D7). NULL is unknown, never "no". */
  marketable: number | null;
  name: string; class_id: string; instance_id: string; first_seen_obs: number; last_seen_obs: number;
};
/** What CSFloat's inventory read last said: `eligible` is the venue's `tradable` flag, `item` the item as it described it. */
export type CsfloatEvidence = { account_id: string; asset_id: string; eligible: number | null; item: CsfloatListingItem; first_seen_obs: number; last_seen_obs: number };

type EvidenceRow = {
  account_id: string; asset_id: string; source: EvidenceSource; tradable: number | null; marketable: number | null; quantity: number | null;
  eligible: number | null; detail_json: string | null; name: string | null; class_id: string | null; instance_id: string | null;
  first_seen_obs: number; last_seen_obs: number;
};
type Fact = Omit<EvidenceRow, 'account_id' | 'source' | 'first_seen_obs' | 'last_seen_obs'>;

/**
 * `asset_evidence`: what a source other than the Game Coordinator says about an asset this account
 * holds, one row per source (consolidation plan D11). A row mirrors the source's last complete
 * walk: `first_seen_obs` is the walk that first showed the asset, `last_seen_obs` the latest, and a
 * walk sweeps the rows it did not show, so "is this the current read" is `last_seen_obs` against
 * the surface's latest observation. A flag the source did not give is NULL: unknown, never "no".
 */
export class AssetEvidenceStore {
  constructor(readonly db: EngineDatabase) {}

  community(accountId: string, assetId: string): CommunityEvidence | undefined {
    const row = this.row(accountId, assetId, 'community');
    return row ? communityOf(row) : undefined;
  }

  csfloat(accountId: string, assetId: string): CsfloatEvidence | undefined {
    const row = this.row(accountId, assetId, 'csfloat');
    return row ? csfloatOf(row) : undefined;
  }

  /** Every asset CSFloat's last complete read showed for the account. */
  csfloatHeld(accountId: string): CsfloatEvidence[] {
    return (this.db.raw().prepare(`SELECT * FROM asset_evidence WHERE account_id=? AND source='csfloat'`).all(accountId) as EvidenceRow[]).map(csfloatOf);
  }

  /** The Community walk's word on every asset it showed. Called inside the walk's transaction, after its observation row. */
  observeCommunity(accountId: string, items: readonly TradeInventoryItem[], observationId: number): void {
    this.observe(accountId, 'community', observationId, items.map((item) => ({
      asset_id: item.assetId, tradable: item.tradable ? 1 : 0, marketable: item.marketable === undefined ? null : item.marketable ? 1 : 0,
      quantity: item.quantity, eligible: null, detail_json: null, name: item.name, class_id: item.classId, instance_id: item.instanceId
    })));
  }

  /** CSFloat's inventory read, each item kept verbatim for the identity association. Called inside the walk's transaction. */
  observeCsfloat(accountId: string, items: readonly CsfloatListingItem[], observationId: number): void {
    this.observe(accountId, 'csfloat', observationId, items.map((item) => ({
      asset_id: item.assetId, tradable: null, marketable: null, quantity: null,
      eligible: item.tradable === undefined ? null : item.tradable === 1 ? 1 : 0, detail_json: JSON.stringify(item), name: null, class_id: null, instance_id: null
    })));
  }

  private row(accountId: string, assetId: string, source: EvidenceSource): EvidenceRow | undefined {
    return this.db.raw().prepare('SELECT * FROM asset_evidence WHERE account_id=? AND asset_id=? AND source=?').get(accountId, assetId, source) as EvidenceRow | undefined;
  }

  /** Each asset the walk showed, its first sighting kept; then the rows this walk did not show go. */
  private observe(accountId: string, source: EvidenceSource, observationId: number, facts: readonly Fact[]): void {
    const upsert = this.db.raw().prepare(`INSERT INTO asset_evidence(account_id, asset_id, source, tradable, marketable, quantity, eligible, detail_json, name, class_id, instance_id, first_seen_obs, last_seen_obs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, asset_id, source) DO UPDATE SET tradable=excluded.tradable, marketable=excluded.marketable, quantity=excluded.quantity,
        eligible=excluded.eligible, detail_json=excluded.detail_json, name=excluded.name, class_id=excluded.class_id, instance_id=excluded.instance_id,
        last_seen_obs=excluded.last_seen_obs`);
    for (const fact of facts) {
      upsert.run(accountId, fact.asset_id, source, fact.tradable, fact.marketable, fact.quantity, fact.eligible, fact.detail_json, fact.name, fact.class_id, fact.instance_id,
        observationId, observationId);
    }
    this.db.raw().prepare('DELETE FROM asset_evidence WHERE account_id=? AND source=? AND last_seen_obs<>?').run(accountId, source, observationId);
  }
}

/** A Community row's columns are NOT NULL by the table's CHECK, so the reading is exact. */
function communityOf(row: EvidenceRow): CommunityEvidence {
  return { account_id: row.account_id, asset_id: row.asset_id, quantity: row.quantity!, tradable: row.tradable!, marketable: row.marketable,
    name: row.name!, class_id: row.class_id!, instance_id: row.instance_id!, first_seen_obs: row.first_seen_obs, last_seen_obs: row.last_seen_obs };
}

function csfloatOf(row: EvidenceRow): CsfloatEvidence {
  return { account_id: row.account_id, asset_id: row.asset_id, eligible: row.eligible, item: JSON.parse(row.detail_json!) as CsfloatListingItem,
    first_seen_obs: row.first_seen_obs, last_seen_obs: row.last_seen_obs };
}
