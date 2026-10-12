import { launchFor, type DesktopSettings } from '../../shared/api.js';

/**
 * How this desktop opens one account (steam/auth.md, "Launch preferences"): the options for its
 * `connect`, or null to leave it signed out. The launch sweep asks it for every saved account, and
 * "Connect all" asks it again, because that button is the sweep run once more. Pressing Connect
 * for one account is not: that is a person asking for exactly that account, and connects in full.
 */
export function launchConnect(settings: DesktopSettings, accountId: string): { cs2?: false } | null {
  const launch = launchFor(settings, accountId);
  if (!launch.signIn) return null;
  return launch.cs2 ? {} : { cs2: false };
}
