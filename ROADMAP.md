# Sui — plan and roadmap

**Free tiers, verified before use. Zero blind spots. Zero silent degradation.**

This is the working plan: twelve phases, sixty batches, in dependency order. Every batch has a status, and a status is only `done` when a command in this repository proves it — a test, an eval run, or a soak report. Nothing here is marked done because it was written.

Last updated: 2026-11-14 · 214 tests green · eval self-test green · soak p95 1.13ms against a 15ms budget · 7 kits vendored · prober built.

---

## How this plan is built

Three rules keep it honest:

1. **Invariants come first.** `packages/core/src/invariants.js` holds all fifteen as data, each with the module that enforces it and the test that proves it. `test/invariants.test.js` fails if an invariant loses either. An invariant whose test is `none` is not allowed to exist.
2. **A batch is done when a command says so.** Tests (`npm test`), the golden-set eval (`npm run eval`), the soak (`npm run soak`), or the invariant audit (`sui invariants`). The acceptance criteria in the project prompt (AC1–AC7) map onto those commands.
3. **Reuse is gated by licence, not by convenience.** The fleet's kits are PolyForm Noncommercial; Sui is MIT. `docs/legal/LICENSE_INVENTORY.md` records what may be vendored and what may only be adapted. See ADR-0002.

## Where Sui stands

| | |
|---|---|
| Runtime | Node 20+, ESM, **zero runtime dependencies** |
| Layout | npm workspaces: `apps/{gateway,dashboard,cli}` · `packages/{core,providers,router,telemetry,catalog,guardrails,sdk}` |
| Tests | 214 passing, no network, no keys (`npm test`) |
| Eval | 50-prompt golden set, 56-check self-test, regression gate against `evals/baseline.json` |
| Soak | `npm run soak` — 1,200 requests, p95 2.57ms overhead, no unhandled errors |
| Security | Host-header allowlist, SHA-256 key hashes with constant-time compare, no default password, no JWT, paid vault sealed with AES-256-GCM |
| Kits | crypto, ml, search, tokens, compress, export, web — vendored at pinned commits, loaded in an isolated VM |

---

## Phase status

Legend: **done** = a command proves it · **partial** = shipped, with a named gap · **todo** = not started · **blocked** = waiting on a decision (licence, external fact, or benchmark).

### Phase 0 — HARDEN

| Batch | Status | Evidence / gap |
|---|---|---|
| B0.1 Security fixes | **done** | Host-header allowlist (`hostAllowed`, tested with a forged Host), SHA-256 API keys + `timingSafeEqual` (`verifyApiKey`), `EADDRINUSE`/`EACCES` as sentences, `sui keys hash` to rotate plaintext keys. JWT fallback secret: N/A, Sui issues no JWTs (ADR-0006). Default password: N/A, there is no password login. SQLite race: N/A, persistence is append-only JSONL (ADR-0001). |
| B0.2 Global error handlers | **done** | `apps/cli/bin/sui.js` traps `unhandledRejection` and `uncaughtException`, prints a plain sentence, and never claims in-flight work completed. |
| B0.3 72h soak harness | **partial** | `scripts/soak.mjs` exists, gates p95 overhead and memory growth, and CI runs 60s. The 72-hour run itself has not been done — it needs a machine held for three days. |

### Phase 1 — FOUNDATION

| Batch | Status | Evidence / gap |
|---|---|---|
| B1.1 Monorepo scaffold | **done** | npm workspaces (not Turborepo — ADR-0003). `apps/`, `packages/`, `evals/`, `config/`, `docs/adr/`, `docs/legal/`, `vendor/`. |
| B1.2 `packages/core` | **done** | Error taxonomy, config schema + validator, cost model, and the invariant table with its audit. |
| B1.3 `packages/sdk` | **done** | `SuiClient`: chat, stream (async iterator), models, status, metrics, toggle validation, health. Six tests against a live gateway. |
| B1.4 `apps/gateway` | **partial** | OpenAI-compatible surface, SSE, dashboard API, `/v1/models` from memory (I3, measured <1000ms). **Go/Rust data plane deferred** — ADR-0001 sets the benchmark that would justify it; today's Node handler costs p50 0.38ms. SQLite not yet: config is the routing table, the ledger is JSONL. |
| B1.5 `apps/cli` | **done** | `sui init · start · doctor · models · cost · tools · migrate · keys hash · invariants`. |
| B1.6 `evals/` golden set | **done** | 50 prompts across 10 categories, 9 deterministic graders, self-test proving the graders grade (50 must-pass + 6 must-fail), JSON+Markdown reports. |
| B1.7 CI eval gate | **done** | `.github/workflows/ci.yml`: tests on Node 20 and 22, eval self-test, eval gate, 60s soak, invariant audit, migration preview. |

