# Contributing

CSlytics is open source, not open contribution. The code is public so you can read exactly what runs
against your Steam accounts; the work of changing it happens in a private repository.

**Issues are welcome.** A bug report, a wrong price, an item the app misreads, a Steam or CSFloat
change it has not caught up with, an idea. The more exact the better: the version (Settings ›
General › About), what you did, what you expected, and what you saw.

**Pull requests are not merged.** Every change to the trading engine is gated by a test suite that
runs it against simulated Steam and CSFloat services told to misbehave: timeouts, partial pages,
replies that claim success for things that never happened. That suite is not public, so a pull
request here cannot be checked the way every other change is. If a pull request shows a real
problem, the problem will be fixed, and the issue will say so.

You are free to fork under the [licence](LICENSE). A fork must use its own name and icon.
