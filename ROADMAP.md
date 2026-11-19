# Roadmap

Status is only `done` when a command proves it. Every row below names the command that would change it.

Last audit: 2026-11-19 · `0.12.23` · 585 tests · audit 8/8 · ADR 10/10.

## Where the product stands

| | Sui | The thing it is measured against |
|---|---|---|
| Catalogue | 41 endpoints, **0 verified** until you probe | 394 providers, 153 free |
| Routing strategies | 5 (`fallback`, `weighted`, `cheapest`, `latency`, `quota-weighted`) + `auto` | 22 |
| Compression | 7 engines, inflation guard on | 12 |
| Languages | 6 (en, hi, gu, mr, ta, te) | 67 |
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
| Streaming, dashboard, languages, version — from the tarball | same |
| p95 inside the 15 ms budget | `npm run soak` |
| Windows without an npm account | `docs/WINDOWS.md` |

## Quick wins — small, real, done first

| # | What | Why it matters | Effort |
|---|---|---|---|
| 1 | **npm metadata: engines, keywords, bugs, LICENSE per package** | 19 packages had no `engines` (npm cannot warn a Node 18 user), no keywords (npm search found nothing), and **no LICENSE file in the tarball** — MIT requires the notice to travel with every copy. Shipped in 0.12.23. | done |
| 2 | **Stale numbers in docs** | README and the landing page said 572 tests when there were 583; `docs/PUBLISHING.md` still showed `v0.12.0`. Shipped in 0.12.23. | done |
| 3 | **`npm pkg fix` warnings** | npm was cleaning the `bin` path on every publish. Fixed in 0.12.23. | done |
| 4 | Finish the translation: the four foot lines and the detail tables | the dashboard is translated at the top and English below the fold; `docs/LANGUAGES.md` says so, but it is still a mixed page | 1 release |
| 5 | `sui doctor --json` | the one command every new user runs has no machine-readable output, so it cannot be scripted | small |
| 6 | A `CHANGELOG` entry generator from commit subjects | the changelog is written by hand and has been wrong once | small |

## Medium — worth doing, not urgent

| # | What | Why | Effort |
|---|---|---|---|
| 7 | Pool-deduped budget for every catalogue entry | `sui free-budget` reports 1.18B unverified from 4 pools; 37 entries have no published budget recorded | data entry |
| 8 | `sui probe` concurrency | 41 endpoints at 8 s each is five minutes serial | small |
| 9 | A dashboard page per provider | the weather card is a list; a provider's own page would carry its probe history | medium |
| 10 | `forcedModel` and rate limits in the tenant console | the API enforces both; the dashboard shows neither | medium |

## Large — a decision, not a task

| # | What | The decision |
|---|---|---|
| 11 | Breadth: 41 → several hundred endpoints | a grind, and each one needs a source. `sui free-budget` will keep reporting `0 verified` until somebody probes |
| 12 | A second data plane | the two-plane split exists; a hosted model plane does not |
| 13 | More languages | 6 → 22 is mechanical; 6 → 67 would be a claim this project cannot check |

## What is deliberately not built

| Refused | Reason |
|---|---|
| MITM/TPROXY capture | intercepting TLS contradicts the privacy posture |
| A headline token number | cannot be verified from the user's machine |
| Credential masking on by default | changes what the model sees |
| A quality score without an eval run | the harness self-test is labelled as one for exactly this reason |

## Needs a human, in this order

| # | Step | Command | Time |
|---|---|---|---|
| 1 | One free provider key | `console.groq.com` → API Keys | 2 min |
| 2 | Prove the routes | `sui doctor` | 30 s |
| 3 | Turn candidates into routes | `sui probe --write` | 2 min |
| 4 | Record a quality baseline | `sui eval --update-baseline` | 2 min |
| 5 | 72-hour soak (optional) | `sui soak --minutes 4320 --rps 20` | 3 days |

Until step 3 runs, the honest report is: 41 catalogue entries, **0 verified**.
