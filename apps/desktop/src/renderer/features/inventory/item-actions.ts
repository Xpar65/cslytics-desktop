/**
 * Which actions an item actually allows.
 *
 * This is the interaction matrix in `cslytics-app-docs/steam/interactions.md` and the storage
 * rules in `storage-units.md`, written as code, with the rollout document's one-line summary at
 * its centre: **a market-locked item can be stored in a casket; a trade-protected one cannot.**
 * Those are two different columns in the database and two different answers, and collapsing them
 * is how a perfectly storable item comes to look unstorable.
 *
 * Three rules govern everything here:
 *
 *  1. **The engine is the gate; this is a courtesy.** Hiding a button never replaces the engine's
 *     refusal. This hides what the read model already proves impossible, and the caller shows the
 *     engine's message verbatim when it refuses anyway.
 *  2. **A multi-selection offers only what every selected item allows.** The engine rejects a
 *     batch atomically, so a button that produces a whole-batch rejection over one item is a
 *     trap. `intersect` is that rule, and it names what blocked each withheld action so the fix
 *     is one click away.
 *  3. **A lock is a date, and a date that has passed is not a lock.** Steam keeps reporting
 *     `tradable_after` long after it lapses, so the comparison against the clock is what decides,
 *     exactly as the engine's own guards do. See `lockOf` for why this is arithmetic rather than
 *     the sort of inference rule 1 forbids.
 */

import { DISPLAY_ONLY_REASON, isDisplayOnly } from './display-only.js';
import { isStorageUnit } from './storage-unit.js';

export type ActionKind = 'STORE' | 'RETRIEVE' | 'TRANSFER' | 'LIST' | 'CSFLOAT_LIST' | 'REPRICE' | 'DELIST_TO_STORE';

/** Every action, in the order the inspector renders them: the likely one first. */
export const ACTION_ORDER: readonly ActionKind[] = ['LIST', 'CSFLOAT_LIST', 'STORE', 'RETRIEVE', 'TRANSFER', 'REPRICE', 'DELIST_TO_STORE'];

/** The part of an inventory row that decides what can be done to it. Names play no part. */
export type ActionRow = {
  /** `fungible` is a case, sticker or agent: CSFloat lists one of those only from main inventory. */
  unitKind: 'individual' | 'fungible';
  accountId: string;
  rowKey: string;
  localId: string;
  location: string;
  /**
   * `1` when an open Steam listing names the row. Beside `location`, not one of its values: the
   * Game Coordinator keeps a listed item in main inventory, so a listed row is also `MAIN`.
   */
  steamListed?: number | boolean | null | undefined;
  casketId: string | null;
  quantity: number;
  tradableAfter: string | null;
  tradeProtectedUntil: string | null;
  /**
   * Steam's `marketable` flag from the last Community read (holdings plan D7): `false` means the
   * item cannot be sold on the market at all — a pet, for one. `null`/absent is unknown, and
   * unknown does not block, exactly as the engine's preflight reads it.
   */
  marketable?: number | boolean | null | undefined;
  /** Identity, not a name: it is how a storage unit is known to be one. */
  defIndex?: number | undefined;
  /** Attached by the host. An item the catalogue has never heard of still selects and operates. */
  name?: string | undefined;
  unresolved?: string | null | undefined;
  /**
   * Whether CSFloat trades this kind of item at all, attached by the host from CSFloat's own
   * catalogue (`csfloat-kinds.ts`); `null` or absent before one has been fetched.
   */
  csfloatSupport?: 'supported' | 'unsupported' | null | undefined;
  /** The engine's `cannot trade` on the unit (attribute 2). See `display-only.ts`. */
  cannotTrade?: number | boolean | null | undefined;
  /** The catalogue's `marketable` for the kind, attached by the host. See `display-only.ts`. */
  catalogueMarketable?: boolean | null | undefined;
};

/**
 * The engine's `csfloat.eligibility` answer. `absent` is a complete CSFloat read that does not hold
 * the item at all; `unknown` is no complete read to ask.
 */
export type CsfloatState = 'eligible' | 'ineligible' | 'absent' | 'unknown';

/**
 * Why CSFloat is not offered for an item it does not hold.
 *
 * Two different reasons, and CSFloat's own catalogue of kinds tells them apart (`csfloatSupport`):
 * a kind it does not list at all — a viewer pass, a key, a name tag, sealed graffiti — or an item
 * of a kind it lists that its read has not caught up with, which it does about two minutes after a
 * retrieve. The first is said before any eligibility read, because no read will change it. With
 * no catalogue fetched yet the window says only what the read said. An item the read holds
 * tradable is offered whatever the catalogue says: the venue's read of the unit outranks its list
 * of kinds.
 */
