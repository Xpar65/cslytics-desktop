import GlobalOffensive from 'globaloffensive';
import type {
  AccountId,
  CasketRead,
  GcEvent,
  GcStatus,
  MutationOutcome,
  RawEconAttribute,
  RawEconItem,
  SteamGcPort,
  StorageUnit,
  TerminalRead
} from '@cslytics/ports';
import type { CredentialVault } from './vault.js';
import { SteamClientSessionPool, type SteamClient } from './client-session.js';
import { decodeEconAttribute } from './econ-attributes.js';

type Session = {
  user: SteamClient;
  gc: any;
  generation: number;
  connected: boolean;
  /** The app id Steam says another session for this account is playing, or null. */
  blockedApp: number | null;
  detail: string | null;
  observedAt: string | null;
  /**
   * Survives a reconnect. `InventoryService.startEventLoop` is iterating this queue for the
   * life of the account, so replacing it would leave that loop reading a stream nothing ever
   * writes to again — a silent, permanent loss of GC events.
   */
  events: AsyncQueue<GcEvent>;
};

/**
 * Why a connect attempt failed, kept per account even when no session object exists.
 *
 * The client pool logs on *before* the GC adapter has anything to record state against, and
 * `LoggedInElsewhere` is thrown from exactly there. Without this, the clearest evidence Steam
 * ever gives — the other computer kicked us — would be lost on the way out.
 */
type Outage = { blocked: boolean; detail: string; observedAt: string };

/**
 * How many times one `connect` asks the Game Coordinator before giving up.
 *
 * Two, not more: a handshake that has failed twice is not flaky, it is unavailable, and a
 * third wait only makes the window sit longer before saying so.
 */
const GC_HANDSHAKE_ATTEMPTS = 2;

const CS2_APP_ID = 730;

/**
 * The two GC messages `globaloffensive` does not know, from Valve's `econ_gcmessages.proto`.
 *
 * `OpenCrate` (2534) replaced the struct-bodied `UnlockCrate` (1007), which the current proto
 * marks `_DEPRECATED`. Both carry a protobuf body, so they go out with a `{}` header — the
 * casket messages the library sends take the same route. Evidence and grades:
 * cslytics-app-docs/steam/crates-and-terminals.md.
 */
const MSG_OPEN_CRATE = 2534;
const MSG_VOLATILE_ITEM_LOAD_CONTENTS = 2536;

/**
 * `ItemCustomizationNotification.request` codes this adapter waits on. The casket codes were
 * already here as literals in `notificationKind`; these two are the same enum.
 */
const NOTIFY_UNLOCK_CRATE = 1007;
const NOTIFY_CASKET_CONTENTS = 1012;

/**
 * `NameItem` is a *struct* message, not protobuf: two little-endian uint64s, a zero byte and a
 * NUL-terminated name, sent with a null header, as `node-globaloffensive`'s `nameItem` writes
 * it (`name-item.json`). The notification that answers it reuses the same code.
 */
const MSG_NAME_ITEM = 1006;
const NOTIFY_NAME_ITEM = 1006;

/** Econ attributes lifted onto `RawEconItem` that `globaloffensive` leaves in `attribute[]`. */
const ATTR_EXPIRATION_DATE = 183;
const ATTR_POINTS_REMAINING = 169;
const ATTR_PURCHASE_PRICE = 316;

/**
 * Builds the CS2 handler bound to one Steam client.
 *
 * Injectable for the same reason `SteamClientSessionPool` takes its client factory: the real
 * `GlobalOffensive` refuses anything that is not a genuine steam-user, so without this seam
 * nothing about reconnection, retries or event delivery could be tested off Steam.
 */
export type GcHandlerFactory = (user: SteamClient) => any;

export class SteamGcAdapter implements SteamGcPort {
  private readonly sessions = new Map<string, Session>();
  private readonly outages = new Map<string, Outage>();

  constructor(
    vault: CredentialVault,
    private readonly operationTimeoutMs = 30_000,
    private readonly clients = new SteamClientSessionPool(vault),
    private readonly createGc: GcHandlerFactory = (user) => new GlobalOffensive(user as any)
  ) {}

  /**
   * Establishes a GC session, or confirms the one already held.
   *
   * Safe and cheap to call before every read: a live session short-circuits, and a session
   * that has since died is rebuilt rather than reused. That second half is the whole point.
   * The previous version cached "connected" the first time it succeeded, so once another
   * machine took the CS2 session away, every later sync in this process failed against a
   * handle that could never recover — and closing the other client changed nothing, because
   * nothing ever asked Steam again.
   */
  async connect(accountId: AccountId, timeoutMs: number): Promise<{ connected: true; generation: number }> {
    // The client logon is where an account signed in on another computer is refused outright,
    // with EResult 6. It throws from the pool, before this adapter has a session to note it
    // against, so the classification happens here and is remembered separately.
    let user: SteamClient;
    try {
      ({ user } = await this.clients.connect(accountId, timeoutMs));
    } catch (error) {
      throw this.recordOutage(accountId, error);
    }

    const session = this.sessionFor(accountId, user);
    if (isLive(session)) {
      this.outages.delete(accountId);
      return { connected: true, generation: session.generation };
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        await onceWithAction(session.gc, 'connectedToGC', timeoutMs, () => launchCs2(user));
        break;
      } catch (error) {
        // On this path Steam says nothing at all — the session simply never arrives. The
        // `playingState` event is the only thing that names the cause, and it lands first.
        if (session.blockedApp !== null) {
          note(session, blockedBy(session));
          throw new Error(blockedBy(session));
        }
        if (attempt >= GC_HANDSHAKE_ATTEMPTS) throw this.recordOutage(accountId, error);
        // Observed live: the first handshake after a fresh logon sometimes never completes,
        // and the next one succeeds seconds later. Retrying a *read* handshake carries none of
        // the risk CLAUDE.md rule 1 is about — nothing has been requested of the account yet.
        note(session, `the CS2 Game Coordinator did not answer attempt ${attempt}; trying once more`);
      }
    }

