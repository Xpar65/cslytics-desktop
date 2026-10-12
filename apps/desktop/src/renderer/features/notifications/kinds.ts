import type { IconName } from '../../components/Icon.js';
import type { RecordTab, Section, SettingsPage } from '../../lib/sections.js';

/** How loud a notification is. It sets the toast's edge colour and how long the toast stays. */
export type Severity = 'info' | 'success' | 'warn' | 'error';

/**
 * Where a click takes the user. A per-account page needs the account it is about; a route into
 * Records may name the book it opens, and one into Settings the page it opens; `panel` opens the
 * work panel on that tab as well, for a notification about work.
 */
export type Route = {
  section: Section;
  tab?: RecordTab | undefined;
  settings?: SettingsPage | undefined;
  accountId?: string | null | undefined;
  panel?: 'work' | 'waiting' | undefined;
};

/**
 * Everything about a notification that is not the fact itself.
 *
 * `shape` is the field that matters most (README, "Vocabulary"): an *event* happened once and is
 * raised once; a *condition* holds for a while, is asserted while true and resolved when false,
 * and asserting it twice is one row, not two. That distinction is what keeps a network that is
 * down for an hour from filling the bell with sixty copies of the same warning.
 */
export type NotificationKind = {
  shape: 'event' | 'condition';
  severity: Severity;
  icon: IconName;
  /** At most 60 characters, in words a person uses. Names no identifier. */
  title: string;
  /**
   * One sentence, or several variants the producer chooses between by name — the copy stays
   * here either way, so every sentence the user can be shown is in one file.
   */
  body: string | Readonly<Record<string, string>>;
  /** The one thing a click does. `null` means the row is information only. */
  action: { label: string; route: Route } | null;
};

/**
 * The registry. Adding a notification is one entry here and one producer that raises it
 * (README, "Adding a notification"). Ids are `noun.verb`, kebab-case, and never change once
 * shipped: a future settings file will store them.
 */
export const NOTIFICATION_KINDS = {
  'catalogue.unreachable': {
    shape: 'condition',
    severity: 'warn',
    icon: 'wifi-off',
    title: 'Cannot connect to the CSlytics API',
    body: {
      withRevision: 'Check your network settings. Names already on screen are from the last successful download.',
      withoutRevision: 'Check your network settings. Item names and images will appear once the catalogue can be reached.'
    },
    action: null
  },
  // Both are facts `/me` already carries (`marketplace.status` → `restriction`, `stall`); the
  // producer reads them, it never decides them. The second is the trap CSFloat leaves behind:
  // it sets the stall away when it suspends and does not clear it when the suspension ends.
  'csfloat.suspended': {
    shape: 'condition',
    severity: 'warn',
    icon: 'ban',
    title: 'CSFloat has suspended this account',
    body: 'New listings are refused until CSFloat lifts it. Repricing and delisting still work.',
    action: { label: 'Open account', route: { section: 'settings' } }
  },
  'csfloat.stall-away': {
    shape: 'condition',
    severity: 'warn',
    icon: 'eye-off',
    title: 'Your CSFloat stall is still away',
    body: 'The suspension has ended, but CSFloat left the stall away, so nothing you have listed there is visible.',
    action: { label: 'Bring it back', route: { section: 'settings' } }
  },
  // A listing from a storage unit that ran out of time: the engine failed the operation with its
  // timeout reason after CSFloat's reads never showed the item (CSF-34). The item is loose and
  // unlisted. The work panel's row names it; this copy cannot, because a body has no slots.
  'csfloat.visibility-timeout': {
    shape: 'event',
    severity: 'error',
    icon: 'x-circle',
    title: 'A CSFloat listing from storage was not created',
    body: 'CSFloat did not see the item within 10 minutes of it leaving the unit. It is in your inventory and not listed; list it again once CSFloat shows it.',
    action: { label: 'Open work panel', route: { section: 'inventory', panel: 'work' } }
  },
  // This build, from `release.status` (desktop release plan §4, §5). The reasons a rule gives are
  // the release host's words, so they are shown under Settings › General › About and not here:
  // every sentence in this file is one this repository wrote.
  'release.update-ready': {
    shape: 'condition',
    severity: 'info',
    icon: 'download',
    title: 'An update is ready',
    body: 'It installs when you quit CSlytics, or now from Settings.',
    action: { label: 'Open Settings', route: { section: 'settings' } }
  },
  'release.retired': {
    shape: 'condition',
    severity: 'error',
    icon: 'ban',
    title: 'This version of CSlytics can no longer trade',
    body: 'Listing, delisting, transfers and storage moves are refused until you update. Everything you own is still shown.',
    action: { label: 'See why', route: { section: 'settings' } }
  },
  'release.paused': {
    shape: 'condition',
    severity: 'warn',
    icon: 'pause',
    title: 'Some actions are paused in this version',
    body: 'An update brings them back. Settings says which and why.',
    action: { label: 'See which', route: { section: 'settings' } }
  }
} as const satisfies Record<string, NotificationKind>;

export type NotificationKindId = keyof typeof NOTIFICATION_KINDS;

/** The kinds a producer may `assert` and `resolve`. */
export type ConditionKindId = {
  [K in NotificationKindId]: (typeof NOTIFICATION_KINDS)[K]['shape'] extends 'condition' ? K : never;
}[NotificationKindId];

/** The kinds a producer may `raise`. */
export type EventKindId = Exclude<NotificationKindId, ConditionKindId>;

/** The body variants one kind declares, so a producer cannot name one that does not exist. */
export type BodyVariant<K extends NotificationKindId> =
  (typeof NOTIFICATION_KINDS)[K]['body'] extends string
    ? never
    : keyof (typeof NOTIFICATION_KINDS)[K]['body'] & string;