export const CSFLOAT_UNSUPPORTED = 'not supported by CSFloat';
const CSFLOAT_NOT_YET = "not in CSFloat's inventory yet";
const CSFLOAT_NOT_HELD = "not in CSFloat's inventory";
/** A disconnected venue is hidden rather than explained; see `ItemInspector`. */
export const CSFLOAT_DISCONNECTED = 'on an account without CSFloat connected';

export type ActionContext = {
  /**
   * How many accounts are in the window. Cross-account transfer needs at least two. This is the
   * window, not the tab's scope: narrowing the view to one account does not take the others away
   * as destinations. Build it with `actionContext` rather than by hand.
   */
  accountCount: number;
  /** Whether the account has CSFloat connected at all (`marketplace.status`). */
  csfloatConnected: boolean;
  /** Why CSFloat would refuse a new listing from this account right now, when it would (a suspension). */
  csfloatRestricted?: string | null | undefined;
  /** By local id. A missing entry is `unknown` — never a refusal; see `csfloatEligibility`. */
  csfloatEligibility?: Readonly<Record<string, CsfloatState>> | undefined;
};

/**
 * The context the inspector judges a selection in.
 *
 * `scope` is taken only to be ignored for the account count: it is what the tab is filtered to,
 * and counting it hid Transfer whenever one account was picked, although the transfer panel's
 * destinations come from the whole window and had somewhere to send the item all along.
 */
export function actionContext(input: {
  scope: readonly string[];
  window: ReadonlyArray<{ id: string }>;
  csfloatConnected: boolean;
  csfloatRestricted?: string | null | undefined;
  csfloatEligibility?: Readonly<Record<string, CsfloatState>> | undefined;
}): ActionContext {
  return {
    accountCount: new Set([...input.window.map((account) => account.id), ...input.scope]).size,
    csfloatConnected: input.csfloatConnected,
    csfloatRestricted: input.csfloatRestricted,
    csfloatEligibility: input.csfloatEligibility
  };
}

export type Lock = { kind: 'market' | 'trade'; until: string };
export type Chain = { hops: readonly string[]; slotsNeeded: number; sourceCasketId: string | null };
export type Blocked = { kind: ActionKind; reason: string };
export type ActionVerdict = {
  allowed: ActionKind[];
  blocked: Blocked[];
  chains: Partial<Record<ActionKind, Chain>>;
};

/**
 * Which lock an item is under, if any.
 *
 * Trade protection wins when both are set: it is the stricter of the two, and reporting the
 * weaker one would offer *Store* on an item the engine will refuse.
 *
 * **A date that has passed is not a lock.** This looks like the one place rule 1 would demand
 * caution, and it is not: `tradable_after` is not a claim about the present that might have gone
 * stale, it is a claim the observation already made about a *future* time — "not tradable until
 * T". After T, the lock has lifted by arithmetic rather than by inference, and no fresh read is
 * needed to know it. Steam keeps reporting the date long after it passes, so treating a past one
 * as live makes every such item permanently unlistable in the window while the engine, which
 * compares `tradable_after <= now`, would have accepted it perfectly well. A renderer stricter
 * than the engine hides legal actions, which is its own kind of lie about what is possible.
 */
export function lockOf(row: Pick<ActionRow, 'tradableAfter' | 'tradeProtectedUntil'>, now: Date): Lock | null {
  if (row.tradeProtectedUntil && new Date(row.tradeProtectedUntil) > now) return { kind: 'trade', until: row.tradeProtectedUntil };
  if (row.tradableAfter && new Date(row.tradableAfter) > now) return { kind: 'market', until: row.tradableAfter };
  return null;
}

/**
 * What this one row allows, and why it does not allow the rest.
 *
 * `reason` is a predicate phrase — "in storage", "trade-protected" — so a caption can put a count
 * in front of it and read as a sentence in both numbers.
 */
