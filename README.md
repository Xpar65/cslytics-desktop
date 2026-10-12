# CSlytics

A free, open-source Windows desktop for CS2 traders. It manages every Steam account you own from one
window: inventory and storage units, Steam Community Market listings and buy orders, trades, the
in-game store, and CSFloat listings, buy orders and deliveries.

**Download:** [cslytics.com](https://cslytics.com) or this repository's
[Releases](https://github.com/Xpar65/cslytics-desktop/releases). Both carry the same signed files.

## Why you can trust it with your accounts

This is the code the installer is built from. Read it, or have someone you trust read it.

- **It never asks for your Steam Guard secrets.** No `shared_secret`, no `identity_secret`, no
  `.maFile`. You sign in with a QR code from the Steam mobile app, or a password and a Steam Guard
  code, exactly as on the Steam website. Trade and listing confirmations stay on your phone.
- **Your logins stay on your machine.** Steam sign-in tokens and a CSFloat API key, if you add one,
  are encrypted by Windows for your user account (`credentials.enc.json`, through Electron's
  `safeStorage`). They are sent only to Steam and CSFloat.
- **Your trading record stays on your machine.** Everything the app observes and everything you ask
  it to do is kept in `%APPDATA%\CSlytics\trading.sqlite`.
- **It talks to exactly these hosts:** Steam, its image servers and the CS2 Game Coordinator;
  `csfloat.com`, for its public list of the items it trades (fetched at start-up with no key and no
  account) and for your CSFloat account only once you connect it; `api.cslytics.com` for item
  names, which receives item identifiers and nothing about you or your accounts; and
  `downloads.cslytics.com` for updates. Requests to CSlytics hosts say which version is asking and
  nothing else.
- **Updates are signed.** An installed copy refuses an update that is not signed by the publisher
  `Liam Cunneen`.

### Check your download

Every release lists the SHA-256 of each file. In PowerShell:

```powershell
Get-FileHash .\CSlytics-Setup-<version>.exe
```

The hash must match the release notes, and the file's *Digital Signatures* tab must name
`Liam Cunneen`. Builds from anywhere else are not official.

## Build it yourself

Windows, Node 22 and pnpm 10.

```powershell
pnpm install
pnpm dev               # run from source
pnpm package:desktop   # an unsigned installer in apps\desktop\dist
pnpm smoke:packaged    # start the packaged app once and check it opens its record
```

## What is here

| Path | Is |
|---|---|
| `apps/desktop` | the Electron app: main process, the window, the update and release policy |
| `packages/engine` | desired state, observation and convergence; the only writer of the trading record |
| `packages/ports` | the contract vocabulary between the engine and the outside world |
| `packages/adapters-steam` | Steam: sign-in, the Game Coordinator, inventory, market, trades |
| `packages/adapters-csfloat` | CSFloat |
| `packages/catalogue` | item names and images, outside the engine |
| `scripts` | packaging, the packaged smoke test and the release script |

The engine never reads a request's reply as proof that something happened. A listing exists when a
later read of the account shows it; a timeout means *unknown*, and the engine waits for the next
complete read before it acts again.

The test suite, the simulated Steam and CSFloat it runs against, and the research behind them are
kept in a private development repository. Comments in this code cite those documents by path; the
paths will not resolve here.

## Licence

[GNU Affero General Public License v3.0](LICENSE). You may use, study, change and share this code.
If you distribute a changed version, or run one as a service for others, you must publish its
source under the same licence.

The licence covers the code, not the name. "CSlytics" and its logo identify official builds; a fork
must use its own name and icon.

## Contributing and security

Bug reports and ideas are welcome as issues. Pull requests are not merged; see
[CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).
