# `@cslytics/catalogue`

What an item is **called**, and what it looks like. Nothing here is trading state.

## What it owns

- Fetching the catalogue from `api.cslytics.com`'s FREE static namespace, validating it strictly,
  and refusing anything doubtful whole rather than partially (`src/parse.ts`).
- Keeping the applied generation in files it owns, swapped atomically, so a process that dies
  mid-write leaves the previous generation current (`src/store.ts`).
- Resolving `(def_index, paint_index, quality)` to a name, a rarity, a collection and an image
  reference — or to an explicit *unresolved* reason, never to a guess (`src/index.ts`).
- Resolving a search term to identity keys, which is the only catalogue-shaped value allowed to
  reach the engine.
- Composing image URLs from a compiled host allowlist, in one place (`src/images.ts`).
- Converting between the real float and the norm float against a skin's paint range
  (`src/float.ts`), and turning a norm-float filter into real-float bands the engine can evaluate
  (`src/bands.ts`). The words are defined in [conventions.md](../../cslytics-app-docs/conventions.md#real-float-and-norm-float).

## What may import it

The desktop's **main process**, and tests. Not the engine — `check:deps` fails the build if that
changes. The renderer imports pure functions only, through `src/browser.ts` (`cachedImageUrl`,
`resizedImageUrl`, `realToNorm`): it never syncs, resolves or reads a catalogue file, receives names and paint ranges
already attached to its rows, and gets composed image references, never a host name.

## What it must never own

- **A trading fact.** No ownership, location, quantity, reservation, attempt or ledger posting.
  If deleting this package's files would make a trading decision wrong, something is in the wrong
  place. An entry's `marketable: false` is the nearest it comes, and it only ever refuses: it says
  a coin or medal's *kind* is never a market item, so the window offers it no verb, while the
  engine judges each unit by what Steam observed. Deleting it would offer a coin Store and List
  and the engine or Steam would still refuse; nothing it says permits anything.
- **A mutation target.** Commands address identity tuples and asset handles. A name may never
  decide what a command acts on; the engine cannot resolve one because it has never heard of names.
- **A credential.** A catalogue request carries identity tuples and nothing else — no account id,
  no SteamID, no asset id, no header. `check:assets` asserts it.

## Why it is not an adapter or an Oracle package

`Port`, `Adapter` and `Oracle` name the engine's boundary. This is not on it. See
[architecture.md](../../cslytics-app-docs/architecture.md) principle 1 and
[conventions.md](../../cslytics-app-docs/conventions.md).

## Two failure rules

1. **An unreachable server subtracts a name, never an item.** A failed, empty or malformed sync
   leaves the applied generation exactly where it was. A fetch that did not happen is not evidence
   that an item stopped existing.
2. **An unknown key is unresolved, never guessed.** No nearest def-index, no same-paint substitute.
   An unresolved row still shows, still selects, and still operates.