export function allowedActions(row: ActionRow, context: ActionContext, now: Date): ActionVerdict {
  const allowed: ActionKind[] = [];
  const blocked: Blocked[] = [];
  const chains: Partial<Record<ActionKind, Chain>> = {};
  const lock = lockOf(row, now);
  const stored = row.location === 'CASKET';
  // Listed is asked first everywhere below: a listed row is also in main inventory.
  const listed = row.steamListed === 1 || row.steamListed === true;
  const main = row.location === 'MAIN';
  const allow = (kind: ActionKind): void => { allowed.push(kind); };
  const deny = (kind: ActionKind, reason: string): void => { blocked.push({ kind, reason }); };

  // ---- A storage unit ----------------------------------------------------- none of it
  // A unit is neither marketable nor tradable, and a unit cannot go inside a unit. Renaming is the
  // one thing that can be done to one, and the inspector offers it beside the name, not as a verb.
  if (isStorageUnit(row)) {
    for (const kind of ACTION_ORDER) deny(kind, 'a storage unit');
    return { allowed, blocked, chains };
  }

  // ---- A display item ---------------------------------------------------- held, not handled
  // A coin, medal, badge or granted music kit: Steam lets no one sell, trade or store one
  // (`display-only.ts`). One that somehow sits in a unit may still come out, so nothing is trapped.
  if (isDisplayOnly(row)) {
    for (const kind of ACTION_ORDER) {
      if (kind === 'RETRIEVE' && stored) allow(kind);
      else deny(kind, DISPLAY_ONLY_REASON);
    }
    return { allowed, blocked, chains };
  }

  // ---- Store ------------------------------------------------------------- market lock is fine
  if (stored) deny('STORE', 'in storage');
  else if (listed) deny('STORE', 'listed on the market');
  else if (!main) deny('STORE', 'not in inventory');
  else if (lock?.kind === 'trade') deny('STORE', 'trade-protected');
  else allow('STORE');

  // ---- Retrieve ---------------------------------------------------------- a lock does not stop it
  if (stored) allow('RETRIEVE');
  else if (listed) deny('RETRIEVE', 'listed on the market');
  else deny('RETRIEVE', 'in inventory');

  // ---- List on Steam ------------------------------------------------------
  // From a storage unit this is a chain, not a refusal: `command.submit` admits a LIST member
  // carrying its `sourceCasketId`, and `ListingPlanner` derives RETRIEVE_FROM_CASKET →
  // CREATE_SELL_LISTING, observing the item back in main inventory before it lists. A case is a
  // handle like a skin, so it chains the same way, and it keeps its asset id across the round-trip.
  const unmarketable = row.marketable === false || row.marketable === 0;
  if (listed) deny('LIST', 'already listed');
  else if (unmarketable) deny('LIST', 'not marketable on Steam');
  else if (lock) deny('LIST', lock.kind === 'trade' ? 'trade-protected' : 'market-locked');
  else if (stored) {
    allow('LIST');
    chains['LIST'] = { hops: ['RETRIEVE_FROM_CASKET', 'CREATE_SELL_LISTING'], slotsNeeded: 1, sourceCasketId: row.casketId };
  } else if (main) allow('LIST');
  else deny('LIST', 'not in inventory');

  // ---- List on CSFloat ----------------------------------------------------
  // From a storage unit this is a chain too, with a wait in the middle: the engine admits the item
  // as a retrieve, and creates the listing only once CSFloat's own copy of the inventory shows it
  // (CSF-31–34), which took about two minutes on 2026-09-23. Eligibility cannot be asked of a
  // crated item — CSFloat cannot see inside a unit — so it is not asked here; the engine asks it
  // at the send. The engine chains only a skin that way: a crated case is refused, so it is
  // withheld here until it is retrieved.
  const eligibility = context.csfloatEligibility?.[row.localId] ?? 'unknown';
  const support = row.csfloatSupport ?? null;
  if (unmarketable) deny('CSFLOAT_LIST', 'not marketable on Steam');
  else if (!context.csfloatConnected) deny('CSFLOAT_LIST', CSFLOAT_DISCONNECTED);
  // Refused here with the venue's reason rather than admitted into its `code 138` refusal.
  else if (context.csfloatRestricted) deny('CSFLOAT_LIST', context.csfloatRestricted);
  // A kind CSFloat does not list says so first: no wait, unlock or refresh changes it.
  else if (support === 'unsupported' && eligibility !== 'eligible') deny('CSFLOAT_LIST', CSFLOAT_UNSUPPORTED);
  else if (listed) deny('CSFLOAT_LIST', 'already listed');
  else if (lock) deny('CSFLOAT_LIST', lock.kind === 'trade' ? 'trade-protected' : 'market-locked');
  else if (stored && row.unitKind === 'fungible') deny('CSFLOAT_LIST', 'in storage; retrieve it first');
  else if (stored) {
    allow('CSFLOAT_LIST');
    chains['CSFLOAT_LIST'] = { hops: ['RETRIEVE_FROM_CASKET', 'CSFLOAT_CREATE'], slotsNeeded: 1, sourceCasketId: row.casketId };
  }
  else if (!main) deny('CSFLOAT_LIST', 'not in inventory');
  else if (eligibility === 'eligible') allow('CSFLOAT_LIST');
  else if (eligibility === 'absent') deny('CSFLOAT_LIST', support === 'supported' ? CSFLOAT_NOT_YET : CSFLOAT_NOT_HELD);
  else deny('CSFLOAT_LIST', eligibility === 'unknown' ? 'not checked against CSFloat yet' : 'not eligible on CSFloat');

  // ---- Transfer to another account ----------------------------------------
  // From a storage unit this is a chain, like listing: the transfer planner admits a crated item
  // as a retrieval hop, and the batch sends only once a complete walk shows it back in main
  // inventory.
  if (context.accountCount < 2) deny('TRANSFER', 'in a window holding one account');
  else if (listed) deny('TRANSFER', 'listed on the market');
  else if (lock) deny('TRANSFER', lock.kind === 'trade' ? 'trade-protected' : 'market-locked');
  else if (stored) {
    allow('TRANSFER');
    chains['TRANSFER'] = { hops: ['RETRIEVE_FROM_CASKET', 'trade.send'], slotsNeeded: 1, sourceCasketId: row.casketId };
  } else if (main) allow('TRANSFER');
  else deny('TRANSFER', 'not in inventory');

  // ---- Reprice and delist ------------------------------------------------- listings only
  for (const kind of ['REPRICE', 'DELIST_TO_STORE'] as const) {
    if (listed) allow(kind);
    else deny(kind, stored ? 'in storage' : 'not listed on the market');
  }

  return { allowed, blocked, chains };
}