    session.connected = true;
    session.blockedApp = null;
    session.generation += 1;
    note(session, 'connected to the CS2 Game Coordinator');
    this.outages.delete(accountId);
    return { connected: true, generation: session.generation };
  }

  /**
   * Classifies a failed connect, remembers it, and returns the error to throw.
   *
   * The returned message is the one a user reads on the status line, so it names the fix when
   * there is one: `connectedToGC timeout` sent a real investigation to the wrong layer for an
   * afternoon, and "another computer is signed into this account" would have ended it.
   */
  private recordOutage(accountId: string, error: unknown): Error {
    const elsewhere = isLoggedInElsewhere(error);
    const detail = elsewhere
      ? 'another computer is signed into this Steam account, and Steam allows one client at a '
        + 'time. Sign out of Steam there, then sync again.'
      : `could not reach the CS2 Game Coordinator: ${errorMessage(error)}`;
    this.outages.set(accountId, { blocked: elsewhere, detail, observedAt: new Date().toISOString() });
    const session = this.sessions.get(accountId);
    if (session) {
      session.connected = false;
      note(session, detail);
    }
    return new Error(detail);
  }

  /**
   * Marks this account's GC session dead, for when the Steam client under it is retired.
   *
   * The session object stays in the map on purpose. `InventoryService.startEventLoop` holds
   * the iterable of its event queue for the life of the account, and `sessionFor` carries that
   * queue across a reconnect; deleting the entry would hand the next connect a fresh queue
   * that nothing is reading, and lose every GC event from then on in silence.
   */
  disconnect(accountId: AccountId): void {
    this.outages.delete(accountId);
    const session = this.sessions.get(accountId);
    if (!session) return;
    session.connected = false;
    session.blockedApp = null;
    note(session, 'signed out of Steam in this window');
  }

  /**
   * The Steam client under this account's live GC session.
   *
   * The in-game store speaks to the same Game Coordinator over the same exclusive session, so
   * `SteamInGameStoreAdapter` borrows this client for its raw sends rather than opening a second one
   * that Steam would refuse. Throws the same named reason `session()` throws when there is no
   * live session: a blocked or dropped GC is not a store problem to explain twice.
   */
  client(accountId: AccountId): SteamClient {
    return this.session(accountId).user;
  }

  connectionStatus(accountId: AccountId): GcStatus {
    const session = this.sessions.get(accountId);
    if (session && isLive(session)) {
      return { state: 'CONNECTED', generation: session.generation, detail: session.detail, observedAt: session.observedAt };
    }
    const outage = this.outages.get(accountId);
    // Either witness is enough: `playingState` names the game, EResult 6 names the client.
    const blocked = session?.blockedApp != null || outage?.blocked === true;
    if (!session && !outage) return { state: 'DISCONNECTED', generation: null, detail: null, observedAt: null };
    return {
      state: blocked ? 'BLOCKED_ELSEWHERE' : 'DISCONNECTED',
      generation: null,
      detail: session?.detail ?? outage?.detail ?? null,
      observedAt: session?.observedAt ?? outage?.observedAt ?? null
    };
  }

  /**
   * The session for this account on this client, built once.
   *
   * Rebuilt only when the pool hands back a different `SteamClient` — a `GlobalOffensive` is
   * bound to the client it was constructed with, so a retired client leaves a handler that can
   * never fire again. The event queue and the generation are carried across: generations must
   * never restart below a persisted item witness, and the queue has a reader attached.
   */
  private sessionFor(accountId: string, user: SteamClient): Session {
    const existing = this.sessions.get(accountId);
    if (existing && existing.user === user) return existing;

    const session: Session = {
      user,
      gc: this.createGc(user),
      // A new process must not restart generations below persisted item witnesses.
      generation: existing?.generation ?? Date.now() * 1000,
      connected: false,
      blockedApp: existing?.blockedApp ?? null,
      detail: existing?.detail ?? null,
      observedAt: existing?.observedAt ?? null,
      events: existing?.events ?? new AsyncQueue<GcEvent>()
    };
    this.sessions.set(accountId, session);
    this.bindEvents(session);
    return session;
  }

  async getInventorySnapshot(accountId: AccountId): Promise<{ items: RawEconItem[]; generation: number }> {
    const session = this.session(accountId);
    session.generation += 1;
    const items = (session.gc.inventory ?? []).filter((item: any) => item.casket_id == null).map(mapItem);
    return { items, generation: session.generation };
  }

  events(accountId: AccountId): AsyncIterable<GcEvent> {
    return this.session(accountId).events.iterable();
  }

  drainEvents(accountId: AccountId): GcEvent[] {
    return this.session(accountId).events.drain();
  }

  async listStorageUnits(accountId: AccountId): Promise<StorageUnit[]> {
    const session = this.session(accountId);
    return (session.gc.inventory ?? [])
      .filter((item: any) => Number(item.def_index) === 1201)
      .map((item: any) => ({
        casketId: String(item.id),
        label: item.custom_name == null ? null : String(item.custom_name),
        containsCount: Number(item.casket_contained_item_count ?? 0),
        generation: session.generation
      }));
  }

  /**
   * Reads one unit's contents: complete when the set and the count agree at one cache state.
   *
   * `globaloffensive` answers this three ways. An empty count is answered with `[]` and no
   * message. A cache already holding as many children as the count is answered from the cache,
   * and no message. Otherwise it sends `CasketItemLoadContents` and calls back on the
   * `CasketContents` notification, by which time the children have arrived as SO creates. The
   * rule this replaced demanded that notification *and* an unchanged generation, which no answer
   * can satisfy: the two quiet paths carry no notification, and the loud path bumps the
   * generation once per child it delivers. Every one of the 178 casket walks this desktop
   * recorded between 2026-09-08 and 2026-09-15 was `stale-count`, so nothing that needs a
   * complete unit — retrieving a crated item to list it — ever had its evidence.
   *
   * What makes the answer trustworthy is the session, not the notification. A GC session is
   * exclusive per account, so while it is held nothing else can change a unit, and every change
   * this session makes arrives as an SO update the cache applies before the next read. So the
   * count is read from the unit *after* the children are in hand — the set and the count from one
   * cache state, which is the "same generation" the port asks for, by construction — and the read
   * is complete when they agree. A count that moved during the read means the unit changed under
   * it: incomplete, read again. `stale-count` is left to the Oracle's stale-witness scenarios.
   */
  async getCasketContents(accountId: AccountId, casketId: string): Promise<CasketRead> {
    const session = this.session(accountId);
    const unit = (): any => (session.gc.inventory ?? []).find((item: any) => String(item.id) === casketId && Number(item.def_index) === 1201);
    const before = unit();
    if (!before) throw new Error(`Unknown storage unit ${casketId}`);
    const countBefore = Number(before.casket_contained_item_count ?? 0);
    // What `globaloffensive` is about to do, decided the way it decides it: an empty unit and one whose
    // children are all in the cache are answered without a message; anything else is a load.
    const loaded = (session.gc.inventory ?? []).filter((item: any) => String(item.casket_id ?? '') === casketId).length;
    const transport: CasketRead['transport'] = countBefore === 0 || loaded === countBefore ? 'cache' : 'wire';
    const rawItems = await callbackWithTimeout<any[]>(this.operationTimeoutMs, (done) => session.gc.getCasketContents(casketId, done));
    const items = rawItems.map(mapItem);
    // The SO cache may have replaced the unit's row while the children loaded; read it again now.
    const containsCount = Number((unit() ?? before).casket_contained_item_count ?? 0);
    const generation = session.generation;
    const complete = containsCount === countBefore && items.length === containsCount;
    return {
      casketId,
      items,
      containsCount,
      countGeneration: generation,
      itemsGeneration: generation,
      completeness: complete ? 'complete' : 'incomplete',
      transport
    };
  }

  async addToCasket(accountId: AccountId, casketId: string, itemId: string): Promise<MutationOutcome> {
    return this.move(accountId, casketId, itemId, true);
  }

  async removeFromCasket(accountId: AccountId, casketId: string, itemId: string): Promise<MutationOutcome> {
    return this.move(accountId, casketId, itemId, false);
  }

  // --- Crates and terminals ------------------------------------------------------------------

  /**
   * Opens a crate with a key.
   *
   * The wire form is `CMsgOpenCrate` with the key in `tool_item_id` — the field Valve named
   * for exactly this — and it has **no live capture yet**. Everything about
   * the outcome alphabet is the important part: a timeout is `AMBIGUOUS`, because the crate
   * may already be gone and the item already granted, and re-sending would open a second one.
   */
  async openCrate(accountId: AccountId, crateId: string, keyId: string): Promise<MutationOutcome> {
    return this.unlock(accountId, crateId, keyId, `UnlockCrate notification after opening ${crateId}`);
  }

  /**
   * Activates a sealed terminal: `OpenCrate` with no tool. The GC answers `UnlockCrate` for
   * the terminal itself, which then carries an expiry (attr 183) and a points counter (169).
   */
  async activateTerminal(accountId: AccountId, terminalId: string): Promise<MutationOutcome> {
    return this.unlock(accountId, terminalId, null, `UnlockCrate notification after activating ${terminalId}`);
  }

  private async unlock(accountId: string, subjectId: string, toolId: string | null, evidence: string): Promise<MutationOutcome> {
    const session = this.session(accountId);
    if (!session.connected) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    const send = rawSender(session);
    if (!send) return { kind: 'DEFINITIVELY_REJECTED', reason: 'client-cannot-send', raw: null };
    try {
      // The first UnlockCrate the GC sends is accepted unfiltered: the notification names the
      // *produced* item, not the crate, so there is nothing to match it against.
      // Mutations are serialised per account above this layer, which is what makes that safe.
      const itemIds = await waitForNotification(session.gc, NOTIFY_UNLOCK_CRATE, null, this.operationTimeoutMs, () => {
        send(MSG_OPEN_CRATE, encodeOpenCrate({ toolItemId: toolId ?? '0', subjectItemId: subjectId }));
      });
      return { kind: 'SUBMITTED', evidence, raw: { notification: 'UnlockCrate', itemIds } };
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: errorMessage(error).includes('timeout') ? 'timeout' : 'transport', raw: errorMessage(error) };
    }
  }

  /**
   * Reads a terminal's current offer.
   *
   * The offer is an SO item parented to the terminal through the casket attributes, so when
   * the cache already holds one this returns it and asks Steam nothing, reported honestly as
   * `cached`. Otherwise `VolatileItemLoadContents` is sent and
   * the GC answers `CasketContents` naming the terminal, exactly as a storage unit would.
   */
  async readTerminalOffer(accountId: AccountId, terminalId: string): Promise<TerminalRead> {
    const session = this.session(accountId);
    const terminal = terminalItem(session, terminalId);
    const describe = (offer: any, completeness: TerminalRead['completeness']): TerminalRead => ({
      terminalId,
      state: terminal.expiresAt === undefined ? 'SEALED' : 'ACTIVE',
      offer: offer ? mapItem(offer) : null,
      pointsRemaining: terminal.pointsRemaining ?? null,
      expiresAt: terminal.expiresAt ?? null,
      generation: session.generation,
      completeness
    });
    const cached = offerOf(session, terminalId);
    if (cached) return describe(cached, 'cached');
    if (terminal.expiresAt === undefined) return describe(null, 'cached');
    const send = rawSender(session);
    if (!send) throw new Error(`the Steam client for ${accountId} cannot send Game Coordinator messages`);
    await waitForNotification(session.gc, NOTIFY_CASKET_CONTENTS, terminalId, this.operationTimeoutMs, () => {
      send(MSG_VOLATILE_ITEM_LOAD_CONTENTS, encodeOpenCrate({
        toolItemId: '0', subjectItemId: terminalId, pointsRemaining: terminal.pointsRemaining ?? 0
      }));
    });
    return describe(offerOf(session, terminalId), 'loaded');
  }

  /**
   * Loads the first offer, or declines the current one and loads the next.
   *
   * `points_remaining` echoes the counter the terminal currently shows; a terminal that has
   * never shown an offer has none, and `0` is sent for it. The GC answers
   * `CasketContents` for the terminal and the new offer appears as its child.
   */
  async advanceTerminalOffer(accountId: AccountId, terminalId: string): Promise<MutationOutcome> {
    const session = this.session(accountId);
    if (!session.connected) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    const terminal = terminalItem(session, terminalId);
    if (terminal.expiresAt === undefined) return { kind: 'DEFINITIVELY_REJECTED', reason: 'terminal-not-active', raw: null };
    const send = rawSender(session);
    if (!send) return { kind: 'DEFINITIVELY_REJECTED', reason: 'client-cannot-send', raw: null };
    try {
      await waitForNotification(session.gc, NOTIFY_CASKET_CONTENTS, terminalId, this.operationTimeoutMs, () => {
        send(MSG_OPEN_CRATE, encodeOpenCrate({
          toolItemId: terminalId, subjectItemId: terminalId, pointsRemaining: terminal.pointsRemaining ?? 0
        }));
      });
      const offer = offerOf(session, terminalId);
      return {
        kind: 'SUBMITTED',
        evidence: `CasketContents notification for terminal ${terminalId}`,
        raw: { notification: 'CasketContents', offerItemId: offer ? String(offer.id) : null }
      };
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: errorMessage(error).includes('timeout') ? 'timeout' : 'transport', raw: errorMessage(error) };
    }
  }

  /**
   * Names an item — in practice, a storage unit, with no Name Tag.
   *
   * The GC's answer to a name it will not take is silence, so this method cannot tell a
   * rejected name from a lost reply: both are `AMBIGUOUS` timeouts. Validating the name is the
   * engine's job (`policy/casket-name.ts`), and it happens before this is ever called.
   */
  async nameItem(accountId: AccountId, itemId: string, name: string, nameTagId: string | null = null): Promise<MutationOutcome> {
    const session = this.session(accountId);
    if (!session.connected) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    const send = rawSender(session);
    if (!send) return { kind: 'DEFINITIVELY_REJECTED', reason: 'client-cannot-send', raw: null };
    try {
      const itemIds = await waitForNotification(session.gc, NOTIFY_NAME_ITEM, itemId, this.operationTimeoutMs, () => {
        send(MSG_NAME_ITEM, encodeNameItem(nameTagId ?? '0', itemId, name), null);
      });
      return { kind: 'SUBMITTED', evidence: `NameItem notification for ${itemId}; the label is proven by a later unit observation`, raw: { notification: 'NameItem', itemIds } };
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: errorMessage(error).includes('timeout') ? 'timeout' : 'transport', raw: errorMessage(error) };
    }
  }

  /**
   * One store or retrieve. Moves may overlap: a command sends the next one without waiting for this
   * one's answer (bulk storage plan D1), so the answer is matched by the item's own SO event and
   * never by the unit's notification, which names only the unit (`waitForCasketOperation`). A move
   * is given `MOVE_TIMEOUT_MS`, not the half-minute other operations get: the GC answers one in
   * about 350 ms, and a silent one is ambiguous however long it is waited for.
   *
   * With no live session nothing is written to the socket and the move is refused as such. It
   * used to throw from `session()` before its `try`, which `executeMutation` recorded as an
   * ambiguous attempt for a send that never left.
   */
  private async move(accountId: string, casketId: string, itemId: string, adding: boolean): Promise<MutationOutcome> {
    const session = this.sessions.get(accountId);
    if (!session || !isLive(session)) return { kind: 'DEFINITIVELY_REJECTED', reason: 'gc-disconnected', raw: null };
    try {
      const type = await waitForCasketOperation(session.gc, casketId, itemId, adding, Math.min(this.operationTimeoutMs, MOVE_TIMEOUT_MS), () => {
        if (adding) session.gc.addToCasket(casketId, itemId);
        else session.gc.removeFromCasket(casketId, itemId);
      });
      const kind = notificationKind(type);
      if (kind === 'casket-full') {
        return { kind: 'DEFINITIVELY_REJECTED', reason: 'casket-full', raw: type };
      }
      if (kind === 'inventory-full') {
        return { kind: 'DEFINITIVELY_REJECTED', reason: 'inventory-full', raw: type };
      }
      return {
        kind: 'SUBMITTED',
        evidence: adding ? 'CasketAdded notification' : 'CasketRemoved notification',
        raw: type
      };
    } catch (error) {
      return { kind: 'AMBIGUOUS', cause: errorMessage(error).includes('timeout') ? 'timeout' : 'transport', raw: errorMessage(error) };
    }
  }

  private bindEvents(session: Session): void {
    session.gc.on('itemAcquired', (item: any) => {
      session.generation += 1;
      session.events.push({ kind: 'added', item: mapItem(item), generation: session.generation });
    });
    session.gc.on('itemChanged', (previousItem: any, item: any) => {
      session.generation += 1;
      session.events.push({ kind: 'updated', previousItem: mapItem(previousItem), item: mapItem(item), generation: session.generation });
    });
    session.gc.on('itemRemoved', (item: any) => {
      session.generation += 1;
      session.events.push({ kind: 'removed', itemId: String(item?.id ?? item), generation: session.generation });
    });
    session.gc.on('disconnectedFromGC', (reason: unknown) => {
      session.generation += 1;
      session.connected = false;
      note(session, `the CS2 Game Coordinator dropped the session: ${String(reason)}`);
      session.events.push({ kind: 'disconnected', reason: String(reason), generation: session.generation });
    });

    // Steam's own account-level answer to "who is playing this game". `blocked` means another
    // session for this account took the game, which is the exclusive-session conflict a second
    // computer causes. It is the only place Steam names that cause; the GC just goes quiet.
    session.user.on('playingState', (blocked: unknown, playingApp: unknown) => {
      const app = Number(playingApp);
      if (blocked === true) {
        session.blockedApp = Number.isFinite(app) ? app : 0;
        session.connected = false;
        note(session, blockedBy(session));
        return;
      }
      if (session.blockedApp !== null) note(session, 'the other session released this account');
      session.blockedApp = null;
    });

    // A dropped CM connection takes the GC session with it. Marking it here is what lets the
    // next sync notice, rather than discovering it through a timeout on the first read.
    session.user.on('disconnected', (eresult: unknown) => {
      session.connected = false;
      note(session, `Steam disconnected this client (EResult ${String(eresult)})`);
    });
    session.user.on('error', (error: unknown) => {
      session.connected = false;
      if (isLoggedInElsewhere(error)) {
        // Observed live: the other computer's client kicks this one ~200ms after `playingState`
        // reports the block. Recorded as a block so the window says which, not just "gone".
        session.blockedApp = session.blockedApp ?? 730;
        note(session, blockedBy(session));
        return;
      }
      note(session, `Steam client error: ${errorMessage(error)}`);
    });
  }

  /**
   * The live session for a read, or an error that says what is actually wrong.
   *
   * "GC is not connected" on its own sent a reader looking for a network problem when the real
   * answer was that they were signed in on another computer.
   */
  private session(accountId: string): Session {
    const session = this.sessions.get(accountId);
    if (session && isLive(session)) return session;
    const status = this.connectionStatus(accountId);
    const because = status.state === 'BLOCKED_ELSEWHERE'
      ? ` — ${session ? blockedBy(session) : 'another session holds this account'}`
      : status.detail ? ` — ${status.detail}` : '';
    throw new Error(`GC is not connected for ${accountId}${because}`);
  }
}

