# Roadmap

Status is only `done` when a command proves it. Every row names the command that would change it.

Last audit: 2026-11-23 · `0.12.37` · 621 tests · audit 8/8 · ADR 10/10 · 1 verified route (owner's machine).

## Where the product stands

| | Sui | The thing it is measured against |
|---|---|---|
| Catalogue | 41 endpoints, **1 verified** (Groq, on a machine with egress) | 394 providers, 153 free |
| Routing strategies | 5 + `auto` | 22 |
| Compression | 7 engines, inflation guard on | 12 |
| Languages | 6 (en, hi, gu, mr, ta, te) — the boundary is documented and tested | 67 |
| Runtime dependencies | **0** | many |
| Proof a route works | **probe or nothing** | catalogue entry |
| Pass rate | printed with its 95% interval | not published |

The one-line difference: they optimise for breadth and savings, this optimises for being able to prove what it did.

## Done, and how it is checked

| Area | Command that proves it |
|---|---|
| 19 invariants, each with an enforcer and a test | `npm test` |
| 12 ADRs, 10/10 compliant | `npm run adr:check` |
| Security: CORS same-origin, SSRF guard, open-relay refusal | `test/security.test.js` |
| Malformed input: 10 cases, one contract | `test/robustness.test.js` |
| The published tarball installs and runs | `node scripts/verify-published.mjs` |
| Streaming, dashboard, languages, catalogue, kits — from the tarball | same |
| End to end on a real machine: install → init → doctor → probe → reply | owner's Windows box, 2026-11-23 |
| p95 inside the 15 ms budget | `npm run soak` |
| Answer quality measurable from the tarball, not just a checkout | `sui eval --self-test` |
| The health check scriptable, and the sweep bounded | `sui doctor --json`, `sui probe --concurrency 8` |
| Windows without an npm account | `docs/WINDOWS.md` |
| Legal docs reviewed and signed off | `docs/legal/LEGAL-INDEX.md` |

## Quick wins — small, real, in order

| # | What | Why it matters | Effort |
|---|---|---|---|
| 1 | A `CHANGELOG` entry generated from commit subjects | the changelog is hand-written and has been wrong once | small |
| 2 | `--json` on `catalog`, `free-budget` and `cost` already exist — a single `--json` contract across every command | two commands now keep it; the rest are ad hoc | small |

## Medium

| # | What | Why | Effort |
|---|---|---|---|
| 5 | Per-provider dashboard page | the weather card is a list; a provider's own page would carry its probe history | medium |
| 6 | Pool-deduped budget for every catalogue entry | 37 of 41 entries have no published budget recorded | data entry |
| 7 | `forcedModel` and rate limits in the tenant console | the API enforces both; the dashboard shows neither | medium |

## Large — a decision, not a task

| # | What | The decision |
|---|---|---|
| 8 | Breadth: 41 → several hundred endpoints | a grind, and each needs a source. `sui free-budget` keeps reporting unverified until somebody probes |
| 9 | A second data plane | the two-plane split exists; a hosted model plane does not |

## Closed

| Refused or finished | Reason |
|---|---|
| MITM/TPROXY capture | intercepting TLS contradicts the privacy posture |
| A headline token number | cannot be verified from the user's machine |
| Credential masking on by default | changes what the model sees |
| A quality score without an eval run | the harness self-test is labelled as one for exactly this reason |
| **More languages** | **dropped by the owner.** Six stand; the boundary is in `docs/LANGUAGES.md` and a test keeps it stated |
| **Legal review** | **signed off by the owner, 2026-11-23** |
| **`sui eval` as a command** | shipped 0.12.37 — the harness and the golden set travel in the CLI package, and `verify-published` runs it from the tarball |
| **Probe concurrency** | shipped 0.12.37 — bounded at 8 by default, `--concurrency N`, and a hard deadline so a blackholed socket cannot hang a sweep |
| **`sui doctor --json`** | shipped 0.12.37 — stdout is the document, exit 1 when no combo answered |

## Needs a human, in this order

| # | Step | Command | Time |
|---|---|---|---|
| 1 | Point an editor at the endpoint | `sui tools --set continue` | 1 min |
| 2 | Cap daily spending | edit `budgets.dailyUsd` | 1 min |
| 3 | A second free key, for redundancy | Cerebras or Mistral → `sui probe --write` | 5 min |
| 4 | 72-hour soak | `sui soak --minutes 4320 --rps 20` | 3 days |
