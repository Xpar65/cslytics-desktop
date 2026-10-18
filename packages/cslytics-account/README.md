# `@cslytics/cslytics-account`

The CSlytics account on this desktop: an **optional** sign-in to the CSlytics website through the
person's own browser, the account the website reports, and the tokens that keep it. Nothing the app
does with Steam depends on it.

## What it owns

- The browser sign-in: an authorization code with PKCE (RFC 7636), received on a one-shot listener
  on `127.0.0.1` as RFC 8252 describes for native apps (`src/loopback.ts`, `src/pkce.ts`). The
  decision about each request to that listener is `CallbackGate`, so it can be proved without a
  socket.
- The website's four calls, and the one rule about their answers that matters most: only the
  website *refusing* a grant signs a person out. A timeout, a 5xx, a 429 or a body that does not
  parse is `unavailable`, and leaves everything as it was (`src/issuer.ts`).
- The account itself (`src/account.ts`): sign-in, verification against `GET /api/desktop/me`,
  refresh-token rotation, sign-out, and what a restart finds. The refresh token is in the vault under
  `cslytics-refresh-token`; the account as last verified is `cslytics-account.json`
  (`src/account-file.ts`); the access token is only ever in memory.
- `OracleAccountIssuer`, a deterministic twin of the website's issuer that keeps the same rules:
  single-use codes bound to their challenge, rotation, a 60-second window for retrying a lost
  rotation, and replay revoking the session.

## What may import it

The desktop's **main process**, and tests. The engine may not, and `check:deps` fails the build if
it does: a CSlytics account is a fact about the person at this desktop, never about a Steam account,
and the trading record stays portable only while nothing like it enters. The window takes the
`CslyticsStatus` type and nothing else; it learns everything over IPC.

The package itself imports `@cslytics/ports` and `node:` modules only. Fetch, the browser opener and
the clock are handed in by main.

## What it must never own

- **A token anywhere but the vault and memory.** Not in `cslytics-account.json`, a log line, an IPC
  reply, or a diagnostics export.
- **A local gate.** Signing in unlocks what the website and the API serve. A check that only this
  app performs would be one line for anyone to delete, so nothing local is ever locked behind it.
- **A wait on the engine's path.** Main starts the Engine Runtime without waiting for the website,
  and an outage changes no Steam behaviour.

## Order of writes

Sign-in writes the vault, then the file. Sign-out deletes the vault entry, then the file, and only
then tells the website. A restart that finds the file without the credential removes the file; one
that finds the credential without the file asks the website again. No crash leaves a signed-in
account without its credential.
