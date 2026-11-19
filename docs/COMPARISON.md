# Sui and OmniRoute

[OmniRoute](https://github.com/cheaper-inference/OmniRoute) is the project this one is measured against: MIT, 88k stars, 394 providers, 22 routing strategies, 12 compression engines. It is further along than Sui in almost every direction, and anyone choosing between them should know exactly where.

This page is what Sui can and cannot claim, and what it took from OmniRoute's design. It is written to be checkable: every "Sui has" line names the file or command that proves it.

## Where OmniRoute is ahead

| Area | OmniRoute | Sui |
|---|---|---|
| Providers | 394, of which 153 catalogued free | 29 seeded, 0 verified until you probe |
| Routing strategies | 22, composable per combo step | 4 (`fallback`, `weighted`, `cheapest`, `latency`) |
| Compression engines | 12, pipeline-ordered, per-combo toggles | 7 (`canonicalise`, `session_dedup`, `rtk`, `headroom`, `caveman`, `llmlingua_2`, `ccr`) |
| Dashboard | full app, 67 languages | one page, English |
| Deployment | desktop, PWA, Docker, tray, VS Code, remote mode, MITM capture | Node process, `--headless` |
| Ecosystem | A2A, memory, media generation, OCR, voice | MCP server and client, sandbox |

## Where Sui is ahead

| Claim | Evidence |
|---|---|
| **Nothing routes until a probe proved it** | `sui probe --write` → `$SUI_HOME/catalog-verified.json`; the router reads the overlay, not the seed |
| **A measured pass rate with its interval** | `npm run eval` prints `86% (43/50) · 95% CI 74–93%`, per category, thin categories marked indicative |
| **19 invariants, each with an enforcer and a test** | `packages/core/src/invariants.js`, asserted by `test/invariants.test.js` |
| **The paid gate is a branch in the startup path** | `apps/gateway/src/index.js` does not open the vault unless `paidTiers.enabled`; the key never exists in memory |
| **Zero runtime dependencies** | `npm ls --prod` is empty; ADR-0003 |
| **Every claim in the README is a number with its sample size** | `docs/MEASUREMENT.md` |

The difference is one sentence: OmniRoute is optimised for **breadth and savings**, Sui for **being able to prove what it did**.

## What Sui took from OmniRoute

| Feature | Sui state |
|---|---|
| Inflation guard on compression (never ship a "compressed" prompt that grew) | **shipped** — `packages/compression/src/index.js`; four presets × five adversarial inputs in `test/compression.test.js` |
| Headless mode (`--headless`, proxy engine only) | **shipped** — `apps/cli/src/cli.js`, `apps/gateway/src/server.js` |
| Cost and usage response headers | **already had** — `x-sui-cost-usd`, `x-sui-provider`, `x-sui-combo`, `x-sui-verified`, `x-sui-cached` |
| Terms-risk catalog with an `avoid` state | **already had** — `tos: avoid` entries are never auto-routed |
| Session dedup, RTK-style tool-output filtering, headroom, caveman, LLMLingua-2 | **already had** — the same engine families under `packages/compression` |

## Queued, in the order worth doing

| # | What | Why it matters here | Effort |
|---|---|---|---|
| 1 | `quota-weighted` routing — skip exhausted accounts, draw by leftover quota ÷ in-flight load | Sui knows a target's quota window; it does not yet use that to choose between two live targets | medium |
| 2 | Pool-deduped free-tier budget (`sui free-budget`) | OmniRoute's honest-arithmetic story, but with Sui's twist: only count pools a probe actually reached | medium |
| 3 | `auto` combo + task-aware routing | the cascade classifier already picks cheap vs strong; `auto` exposes that as a combo name | small |
| 4 | Adaptive admission — queue a heavy request instead of 503 | Sui fails fast under load | medium |
| 5 | `forcedModel` per API key | the tenant console already knows who is calling | small |
| 6 | i18n for the dashboard and CLI | the audience here reads Indian languages; OmniRoute ships 67 | large |
| 7 | More providers in the seed | breadth is the one thing that cannot be faked | continuous |

Items 1, 2 and 4 are the ones where Sui's verification data makes the feature *better* than the original: a quota-weighted router is only as good as its knowledge of remaining quota, and Sui measures that rather than reading a config.

## What Sui will not copy

- **MITM/TPROXY capture.** Intercepting TLS to see a CLI's traffic is a real capability and the wrong default for a tool that claims a privacy posture.
- **A headline token number.** OmniRoute is careful about this — pool-deduped, published methodology, re-audited every two weeks. Sui would have to publish a number it cannot verify from the user's own machine, which is the opposite of the point.
- **Credential masking on by default.** Redaction changes what the model sees; it stays opt-in.
