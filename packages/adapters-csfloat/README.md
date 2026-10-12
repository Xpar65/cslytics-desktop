# `@cslytics/adapters-csfloat`

Real CSFloat. The user's own developer key, and the routes it opens.

Imports `@cslytics/ports` and nothing else. Never the engine, never an Oracle, never the Steam
adapter — the shared `CredentialVault` moved into `ports` precisely so this package would not
have to reach for it through `adapters-steam`.

| File | Surface |
|---|---|
| `transport.ts` | One host, no redirects, a write-only `Authorization` header, and rate headers read case-insensitively |
| `account.ts` | `CsfloatAccountAdapter`: `/me` identity, balances and readiness, and the classification of every way it can fail |

## What this package refuses to do

**Follow a redirect.** `redirect: 'manual'` is not a preference. Following a 30x would send the
key to whatever the response pointed at, so a redirect is reported and the request ends there.

**Leave the host.** Every URL is built from `CSFLOAT_BASE`; a path that would escape the approved
host or the `/api/v1/` prefix throws before a key is attached. Nothing here accepts a URL.

**Return, log or interpolate the key.** It goes into a header and nowhere else. Failures carry a
status and CSFloat's own body, and the vault reference names an account and a version, never a
secret.

**Decide what happened.** A `401` is the venue refusing the key; a timeout, a WAF page or a `429`
is the absence of an answer. Both are reported as what they are, because only the first may end a
connection and this layer is not the one that gets to make that call.

## The credential reference

`csfloatKeyRef(accountId, version)` names one vault entry. It is versioned because replacing a key
is two durable steps — write the new entry, then switch the database reference — and reusing one
name would make the gap between them destructive. The engine spells the same string
(`credentialRefFor`), because rule 7 forbids it importing this package;
`tests/unit/csfloat-account-adapter.test.ts` is what keeps the two spellings identical.
