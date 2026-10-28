# `@cslytics/runtime`

What a process that drives the engine needs beside the engine: the command schema, the dispatch
table that answers it, the record opener and the single-writer lock. The desktop's utility process
is one composition of ports plus this package, and the test harness is another.

| Entry | Exports | Imports |
|---|---|---|
| `@cslytics/runtime` | `createRuntimeDispatch`, `openTradingRecord`, `RuntimeClock`, the lock, the schema | `@cslytics/engine`, `@cslytics/ports`, `zod` |
| `@cslytics/runtime/api` | `runtimeCommandSchema`, `RuntimeCommand`, `changeNotificationSchema`, `RUNTIME_COMMAND_TYPES`, the filter schemas | `zod` only, so a window or a thin client can bundle it without the engine |
| `@cslytics/runtime/lock` | `acquireRuntimeLock`, `releaseRuntimeLock`, `reapRuntimeLock`, `reapRuntimeLockWhenGone` | `node:fs` only, so a supervisor can reap a dead runtime's lock without loading `node:sqlite` |

## The one dispatch table

`createRuntimeDispatch(engine, hasStoredCredential)` returns the function that answers a
`RuntimeCommand`. It is the only place a command name meets an engine method, so a command takes
the same path whether a person pressed it in the desktop or a test sent it in process. A name the
table does not know is refused by name rather than answered with `undefined`.

A caller with commands of its own (the desktop answers names, prices, settings and releases
itself) spreads `runtimeCommandSchema.options` into its own discriminated union and answers its
additions before forwarding the rest. Nothing here knows those additions exist.

## What is deliberately not here

Composition. Which `SteamAuthPort` or `CsfloatTradePort` an engine gets is decided in exactly one
file per process — `apps/desktop/src/main/runtime/engine-runtime.ts` or a test harness
— and never in this package, which would otherwise be the shortcut that lets a runtime pick a
venue implementation on its own.