export type Blocker = { count: number; first: string; reason: string };
export type IntersectResult = {
  /** Exactly what every row allows: what the engine will admit as one batch. */
  allowed: ActionKind[];
  /** One entry per action some row allows and some row does not, naming what blocks it. */
  blockers: Partial<Record<ActionKind, Blocker>>;
  /** Summed across the members that chain, so a caption can say how many hops it adds. */
  chains: Partial<Record<ActionKind, { hops: number; slotsNeeded: number }>>;
};

/**
 * What a whole selection offers.
 *
 * The offered set is the intersection over the engine's own rule set, which is the point: a bulk
 * command the inspector offers is one the engine will admit whole. Every action that at least one
 * row allows but not all of them do gets a blocker naming the count and the first item — an
 * action nothing allows is silent, because a caption for it would be noise rather than a fix.
 */
export function intersect(rows: ReadonlyArray<{ row: ActionRow; verdict: ActionVerdict }>): IntersectResult {
  if (rows.length === 0) return { allowed: [], blockers: {}, chains: {} };

  const allowed = ACTION_ORDER.filter((kind) => rows.every(({ verdict }) => verdict.allowed.includes(kind)));
  const blockers: Partial<Record<ActionKind, Blocker>> = {};
  for (const kind of ACTION_ORDER) {
    if (allowed.includes(kind)) continue;
    if (!rows.some(({ verdict }) => verdict.allowed.includes(kind))) continue;
    const offenders = rows.filter(({ verdict }) => !verdict.allowed.includes(kind));
    const first = offenders[0];
    if (!first) continue;
    blockers[kind] = {
      count: offenders.length,
      first: first.row.name ?? first.row.localId,
      reason: first.verdict.blocked.find((entry) => entry.kind === kind)?.reason ?? 'unavailable'
    };
  }

  const chains: IntersectResult['chains'] = {};
  for (const kind of allowed) {
    const chained = rows.filter(({ verdict }) => verdict.chains[kind]);
    if (chained.length === 0) continue;
    chains[kind] = {
      hops: chained.length,
      slotsNeeded: chained.reduce((sum, { verdict }) => sum + (verdict.chains[kind]?.slotsNeeded ?? 0), 0)
    };
  }

  return { allowed, blockers, chains };
}

// ---------------------------------------------------------------------------- action groups

/**
 * What a person is trying to do, before they have said where or for how much.
 *
 * The inspector asks this first — *List, Store, Transfer* — and only then asks for the venue, the
 * unit or the account. `ActionKind` is the engine's vocabulary and answers a narrower question:
 * "List on Steam" and "List on CSFloat" are two commands, but they are one intention, and asking
 * a person to pick the venue before they have picked the verb puts the rarest decision first.
 */
export type ActionGroup = 'LIST' | 'STORE' | 'TRANSFER' | 'RETRIEVE' | 'REPRICE' | 'DELIST_TO_STORE';