/**
 * Asks Steam to make this client the one playing CS2.
 *
 * Clearing first is not superstition: steam-user tracks the playing set locally, so a client
 * that already believes it is playing 730 sends no new hello and a second attempt waits on a
 * handshake that never restarts. Both probes in `endpoint-testing/steam/GC/` use this same
 * sequence, and it is the one the incumbent uses.
 *
 * Neither call forces: this never takes the session from another client.
 */
function launchCs2(user: SteamClient): void {
  user.gamesPlayed([]);
  user.gamesPlayed([730]);
}

/**
 * `globaloffensive` owns the ground truth for whether a session exists. The local flag is kept
 * beside it because the library's property is undefined on some versions, and because a
 * `playingState` block is observed before the GC itself notices.
 */
function isLive(session: Session): boolean {
  return session.connected && session.gc?.haveGCSession !== false;
}

function blockedBy(session: Session): string {
  const app = session.blockedApp;
  return app === 730
    ? 'another computer signed into this Steam account is playing CS2, which takes the Game '
      + 'Coordinator session. Close CS2 there, then sync again.'
    : `another session signed into this Steam account is playing app ${app ?? 'unknown'}, `
      + 'which takes the Game Coordinator session. Close it there, then sync again.';
}

/**
 * Steam's EResult 6. Raised on the *client logon* when the account is signed in somewhere else,
 * which is a different and earlier failure than losing only the game slot.
 */
