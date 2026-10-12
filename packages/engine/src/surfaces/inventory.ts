import type { AccountId, GcEvent, RawEconItem } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { groupKey, isSyntheticGcItem } from '../kernel/identity.js';
import { errorMessage } from '../kernel/support.js';
import { HoldingsStore } from '../db/holdings.js';

/** GC session, full inventory snapshots, and the incremental SO-cache event stream. */
export class InventoryService {
  private readonly eventLoops = new Map<string, { stop: boolean }>();

  constructor(protected readonly context: EngineContext) {}

  /** The holdings write path (`db/holdings.ts`): every unit row this surface writes goes through it. */
  protected get holdings(): HoldingsStore { return new HoldingsStore(this.context.database); }

  async connectGc(accountId: AccountId, timeoutMs = 30_000): Promise<void> {
    await this.context.ports.gc.connect(accountId, timeoutMs);
  }

  /**
   * Persists one complete raw snapshot before any enrichment (rollout-v3 Stage 3 gate).
   * A walk that fails — at the fetch, at staging, or part-way through the chunks — records an
   * *incomplete* observation, so that nothing downstream can infer absence from it and so that
   * the failure is visible at all.
   */
  sync(accountId: AccountId): Promise<number> {
    return this.context.reads.run(`${accountId}:gc-inventory`, () => this.walk(accountId));
  }