/** Every group, in the order the inspector offers them: the likely one first. */
export const GROUP_ORDER: readonly ActionGroup[] = ['LIST', 'STORE', 'TRANSFER', 'RETRIEVE', 'REPRICE', 'DELIST_TO_STORE'];

/**
 * The kinds a group can submit, the default first.
 *
 * Only `LIST` holds more than one, and that is the whole reason groups exist: the venue is a
 * detail of listing, not a second verb.
 */
export const GROUP_KINDS: Readonly<Record<ActionGroup, readonly ActionKind[]>> = {
  LIST: ['LIST', 'CSFLOAT_LIST'],
  STORE: ['STORE'],
  TRANSFER: ['TRANSFER'],
  RETRIEVE: ['RETRIEVE'],
  REPRICE: ['REPRICE'],
  DELIST_TO_STORE: ['DELIST_TO_STORE']
};

export type GroupResult = {
  /** Groups every selected row can take *some* route through. */
  allowed: ActionGroup[];
  /** One entry per group some row allows and some row allows no route through at all. */
  blockers: Partial<Record<ActionGroup, Blocker>>;
};

/**
 * What a whole selection can be asked to do.
 *
 * A single-kind group is exactly `intersect`'s answer for that kind. `LIST` is not: a row is
 * offered listing when it can reach **either** venue, because the listing workspace submits one
 * command per venue and one row at a time if asked — an item that only Steam will take and an
 * item only CSFloat will take are two batches, not a batch the engine would reject. Rule 2 is
 * unchanged: what each of those batches contains is still only what every member of it allows,
 * and the workspace never puts a row in a batch its own verdict refuses.
 *
 * The blocker reason is the *default* venue's reason, because a row that can reach neither venue
 * is refused by both and Steam's words are the ones that name the item's real problem
 * ("trade-protected", "already listed") rather than CSFloat's connection state.
 */
export function groupsFor(rows: ReadonlyArray<{ row: ActionRow; verdict: ActionVerdict }>): GroupResult {
  if (rows.length === 0) return { allowed: [], blockers: {} };
  const takes = (verdict: ActionVerdict, group: ActionGroup): boolean =>
    GROUP_KINDS[group].some((kind) => verdict.allowed.includes(kind));

  const allowed = GROUP_ORDER.filter((group) => rows.every(({ verdict }) => takes(verdict, group)));
  const blockers: Partial<Record<ActionGroup, Blocker>> = {};
  for (const group of GROUP_ORDER) {
    if (allowed.includes(group)) continue;
    if (!rows.some(({ verdict }) => takes(verdict, group))) continue;
    const offenders = rows.filter(({ verdict }) => !takes(verdict, group));
    const first = offenders[0];
    if (!first) continue;
    const [primary] = GROUP_KINDS[group];
    blockers[group] = {
      count: offenders.length,
      first: first.row.name ?? first.row.localId,
      reason: first.verdict.blocked.find((entry) => entry.kind === primary)?.reason ?? 'unavailable'
    };
  }
  return { allowed, blockers };
}

/** Which venues this one row can actually be listed on, in the order the workspace offers them. */
export function venuesFor(verdict: ActionVerdict): Array<'steam' | 'csfloat'> {
  const venues: Array<'steam' | 'csfloat'> = [];
  if (verdict.allowed.includes('LIST')) venues.push('steam');
  if (verdict.allowed.includes('CSFLOAT_LIST')) venues.push('csfloat');
  return venues;
}

/**
 * The venues a row is shown but cannot go to, each with why, worded to follow the venue's name.
 *
 * The workspace lists them in the marketplace control, disabled, so an item CSFloat will not take
 * says so where the choice is made instead of the choice silently not being there. A venue the
 * account has not connected is left out, as the inspector leaves it out.
 */
export function unavailableVenues(verdict: ActionVerdict): Partial<Record<'steam' | 'csfloat', string>> {
  const unavailable: Partial<Record<'steam' | 'csfloat', string>> = {};
  const reasonFor = (kind: ActionKind): string | undefined => verdict.allowed.includes(kind) ? undefined : verdict.blocked.find((entry) => entry.kind === kind)?.reason;
  const steam = reasonFor('LIST');
  if (steam) unavailable.steam = steam;
  const csfloat = reasonFor('CSFLOAT_LIST');
  if (csfloat && csfloat !== CSFLOAT_DISCONNECTED) unavailable.csfloat = csfloat === CSFLOAT_UNSUPPORTED ? 'does not support this item' : csfloat;
  return unavailable;
}