function isLoggedInElsewhere(error: unknown): boolean {
  const eresult = (error as { eresult?: unknown } | null)?.eresult;
  return eresult === 6 || /LoggedInElsewhere/i.test(errorMessage(error));
}

function note(session: Session, detail: string): void {
  session.detail = detail;
  session.observedAt = new Date().toISOString();
}

function mapItem(item: any): RawEconItem {
  const mapped: RawEconItem = {
    id: String(item.id),
    defIndex: Number(item.def_index),
    quality: Number(item.quality ?? 4)
  };
  assign(mapped, 'quantity', item.quantity, Number);
  assign(mapped, 'paintIndex', item.paint_index, Number);
  assign(mapped, 'paintWear', item.paint_wear, Number);
  assign(mapped, 'paintSeed', item.paint_seed, Number);
  assign(mapped, 'rarity', item.rarity, Number);
  assign(mapped, 'flags', item.flags, Number);
  assign(mapped, 'origin', item.origin, Number);
  assign(mapped, 'tradableAfter', item.tradable_after, (value) => new Date(value).toISOString());
  if (item.casket_id !== undefined) mapped.casketId = item.casket_id == null ? null : String(item.casket_id);
  assign(mapped, 'casketContainsCount', item.casket_contained_item_count, Number);
  if (item.custom_name !== undefined) mapped.customName = item.custom_name == null ? null : String(item.custom_name);
  if (Array.isArray(item.attribute)) mapped.attributes = item.attribute.map(mapAttribute);
  // `globaloffensive` lifts the skin and casket attributes and leaves the rest in `attribute[]`.
  // The terminal ones are lifted here the same way the library lifts attr 75: a reader of
  // `RawEconItem` should not need the attribute table to know whether a terminal is active.
  const expires = attributeUint32(item, ATTR_EXPIRATION_DATE);
  if (expires !== undefined) mapped.expiresAt = new Date(expires * 1000).toISOString();
  const points = attributeUint32(item, ATTR_POINTS_REMAINING);
  if (points !== undefined) mapped.pointsRemaining = points;
  const price = attributeUint32(item, ATTR_PURCHASE_PRICE);
  if (price !== undefined) mapped.purchasePrice = price;
  return mapped;
}

