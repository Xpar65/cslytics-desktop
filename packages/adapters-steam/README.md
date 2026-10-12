# `@cslytics/adapters-steam`

Real Steam. Interactive QR and Guard login, the CS2 Game Coordinator session, Community Market
HTTP, and the credential-vault interface.

Imports `@cslytics/ports` and Steam client libraries. Never the engine, never an Oracle.

| File | Surface |
|---|---|
| `auth.ts` | `SteamSessionAuthAdapter`: QR, Guard and refresh-token login; token audience |
| `client-session.ts` | `SteamClientSessionPool`: one pooled client per account, shared by auth and GC |
| `gc.ts` | `SteamGcAdapter`: inventory snapshots, casket reads, store and retrieve, item events; storage unit renames; crate opening and terminal offers, sent raw because `globaloffensive` does not know `OpenCrate` |
| `market.ts` | `SteamMarketAdapter`: listings walk, sell, delist, buy orders, wallet, history |
| `in-game-store.ts` | `SteamInGameStoreAdapter`: the in-game store over the GC session `gc.ts` holds — price sheet, init, approval through a `CheckoutHost` the desktop supplies, finalize, cancel |
| `in-game-store-sheet.ts`, `in-game-store-protocol.ts` | the Valve LZMA container and binary KeyValues parse behind the sheet, and the store messages defined in code with their wire numbers |
| `vault.ts` | `CredentialVault`: the interface the desktop's Windows-backed store satisfies |

## Two rules that shape every file here

**No 2FA secret, anywhere.** This package must never accept, read, store, log or depend on a Steam
`identity_secret` or `shared_secret`. Interactive login and refresh tokens are the only
authentication path, and `pnpm check:secrets` enforces that over shipped source, request schemas
and dependencies. The local Guard-code generator under `tools/operator/` is development tooling;
nothing here may import it.

**An adapter reports, it never concludes.** A method returns `Submitted`, `DefinitivelyRejected` or
`Ambiguous` and stops. Deciding what actually happened needs a later observation, and that decision
belongs to the engine. A timeout or a malformed body is `Ambiguous` — never an assumed failure,
because an assumed failure is what produces a duplicate listing.

## Before changing a surface

Read the [owning rationale](../../cslytics-app-docs/steam/README.md) for that surface, then the
fixture behind the claim, then the deeper incumbent material through the
[reference index](../../cslytics-app-docs/REFERENCE-INDEX.md). Steam changes silently: a year-old
fixture still parses long after it stopped describing reality, which is why `check:fixtures` ages
them out after 30 days.

A CS2 Game Coordinator session is exclusive per account. An account signed in on another computer
with CS2 open cannot get one here, and the adapter says so by name rather than timing out.
`pnpm probe:gc-availability <account>` answers it live in about a minute.
