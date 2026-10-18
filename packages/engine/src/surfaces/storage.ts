import type { AccountId, CasketRead, MutationOutcome } from '@cslytics/ports';
import type { ActionRow } from '../db/database.js';
import { type EngineContext, type SentMutation, executeMutation, sendMutation } from '../kernel/context.js';
import { groupKey, isSyntheticGcItem } from '../kernel/identity.js';
import { HoldingsStore } from '../db/holdings.js';
import type { RawEconItem } from '@cslytics/ports';
import { errorMessage, required } from '../kernel/support.js';
import { ACCOUNT_INVENTORY, ACCOUNT_STORAGE_UNITS, attemptReturned, locationEvidence, surfaceEvidence, surfaceOf, postAttempt, evaluatePreconditions, PRECONDITIONS, requirePreconditions, type ActionKind, type ProofNeed } from '../kernel/evidence.js';
import { reconcileDivergence } from '../policy/divergence.js';
import { settleNotApplied } from '../kernel/not-applied.js';
import { validateCasketName } from '../policy/casket-name.js';
import type { MarketplaceConsent } from '../kernel/marketplace-commitments.js';

/**
 * `forListing`: a retrieve under a listing, which checks the listing's own preconditions before moving anything.
 * `consent`: the claims on the item the person chose to store it despite (bulk storage plan D9), frozen at admission.
 */
export type CasketParams = { casketId: string; assetId: string; forListing?: boolean; consent?: readonly MarketplaceConsent[] };
/** `previousLabel` is what a complete walk has to still show for "not applied" to mean anything. */
export type RenameParams = { casketId: string; name: string; previousLabel: string | null };

export const LABEL_CHANGED_EXTERNALLY = 'Storage unit was renamed outside this app; review before renaming it again';
export const RENAME_NOT_TAKEN = 'Steam did not take the new name twice; check the name before trying again';

export const MAIN_INVENTORY_HARD_CAP = 1000;
/** How many items one storage unit holds (corpus `cs2-gc.casket.add`: `CasketTooFull` past it). */
export const CASKET_CAPACITY = 1000;

/** One unit read: its observation, and whether the adapter answered from the cache or sent the Game Coordinator a contents load (read broker plan D5). */
export type CasketWalk = { observationId: number; transport: CasketRead['transport'] };

/** Storage-unit discovery, casket reads, and the observation-gated store/retrieve writes. */
export class StorageService {
  constructor(protected readonly context: EngineContext) {}

