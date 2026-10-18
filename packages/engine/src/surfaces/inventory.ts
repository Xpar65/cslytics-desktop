import type { AccountId, GcEvent, RawEconItem } from '@cslytics/ports';
import type { EngineContext } from '../kernel/context.js';
import { groupKey, isSyntheticGcItem } from '../kernel/identity.js';
import { errorMessage } from '../kernel/support.js';
import { HoldingsStore } from '../db/holdings.js';
import type { ItemRow } from '../db/database.js';

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
   * A walk that fails — at the fetch or at the write — records an *incomplete* observation, so
   * that nothing downstream can infer absence from it and so that the failure is visible at all.
   */
  async sync(accountId: AccountId): Promise<number> {
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
    // Stock/NonEconomy SO objects are in the GC cache but are not owned inventory. Filtered
    // before the observation row, so totalExpected is the set the walk writes.
    return this.recordSnapshot(accountId, startedAt, snapshot.generation, this.ownedInventory(snapshot.items));
  }

  /**
   * The walk on record first, incomplete, then its one write. The row opens before the write
   * because the write can fail, and a failure that leaves no row is indistinguishable from a walk
   * that never ran: when a migration once left the staging copy a column short, every walk threw
   * before anything was written and nothing in the record said so (N-SCALE-08).
   */
  protected async recordSnapshot(accountId: AccountId, startedAt: string, generation: number, items: readonly RawEconItem[]): Promise<number> {
    const { database } = this.context;
    const observationId = database.insertObservation({
      accountId,
      surface: 'gc-inventory',
      generation,
      startedAt,
      finishedAt: this.context.now(),
      complete: false,
      totalExpected: items.length
    });
    try {
      await this.writeSnapshot(accountId, observationId, items);
    } catch (error) {
      database.raw().prepare('UPDATE observation SET error=?, finished_at=? WHERE id=?').run(errorMessage(error), this.context.now(), observationId);
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-inventory', complete: false, observationId });
      return observationId;
    }
    // Emitted after the transaction commits, never inside it: a listener that reads the database
    // mid-transaction would see rows no reader is allowed to see yet.
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-inventory', complete: true, observationId });
    return observationId;
  }

  /**
   * Every unit of the scope under this observation, the rows it did not show swept, the
   * observation complete: one transaction (consolidation plan D8). The snapshot is already in
   * memory and a scope holds at most 1,000 units, so there is nothing to chunk; a reader sees the
   * old rows whole until the commit and the new rows whole after it, never a mix (REC-06).
   * Absence is concluded only here, with every row written (rule 5).
   */
  protected async writeSnapshot(accountId: AccountId, observationId: number, items: readonly RawEconItem[]): Promise<void> {
    const { database } = this.context;
    database.transaction(() => {
      this.holdings.replaceUnits(accountId, 'MAIN', null, items, observationId, true, (item) => this.stackKey(item));
      database.raw().prepare('UPDATE observation SET complete=1, finished_at=? WHERE id=?').run(this.context.now(), observationId);
    });
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
        for await (const first of this.context.ports.gc.events(accountId)) {
          if (control.stop) break;
          for (const event of this.batch(accountId, first)) {
            if (control.stop) break;
            this.applyEvent(accountId, event);
          }
        }
      } finally {
        this.eventLoops.delete(accountId);
      }
    })();
    return () => { control.stop = true; };
  }

  /**
   * The events applied in one turn: the one the loop was woken by and every one the queue holds
   * behind it (read broker plan D13). Each still writes its own observation row and decides for
   * itself whether it is a hint; what a batch buys is one settle for the burst, where the loop
   * used to settle once per event — 1,707 a minute while a unit's children loaded (L-10,
   * 2026-10-16). Isolated so a saboteur can take them one at a time.
   */
  protected batch(accountId: AccountId, first: GcEvent): GcEvent[] {
    return [first, ...this.context.ports.gc.drainEvents(accountId)];
  }

  stopAllEventLoops(): void {
    for (const control of this.eventLoops.values()) control.stop = true;
    this.eventLoops.clear();
  }

  /**
   * Whether the record already explains an item event, so that it is no hint of anything: the cache
   * shows the item where the record has it (a unit's contents loading as it is read, a unit's own
   * count changing), the cache lets go of a unit's resident (reading one unit unloads another's
   * contents), or one of our own stores or retrieves is moving it, which its command's round read
   * proves (bulk storage plan D5). Decided before the event is applied.
   *
   * Live on 2026-10-16, each unit read unloaded the other unit, whose residents' removals asked for
   * it to be read again, and the two units were read in turn every five seconds for as long as the
   * session lasted (L-10).
   */
  protected explains(accountId: AccountId, event: GcEvent, previous: ItemRow | undefined, casketId: string | undefined): boolean {
    if (!previous || event.kind === 'disconnected') return false;
    const agrees = event.kind === 'removed'
      ? previous.location === 'CASKET'
      : previous.location === (casketId ? 'CASKET' : 'MAIN') && (previous.casket_id ?? undefined) === casketId;
    return agrees || this.context.database.casketMoveOut(accountId, previous.local_id);
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
    const explained = this.explains(accountId, event, previous, casketId);
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
        // A `removed` for a row the record holds in a unit says the SO cache no longer carries
        // that resident: a retrieve, an unload, a leak. It never says the unit lost it; only a
        // complete read of the unit may conclude absence there (rule 5). A loose row leaving the
        // cache is the one hint the GC gives that it left the account, and stays one.
        if (row && row.location !== 'CASKET') database.setItemLocation(accountId, row.local_id, observationId, 'MISSING');
      }
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
    // An explained event is no hint of anything. Each used to ask for the inventory, the unit, the
    // book, its history and the wallet, and a bulk move of 282 kept all five reading at the budget's
    // rate, against the command's own reads (L-10, 2026-10-16).
    if (explained) return;
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
