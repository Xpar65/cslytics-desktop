import type { ComponentType, ReactNode } from 'react';
import type { IconName } from '../components/Icon.js';
import type { Section } from './sections.js';
import type { NamedItem } from '../features/inventory/InventoryTiles.js';
import type { NamedListing } from '../features/listings/listing-parts.js';
import type { CurrentListingStrategy, ListingStrategyOption, StagedEntry, Venue as WorkspaceVenue } from '../components/listing-workspace-store.js';
import type { CurrencyRef } from './money.js';

/**
 * Extensions a build may supply: extra pages, tile badges, inspector panels and listing strategies
 * for the listing workspace. The public desktop supplies none; a build that supplies more replaces
 * this module at bundle time.
 *
 * The shell knows the shape and nothing else: which pages exist, what a badge or a panel is drawn
 * over, and what a page is handed. Every hook is optional and an absent one renders nothing, so
 * the shipped window neither shows a sidebar group nor draws a badge for an extension it does not
 * have. Every import here is a type, so the module costs the bundle nothing until a build fills it.
 */

/** What an extension's page is handed: the accounts in view, the scope, and the shell's two moves. */
export type ExtensionViewProps = {
  /** The accounts the page is about: the one in scope, or every known account. */
  accountIds: readonly string[];
  accounts: ReadonlyArray<{ id: string; name: string; avatarRef?: string | null | undefined; steamId64?: string | null | undefined; currency?: number | null | undefined }>;
  /** `null` is the all-accounts scope. */
  scope: string | null;
  activeAccount: { accountId: string; accountName: string } | null;
  /** Opens a page of the window, putting an account in scope when one is named (`null` for every account). */
  navigate: (route: { section: Exclude<Section, 'extension' | 'host-page'>; accountId?: string | null | undefined }) => void;
  /** Opens one market name on the Items page, whose Back returns here. */
  openItem: (name: string) => void;
};

/** A page an extension adds to the sidebar. A `perAccount` page needs an account in scope, as Store does. */
export type ExtensionSection = {
  id: string;
  label: string;
  icon: IconName;
  blurb: string;
  perAccount?: boolean | undefined;
  component: ComponentType<ExtensionViewProps>;
};

/** What a holding badge is drawn over: a tile's row or the grouped view's summary row, which share these fields. */
export type ExtensionHolding = Pick<NamedItem, 'accountId' | 'matchKey' | 'defIndex' | 'paintIndex' | 'quality' | 'name' | 'marketHashName' | 'category' | 'rarity' | 'collection'> & {
  /** A tile's row only: a group row stands for many holdings. */
  localId?: string | undefined;
  paintWear?: number | null | undefined;
  quantity?: number | undefined;
};

export type ExtensionInspectorContext = { kind: 'item'; row: NamedItem } | { kind: 'listing'; row: NamedListing };

/** A staged row as a build's listing strategies are told about it. */
export type ListingStrategyRow = {
  key: string;
  entry: StagedEntry;
  venue: WorkspaceVenue;
  /** The row's own choice: an id, `null` for none, or `undefined` while it follows what it is under now. */
  chosen: string | null | undefined;
};

/** What a strategy that prices a row itself would list it at now. */
export type ListingStrategyPreview =
  | { state: 'reading' }
  | { state: 'priced'; buyerCents: number; receiveCents: number | null; currency: CurrencyRef }
  /** It would not list the row yet, and why: it waits until it can. */
  | { state: 'waiting'; why: string }
  | { state: 'failed'; why: string };

/** What a build's listing strategies say about the rows of one workspace. */
export type ListingStrategyView = {
  /** Every strategy a row can be handed to; `null` while they are being read. */
  options: readonly ListingStrategyOption[] | null;
  /** By row key: what the row is under now. A row absent is under none. */
  current: ReadonlyMap<string, CurrentListingStrategy>;
  /** Row keys whose current strategy is still being read. Nothing is sent for them until it is. */
  reading: ReadonlySet<string>;
  /** By row key, for rows on a strategy that prices them itself. */
  previews: ReadonlyMap<string, ListingStrategyPreview>;
  /** Why the strategies could not be read, when they could not. */
  error: string | null;
};

/** One send a build's listing strategies make, accepted or refused whole, as a workspace batch is. */
export type ListingStrategySend = { venue: WorkspaceVenue; kind: string; keys: readonly string[]; send: () => Promise<unknown> };

/**
 * Listing strategies a build offers in the listing workspace: a row can be handed to one instead of
 * being listed by hand at the price typed, and that strategy then lists it and keeps it listed.
 * The workspace decides what each row sends (`planRow`); this is how each part of it is sent.
 */
export type ListingStrategies = {
  /**
   * A hook, called once in every render of each workspace with the rows on screen. `open`: the
   * panel is showing, so what it reads should be kept fresh.
   */
  useView: (rows: readonly ListingStrategyRow[], open: boolean) => ListingStrategyView;
  /** The sends that hand rows to the strategy chosen for each. `buyerCents` is the typed price, for a strategy that takes one. */
  assign: (rows: ReadonlyArray<{ entry: StagedEntry; venue: WorkspaceVenue; strategy: string; buyerCents: number | null }>) => ListingStrategySend[];
  /**
   * Lets rows go from the strategy they were handed to: to `none` (a person's own price follows,
   * or the one they are listed at stays) or back to their `fallback`.
   */
  release: (entries: readonly StagedEntry[], to: 'none' | 'fallback') => Promise<void>;
};

export type Extensions = {
  /** The sidebar label over the extension pages. */
  group?: string | undefined;
  sections: readonly ExtensionSection[];
  /** Drawn over a holding's tile (a `TileBadge` in the `tag` corner) and in the grouped view's meta line. */
  holdingBadges?: ((row: ExtensionHolding) => ReactNode) | undefined;
  listingBadges?: ((row: NamedListing) => ReactNode) | undefined;
  /** Drawn in the inspector under where the item is, or under a listing's wear line. */
  inspectorPanels?: ((context: ExtensionInspectorContext) => ReactNode) | undefined;
  /** Drawn at the foot of the item inspector's actions, for the selection as a whole. */
  selectionActions?: ((context: { rows: readonly NamedItem[]; accountIds: readonly string[] }) => ReactNode) | undefined;
  /** Offered on every row of the listing workspace, and for every row at once. */
  listingStrategies?: ListingStrategies | undefined;
};

export const NO_EXTENSIONS: Extensions = { sections: [] };

/** What this build supplies. */
export const extensions: Extensions = NO_EXTENSIONS;

/** The section open in the `extension` slot, by id; `null` when none is open or the id is not one supplied. */
export function extensionSection(all: Extensions, id: string | null): ExtensionSection | null {
  if (id === null) return null;
  return all.sections.find((section) => section.id === id) ?? null;
}

/**
 * Refuses a section whose id is a page the window already has, or one supplied twice: the sidebar
 * would pick it and the view would show another. Called once as the shell loads, so a wrong build
 * fails on its first frame rather than on the click.
 */
export function checkExtensions(all: Extensions, sectionIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const section of all.sections) {
    if (sectionIds.includes(section.id)) throw new Error(`Extension section "${section.id}" takes the id of a page the window already has`);
    if (seen.has(section.id)) throw new Error(`Extension section "${section.id}" is supplied twice`);
    seen.add(section.id);
  }
}