  async syncUnits(accountId: AccountId, contents = true): Promise<number[]> {
    const { database } = this.context;
    const startedAt = this.context.now();
    let units;
    try {
      units = await this.context.ports.gc.listStorageUnits(accountId);
    } catch (error) {
      const failed = database.insertObservation({
        accountId,
        surface: 'gc-storage-units',
        startedAt,
        finishedAt: this.context.now(),
        complete: false,
        error: errorMessage(error)
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-storage-units', complete: false, observationId: failed });
      return [failed];
    }

    const unitObservation = database.transaction(() => {
      const observationId = database.insertObservation({
        accountId,
        surface: 'gc-storage-units',
        startedAt,
        finishedAt: this.context.now(),
        complete: true,
        totalExpected: units.length
      });
      const statement = database.raw().prepare(`
        INSERT INTO storage_unit(account_id, casket_id, label, contains_count, contents_obs, state, label_obs)
        VALUES (?, ?, ?, ?, NULL, 'ACTIVE', ?)
        ON CONFLICT(account_id, casket_id) DO UPDATE SET label=excluded.label, contains_count=excluded.contains_count, label_obs=excluded.label_obs
      `);
      for (const unit of units) statement.run(accountId, unit.casketId, unit.label, unit.containsCount, observationId);
      database.touch(accountId, 'storage_unit');
      return observationId;
    });

    this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-storage-units', complete: true, observationId: unitObservation });

    const observations = [unitObservation];
    // The unit list and every unit's contents are two different costs. A cadence pass wants the
    // cheap one — labels, counts, a unit that appeared — and leaves contents to the triggers that
    // actually imply a change: a GC event naming that casket, a store or retrieve settling, or
    // the post-reconnect sweep. Walking every casket on a timer would spend the GC budget proving
    // nothing changed, because while this app holds the exclusive session nothing else can.
    if (contents) {
      for (const unit of units) observations.push((await this.syncCasket(accountId, unit.casketId)).observationId);
    }
    return observations;
  }

  /**
   * Reads one storage unit.
   *
   * A read counts as complete only when the adapter says `complete`, the count and the item
   * set come from one cache state, and the two agree. The adapter reads the count after the
   * children are in hand, so a load's own SO creates cannot make a read incomplete, and a count
   * that moved during the read does — see cslytics-app-docs/steam/storage-units.md for why the
   * earlier notification-and-generation rule was never once satisfied live.
   */
  async syncCasket(accountId: AccountId, casketId: string): Promise<CasketWalk> {
    const { database } = this.context;
    const startedAt = this.context.now();
    let read: CasketRead;
    try {
      read = await this.context.ports.gc.getCasketContents(accountId, casketId);
    } catch (error) {
      const failed = database.insertObservation({
        accountId,
        surface: 'gc-casket',
        scopeKind: 'casket',
        scopeId: casketId,
        startedAt,
        finishedAt: this.context.now(),
        complete: false,
        error: errorMessage(error)
      });
      this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-casket', scopeId: casketId, complete: false, observationId: failed });
      // A read that threw asked the wire for nothing it was charged for; the adapter did not say.
      return { observationId: failed, transport: 'cache' };
    }

    const complete = read.completeness === 'complete'
      && read.countGeneration === read.itemsGeneration
      && read.items.length === read.containsCount;

    const observationId = database.transaction(() => {
      const observationId = database.insertObservation({
        accountId,
        surface: 'gc-casket',
        scopeKind: 'casket',
        scopeId: casketId,
        generation: read.itemsGeneration,
        startedAt,
        finishedAt: this.context.now(),
        complete,
        totalExpected: read.containsCount,
        ...(complete ? {} : { error: `casket-${read.completeness}` })
      });
      database.raw().prepare(`
        UPDATE storage_unit SET contains_count=?, contents_obs=?, state=CASE WHEN ? >= ? THEN 'FULL' ELSE state END
        WHERE account_id=? AND casket_id=?
      `).run(read.containsCount, observationId, read.containsCount, CASKET_CAPACITY, accountId, casketId);
      database.touch(accountId, 'storage_unit');

      const owned = read.items.filter((item) => !isSyntheticGcItem(item));
      this.persistCasketContents(accountId, casketId, owned, observationId, complete);
      return observationId;
    });
    this.context.signals.emit({ kind: 'observed', accountId, surface: 'gc-casket', scopeId: casketId, complete, observationId });
    return { observationId, transport: read.transport };
  }

  queueStore(accountId: AccountId, localId: string, casketId: string, commandId: string | null = null): ActionRow {
    const params = this.storeParams(accountId, localId, casketId);
    return this.context.database.createDesiredAction({
      accountId,
      targetKind: 'item-location',
      targetId: localId,
      intent: 'CASKET',
      params,
      commandId,
      actionKind: 'STORE_IN_CASKET',
      resourceKey: `item:${localId}`,
      now: this.context.now()
    });
  }

  /** The store hop of a command: the same admission as `queueStore`, on the hop's action rather than a goal's (D3). */
  queueStoreStep(accountId: AccountId, localId: string, casketId: string, stepId: string, consent: readonly MarketplaceConsent[] = []): ActionRow {
    const params = { ...this.storeParams(accountId, localId, casketId), ...(consent.length ? { consent } : {}) };
    return this.context.database.enqueueAction({ accountId, stepId, actionKind: 'STORE_IN_CASKET', targetId: localId, resourceKey: `item:${localId}`, params, now: this.context.now() });
  }

  private storeParams(accountId: AccountId, localId: string, casketId: string): CasketParams {
    const { database } = this.context;
    const item = required(database.itemByLocalId(accountId, localId), `Unknown item ${localId}`);
    if (item.location !== 'MAIN' || !item.asset_id) throw new Error('Item is not in main inventory');
    if (item.trade_protected_until && new Date(item.trade_protected_until) > this.context.ports.clock.now()) {
      throw new Error('Trade-protected items cannot be stored');
    }
    return { casketId, assetId: item.asset_id };
  }

  queueRetrieve(accountId: AccountId, localId: string, casketId: string, commandId: string | null = null): ActionRow {
    const params = this.retrieveParams(accountId, localId, casketId);
    return this.context.database.createDesiredAction({
      accountId,
      targetKind: 'item-location',
      targetId: localId,
      intent: 'MAIN',
      params,
      commandId,
      actionKind: 'RETRIEVE_FROM_CASKET',
      resourceKey: `item:${localId}`,
      now: this.context.now()
    });
  }

  /**
   * The retrieve hop of a command: the same admission as `queueRetrieve`, on the hop's action (D3).
   * Under a listing it carries the listing's preconditions too, so nothing leaves a unit for a
   * listing Steam would refuse.
   */
  queueRetrieveStep(accountId: AccountId, localId: string, casketId: string, stepId: string, forListing = false): ActionRow {
    const params = { ...this.retrieveParams(accountId, localId, casketId), ...(forListing ? { forListing: true } : {}) };
    return this.context.database.enqueueAction({ accountId, stepId, actionKind: 'RETRIEVE_FROM_CASKET', targetId: localId, resourceKey: `item:${localId}`, params, now: this.context.now() });
  }

  private retrieveParams(accountId: AccountId, localId: string, casketId: string): CasketParams {
    const { database } = this.context;
    const item = required(database.itemByLocalId(accountId, localId), `Unknown item ${localId}`);
    if (item.location !== 'CASKET' || !item.asset_id) throw new Error('Item is not in the casket');
    if (database.countMainItems(accountId) >= MAIN_INVENTORY_HARD_CAP) throw new Error('Main inventory hard cap reached');
    return { casketId, assetId: item.asset_id };
  }

  /**
   * One instruction: call this unit that.
   *
   * The name is checked here, before anything is sent, because the GC answers a name it will
   * not take with silence and silence is `AMBIGUOUS` (`policy/casket-name.ts`). The observed
   * label is captured as `previousLabel` so the reconciler can later tell "not applied" from
   * "somebody else renamed it".
   */
  queueRename(accountId: AccountId, casketId: string, name: string, commandId: string | null = null): ActionRow {
    const { database } = this.context;
    const trimmed = name.trim();
    const reason = this.validateName(trimmed);
    if (reason) throw new Error(reason);
    const unit = required(database.storageUnit(accountId, casketId), `Unknown storage unit ${casketId}`);
    if (unit.label === trimmed) throw new Error('The storage unit already has that name');
    return database.createDesiredAction({
      accountId,
      targetKind: 'casket-label',
      targetId: casketId,
      intent: 'LABELLED',
      params: { casketId, name: trimmed, previousLabel: unit.label } satisfies RenameParams,
      commandId,
      actionKind: 'RENAME_CASKET',
      resourceKey: `casket:${accountId}:${casketId}`,
      now: this.context.now()
    });
  }

  /** The names the GC would refuse, refused first. A saboteur overrides this; nothing shipped does. */
  protected validateName(name: string): string | null {
    return validateCasketName(name);
  }

  async execute(actionId: string): Promise<MutationOutcome> {
    const action = required(this.context.database.action(actionId), `Unknown action ${actionId}`);
    if (action.kind === 'RENAME_CASKET') return this.executeRename(action);
    return (await this.send(actionId)).answer;
  }

  /**
   * Sends one store or retrieve and returns once it has gone out, with its answer still to come.
   * A command's pass sends its next move without waiting for this one's answer (bulk storage plan
   * D1); the per-kind budget in `executeMutation` is what spaces the sends. A refusal before
   * anything went out — a precondition, a pledge, an open breaker — is thrown, as before.
   */
  async send(actionId: string): Promise<SentMutation> {
    const { database } = this.context;
    const action = required(database.action(actionId), `Unknown action ${actionId}`);
    if (!['STORE_IN_CASKET', 'RETRIEVE_FROM_CASKET'].includes(action.kind)) throw new Error('Not a casket action');
    const params = database.actionParams(action) as CasketParams;
    const validate = (): void => {
      const forListing = params.forListing === true || (action.desired_id !== null && database.desiredState(action.desired_id)?.intent === 'LISTED_AT');
      const checks = forListing
        ? [...PRECONDITIONS[action.kind as ActionKind], 'market-lock' as const, 'no-open-order' as const] : PRECONDITIONS[action.kind as ActionKind];
      requirePreconditions(evaluatePreconditions(database, action.account_id, action.target_id, checks, this.context.ports.clock.now(), params.casketId, params.consent));
      if (action.kind === 'RETRIEVE_FROM_CASKET') {
        const reserved = database.actions(action.account_id).filter((pending) => pending.id !== action.id && pending.kind === 'RETRIEVE_FROM_CASKET'
          && ['RUNNING','AWAITING_OBSERVATION'].includes(pending.state) && database.itemByLocalId(action.account_id, pending.target_id)?.location !== 'MAIN').length;
        if (database.countMainItems(action.account_id) + reserved >= MAIN_INVENTORY_HARD_CAP) throw new Error('Main inventory capacity is reserved by pending retrievals');
      }
      const item = required(database.itemByLocalId(action.account_id, action.target_id), 'Casket action no longer matches the observed item');
      if (item.asset_id !== params.assetId || (action.kind === 'RETRIEVE_FROM_CASKET' && item.casket_id !== params.casketId)) throw new Error('Casket action no longer matches the observed item');
    };
    // A move owed a read, or refused, says so before it takes a slot of the send budget, and is
    // checked again once it has one. A pass over 178 retrieves each owed the same read spent half
    // a minute pacing sends that never went (L-10, 2026-10-16).
    validate();
    return sendMutation(this.context, action, () => action.kind === 'STORE_IN_CASKET'
      ? this.context.ports.gc.addToCasket(action.account_id, params.casketId, params.assetId)
      : this.context.ports.gc.removeFromCasket(action.account_id, params.casketId, params.assetId), validate);
  }

  async executeBatch(actionIds: readonly string[]): Promise<MutationOutcome[]> {
    const results: MutationOutcome[] = [];
    for (const actionId of actionIds) results.push(await this.execute(actionId));
    return results;
  }

  private executeRename(action: ActionRow): Promise<MutationOutcome> {
    const { database } = this.context;
    const params = database.actionParams(action) as RenameParams;
    return executeMutation(
      this.context,
      action,
      () => this.context.ports.gc.nameItem(action.account_id, params.casketId, params.name),
      () => requirePreconditions(evaluatePreconditions(
        database, action.account_id, action.target_id, PRECONDITIONS.RENAME_CASKET, this.context.ports.clock.now(), params.casketId
      ))
    );
  }

  /**
   * Decides a rename from the label's own proof, never from the notification.
   *
   * `storage_unit.label_obs` names the observation that last wrote the label — a complete unit
   * walk, or the SO update `InventoryService.applyEvent` records for the unit. Only one that
   * started after the attempt can say anything about the attempt:
   *
   *  - it carries the requested name → applied;
   *  - it carries a third name → somebody renamed the unit in the game client meanwhile. The
   *    same loop a cancelled listing goes to: suspend with one reason, never re-send (STO-07);
   *  - it carries the old name and is a complete walk → not applied. A sighting is not an
   *    absence claim (rule 5), so an SO update showing the old name proves nothing here. The
   *    action goes back to READY for a deliberate second try; a second miss suspends, because
   *    a name Steam declines twice is a name, not a lost reply.
   */
  private reconcileRename(action: ActionRow): void {
    const { database } = this.context;
    const accountId = action.account_id;
    const params = database.actionParams(action) as RenameParams;
    const unit = database.storageUnit(accountId, params.casketId);
    if (!unit || unit.label_obs === null) return;
    const proof = database.observation(accountId, unit.label_obs);
    if (!proof || !postAttempt(database, action, proof, false)) return;
    const now = this.context.now();
    if (unit.label === params.name) {
      database.resolveAction(action, proof.id, true, now);
      return;
    }
    if (unit.label !== params.previousLabel) {
      database.resolveAction(action, proof.id, false, now);
      database.suspendGoal(accountId, database.goalOf(action), LABEL_CHANGED_EXTERNALLY, now);
      return;
    }
    if (surfaceOf(proof) !== 'gc-storage-units' || !postAttempt(database, action, proof, true)) return;
    // The cap is `kernel/retry-policy.ts`; the words on the second miss are this file's contract.
    settleNotApplied(this.context, action, proof.id, 'Steam kept the old name', { exhaustedReason: RENAME_NOT_TAKEN });
  }

  /**
   * What a casket read writes: every unit of either kind at `CASKET` in this unit, and — only
   * when the read was complete — every row the read did not see marked `MISSING` (rule 5). A
   * saboteur that writes the contents as if they were loose overrides this.
   */
  protected persistCasketContents(accountId: AccountId, casketId: string, items: readonly RawEconItem[], observationId: number, complete: boolean): void {
    new HoldingsStore(this.context.database).replaceUnits(accountId, 'CASKET', casketId, items, observationId, complete, (item) => this.stackKey(item));
  }

  /** The group key seam (holdings plan D4). A saboteur that pools by def index overrides it. */
  protected stackKey(item: RawEconItem): string {
    return groupKey(item);
  }

  /**
   * Whether the observation that places an item where a move wanted it may prove the move. Every
   * observation may, the item's own Game Coordinator event included: a retrieve is proved by its SO
   * create (bulk storage plan D5, BULK-06). Isolated so a saboteur can wait for a walk instead.
   */
  protected proves(_accountId: AccountId, _observationId: number): boolean {
    return true;
  }

  /**
   * Records a move a complete unit read and inventory walk proved did not land: through
   * `settleNotApplied`, the one way, so the retry row's cap ends it (BULK-05). Isolated so a saboteur
   * can bring back the bypass that let a move read *Trying again* for ever.
   */
  protected notApplied(action: ActionRow, observationId: number, what: string): void {
    settleNotApplied(this.context, action, observationId, what);
  }

  /** What a waiting casket action needs walked before `reconcile` can settle it (settling and read path plan D5). */
  needs(action: ActionRow): ProofNeed {
    const { database } = this.context;
    const after = attemptReturned(database, action);
    if (action.kind === 'RENAME_CASKET') return { kind: 'walks', walks: [{ ref: ACCOUNT_STORAGE_UNITS, startedAfter: after }] };
    if (action.kind !== 'STORE_IN_CASKET' && action.kind !== 'RETRIEVE_FROM_CASKET') return { kind: 'none' };
    const { casketId } = database.actionParams(action) as CasketParams;
    return { kind: 'walks', walks: [
      { ref: ACCOUNT_INVENTORY, startedAfter: after },
      { ref: { surface: 'gc-casket', scope: { kind: 'casket', id: casketId } }, startedAfter: after }
    ] };
  }

  /**
   * Decides applied/not-applied for casket actions strictly from post-attempt observations: every
   * waiting one, or with `about`, only those about these items (and any rename), which is all an
   * item event can decide.
   */
  reconcile(accountId: AccountId, about?: ReadonlySet<string>): void {
    const { database } = this.context;
    // A settle earned only by item events can change the verdict on those items' moves and on
    // nothing else: every other proof is a walk, and a walk earns a full settle. Judged in full on
    // every event, a store of 968 judged each of its waiting stores twice an answer, and by the
    // 300th the engine read answers later than the GC sent them (casket pace probe, 2026-10-18).
    const waiting = about ? database.awaitingActionsAbout(accountId, [...about]) : database.actions(accountId, 'AWAITING_OBSERVATION');
    for (const action of waiting) {
      if (action.kind === 'RENAME_CASKET') {
        this.reconcileRename(action);
        continue;
      }
      if (!['STORE_IN_CASKET', 'RETRIEVE_FROM_CASKET'].includes(action.kind)) continue;

      const params = database.actionParams(action) as CasketParams;
      const item = database.itemByLocalId(accountId, action.target_id);
      const now = this.context.ports.clock.now();
      const casket = surfaceEvidence(database, accountId, { surface: 'gc-casket', scope: { kind: 'casket', id: params.casketId } }, now, true, action);
      const inventory = surfaceEvidence(database, accountId, ACCOUNT_INVENTORY, now, true, action);
      const wanted = action.kind === 'STORE_IN_CASKET' ? 'CASKET' : 'MAIN';
      const location = locationEvidence(database, accountId, action.target_id, wanted, now, action);

      if (location.grade === 'SATISFIED' && this.proves(accountId, location.observationId) && (action.kind === 'RETRIEVE_FROM_CASKET' || item?.casket_id === params.casketId)) {
        database.resolveAction(action, location.observationId, true, this.context.now());
        database.releaseSlot(accountId, action.id, action.kind === 'RETRIEVE_FROM_CASKET');
      } else if (casket.grade === 'SATISFIED' && inventory.grade === 'SATISFIED'
        && ((action.kind === 'STORE_IN_CASKET' && item?.location === 'MAIN')
          || (action.kind === 'RETRIEVE_FROM_CASKET' && item?.location === 'CASKET' && item?.casket_id === params.casketId))) {
        // The one way a proof of absence is recorded: `READY` for the next round while under the
        // cap, `FAILED` with these words after the fourth send (kernel/retry-policy.ts, BULK-05).
        this.notApplied(action, casket.observationId, action.kind === 'STORE_IN_CASKET' ? 'Steam kept it in your inventory' : 'Steam kept it in the storage unit');
        database.releaseSlot(accountId, action.id, false);
      }
    }
    // A storage divergence is not a storage lifecycle: it goes to the same loop a cancelled
    // listing goes to (order-lifecycle.md §2.1).
    reconcileDivergence(this.context, accountId);
  }
}
