# Security

CSlytics holds Steam sign-in tokens and, if you add one, a CSFloat API key. A flaw that could leak
them, act on an account without the owner asking, or let anyone but the publisher ship an update is
the most serious kind of bug this project can have.

## Reporting a vulnerability

Report it privately through this repository's **Security › Report a vulnerability** form. Please do
not open a public issue for it.

Include the version, what an attacker needs (a network position, a file on the machine, a crafted
item or listing), and what they get. You will get a reply, and a fix will be released with credit to
you unless you would rather not be named.

## Official builds

The only official builds are the ones on this repository's Releases page and on
`downloads.cslytics.com`. Each is signed by the publisher `Liam Cunneen`, and each release lists the
SHA-256 of every file. A build from anywhere else, or one asking you for a Steam Guard secret or a
`.maFile`, is not CSlytics.
