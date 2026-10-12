# `@cslytics/engine`

Desired state, observation, convergence, and the only code in the repository that writes SQLite.

Imports `@cslytics/ports` and platform libraries. **Never** an adapter, an Oracle, `tools/` or
`tests/` — [../README.md](../README.md) explains why that boundary carries the weight it does.

## The folders are levels

`kernel` → `db` → `policy` → `surfaces` → `orchestrate`, with `read` beside them; imports point
down, and the two exceptions are declared in
[architecture.md](../../cslytics-app-docs/architecture.md#the-declared-import-graph) rather than
assumed. A surface is a vertical slice — one file owns sync, execute and reconcile for one external
surface — so a behaviour change is one file, not three.

## The shape of a decision

Every mutation takes one path, and each step has one owner:

1. an intent is persisted (`db/`), then
2. preconditions are evaluated against evidence (`kernel/evidence.ts`), then
3. an attempt is recorded and classified (`kernel/context.ts` → `executeMutation`, `kernel/outcome.ts`), then
4. a later authoritative observation decides what actually happened (the file in `surfaces/`), then
5. the read model publishes it (`read/views.ts`).

A response never skips to step 5. `Submitted` means the request was accepted, not that the state
exists, and ambiguity survives until an observation resolves it. That is repository rule 1, and it
is why `classifyAmbiguity` has no branch that guesses.

## Finding your way in

| Question | Start at |
|---|---|
| is this evidence fresh enough to conclude X? | `kernel/evidence.ts` → `FRESHNESS`, `evaluatePreconditions`, `postAttempt` |
| how is a mutation attempted and classified? | `kernel/context.ts` → `executeMutation`; `kernel/outcome.ts` |
| which table holds this, and what may write it? | [DATA-INDEX.md](../../DATA-INDEX.md) |
| what is an item's identity? | `kernel/identity.ts` → `stableItemKey`, `isIndividualItem`, `commodityKey`, `isSyntheticGcItem` |
| why did work stop? | `policy/divergence.ts`, then `read/views.ts` → `conflicts` |
| what does the UI actually read? | `read/views.ts` |
| how does an in-game store purchase complete? | `surfaces/in-game-store.ts` → `reconcile`; money admission shared with buy orders in `policy/wallet-admission.ts` |

[CODE-INDEX.md](../../CODE-INDEX.md) routes by symptom rather than by file, and is the faster entry
point when you know what went wrong but not where it lives.

## Rules this package exists to keep

- One writer, WAL, short transactions, and **never** a transaction held across a network or GC wait
  (rule 6). A dead `RUNNING` action recovers as `AWAITING_OBSERVATION`, never as retryable work.
- Everything is keyed by `accountId`. There is no ambient current account (rule 8).
- A Steam `asset_id` is not identity (rule 3). Float items use the stable tuple; non-float items
  are fungible quantities with operational handles.
- `TradingEngine` takes `ServiceOverrides` so a test can inject a wrong policy. That is
  composition, not a fault-injection hook: no "crash here" parameter may enter a production
  signature.