/**
 * A little-endian uint32 out of a raw econ attribute's `value_bytes`, or undefined.
 *
 * The GC fills `value_bytes` and leaves `value` null (measured 2026-09-13,
 * `cslytics-app-docs/steam/gc-inventory.md`), and the library hands the bytes over as either a
 * Buffer or a `{ "0": n, ... }` object once serialised — both are handled.
 */
function attributeUint32(item: any, defIndex: number): number | undefined {
  const attribute = Array.isArray(item?.attribute) ? item.attribute.find((row: any) => Number(row?.def_index) === defIndex) : undefined;
  if (!attribute) return undefined;
  const bytes = attribute.value_bytes;
  if (!bytes) return undefined;
  const view = Uint8Array.from(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? bytes : (Object.values(bytes) as number[]));
  if (view.byteLength < 4) return undefined;
  return new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
}

/** The terminal item as the SO cache holds it, mapped, or an error naming the asset id. */
function terminalItem(session: Session, terminalId: string): RawEconItem {
  const raw = (session.gc.inventory ?? []).find((item: any) => String(item.id) === terminalId);
  if (!raw) throw new Error(`Unknown terminal ${terminalId}`);
  return mapItem(raw);
}

/** The one SO item parented to this terminal — its current offer — or undefined. */
function offerOf(session: Session, terminalId: string): any | undefined {
  return (session.gc.inventory ?? []).find((item: any) => item.casket_id != null && String(item.casket_id) === terminalId);
}

