# CSlytics

A free, open-source Windows app for CS2 traders. Every Steam account you own in one window:
inventory and storage units, Steam Market listings and buy orders, trades, the in-game store, and
CSFloat listings, buy orders and deliveries.

**[Download for Windows](https://cslytics.com/download)** ·
[Guides](https://cslytics.com/guides) ·
[Releases](https://github.com/Xpar65/cslytics-desktop/releases) ·
[Road map](https://cslytics.com/#roadmap) ·
[Discord](https://discord.gg/cHFQakqDRF)

**It never asks for your Steam Guard secrets.** No `shared_secret`, no `identity_secret`, no
`.maFile`. You sign in with a QR code from the Steam mobile app, or your password and a Steam Guard
code, the same way you do on the Steam website. Trade and listing confirmations stay on your phone.

## Why you can trust it with your accounts

This is the code the installer is built from. Read it, or ask someone you trust to read it.

- **Your logins stay on your machine.** Steam sign-in tokens, and a CSFloat API key if you add one,
  are encrypted by Windows for your user account (`credentials.enc.json`, through Electron's
  `safeStorage`). They are only ever sent to Steam and CSFloat.
- **Your trading record stays on your machine.** Everything the app sees and everything you ask it
  to do is kept in `%APPDATA%\CSlytics\trading.sqlite`.
- **It talks to exactly these hosts:** Steam, its image servers and the CS2 Game Coordinator;
  `csfloat.com`, for its public list of the items it trades (fetched at start-up with no key and no
  account) and for your CSFloat account only once you connect it; `api.cslytics.com` for item
  names, which receives item identifiers and nothing about you or your accounts; and
  `downloads.cslytics.com` for updates. Requests to my servers say which version is asking and
  nothing else.
- **Every build is signed by me.** The publisher on the signing certificate is **Liam Cunneen**.
  It's an individual certificate in my name, not a company's, so that's the name Windows shows. An
  installed copy refuses any update that isn't signed by it.

### Installing, and checking your download

The installer is signed, but it's new, so Windows SmartScreen and Chrome may still warn that it's
an "unrecognized app" until it builds up download history. The
[download page](https://cslytics.com/download) shows what that warning looks like and how to get
past it.

Every release lists the SHA-256 of each file. To check yours, in PowerShell:

```powershell
Get-FileHash .\CSlytics-Setup-<version>.exe
```

The hash should match the release notes, and the file's *Digital Signatures* tab should name
`Liam Cunneen`. The only official builds are the ones on cslytics.com and this repository's
Releases.

## How to do things with it

Each guide on [cslytics.com/guides](https://cslytics.com/guides) starts with what Steam or CSFloat
lets you do on your own and the limits that apply, then shows the same job done in bulk here, with
screenshots and short recordings.

- [Sell multiple CS2 items at once on the Steam Market](https://cslytics.com/guides/sell-multiple-items-steam-market)
- [Manage CS2 storage units in bulk](https://cslytics.com/guides/cs2-storage-units)
- [List CS2 items on CSFloat in bulk](https://cslytics.com/guides/csfloat-bulk-listing)
- [Manage multiple Steam accounts for CS2 trading](https://cslytics.com/guides/multiple-steam-accounts-cs2)
- [Move CS2 items between your own Steam accounts](https://cslytics.com/guides/transfer-cs2-items-between-accounts)
- [Search your CS2 inventory by float, wear, pattern and storage unit](https://cslytics.com/guides/search-cs2-inventory)
- [See what a CS2 skin is worth at its exact float](https://cslytics.com/guides/cs2-skin-price-by-float)

## Ideas, bugs and the road map

What I'm working on next is on the [road map](https://cslytics.com/#roadmap). The best place for an
idea is `#feature-requests` on the [Discord](https://discord.gg/cHFQakqDRF). Bugs can go in
`#bugs-and-feedback` there, or in an issue here.

## Build it yourself

Windows, Node 22 and pnpm 10.

```powershell
pnpm install
pnpm dev               # run from source
pnpm package:desktop   # an unsigned installer in apps\desktop\dist
```

## What is here

| Path | Is |
|---|---|
| `apps/desktop` | the Electron app: main process, the window, updates and the release policy |
| `apps/host` | the same engine headless: a command line and an HTTP surface over one trading record, with the venues composed by a ports module you name |
| `packages/engine` | desired state, observation and convergence; the only writer of the trading record |
| `packages/ports` | the contract vocabulary between the engine and the outside world |
| `packages/runtime` | the command schema and the one dispatch table the desktop and the host both answer from |
| `packages/adapters-steam` | Steam: sign-in, the Game Coordinator, inventory, market, trades |
| `packages/adapters-csfloat` | CSFloat |
| `packages/catalogue` | item names and images, outside the engine |

The engine never takes a reply as proof that something happened. A listing exists when a later
read of the account shows it; a timeout means *unknown*, and the engine waits for the next complete
read before it acts again.

The tests aren't here. They replay recorded Steam and CSFloat traffic from my own accounts, which I
can't publish, and run the engine against simulated versions of both that misbehave on purpose.
They live in a private repository with my research notes. Comments in this code cite those files by
path, so those paths won't resolve here.

## Licence

[GNU Affero General Public License v3.0](LICENSE). You can use, study, change and share this code.
If you distribute a changed version, or run one as a service for other people, you have to publish
its source under the same licence.

The licence covers the code, not the name. "CSlytics" and its logo mark official builds, so a fork
needs its own name and icon.

## Contributing and security

Pull requests aren't merged here, for the reason in [CONTRIBUTING.md](CONTRIBUTING.md). If you have
an idea, `#feature-requests` on the [Discord](https://discord.gg/cHFQakqDRF) is the friendlier
place for it. To report a vulnerability, see [SECURITY.md](SECURITY.md).