### Phase 2 — FREE-TIER INTELLIGENCE

| Batch | Status | Gap |
|---|---|---|
| B2.1 `packages/catalog` | **partial** | Schema, dedupe by `pool_key`, ToS states, retention levels, capability list, scoring, plus a generated set. **26 entries today (11 hand-written + 15 from app-endpoints); target is 500+, and none has a verified URL.** |
| B2.2 Catalog sync worker | **partial** | `scripts/build-catalog.mjs` ingests the fleet's `app-endpoints` dataset (2,214 APIs → 1,103 keyless → 15 model-ish, HTTPS, no-key entries) and writes `packages/catalog/generated.json`. One source, run by hand; four sources and a schedule remain. |
| B2.3 Canary prober | **done** | `packages/prober`: three levels (liveness, readiness, suitability), per-capability fixtures that are versioned, synthetic and side-effect free, auto-disable after 3 consecutive failures, auto re-enable on recovery, capped history, and `sui probe [provider]`. 15 tests, including one that catches a provider faking a stream with a single frame. Not yet scheduled by `sui start` — that is B9.1. |
| B2.4 ToS policy engine | **partial** | `tos: allowed\|review\|avoid` is enforced in routing (I12) and audited. No ingestion, no review workflow, no per-provider policy documents. |
| B2.5 Keyless providers wired | **blocked** | Pollinations, OVHcloud, LLM7, Kilo are in the seed as identities with `base_url: null, needs_probe: true`. Shipping an unverified URL would violate the positioning; the prober (B2.3) has to resolve them, and their ToS must be read before customer prompts go near them. |
| B2.6 Local runtime discovery | **partial** | Loopback literals only (Ollama `127.0.0.1:11434`, LM Studio `127.0.0.1:1234`) in the seed, and onboarding probes reachability. No discovery loop, no llama.cpp. |
| B2.7 Weather Map backend | **partial** | `summarise()` produces the health view the map needs (routable / awaiting probe / tos-avoid). No trend history yet. |

### Phase 3 — ROUTING CORE

| Batch | Status | Gap |
|---|---|---|
| B3.1 Free-first tier order | **partial** | Tier is a field and the paid gate is enforced (I4). Ordering is per-combo today; the global free→free-probed→paid ordering rule is not yet applied across combos. |
| B3.2 Circuit breaker | **done** | Three states, lazy recovery, trips on 5xx/transport only (I13), tested both ways. |
| B3.3 Streaming behaviour | **partial** | First token is the loading state (dashboard + SSE headers). **Empty-turn retry** is done: a 200 with nothing in it is retried once on the same target, then the next target answers — and it does not trip the breaker, because an empty turn is a quality problem, not an outage (5 tests). First-chunk clone is deliberately not implemented: buffering the first chunk to allow a later failover trades time-to-first-token for a splice the user never asked for. Mid-stream drops are reported, not re-routed. |
| B3.4 Verification escalation | **done** | `packages/verify` scores an answer from seven deterministic signals (empty, truncated, refusal, hedging, repetition, wrong shape, off-topic), each with a named penalty. Below 0.7 the router escalates once; if nothing clears the bar the best answer returns marked `verified: false` with the reasons. No judge model, deliberately. 13 tests. |
| B3.5 Speculative cascade | todo | 50ms classifier budget, confidence-drop trigger. |
| B3.6 Virtual models | **partial** | `fallback`, `weighted`, `cheapest`, `latency` with per-arm attribution. The spec's `conditional` mode is not implemented. |
| B3.7 SLA constraints + EWMA + CUSUM | todo | Latency p95 exists as a measurement, not as a hard constraint with drift ejection. |