/**
 * steam-user's raw GC send bound to this session, or null when the client lacks one.
 *
 * The header decides how the GC parses the body: `{}` marks a protobuf message, `null` a
 * struct. Sending `NameItem` under a protobuf header, or `OpenCrate` under a struct one, is
 * not an error anywhere — the GC simply never answers, which reads as a timeout.
 */
function rawSender(session: Session): ((msgType: number, body: Buffer, header?: Record<string, never> | null) => void) | null {
  const user = session.user;
  if (typeof user.sendToGC !== 'function') return null;
  return (msgType, body, header = {}) => user.sendToGC!(CS2_APP_ID, msgType, header, body);
}

/**
 * The `NameItem` struct body: `uint64 name_tag_id`, `uint64 item_id`, one zero byte, then the
 * name as NUL-terminated UTF-8. Both witnesses write exactly these 17 bytes plus the name.
 */
export function encodeNameItem(nameTagId: string, itemId: string, name: string): Buffer {
  const text = Buffer.from(name, 'utf8');
  const body = Buffer.alloc(8 + 8 + 1 + text.length + 1);
  body.writeBigUInt64LE(BigInt(nameTagId), 0);
  body.writeBigUInt64LE(BigInt(itemId), 8);
  body.writeUInt8(0, 16);
  text.copy(body, 17);
  body.writeUInt8(0, 17 + text.length);
  return body;
}

