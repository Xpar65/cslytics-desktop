# Contributing

Thanks for wanting to help. CSlytics is open source so you can read exactly what runs against your
Steam accounts, but I make the changes myself, in a private repository.

**Ideas** are best in `#feature-requests` on the [Discord](https://discord.gg/cHFQakqDRF). Check
the [road map](https://cslytics.com/#roadmap) first, since it may already be planned.

**Bugs** can go in `#bugs-and-feedback` on the Discord, or in an issue here: a wrong price, an item
the app misreads, a Steam or CSFloat change it hasn't caught up with. The more exact the better:
the version (Settings › General › About), what you did, what you expected, and what you saw.

**Pull requests aren't merged.** Every change to the trading engine has to pass a test suite that
runs it against simulated Steam and CSFloat services told to misbehave: timeouts, partial pages,
replies that claim success for things that never happened. That suite replays recorded traffic from
my own accounts, so it can't be public, and a pull request here can't be checked the way every
other change is. If a pull request shows a real problem, I'll fix the problem and say so on it.

You're free to fork under the [licence](LICENSE). A fork needs its own name and icon.