### Phase 4 — COMPRESSION & CACHING

| Batch | Status | Gap |
|---|---|---|
| B4.1 Compression engines | **done** | Six engines — `session_dedup`, `rtk`, `caveman`, `headroom`, `llmlingua_2`, `ccr` — behind four presets. Protected spans (code, URLs, JSON, paths, ids) are lifted out and restored byte-for-byte; a test proves it for every preset. 17 tests. `llmlingua_2` and `ccr` are labelled approximations: the real methods need a trained model and an external cache. |
| B4.2 The remaining engines | **partial** | `compress-kit` covers the byte-level engines and is wired for gzip exports. The spec's full nine-engine list is not exhausted: `lexora`-style canonicalisation and the CHCE binaries are not integrated. |
| B4.3 Budget manager (quota → preset) | **done** | `choosePreset()` maps remaining quota to a preset (60/30/10% thresholds); `preset: "auto"` uses the provider budget as a quota proxy until real quota telemetry lands. `sui budget` shows the mapping. |
| B4.4 Output-axis dial | **done** | Four styles plus `auto`, injected as a directive under 90 characters, prepended to the existing system message (or creating one). `auto` reads the same quota fraction as the preset and sends a coding task to `code_only`. 10 tests with the savings ledger. |
| B4.5 Cache-aware compression (CAPC) | **done** | `preserveCachedPrefix` (default on) keeps the system message byte-for-byte when prompt caching is on, so compression cannot invalidate a provider's prefix cache. When nothing else is compressible, `skipped` says why. 2 tests. |
| B4.6 Native prompt caching | **done** | Stable-prefix detection, per-provider hints (Anthropic `cache_control`, OpenAI `prompt_cache_key`), a warm/cold fingerprint memory, and a `volatile` list that names the timestamp or request id breaking the cache. Gemini is reported unsupported rather than faked. |
| B4.7 Semantic cache | **partial** | Two tiers: exact hash, and a **lexical** tier over `ml-kit` tf-idf at a 0.98 threshold — near-duplicate prompts hit without an exact key, and `cacheKind` says which tier answered. Off by default (it holds recent prompt text in memory). A true embedding tier is still todo. |

### Phase 5 — AGENTS & PROTOCOLS

All todo. `ai-bridge` (MCP-shaped tool plumbing, adapters) is the intended reference for B5.1/B5.2, again pending licence.

### Phase 6 — SECURITY & PRIVACY

| Batch | Status | Gap |
|---|---|---|
| B6.4 Guardrail plugin architecture | **partial** | `packages/guardrails` is a clean seam with size, pattern and token-clamp checks. No provider plugins (Bedrock/Azure/Model Armor/Lakera/NeMo). |
| B6.6 Tenant isolation | **partial** | Keys are tenants: `allowedCombos`/`allowedModels`, per-key `dailyUsd`, per-key `rateLimit` (token bucket, 429 + Retry-After), per-key `guardrails` that win over the request, hashed at rest. 12 tests. Not done: per-tenant fallback chains, provisioning API, a shared limiter store. |
| B6.7 Paid-tier air-gap | **done** | Gate (I4) plus sealed storage: `packages/vault` seals keys with AES-256-GCM via `crypto-kit`, opened only when the gate is on, with the key file at 0600 and the provider names inside the envelope. Limitation stated plainly: the passphrase sits beside the vault unless you supply `SUI_VAULT_PASSPHRASE`. |
| B6.1 Red-team toolkit | **done** | Eleven transforms (ten obfuscations + a plain control), a random canary per run, exact judging that distinguishes compliance from echo. 13 tests. |
| B6.2 Scheduled self-test | **done** | `sui redteam [combo] [--json]` plus a weekly `red_team_self_test` worker that logs CRITICAL/HIGH findings. |
| B6.3 Dual-channel inspection | **done** | Tool definitions and tool results are inspected as well as prompts: injection phrases, zero-width/bidi characters, oversized results. Modes `off`/`warn`/`block`; a block refuses before any provider is called. 10 tests. |
| B6.5 Privacy-tiered routing | **done** | Providers declare `retention` and `trainsOnData`; tiers `any`/`standard`/`strict`; a caller may ask for stricter via `x-sui-privacy`. An unmarked provider is `unknown`, and `unknown` fails `strict` — not knowing is not the same as being safe. A strict request with nothing eligible fails closed. 10 tests. |

