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

One kind of answer stands in for the observation of step 4: one that returns the object as it now
is, and may settle the change it answers. A CSFloat reprice returns the listing, and the answer is
recorded as an observation of that listing and judged by the rules a read is judged by
(`orchestrate/csfloat-selling.ts` → `settleOnAnswer`, `db/csfloat.ts` → `recordAnswer`). A Steam
price change in place names the listing's price, and the answer is recorded as a stated price on
the listing, with no observation behind it (`surfaces/market.ts` → `recordPriceAnswer`,
`db/orders.ts` → `stateSteamPrice`). Nothing else in a response is one: an acknowledgement that
states nothing still waits for a read, and a read begun after such an answer that disagrees with
it replaces it.

One kind of mutation is sent again with no observation proving it absent: Steam's discard of a
lower listing price that waits for its confirmation. A discard only drops something of ours that
is still waiting, or does nothing, so a second send cannot apply an effect twice. A send Steam
never answered (no HTTP 200 answer of the market's action route came back, whatever the cause)
is sent again after 30 seconds, 2 minutes and 10 minutes, four sends in all; when none is heard
the change fails as `withdrawal-unheard`, because the lower price may still be waiting there
(`surfaces/market.ts` → `recordDiscardAnswer`, `policy/price-change.ts` →
`PRICE_DISCARD_BACKOFF_MS`).

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