/**
 * `CMsgOpenCrate`, encoded by hand.
 *
 * Five optional fields — `tool_item_id` (1, uint64), `subject_item_id` (2, uint64),
 * `for_rental` (3, bool), `points_remaining` (4, uint32), `volatile_limit` (5, uint32) — and
 * a field at its default is omitted.
 * Hand-rolled rather than pulling in protobufjs: the message is five varints, and the rule of
 * this package is one Steam library per surface, not one per message.
 */
export function encodeOpenCrate(message: {
  toolItemId?: string; subjectItemId?: string; forRental?: boolean; pointsRemaining?: number; volatileLimit?: number;
}): Buffer {
  const out: number[] = [];
  const varint = (value: bigint): void => {
    let rest = value;
    while (rest >= 0x80n) { out.push(Number((rest & 0x7fn) | 0x80n)); rest >>= 7n; }
    out.push(Number(rest));
  };
  const field = (number: number, value: bigint): void => { out.push(number << 3); varint(value); };
  if (message.toolItemId !== undefined && message.toolItemId !== '0') field(1, BigInt(message.toolItemId));
  if (message.subjectItemId !== undefined && message.subjectItemId !== '0') field(2, BigInt(message.subjectItemId));
  if (message.forRental) field(3, 1n);
  if (message.pointsRemaining !== undefined && message.pointsRemaining !== 0) field(4, BigInt(message.pointsRemaining >>> 0));
  if (message.volatileLimit !== undefined && message.volatileLimit !== 0) field(5, BigInt(message.volatileLimit >>> 0));
  return Buffer.from(out);
}

/**
 * Sends, then waits for one `ItemCustomizationNotification` of `request` kind.
 *
 * `itemId` narrows to notifications whose first id is that item — the casket-style answers
 * name their container — and null accepts the first of the kind, which is all an
 * `UnlockCrate` allows. A disconnect rejects at once rather than waiting out the timer.
 */
async function waitForNotification(
  gc: any,
  request: number,
  itemId: string | null,
  timeoutMs: number,
  action: () => void
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`notification ${request} timeout`)); }, timeoutMs);
    const listener = (itemIds: unknown, type: unknown): void => {
      if (Number(type) !== request) return;
      const ids = Array.isArray(itemIds) ? itemIds.map(String) : [];
      if (itemId !== null && ids[0] !== itemId) return;
      cleanup();
      resolve(ids);
    };
    const disconnected = (): void => { cleanup(); reject(new Error('GC disconnected')); };
    const cleanup = (): void => {
      clearTimeout(timer);
      gc.removeListener('itemCustomizationNotification', listener);
      gc.removeListener('disconnectedFromGC', disconnected);
    };
    gc.on('itemCustomizationNotification', listener);
    gc.once('disconnectedFromGC', disconnected);
    action();
  });
}

function mapAttribute(attribute: any): RawEconAttribute {
  const result: RawEconAttribute = { defIndex: Number(attribute.def_index) };
  if (attribute.value_bytes) result.valueBytes = Uint8Array.from(Object.values(attribute.value_bytes) as number[]);
  // The GC fills `value_bytes` and leaves `value` null; the schema says what the bytes are. A
  // `value` the GC did fill is kept as sent when the bytes say nothing.
  const decoded = decodeEconAttribute(result.defIndex, result.valueBytes);
  if (decoded) {
    result.kind = decoded.kind;
    result.value = decoded.value;
  } else if (typeof attribute.value === 'number' || typeof attribute.value === 'string') {
    result.value = attribute.value;
  }
  return result;
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: unknown, convert: (value: any) => T[K]): void {
  if (value !== undefined && value !== null) target[key] = convert(value);
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }
  /** Everything buffered, in order, and nothing more: never a value a waiter is owed. */
  drain(): T[] {
    return this.values.splice(0);
  }
  iterable(): AsyncIterable<T> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => this.values.length
      ? { done: false, value: this.values.shift()! }
      : new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve)) }) };
  }
}

