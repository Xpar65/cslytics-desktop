/**
 * An account the Engine Runtime has a row for, as the window lists it: the account strip's tabs,
 * Settings › Account, and the sign-in dialog all read this one shape. Nothing here claims a session
 * exists; whether the account is connected is `session.status`'s to say.
 */
export type AccountCard = {
  accountId: string;
  accountName: string;
  steamId64: string;
  /** True when the OS vault still holds a refresh token, so Connect has something to reuse. */
  hasSession: boolean;
  /** `avatar:<40hex>` when observed; otherwise null and the face falls back to initials. */
  avatarRef: string | null;
  /** The Steam display name when a persona walk has observed one. */
  personaName: string | null;
};
