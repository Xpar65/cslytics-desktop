import { randomUUID } from 'node:crypto';
import { pageCommandMembers, pageTransfers, readDetail, bounded, csfloatOperationAccount, selectionAccounts, selectionMembers, type TradingEngine, type ObservationRow, type ReadOutcome, type RefusalReason, type CommandRequest, type ListingFilter, type TransferMember, type TransferPreview } from '@cslytics/engine';
import type { EngineCommand } from '../../shared/api.js';

export function createRuntimeDispatch(engine: TradingEngine, hasStoredCredential: (id: string) => Promise<boolean>) {
async function dispatch(command: EngineCommand): Promise<unknown> {
  switch (command.type) {
    case 'csfloat.page': return engine.views.csfloatPage(command.accountId,command.book,command.cursor);
    case 'csfloat.overview': return engine.views.csfloatOverview(command.accountId);
    case 'csfloat.protection': return engine.setMarketplaceProtection(command.enabled);
    case 'csfloat.refresh': {
      if (command.eligibility) await ensureGc(command.accountId);
      await engine.csfloatSelling.refresh(command.accountId,command.eligibility);
      await engine.csfloatBuying.refresh(command.accountId);
      return engine.views.csfloatOverview(command.accountId);
    }
    case 'csfloat.list': {
      // Admission reads again whatever it would otherwise refuse on age, Steam's inventory among
      // it, and that read goes through the Game Coordinator. The reply is the admission: the
      // engine sends behind it and the window reads `work.open`, as for a Steam command.
      for (const accountId of new Set(command.members.map(member => member.accountId))) await ensureGc(accountId);
      const operations = await engine.csfloatSelling.submit(command);
      return operations.map(op => ({ id: op.id, accountId: op.account_id, state: op.state }));
    }
    case 'csfloat.reprice':
    case 'csfloat.cancel': {
      const op = await engine.csfloatSelling.submitEdit(command.accountId,command.commandId,command.listingId,command.type === 'csfloat.reprice' ? command.priceCents : undefined);
      return { id: op.id, accountId: op.account_id, state: op.state };
    }
    case 'csfloat.buyOrderEdit': {
      // The reply is the admission: the engine sends behind it, and the Buy orders row reads the
      // operation the way it reads a Steam cancel's action (rule 1).
      const op = await engine.csfloatBuying.submitEdit(command.accountId,command.commandId,command.orderId,{ maxPriceCents: command.maxPriceCents, quantity: command.quantity,
        ...(command.constraints ? { constraints: command.constraints } : {}) });
      return { id: op.id, accountId: op.account_id, state: op.state };
    }
    case 'csfloat.buyOrderCancel': {
      const op = await engine.csfloatBuying.submitCancel(command.accountId,command.commandId,command.orderId);
      return { id: op.id, accountId: op.account_id, state: op.state };
    }
    case 'csfloat.deliver': {
      await ensureGc(command.accountId);
      await engine.csfloatSelling.refresh(command.accountId,true);
      const delivery = engine.csfloatDelivery.queue(command.accountId,command.commandId,command.tradeId);
      await engine.csfloatDelivery.advance(delivery.id);
      return null;
    }
    case 'csfloat.deliveryRefresh': {
      if (csfloatOperationAccount(engine.database, command.operationId) !== command.accountId) throw new Error('Delivery belongs to another account');
      await engine.csfloatSelling.refresh(command.accountId,true);
      await engine.csfloatDelivery.advance(command.operationId);
      return null;
    }
    case 'csfloat.cannotDeliver': {
      if (csfloatOperationAccount(engine.database, command.operationId) !== command.accountId) throw new Error('Delivery belongs to another account');
      await engine.csfloatDelivery.cannotDeliver(command.operationId);
      await engine.csfloatDelivery.advance(command.operationId);
      return null;
    }
    case 'transfer.refresh': return engine.transfers.refresh(command.destinationAccountId,command.accountIds);
    case 'transfer.cancel': return engine.transfers.cancel(command.commandId,command.accountId);
    case 'transfers.page': return pageTransfers(engine.database,definedFields(command));
    case 'transfer.plan':
    case 'transfer.submit': {
      const members: TransferMember[] = command.members?.map(definedFields) ?? [];
      if (command.manifestToken) {
        const draft = engine.database.draft(command.manifestToken);
        if (!draft || draft.preparing || draft.state !== 'DRAFT' || draft.revision !== command.manifestRevision) throw new Error('Selection token is stale');
        const rows = selectionMembers(engine.database, draft.id, 6201);
        if (rows.length > 6200) throw new Error('Transfer selection exceeds the request size bound');
        members.push(...rows.map(row => ({accountId:row.accountId,quantity:row.quantity,casketId:row.casketId,
          ...(row.stackKey ? {stackKey:row.stackKey} : {localId:row.memberId})})));
      }
      if(command.type === 'transfer.plan') {
        const plan=engine.transfers.plan(command.destinationAccountId,members);
        return bounded<TransferPreview>({...plan,groups:plan.groups.map(group=>({accountId:group.accountId,quantity:group.assets.reduce((n,a)=>n+a.quantity,0)}))});
      }
      return engine.transfers.submit({commandId:command.commandId,destinationAccountId:command.destinationAccountId,members});
    }
    case 'storage.contentsPage': return engine.pageInventory({ ...definedFields(command), filter: { location: 'CASKET', casketId: command.casketId } });
    case 'inventory.detail': return readDetail(engine.database, 'inventory', command.accountId, command.id);
    case 'orders.detail': return readDetail(engine.database, 'orders', command.accountId, command.id);
    case 'orders.close': return engine.closeOrder(command.accountId, command.orderId, command.as);
    case 'history.detail': return readDetail(engine.database, 'history', command.accountId, command.id);
    case 'trades.detail': return readDetail(engine.database, 'trades', command.accountId, command.id);
    case 'ledger.detail': return readDetail(engine.database, 'ledger', command.accountId, command.id);
    case 'activity.detail': return readDetail(engine.database, 'activity', command.accountId, command.id);
    case 'command.membersPage': return pageCommandMembers(engine.database, definedFields(command));
    case 'selection.matching': return engine.commands.captureMatching({ accountIds: command.accountIds, filter: engineFilter(command.filter) });
    case 'auth.beginQr':
      return engine.sessions.beginQrLogin();
    case 'auth.pollQr':
      return engine.sessions.pollQrLogin(command.sessionHandle);
    case 'auth.credentials':
      return engine.sessions.beginCredentialLogin(command.username, command.password);
    case 'auth.guard':
      return engine.sessions.submitGuardCode(command.sessionHandle, command.code);
    case 'auth.cancel':
      await engine.sessions.cancelLogin(command.sessionHandle);
      return { kind: 'cancelled' };
    case 'auth.refresh': {
      const connection = await engine.sessions.connect(command.accountId);
      if (connection.steam.kind !== 'authenticated') {
        throw new Error(connection.lastError ?? 'Steam rejected the stored session');
      }
      return {
        kind: 'authed',
        accountId: connection.accountId,
        accountName: connection.steam.accountName,
        steamId64: connection.steam.steamId64
      };
    }
    case 'marketplace.connect': {
      const result = await engine.connectMarketplace(command.accountId, command.apiKey);
      // The reply says what happened and never echoes what was sent.
      return result;
    }
    case 'marketplace.disconnect':
      await engine.disconnectMarketplace(command.accountId, command.mode);
      return engine.marketplaceStatus(command.accountId);
    case 'marketplace.status': return engine.marketplaceStatus(command.accountId);
    case 'marketplace.refresh': return engine.refreshMarketplaceStatus(command.accountId);
    case 'marketplace.stall': return engine.updateMarketplaceStall(command.accountId, {
      ...(command.away === undefined ? {} : { away: command.away }),
      ...(command.stallPublic === undefined ? {} : { stallPublic: command.stallPublic })
    });
    case 'accounts.list': {
      const listed = [];
      for (const row of engine.listAccounts()) {
        listed.push({
          id: row.id,
          accountName: row.account_name,
          steamId64: row.steam_id64,
          hasSession: await hasStoredCredential(row.id),
          avatarRef: row.avatar_hash && /^[0-9a-f]{40}$/i.test(row.avatar_hash)
            ? `avatar:${row.avatar_hash.toLowerCase()}`
            : null,
          personaName: row.persona_name
        });
      }
      return listed;
    }
    case 'inventory.sync':
      await ensureGc(command.accountId);
      return (await engine.observe(command.accountId, 'gc-inventory'))?.id ?? null;
    case 'inventory.read': return engine.inventory(command.accountId);
    case 'inventory.page': {
      const rest = definedFields(command);
      if (rest.sort === 'name') throw new Error('inventory page reached the engine sorted by name; main must resolve a name sort to keyOrder');
      return engine.pageInventory({
        accountIds: rest.accountIds,
        ...(rest.pageSize !== undefined ? { pageSize: rest.pageSize } : {}),
        ...(rest.sort !== undefined ? { sort: rest.sort } : {}),
        ...(rest.keyOrder !== undefined ? { keyOrder: rest.keyOrder } : {}),
        ...(rest.direction !== undefined ? { direction: rest.direction } : {}),
        ...(rest.cursor !== undefined ? { cursor: rest.cursor } : {}),
        ...(rest.filter !== undefined ? { filter: engineFilter(rest.filter) } : {})
      });
    }
    case 'inventory.groups': {
      const rest = definedFields(command);
      return engine.pageInventoryGroups({
        accountIds: rest.accountIds,
        ...(rest.pageSize !== undefined ? { pageSize: rest.pageSize } : {}),
        ...(rest.cursor !== undefined ? { cursor: rest.cursor } : {}),
        ...(rest.filter !== undefined ? { filter: engineFilter(rest.filter) } : {})
      });
    }
    // The valuation's read (portfolio and pricing plan D6): identity keys and wear bands, which
    // main spells into market names. The envelope is `positions` or `needs-filter`, never a page.
    case 'inventory.positions': {
      const rest = definedFields(command);
      return engine.pageInventoryPositions({
        accountIds: rest.accountIds,
        ...(rest.filter !== undefined ? { filter: engineFilter(rest.filter) } : {})
      });
    }
    // Two read-only relays. Main interprets neither: `work.open` rows are decorated with names on
    // the way out and nothing more, and eligibility is the engine's answer verbatim.
    case 'work.open': return engine.views.pageOpenWork({ accountIds: command.accountIds });
    case 'waiting.open': return engine.views.pageWaiting({ accountIds: command.accountIds });
    case 'csfloat.eligibility': return engine.views.csfloatEligibility(command.accountId, command.localIds);
    case 'history.page': return engine.pageHistory({ ...definedFields(command), ...(command.filter ? { filter: definedFields(command.filter) } : {}) });
    case 'activity.page': return engine.pageActivity(definedFields(command));
    case 'storage.page': return engine.pageStorage(definedFields(command));
    case 'orders.page': return engine.pageOrders({ ...definedFields(command), ...(command.filter ? { filter: definedFields(command.filter) } : {}) });
    case 'trades.page': return engine.pageTrades({ ...definedFields(command), ...(command.filter ? { filter: definedFields(command.filter) } : {}) });
    case 'ledger.page': return engine.pageLedger({ ...definedFields(command), ...(command.filter ? { filter: definedFields(command.filter) } : {}) });
    // Cross-venue and cross-account. Relayed verbatim in both directions: the scope is whatever
    // the window named (rule 8), and the engine answers with identity keys that main names on
    // the way out.
    case 'listings.page': return engine.pageListings({ ...definedFields(command), ...(command.filter ? { filter: listingEngineFilter(command.filter) } : {}) });
    case 'listings.summary': return engine.listingsSummary({ ...definedFields(command), ...(command.filter ? { filter: listingEngineFilter(command.filter) } : {}) });
    case 'trades.list': return engine.views.pageTradeEntries(definedFields(command));
    case 'trades.summary': return engine.views.summariseTrades(definedFields(command));
    case 'trades.entry': return engine.views.readTradeEntry(definedFields(command));
    case 'trades.items': return engine.views.pageTradeItems(definedFields(command));
    case 'trades.sync': {
      const offers = await engine.observeOutcome(command.accountId, 'steam-trade-offers');
      const history = await engine.observeOutcome(command.accountId, 'steam-trade-history');
      return { offers: walkReply(offers), history: walkReply(history) };
    }
    case 'selection.capture': return engine.captureSelection({
      accountIds: command.accountIds,
      members: command.members.map(definedFields)
    });
    case 'selection.read': return engine.readSelection(command.token);
    case 'selection.exclude': return engine.updateSelection(command.token, command.revision, {
      exclude: command.members.map((member) => ({ accountId: member.accountId, localId: member.localId }))
    });
    case 'store.precheck': return engine.commands.precheck({
      ...(command.members ? { members: command.members } : {}),
      ...(command.manifestToken ? { manifestToken: command.manifestToken } : {}),
      destinations: command.destinations
    });
    case 'command.read': return engine.commandProgress(command.commandId);
    case 'command.stop': return engine.stopCommand(command.commandId);
    case 'storage.sync':
      await ensureGc(command.accountId);
      return engine.observeStorage(command.accountId);
    case 'storage.read': return engine.storageView(command.accountId);
    case 'storage.store':
      return submitApprovedCommand({
        commandId: randomUUID(),
        kind: 'STORE',
        members: command.localIds.map((localId) => ({
          accountId: command.accountId,
          localId,
          destinationCasketId: command.casketId
        }))
      });
    case 'storage.retrieve':
      return submitApprovedCommand({
        commandId: randomUUID(),
        kind: 'RETRIEVE',
        members: command.localIds.map((localId) => ({
          accountId: command.accountId,
          localId,
          sourceCasketId: command.casketId
        }))
      });
    case 'storage.rename': {
      await ensureGc(command.accountId);
      // The rename's one precondition is a fresh unit list, and the list is the cheap read.
      await engine.observe(command.accountId, 'gc-storage-units');
      const action = engine.queueRename(command.accountId, command.casketId, command.name);
      const outcome = await engine.executeCasketAction(action.id);
      const sentAt = engine.ports.clock.now().toISOString();
      // A settled attempt is the hint to re-read the surface that can prove it (rule 1); the
      // settle after the walk resolves the action if the label is there, and no walk that began
      // before the rename can stand in for it. The reply reports what was observed, never what
      // was asked for.
      await engine.observe(command.accountId, 'gc-storage-units', { startedAfter: sentAt });
      return {
        actionId: action.id,
        outcome: outcome.kind,
        state: engine.database.action(action.id)?.state ?? null,
        label: engine.database.storageUnit(command.accountId, command.casketId)?.label ?? null
      };
    }
    case 'market.sync': return walkReply(await engine.observeOutcome(command.accountId, 'steam-market'));
    case 'market.read': return engine.marketView(command.accountId);
    case 'plan.read': return engine.dryRunPlan(command.accountId);
    case 'goals.preview': return engine.previewPlan(command.accountId);
    case 'conflicts.read': return engine.conflicts(command.accountId);
    case 'orders.read': return engine.views.orders(command.accountId);
    case 'market.history': return (await engine.observe(command.accountId, 'steam-market-history'))?.id ?? null;
    case 'conflicts.resolve': {
      const goal = engine.resolveGoalConflict(command.accountId, command.desiredId, command.resolution);
      if (command.resolution === 'resume') {
        await ensureGc(command.accountId);
        await engine.converge(command.accountId);
      }
      return goal;
    }
    case 'store.sheet': return engine.storeSheet(command.accountId);
    case 'store.refresh': {
      await ensureGc(command.accountId);
      await engine.syncStorePriceSheet(command.accountId);
      return engine.storeSheet(command.accountId);
    }
    case 'store.purchases': return engine.storePurchases(command.accountId, command.cursor);
    case 'store.buy': {
      // Admission fails closed on stale wallet evidence, and the scheduler may be minutes from
      // its next wallet read: ask for the surfaces it needs first, as buyOrder.create does.
      await ensureGc(command.accountId);
      await engine.ensureFresh(command.accountId, ['steam-wallet', 'steam-market']);
      const purchase = engine.queueStorePurchase({
        commandId: command.commandId,
        accountId: command.accountId,
        lines: command.lines.map((line) => {
          if (typeof line.defIndex !== 'number') throw new Error(`No def index was resolved for store entry ${line.entryKey}`);
          return { entryKey: line.entryKey, defIndex: line.defIndex, quantity: line.quantity, unitPriceCents: line.unitPriceCents };
        })
      });
      // The approval can take minutes. The wait runs on after this answer; the row is the record.
      void engine.advanceStorePurchase(purchase.id);
      return engine.storePurchase(command.accountId, purchase.id);
    }
    case 'store.cancel': {
      if (!engine.storePurchase(command.accountId, command.purchaseId)) throw new Error('Purchase belongs to another account');
      await ensureGc(command.accountId);
      await engine.cancelStorePurchase(command.purchaseId);
      return engine.storePurchase(command.accountId, command.purchaseId);
    }
    case 'store.continue': {
      if (!engine.storePurchase(command.accountId, command.purchaseId)) throw new Error('Purchase belongs to another account');
      await ensureGc(command.accountId);
      void engine.advanceStorePurchase(command.purchaseId);
      return engine.storePurchase(command.accountId, command.purchaseId);
    }
    case 'wallet.sync': return (await engine.observe(command.accountId, 'steam-wallet'))?.id ?? null;
    case 'listing.create':
      return submitApprovedCommand({
        commandId: randomUUID(),
        kind: 'LIST',
        members: [{
          accountId: command.accountId,
          localId: command.localId,
          priceReceiveCents: command.priceReceiveCents
        }]
      });
    case 'command.submit':
      return submitApprovedCommand({
        commandId: command.commandId,
        kind: command.kind,
        ...(command.members ? {
          members: command.members.map((member) => ({
            accountId: member.accountId,
            localId: member.localId,
            ...(member.quantity ? { quantity: member.quantity } : {}),
            ...(member.sourceCasketId ? { sourceCasketId: member.sourceCasketId } : {}),
            ...(member.destinationCasketId ? { destinationCasketId: member.destinationCasketId } : {}),
            ...(member.priceReceiveCents ? { priceReceiveCents: member.priceReceiveCents } : {})
          }))
        } : {}),
        ...(command.manifestToken ? { manifestToken: command.manifestToken } : {}),
        ...(command.manifestRevision ? { manifestRevision: command.manifestRevision } : {}),
        ...(command.destinations ? { destinations: command.destinations } : {}),
        ...(command.priceReceiveCents ? { priceReceiveCents: command.priceReceiveCents } : {}),
        ...(command.consent?.length ? { consent: command.consent } : {})
      });
    case 'listing.remove': {
      const action = engine.queueDelist(command.accountId, command.listingId);
      return engine.executeDelist(action.id);
    }
    case 'buyOrder.create':
      // Admission fails closed on stale evidence (N-BUY-06), and the scheduler may be minutes
      // from its next wallet read. Asking for the two surfaces it needs turns "rejected because
      // the balance is old" into "read the balance, then decide".
      await engine.ensureFresh(command.accountId, ['steam-wallet', 'steam-market']);
      return engine.createBuyOrder(command.accountId, {
      appId: 730,
      currency: command.currency,
      marketHashName: command.marketHashName,
      priceTotalCents: command.priceTotalCents,
      quantity: command.quantity,
      tradeFeeTax: 0,
      billing: { state: command.billingState }
    });
    case 'buyOrders.read': return engine.views.buyOrders({ accountIds: command.accountIds });
    case 'buyOrders.refresh': {
      // Sequential, as `refresh.now` is: several accounts at once is several conversations at once.
      const read: Record<string, Partial<Record<'STEAM' | 'CSFLOAT', boolean>>> = {};
      for (const accountId of command.accountIds) read[accountId] = await engine.refreshBuyOrders(accountId, command.venue);
      return read;
    }
    case 'buyOrder.cancel': {
      const action = engine.queueCancelBuyOrder(command.accountId, command.buyOrderId);
      return engine.executeCancelBuyOrder(action.id);
    }
    case 'portfolio.read': return engine.portfolio(command.accountIds);
    case 'session.status': {
      const rows = [];
      for (const accountId of command.accountIds) {
        rows.push(await engine.sessions.connection(accountId));
      }
      return rows;
    }
    case 'session.connect':
      return engine.sessions.connect(command.accountId, command.cs2 === undefined ? {} : { cs2: command.cs2 });
    case 'session.signOut':
      return engine.sessions.signOut(command.accountId);
    case 'refresh.now': {
      // What `Sync all` became. Per account when one is scoped, across every known account when
      // the all-accounts scope is (plan §9.3). Sequential for the same reason the launch sweep
      // is: several accounts at once is several Steam conversations at once.
      // Only accounts being kept current, which is to say signed in: reading one that is not would
      // sign it in, and an account left signed out stays that way until someone connects it.
      const refreshed: Record<string, readonly string[]> = {};
      const kept = new Set(engine.reads.keptCurrent());
      for (const accountId of command.accountIds) {
        if (kept.has(accountId)) refreshed[accountId] = await engine.refreshNow(accountId);
      }
      return refreshed;
    }
    case 'refresh.resume':
      return engine.refreshResumed();
    case 'accounts.clearable':
      return { refusal: engine.accountClearRefusal(command.accountId) };
    case 'refresh.status':
      return command.accountIds.map((accountId) => engine.refreshStatus(accountId));
    case 'refresh.scope':
      engine.setActiveAccount(command.accountId);
      return { kind: 'scoped', accountId: command.accountId };
    // Main answers the rest itself (`release.*`, `settings.*`, `cslytics.*`, the price commands)
    // and never forwards them. Anything else that reaches here is a command this table does not
    // know, and the answer is a refusal by name rather than `undefined`: a caller reading a field
    // off a silent nothing fails one step later, in a place that says nothing about which command
    // was missing (the `inventory.positions` gap read as "Cannot read properties of undefined").
    default:
      throw new Error(`The Engine Runtime has no handler for "${String((command as { type?: unknown }).type)}"`);
  }
}

/**
 * Makes sure there is a live GC session before a read that needs one.
 *
 * GC + the event loop only — not `sessions.connect`. Inventory sync must not refresh the
 * Steam session on every click. `connect` is cheap when a session is live and rebuilds one
 * when it is not, so asking every time is both correct and free. The loop is started once;
 * a second start is ignored rather than replacing the queue.
 */
/** Zod optional fields arrive as `T | undefined`; engine requests use exactOptionalPropertyTypes. */
function definedFields<T extends Record<string, unknown>>(value: T): {
  [K in Exclude<keyof T, 'type'>]: Exclude<T[K], undefined>
} {
  const next: Record<string, unknown> = { ...value };
  delete next.type;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as { [K in Exclude<keyof T, 'type'>]: Exclude<T[K], undefined> };
}

/**
 * The filter the engine is allowed to see.
 *
 * `search` and `category` are resolved to `matchKeys` by the main process, which is the only place
 * that holds a catalogue. If either survives this far something upstream skipped that step, and
 * passing it on would be worse than dropping it: the engine would ignore it and return every row,
 * turning a narrow search into "here is everything you own".
 *
 * `matchKeys: []` is passed through untouched. It means a name filter matched nothing.
 */
function engineFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> {
  const defined = definedFields({ type: 'filter', ...(filter ?? {}) });
  if ('search' in defined || 'category' in defined) {
    throw new Error('inventory filter reached the engine with a name in it; main must resolve search and category to matchKeys');
  }
  return defined;
}

/** The listings filter as the engine takes it. Chips are main's to resolve; one arriving here was not. */
function listingEngineFilter(filter: NonNullable<Extract<EngineCommand, { type: 'listings.page' }>['filter']>): ListingFilter {
  const { chips, ...rest } = definedFields({ type: 'filter', ...filter });
  if (chips !== undefined) throw new Error('listings filter reached the engine with chips in it; main must resolve them to matchKeys');
  return rest;
}

/** The commands that only move items through this account's own units, which ask no venue anything before admission. */
const MOVES_ONLY: ReadonlySet<CommandRequest['kind']> = new Set<CommandRequest['kind']>(['RETRIEVE', 'STORE', 'TRANSFER', 'DELIST_TO_STORE']);

async function submitApprovedCommand(request: CommandRequest): Promise<unknown> {
  // A listing's preflight refuses a member whose CSFloat coverage has lapsed rather than read an
  // unwalked stall as an empty one (CSF-13), and it is synchronous by design, so the books have to
  // be current before it runs. A move between this account's inventory and its units asks no
  // venue's age (bulk storage plan D7): the store pre-check already named what the record holds,
  // and a CSFloat read before every Store press is what made a store slow to start.
  if (!MOVES_ONLY.has(request.kind)) {
    for (const accountId of commandAccounts(request)) {
      if (engine.marketplaceStatus(accountId).status !== 'CONNECTED') continue;
      await engine.ensureFresh(accountId, ['csfloat-stall', 'csfloat-trades']);
    }
  }
  const submitted = engine.commands.prepare(request);
  if (submitted.state === 'REJECTED') throw new Error(submitted.reject_reason ?? 'Command rejected');
  return submitted;
}

/** Every account a request touches, whether its members are inline or behind a selection token. */
function commandAccounts(request: CommandRequest): string[] {
  const accounts = new Set((request.members ?? []).map((member) => member.accountId));
  if (request.manifestToken) for (const accountId of selectionAccounts(engine.database, request.manifestToken)) accounts.add(accountId);
  return [...accounts];
}

/** Why the broker made no walk, in words a sync button can show. */
const REFUSED: Record<RefusalReason, string> = {
  breaker: 'this surface failed repeatedly and is resting before it is asked again',
  'no-session': 'the account has no Game Coordinator session',
  'no-venue': 'the account is not connected to this venue',
  incomplete: 'the walk did not complete',
  withdrawn: 'the read was withdrawn before it ran'
};

/**
 * What a sync button is told about the walk it asked for: the observation's own record. A read
 * the broker refused made no walk, and says why rather than looking like an empty book (rule 5):
 * a resting surface names what it last answered, so a 429 reads as a 429.
 */
function walkReply(outcome: ReadOutcome): { observationId: number | null; complete: boolean; pagesWalked: number; totalExpected: number | null; error?: string } {
  if (outcome.kind === 'refused') {
    return { observationId: null, complete: false, pagesWalked: 0, totalExpected: null, error: `Not read: ${REFUSED[outcome.reason]}${outcome.detail ? ` (${outcome.detail})` : ''}` };
  }
  const row: ObservationRow = outcome.observation;
  return {
    observationId: row.id,
    complete: row.complete === 1,
    pagesWalked: row.pages_walked ?? 0,
    totalExpected: row.total_expected ?? null,
    ...(row.error ? { error: row.error } : {})
  };
}

async function ensureGc(accountId: string): Promise<void> {
  await engine.connectGc(accountId);
  try {
    engine.startGcEventLoop(accountId);
  } catch (error) {
    if (!/already active/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

return dispatch;
}
