# Notifications

Every message the app raises to the user **without being asked** comes through here: it appears
for a moment in the top-right of the window, and it is kept behind the bell beside the work
indicator until the user opens the bell. Adding a new one is one registry entry and one producer.

This directory is the small, shipped core of the
[notifications plan](../../../../../../cslytics-app-docs/plans/notifications-plan.md). The plan is the
fuller design; this README is what is actually in the tree and how to extend it.

## Vocabulary

**Notification.** A message about something the user did not just do. It has a *kind* (a row in
`kinds.ts`), a *severity*, a *title* and a *body* in words, an optional *account*, and at most one
*action* — where a click takes the user.

**Notice.** Not a notification. `components/ui.tsx` `Notice` is the inline band that answers a
click, shown where the click happened. The line is: *a notice answers; a notification interrupts.*
Something can be both, but nothing is a notification only because raising one was convenient
from wherever the code was.

**Event and condition.** The one distinction that matters when adding a kind:

- An **event** happened once, at a time — a buy order filled, a command was refused. It is
  `raise`d once. Two events are two rows.
- A **condition** holds for a while — the CSlytics API is unreachable, the runtime is down. It is
  `assert`ed while true and `resolve`d when false. Asserting a condition that already holds does
  nothing; resolving one that does not hold does nothing; a condition that comes back is the same
  row raised again, with the new time. A network that flaps all afternoon leaves **one** row.

**Seen.** The bell's badge counts rows that were raised since the bell was last opened. Opening
the bell clears the whole count. A toast leaving — on its own or by its × — does *not* mark
anything seen: a message that scrolled past unread is the case the bell exists for.

## What is on screen

| Surface | File | Behaviour |
|---|---|---|
| Toast stack | `NotificationStack.tsx` | Fixed top-right beneath the account strip, newest on top, at most three plus a "+N more" line. A toast leaves after its severity's lifetime (`TOAST_LIFETIME_MS` in `model.ts`) or when its × or its action is pressed. A resolved condition's toast leaves at once |
| Bell | `NotificationBell.tsx` | Always present in the account strip after the work indicator. Badge is the unseen count, capped at `99+`. Clicking it clears the count and opens the centre |
| Centre | `NotificationCentre.tsx` | A `Drawer`: **Now** (conditions that hold, "since 12:01") then **Earlier** (events and resolved conditions), newest first. A row with an action is a button and goes there; a row without one does nothing on click |

The DOM hooks the offline journey `O-NOTIFY-01` relies on: `.notification-bell`, `.notification-badge`,
`.notification-stack`, `.toast`, `.toast-title`, `.notification-row`, and the dialog named
*Notifications*.

## How it fits together

```
producers/*.ts  ──raise / assert / resolve──▶  NotificationProvider.tsx  ──state──▶  Bell, Stack, Centre
                                                       │
                                                  model.ts (pure reducer + selectors)
                                                       │
                                                  kinds.ts (the registry: copy, severity, action)
```

- `kinds.ts` — the registry. Pure data. Every sentence the user can be shown is here.
- `model.ts` — a pure reducer over `NotificationState` and the selectors the surfaces read
  (`toasts`, `unseenCount`, `centre`, `nextToastExpiry`). No React, no `window`, no clock of its
  own; every action carries its time. `tests/unit/notifications-model.test.ts` drives it in Node.
- `NotificationProvider.tsx` — holds the reducer in context, exposes `useNotifications()`, mounts
  every producer once, and owns the one timer that makes toasts leave.
- `producers/` — one hook per thing that knows a fact. A producer lives beside what it knows
  about, calls `assert`/`resolve` or `raise`, and decides nothing about delivery.
- `../../lib/sections.ts` — the page ids a `Route` may name, so a kind can say "Open Settings"
  without importing the shell.

## Adding a notification

1. **Add the kind** to `NOTIFICATION_KINDS` in `kinds.ts`: `shape`, `severity`, `icon`, `title`,
   `body` (a sentence, or named variants), and `action` (`{ label, route }` or `null`). The id is
   `noun.verb` in kebab-case and never changes once shipped.
   `tests/unit/notification-kinds.test.ts` checks the entry is complete.
2. **Write the producer** in `producers/<thing>.ts` as a hook taking `Pick<NotificationApi, …>`,
   and mount it in `Producers` in `NotificationProvider.tsx`. Derive the fact from a read the
   window already does or a change notice it already receives; a producer never invents a fact.
   For a condition, call `assert` whenever the read says it holds and `resolve` whenever it says
   it does not — both are safe to repeat. For an event, call `raise` once per occurrence.
3. **Prove it can fail**: extend the model test if the reducer learned a rule, and if the fact is
   reachable on the seeded offline profile, an offline journey like `O-NOTIFY-01`.

The types keep the verbs honest: `raise` accepts only event kinds, `assert`/`resolve` only
condition kinds, and `variant` only the body names that kind declares. A mismatch is a type
error; at runtime the reducer throws with the fix in the message.

## Rules this layer keeps

1. **A notification says what was observed, never what was requested.** A mutation receipt raises
   nothing (repository rule 1). The catalogue producer reads `catalogue.status`, which main sets
   from the outcome of a real sync.
2. **The renderer decides delivery; it never decides fact.** What is notable is decided where the
   fact is known. Whether it becomes a toast is decided here.
3. **Nothing here is evidence and nothing here persists.** The record lives in memory and is lost
   on relaunch by design: a condition is re-derived from the reads on the next launch, and an
   event that matters after the window closes is an engine fact the engine already wrote. The
   trading database is never written on this layer's behalf, and no notification row is ever
   stored in it (plan §7.2).
4. **Identifiers never reach the screen.** Titles and bodies are words from the registry.

## Deliberately not built yet

Each of these is designed in the plan and was left out to keep the first cut legible. The plan
section is where to start when one is wanted. Every fact the app already knows and could raise,
ranked by what it costs not to, is the
[notifications plan §12](../../../../../../cslytics-app-docs/plans/notifications-plan.md#12-what-to-hook-up-to-the-bell).

| Not here | Plan |
|---|---|
| Settings: which kinds may toast, per category and per channel | §5 |
| System (OS) notifications when the window is in the background | §7.1 |
| Notifications about engine facts that outlive the window — buy order fills, inbound trade offers — through one engine read and a desktop-owned watermark file | §7.2 |
| Coalescing ("3 buy orders filled"), hover pausing a toast's timer, per-row dismiss and *Clear earlier* in the centre | §3.1, §3.4 |
| Producers for runtime health, account sessions, refused work and shell failures | §3.3 |