  private async walk(accountId: AccountId): Promise<number> {
    const { database } = this.context;
    const startedAt = this.context.now();
    let snapshot: { items: RawEconItem[]; generation: number };
    try {
      snapshot = await this.context.ports.gc.getInventorySnapshot(accountId);
    } catch (error) {
      const failed = database.insertObservation({
        accountId,
        surface: 'gc-inventory',
        startedAt,
        finishedAt: this.context.now(),
        complete: false,
        error: errorMessage(error)
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-inventory', complete: false, observationId: failed });
      return failed;
    }

    // The row opens before anything else touches the database, because every step after this
    // one can fail and a failure that leaves no row at all is indistinguishable from a walk
    // that never ran. Staging used to go first: when a migration left `inventory_backup_item`
    // one column short of `item`, its positional `SELECT *` copy threw, the refresh loop backed
    // the surface off, and every inventory walk stopped — with no observation, no error in the
    // window, and nothing in the database to say so.
    // Stock/NonEconomy SO objects are in the GC cache but are not owned inventory.
    // Filter before the observation row so totalExpected is the published set.
    const items = this.ownedInventory(snapshot.items);
    const observationId = database.insertObservation({
      accountId,
      surface: 'gc-inventory',
      generation: snapshot.generation,
      startedAt,
      finishedAt: this.context.now(),
      complete: false,
      totalExpected: items.length
    });
    try {
      this.beginStaging(accountId, 'gc-inventory', '', snapshot.generation);
    } catch (error) {
      // Staging never began — the publication marker is untouched and readers still see the
      // last published scope — so there is nothing to abort. Calling `abortStaging` here would
      // copy the same two tables back the other way and risk failing for the same reason,
      // replacing the error that explains this with one that does not.
      database.raw().prepare('UPDATE observation SET error=?, finished_at=? WHERE id=?')
        .run(errorMessage(error), this.context.now(), observationId);
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-inventory', complete: false, observationId });
      return observationId;
    }
    const chunkSize = 250;
    try {
      for (let offset = 0; offset < items.length; offset += chunkSize) {
        const chunk = items.slice(offset, offset + chunkSize);
        database.transaction(() => {
          this.holdings.replaceUnits(accountId, 'MAIN', null, chunk, observationId, false, (item) => this.stackKey(item));
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      database.transaction(() => {
        database.raw().prepare('UPDATE observation SET complete=1, finished_at=? WHERE id=?').run(this.context.now(), observationId);
        // Only now, with every chunk written under this observation, may the rows it did not
        // see be concluded absent (rule 5).
        this.holdings.sweepUnseen(accountId, 'MAIN', null, observationId);
        database.publishGeneration(accountId, 'gc-inventory', '', snapshot.generation);
        database.addEvent(accountId, 'inventory-snapshot', {
          observationId,
          generation: snapshot.generation,
          itemCount: items.length,
          gcItemCount: snapshot.items.length,
          ignoredStock: snapshot.items.length - items.length
        }, this.context.now());
      });
    } catch (error) {
      this.abortStaging(accountId, 'gc-inventory', '', snapshot.generation);
      throw error;
    }
    // Emitted after the publishing transaction commits, never inside it: a listener that reads
    // the database mid-transaction would see a scope that no reader is allowed to see yet.
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-inventory', complete: true, observationId });
    return observationId;
  }

  beginStaging(accountId: AccountId, surface: string, scopeId: string, generation: number): number {
    return this.context.database.beginStaging(accountId, surface, scopeId, generation);
  }

  abortStaging(accountId: AccountId, surface: string, scopeId: string, generation: number): void {
    this.context.database.abortStaging(accountId, surface, scopeId, generation);
  }

  /** The group key seam (holdings plan D4). A saboteur that pools by def index overrides it. */
  protected stackKey(item: RawEconItem): string {
    return groupKey(item);
  }

  /**
   * The SO cache can contain generated NonEconomy objects that Steam itself does not
   * treat as inventory. A wrong implementation would skip this filter; `StockIsOwned` does.
   */
  protected ownedInventory(items: readonly RawEconItem[]): RawEconItem[] {
    return items.filter((item) => !isSyntheticGcItem(item));
  }

  startEventLoop(accountId: AccountId): () => void {
    if (this.eventLoops.has(accountId)) throw new Error(`GC event loop already active for ${accountId}`);
    const control = { stop: false };
    this.eventLoops.set(accountId, control);
    void (async () => {
      try {
        for await (const event of this.context.ports.gc.events(accountId)) {
          if (control.stop) break;
          this.applyEvent(accountId, event);
        }
      } finally {
        this.eventLoops.delete(accountId);
      }
    })();
    return () => { control.stop = true; };
  }

  stopAllEventLoops(): void {
    for (const control of this.eventLoops.values()) control.stop = true;
    this.eventLoops.clear();
  }

  applyEvent(accountId: AccountId, event: GcEvent): void {
    if (
      (event.kind === 'added' || event.kind === 'updated')
      && this.ownedInventory([event.item]).length === 0
    ) return;
    const { database } = this.context;
    const assetId = event.kind === 'removed' ? event.itemId : event.kind === 'disconnected' ? undefined : event.item.id;
    const previous = assetId ? database.itemByAssetId(accountId, assetId) : undefined;
    if (previous?.location_generation != null && event.generation <= previous.location_generation) return;
    const casketId = event.kind === 'added' || event.kind === 'updated'
      ? event.item.casketId ?? undefined
      : previous?.casket_id ?? undefined;
    const observationId = database.transaction(() => {
      const observationId = database.insertObservation({
        accountId,
        surface: 'gc-event',
        generation: event.generation,
        startedAt: this.context.now(),
        finishedAt: this.context.now(),
        scopeKind: event.kind === 'disconnected' ? 'account' : 'item',
        ...(assetId ? { scopeId: previous?.local_id ?? assetId } : {}),
        complete: event.kind !== 'disconnected',
        totalExpected: 1
      });
      if (event.kind === 'added' || event.kind === 'updated') {
        const item = event.item;
        this.holdings.upsertUnit(accountId, item, observationId, item.casketId ? 'CASKET' : 'MAIN', item.casketId ?? null, (raw) => this.stackKey(raw));
        // A storage unit's SO update is also the freshest word on its label. Recording it
        // here, with this observation as its proof, is what lets a rename resolve on the
        // update that follows it instead of waiting for the next unit walk, and is how a
        // rename made in the game client reaches the screen (rename plan §4.2, STO-07).
        if (item.defIndex === 1201 && item.customName !== undefined) {
          database.setStorageUnitLabel(accountId, item.id, item.customName, observationId);
        }
      } else if (event.kind === 'removed') {
        const row = database.itemByAssetId(accountId, event.itemId);
        if (row) database.setItemLocation(accountId, row.local_id, observationId, 'MISSING');
      }
      database.addEvent(accountId, `gc-${event.kind}`, event, this.context.now());
      return observationId;
    });
    const { signals } = this.context;
    signals.emit({
      kind: 'observed',
      accountId,
      surface: 'gc-event',
      complete: event.kind !== 'disconnected',
      observationId,
      ...(assetId ? { scopeId: previous?.local_id ?? assetId } : {})
    });
    if (event.kind === 'disconnected') {
      signals.emit({ kind: 'gc-session', accountId, state: 'DISCONNECTED', detail: event.reason });
      return;
    }
    // A `removed` is the only hint this app ever gets that a listing may have sold, since the
    // Community Market pushes nothing and the GC keeps a listed item until it does. What it
    // schedules is a market walk, never a conclusion.
    signals.emit({
      kind: 'gc-item',
      accountId,
      change: event.kind,
      ...(casketId ? { casketId } : {})
    });
  }
}