### Phase 7 — OBSERVABILITY & TENANCY

| Batch | Status | Gap |
|---|---|---|
| B7.5 Prompt-free telemetry | **done** | Salted hash + character count, never prompt text (I11, tested). `/api/traces`, CSV export. |
| B7.4 Explain-my-route | **done** | `sui.route` on every response, `GET /api/explain?combo=…` and `sui explain` narrate the decision in sentences from the plan — no storage, no second query. |
| B7.1 Cost attribution | **partial** | Per provider/model/combo/arm, in the ledger and CSV. Not yet per user/team/tool. |
| B7.2 Savings Ledger | **done** | Cache savings and compression savings are counted separately and valued at the model's own price, with tokens-not-sent and an `avoidedShare`. Surfaced by `sui savings`, `GET /api/savings`, the CSV and a dashboard KPI. |
| B7.3–B7.4, B7.6–B7.7 | todo | Budget alerts, explain-my-route, tenant console backend, grounding check. |

### Phase 8 — UI / UX

| Batch | Status | Gap |
|---|---|---|
| B8.1 Design system tokens | **done** | Token ladder, one signal colour, fixed type scale, tabular figures. I9 is a test: no raw colour value outside `:root`. `sui tokens --check` computes every pair's contrast with `tokens-kit` — and it caught a real failure (the border token was 1.97:1; it is now 3.29:1 light, 3.32:1 dark). |
| B8.2 Chat window | **partial** | Zero-state starters (spec wording), provenance chip per response, plain-language selector with speed/quality/cost and honest locks. **Choice persists per browser, not per thread.** |
| B8.3 Dashboard | **partial** | Skeletons, routing-pool topology, budget bar, prompt-free usage, recent turns, streaming loads, safe-toggle endpoint. Full-catalog view not built. |
| B8.4 Onboarding | **done** | Detect keys and tools, one-click config, real round-trip before "ready" (I7), endpoint + snippet printed. |
| B8.5 Migration wizard | **done** | Preview diff, selective import, post-migration smoke test. |
| B8.6 Error message library | **partial** | Errors are sentences with a next step throughout; not yet one auditable library. |
| B8.7 Accessibility pass | **partial** | Focus rings, live regions, reduced motion, labelled controls, 16px inputs, status never colour-only, and all 16 token pairs verified at AA numerically. No screen-reader walkthrough with a real user. |

### Phases 9–11

**B10.5 eval reports — done**: `GET /api/evals` serves `evals/last-report.json`, and the dashboard shows the last run with its mode. A self-test report is labelled as a harness check, because it proves the graders grade and says nothing about a model.

**B9.3 fallback learning — done**: a combo can reorder its own targets from the ledger — success rate first, then p50 latency, declared order breaking ties, and the declared position kept below `minSamples`. Opt-in per combo, because reordering changes what answers your traffic. `sui.route.learned` reports it per turn. 6 tests.

**B7.3 budget alerts — done**: 75/90/100 percent of the daily and per-provider caps, fired once per threshold per scope per day, with the numbers in the message. A `budget_alerts` worker runs every minute; `GET /api/alerts` serves the log. 6 tests.

**B9.2 canary rollout — done**: `packages/canary` sends a share of traffic to a candidate combo, refuses a verdict before the sample floor, rolls back on a success-rate *or* p95 breach, and **excludes provider outages** from the verdict — blaming a candidate for someone else's downtime is how a good change gets reverted. `GET /api/canary`, `POST /api/canary/rollback`, and the arm recorded on every response. 12 tests.

