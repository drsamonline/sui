# ADR-0011 — attribution is a label the caller supplies, never an identity we infer

**Status:** accepted · 2026-11-15

## Context

Cost is only actionable if it can be charged to someone. But the gateway sits in front of other people's prompts, and the cheapest way to get attribution wrong is to infer it — reading a user agent as a person, or a key as a team.

## Decision

Two headers, and a documented fallback chain:

| Given | Charged to |
|---|---|
| `x-sui-user` / `x-sui-tool` | exactly what was sent, truncated to 64 characters |
| no user header | the API-key **name** (never the key) |
| no tool header | the product part of the user agent (`Cline/3.1.0` → `Cline`) |
| neither | `unattributed` — labelled, never dropped |

The ledger aggregates `byUser` and `byTool` using the **same `bump()`** as provider, model and combo, so the shapes cannot drift apart. `sui cost --by user|tool` prints the charge-back view; the CSV carries both columns.

The tenant console (`GET /api/tenants`, `PATCH /api/tenants/<name>`, `sui tenants`) shows what each key spent, what is left, its rate, its allow-lists and whether a key hash is stored. Two rules there:

- **An uncapped tenant reports `null`, not 0%.** Pretending a number is worse than admitting there is no cap.
- **`SUI_ADMIN_TOKEN`, when set, gates every tenant route.** A console that can raise a cap is a console that can spend your money.

A live `PATCH` applies in memory and says so in the response; the config file remains the source of truth.

## Consequences

- Nothing is inferred beyond those two labels, and neither is treated as identity — no IP, no fingerprint, no session stitching.
- A second `bump()` helper shadowed the module-level one during this work and broke every provider/model/combo aggregate the moment attribution was added. One grouping function is now the rule.
- Per-tenant policy beyond spend, rate and allow-lists (residency, fallback chains) is not built; see the roadmap.
