# `@cslytics/host`

The engine, headless. One process, one trading record, the same dispatch table the desktop's
utility process answers, driven over HTTP or from a script instead of a window.

```powershell
$env:CSLYTICS_HOST_TOKEN = "<a long random string>"
pnpm --filter @cslytics/host start serve --record ./trading.sqlite --ports ./my-ports.mjs --account alt:76561198000000001:alt --connect alt --active alt
pnpm --filter @cslytics/host start exec '{"type":"accounts.list"}'
pnpm --filter @cslytics/host start exec inventory.sync --json '{"accountId":"alt"}'
pnpm --filter @cslytics/host start events
pnpm --filter @cslytics/host build        # apps/host/out/host.mjs, for `node host.mjs serve ...` on a server
```

## What it is, and is not

It is `apps/desktop/src/main/runtime/engine-runtime.ts` with the Electron plumbing taken out:
`createHost` opens the record, composes `TradingEngine` over the ports it is given, answers
`RuntimeCommand`s through `createRuntimeDispatch`, and relays the engine's change notices. The
record it writes is the desktop's record: open it in the desktop later and nothing is missing.

It is **not** a composition of venues. The host never imports an adapter. The ports come from a
**ports module** named on the command line, so the same host runs over the desktop's adapters, over
a deterministic twin of the venues for a rehearsal, or over a composition this repository has never
heard of. That is the point of the seam, and it is also why nothing here can log a person in: a
session is whatever the module's `SteamAuthPort` says it is.

## The ports module

A file or package that exports `createPorts` (or a default export) of this shape:

```ts
import type { PortsModule } from '@cslytics/host';

export const createPorts: PortsModule = async ({ record, env, args, log }) => ({
  ports,                                  // EnginePorts: auth, gc, market, trade, inGameStore, persona, clock, csfloat?
  hasStoredCredential: (accountId) => ...,  // the dispatch's one question beside the ports
  close: async () => { ... }              // release clients and sockets when the host closes
});
```

Everything after `--` on the `serve` command line reaches the module as `args`. The module owns
whatever it needs to make sessions; the host holds no credential and reads none.

## The HTTP surface

| Route | Answers |
|---|---|
| `GET /health` | `{ok, accounts, at}`; no token, nothing a stranger could use |
| `POST /command` | a runtime command as JSON → `{ok:true, value}` or, for a refusal, `{ok:false, error}`; `400` when it is not a command the runtime knows |
| `GET /events` | Server-Sent Events, one `changed` per engine notice: `{accountId, surfaces, at}`, surfaces never rows |
| `POST /shutdown` | `202`, then the host closes |

Every route but `/health` needs `Authorization: Bearer <CSLYTICS_HOST_TOKEN>`. The default bind is
`127.0.0.1:7411`; bind an interface address only behind a firewall. A command's `ok: true` means the
engine admitted or did what was asked, not that the venue shows it: read the record, as a window
does, for what was observed.

## Starting accounts

`--account id:steamId64:name` ensures the record holds a row (an existing account with that name
or SteamID64 is updated in place); `--connect id` signs it in through the module's auth port, one
account at a time; `--active id` keeps that account's surfaces on the active cadence and the others
in the background. `--no-cs2` connects to Steam without asking the Game Coordinator for a session.

## Composition in one place

Which implementation of a port an engine gets is decided in one file per process: the desktop's
`engine-runtime.ts`, a host's ports module, or `tests/engine-harness.ts`. The host adds no second
place; `--ports` names the one.
