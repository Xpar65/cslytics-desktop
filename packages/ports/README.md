# `@cslytics/ports`

The vocabulary every other package speaks. **No dependencies, ever** — `check:deps` fails if
`package.json` gains one, because a type everyone shares must not drag a runtime with it.

## What belongs here

- Identity aliases that are deliberately opaque strings: `AccountId`, `AssetId`, `ListingId`,
  `BuyOrderId`. A Steam identifier never passes through a JavaScript number.
- The outcome alphabet: `DefinitivelyRejected`, `Submitted`, `Ambiguous` — and `ReconciledOutcome`,
  which only a reconciler may produce. An adapter cannot say `OBSERVED_*`, and that asymmetry is
  repository rule 1 expressed in the type system.
- One interface per external surface: `SteamAuthPort`, `SteamGcPort`, `SteamMarketPort`, `SteamInGameStorePort`, plus
  `ClockPort` so nothing reads wall time directly.
- The raw shapes Steam actually returns (`RawEconItem`, `MyListingsPage`, `MyHistoryPage`,
  `Wallet`, `TerminalRead`), with raw venue codes left uninterpreted — interpretation is the
  engine's job. A terminal's final-offer sentinel stays the raw `4294967291` for the same reason.
- Pure logic every side must compute the same way and nobody may own: marketplace fees
  (`fees.ts`) and the item identity key (`item-key.ts`), which the engine keys its rows with and
  the catalogue files its entries under, so neither has to import the other.

## What does not

Policy, freshness rules, retry decisions, SQL, or money arithmetic that depends on a venue. If a
type needs to know what is *true*, it belongs in the engine.

## Changing a port

A port change is a four-file change, and the filenames are parallel on purpose:

1. the port here,
2. the real adapter in `adapters-steam`,
3. the Oracle in `oracle-steam`,
4. the shared assertion in `tests/contract/shapes.ts`, run against both.

Skipping step 3 leaves the offline suite unable to exercise the change; skipping step 4 means
nothing proves the two agree.
