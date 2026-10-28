import type { SteamAuthPort } from './auth.js';
import type { SteamGcPort } from './gc.js';
import type { SteamMarketPort } from './market.js';
import type { SteamTradePort } from './trade.js';
import type { SteamInGameStorePort } from './in-game-store.js';
import type { SteamPersonaPort } from './persona.js';
import type { ClockPort } from '../kernel.js';

export type * from './auth.js';
export type * from './gc.js';
export type * from './market.js';
export type * from './trade.js';
export type * from './in-game-store.js';
export type * from './persona.js';
export type * from './confirmation.js';

/** Everything one Steam account needs, composed once per process. */
export type SteamPorts = {
  auth: SteamAuthPort;
  gc: SteamGcPort;
  market: SteamMarketPort;
  trade: SteamTradePort;
  /** The CS2 in-game store, sharing the GC session `gc` holds. */
  inGameStore: SteamInGameStorePort;
  /** Persona name and avatar hash via the logged-on CM client. */
  persona: SteamPersonaPort;
  clock: ClockPort;
};