async function onceWithAction(emitter: any, event: string, timeoutMs: number, action: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${event} timeout`)); }, timeoutMs);
    const success = (): void => { cleanup(); resolve(); };
    const failure = (error: unknown): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      clearTimeout(timer);
      emitter.removeListener(event, success);
      emitter.removeListener('error', failure);
    };
    emitter.once(event, success);
    emitter.once('error', failure);
    action();
  });
}

async function callbackWithTimeout<T>(timeoutMs: number, action: (done: (error: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('casket contents timeout')), timeoutMs);
    action((error, result) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * How long a store or retrieve waits for its answer. The GC answers one in about 350 ms (measured
 * by us, 2026-04-17); past this the move is ambiguous, and the command's round read decides it.
 */
export const MOVE_TIMEOUT_MS = 5_000;

/** A move still waiting for its answer, as the unit it went to knows it. */
type CasketWaiter = { adding: boolean; refuse: (type: unknown) => void };

/** Per GC handler: the moves waiting on each unit, oldest first. */
const casketWaiters = new WeakMap<object, Map<string, CasketWaiter[]>>();

/**
 * The moves waiting on one unit, with the one listener per GC handler that hands a unit's refusal
 * to the move it answers.
 *
 * `CasketTooFull` (1011) and `CasketInvFull` (1015) name the unit and nothing else, and a command
 * may have several moves to one unit in flight at once. The GC answers in the order it was asked,
 * so a refusal answers the oldest move of its kind still waiting on that unit. A success needs no
 * such guess: it is the item's own SO event, which carries the item's id.
 */
function waitersOn(gc: any, casketId: string): CasketWaiter[] {
  let units = casketWaiters.get(gc);
  if (!units) {
    const created = new Map<string, CasketWaiter[]>();
    units = created;
    casketWaiters.set(gc, created);
    // Moves overlap, each with its own listeners for its item: more than the default ten is normal.
    if (typeof gc.setMaxListeners === 'function') gc.setMaxListeners(Math.max(gc.getMaxListeners?.() ?? 10, 100));
    gc.on('itemCustomizationNotification', (itemIds: unknown, type: unknown) => {
      const kind = notificationKind(type);
      if (kind !== 'casket-full' && kind !== 'inventory-full') return;
      const ids = Array.isArray(itemIds) ? itemIds.map(String) : [];
      created.get(ids[0] ?? '')?.find((waiter) => waiter.adding === (kind === 'casket-full'))?.refuse(type);
    });
  }
  let waiting = units.get(casketId);
  if (!waiting) {
    waiting = [];
    units.set(casketId, waiting);
  }
  return waiting;
}

/**
 * Sends one move and waits for what answers it: the item's SO destroy for a store (or an SO update
 * that places it in the unit), its SO create outside the unit for a retrieve (or an SO update that
 * takes it out), the unit's refusal routed by `waitersOn`, a dropped session, or the deadline. The
 * unit-level `CasketAdded` and `CasketRemoved` notifications are not answers: with several moves in
 * flight they cannot say which one landed.
 *
 * Reading a unit loads its contents into the cache as SO creates, each carrying the unit's id. A
 * resident whose retrieve is in flight arrives that way too, and that is the item where it was, not
 * a retrieve. Answered by it, a retrieve was proved not applied by the read that followed, before
 * the GC had moved anything (measured 2026-10-16: answered after 20 ms, moved 270 ms later).
 */
async function waitForCasketOperation(
  gc: any,
  casketId: string,
  itemId: string,
  adding: boolean,
  timeoutMs: number,
  action: () => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const waiting = waitersOn(gc, casketId);
    const waiter: CasketWaiter = { adding, refuse: (type) => { cleanup(); resolve(type); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('casket operation timeout')); }, timeoutMs);
    const itemEvent = (item: any): void => {
      if (String(item?.id ?? item) !== itemId) return;
      if (!adding && String(item?.casket_id ?? '') === casketId) return;
      cleanup();
      resolve(adding ? 1013 : 1014);
    };
    const changed = (_previous: any, item: any): void => {
      if (String(item?.id ?? '') !== itemId || (String(item?.casket_id ?? '') === casketId) !== adding) return;
      cleanup();
      resolve(adding ? 1013 : 1014);
    };
    const disconnected = (): void => { cleanup(); reject(new Error('GC disconnected')); };
    const cleanup = (): void => {
      clearTimeout(timer);
      const at = waiting.indexOf(waiter);
      if (at >= 0) waiting.splice(at, 1);
      gc.removeListener('disconnectedFromGC', disconnected);
      gc.removeListener(adding ? 'itemRemoved' : 'itemAcquired', itemEvent);
      gc.removeListener('itemChanged', changed);
    };
    waiting.push(waiter);
    gc.once('disconnectedFromGC', disconnected);
    gc.on(adding ? 'itemRemoved' : 'itemAcquired', itemEvent);
    gc.on('itemChanged', changed);
    action();
  });
}

function notificationKind(type: unknown): 'casket-full' | 'contents' | 'added' | 'removed' | 'inventory-full' | 'other' {
  const numeric = Number(type);
  if (numeric === 1011) return 'casket-full';
  if (numeric === 1012) return 'contents';
  if (numeric === 1013) return 'added';
  if (numeric === 1014) return 'removed';
  if (numeric === 1015) return 'inventory-full';
  const text = String(type).toLowerCase();
  if (text.includes('too') && text.includes('full')) return 'casket-full';
  if (text.includes('contents')) return 'contents';
  if (text.includes('added')) return 'added';
  if (text.includes('removed')) return 'removed';
  if (text.includes('inv') && text.includes('full')) return 'inventory-full';
  return 'other';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
