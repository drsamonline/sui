# Legal

The legal documents in this repository, what each one answers, and its status.

| File | Answers | Status |
|---|---|---|
| [`LICENSE`](../../LICENSE) | What others may do with this code | MIT, final |
| [`NOTICE`](../../NOTICE) | Whose work is inside, and under what terms | current |
| [`docs/legal/OWNER_GRANT.md`](OWNER_GRANT.md) | Why PolyForm-licensed kits are distributed here under MIT | written, awaiting a lawyer's read |
| [`docs/legal/LICENSE_INVENTORY.md`](LICENSE_INVENTORY.md) | Every third-party source, pinned commit and what was taken | current |
| [`PRIVACY.md`](../../PRIVACY.md) | What data the software touches and where it goes | **draft** |
| [`TERMS.md`](../../TERMS.md) | The deal for using or buying it | **draft** |
| [`DISCLAIMER.md`](../../DISCLAIMER.md) | What the output must not be relied on for | current |
| [`SECURITY.md`](../../SECURITY.md) | How to report a vulnerability | current |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | The licence grant for contributions, and how the code is held to its claims | current |

## The licence in one line

**MIT.** Everything in this repository is MIT, including the vendored kits — those come from the owner's own repositories, which are published under PolyForm Noncommercial, and are distributed here under a written owner grant ([`OWNER_GRANT.md`](OWNER_GRANT.md)).

That sentence matters beyond politeness: a reader who sees PolyForm files inside an MIT repository without the grant has no way to tell whether the distribution is coherent. [`packages/catalog/sources.json`](../../packages/catalog/sources.json) is the equivalent ledger for the catalogue's endpoint facts, two of whose sources declare no licence and contributed facts only.

## What the software actually does, for the purposes of these documents

| Question | Answer | Where to check |
|---|---|---|
| Does it transmit data? | Yes — prompts go to whichever model provider the route selects | `packages/router/src/router.js` |
| Does it store prompts? | No — the ledger holds a salted hash and a length | `packages/telemetry/src/ledger.js`, I11 |
| Does it store health history? | Durations and booleans only; a row carrying any other field is dropped | `packages/telemetry/src/history.js`, I19 |
| Does it hold credentials? | Provider keys, sealed with AES-256-GCM, and only when the paid gate is open | `packages/vault`, ADR-0004 |
| Does it have accounts? | Optional API keys; the dashboard API is unauthenticated by default and binds loopback | `AUDIT-2026-11-15.md` §3 |
| Does it run model-written code? | Only if you ask it to, in a separate process with no network namespace | `docs/SANDBOX.md` |

## Status

These documents describe the software as shipped and are updated in the same commit as any change to how it handles data. They are not legal advice. A qualified Indian advocate should review `PRIVACY.md`, `TERMS.md` and `OWNER_GRANT.md` before a commercial release.