**B9.1 worker scheduler — done**: `apps/gateway/src/workers.js` runs the prober (hourly) and a cache sweep, off the request path, with a delayed kickoff so startup never waits on the network, `stop()` that clears every timer, `/api/workers` for state and a Probes table on the dashboard. Workers are opt-in for programmatic gateways and on for `sui start` (`--no-workers` to disable). 7 tests.

**B10.1 Weather Map — done**: thriving / resting / down plus "unverified" as its own answer, a plain sentence per provider, and a latency trend line from the prober's 24-observation history. Default view is the routing pool; the full catalogue is `sui catalog`.

**B10.2 Savings panel and B7.4 explain panel — done** (dashboard): the Savings card shows spent, saved by cache, saved by compression, tokens not sent, the would-have-cost total and the share avoided as a bar; "Why this route?" in the playground fetches `/api/explain` and lists the decision, noting that nothing was sent.

**B11.1–B11.7 tutorials — done**: seven task-oriented walkthroughs in `docs/tutorials/` (first five minutes, connect a coding tool, understand routing, red-team your own routes, self-host for a team, build a free agent, troubleshooting with doctor).

Still todo in Phases 9–11: canary + SLO rollback, fallback learning, quota reset detection, token refresh; compression view and eval reports UI; B11.9 ADRs beyond the seven written.

---

## Vendored kits and what they power

| Kit | Powers | Batch |
|---|---|---|
| `crypto-kit` | the paid vault's sealed envelope | B6.7 |
| `ml-kit` | the lexical cache tier | B4.7 |
| `search-kit` | `sui catalog <query>` | B2.2 |
| `tokens-kit` | `sui tokens --check` (WCAG maths) | B8.1, B8.7 |
| `compress-kit` | `sui cost --export --gzip` | B7.x |
| `export-kit`, `web-kit` | vendored, wired in the export and accessibility batches | B7.x, B8.7 |

## The next five batches, in dependency order

1. **B2.5 resolve the keyless endpoints** — the prober can now verify a route; what it lacks is a base URL to verify. Pollinations, OVHcloud, LLM7 and Kilo need their endpoints resolved and their ToS read.
2. **B2.2 the other four sources** — awesome-free-ai-coding, freellmpool, OmniRoute catalog, OpenRouter `:free`, plus a schedule. The app-endpoints ingest proves the shape.
3. **B4.7 embedding tier** — a real semantic tier behind the lexical one.
4. **B10.4 compression view** — what each preset would do to a real prompt, in the UI.
5. **B9.4–B9.6** — quota reset detection, token refresh, worker hardening.

## Risk register

| Risk | Why it matters | Mitigation |
|---|---|---|
| Licence drift (upstream still says PolyForm NC) | A reader of `crypto-kit` alone gets different terms than Sui claims | Owner action: update the upstream `LICENSE` files. Recorded in `docs/legal/LICENSE_INVENTORY.md`. |
| Free tiers are unverifiable at build time | The whole positioning rests on verification | Nothing routable until probed; the seed ships identities, not URLs; the invariant audit reports the count of unprobed entries. |
| Go/Rust data plane temptation | Rewriting early would stall every feature batch | ADR-0001: benchmark gate. Node must miss 15ms p95 under a 10× load before a rewrite is considered. |
| "Done" drifting from "written" | The spec's AC1–AC7 exist to stop this | Every status in this file cites a command. `npm test` runs the invariant table, the eval self-test and the soak gate. |
| Semantic cache needs embeddings without a dependency | A model download breaks the zero-dependency promise | `ml-kit`'s tf-idf path is the intended first tier; embeddings optional and off by default. |

## Working a batch (the protocol)

1. Restate the goal in one sentence.
2. List dependencies and confirm they are merged and eval-green.
3. Propose the file-level plan: paths, modules, tests.
4. Implement.
5. Show the tests and eval results — the command and its output.
6. Confirm invariant compliance, citing `sui invariants`.
7. Update this file and, if architectural, add an ADR.

Say `do B2.3` and that is what happens. If a batch would violate an invariant, work stops and says so before any code is written.
