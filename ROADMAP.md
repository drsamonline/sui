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
| B4.2 Canonicalisation | **done** | `canonicalise` runs first in every preset: unicode form, line endings, zero-width and bidi controls, smart quotes and dashes, shared indentation, trailing spaces, blank-line runs — lossless, and it protects spans like every other engine. The CHCE binaries remain unintegrated. 3 tests. |
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

**B9.4 quota windows — done**: a `429` with `Retry-After` (seconds, an HTTP date, or in the body) closes that target for exactly that long, is reported in the skip reason, is **not** a breaker trip, and reopens with a log line. `quotaWindows` in `/api/status`. 5 tests.

**B11.9 ADRs — done**: ADR-0008 (drift), 0009 (MCP both directions), 0010 (recipes), 0011 (attribution and tenants), 0012 (the four routing policies) join the original seven. `CONTRIBUTING.md` records the invariant discipline, the four harnesses, the three kinds of test failure, and the rules for adapters, engines and kits.

**Writing pass — done**: the detect run over the landing page found four **false claims** before it found any cadence — a shipped tenant console and per-user attribution listed as missing, "6 engines" (seven), "no catalogue entry has a resolved endpoint" (29 do), and the kit licence line stated as a defect rather than a decision. Then the prose: "Zero blind spots", "not a green tick", "Nothing here is marked finished because it was written" — a claim with no evidence, a not-X-but-Y contrast, and interpretive metadiscourse. All gone, and three tests now fail if any returns.

**Dashboard critique — done**: reviewed against the HIG checklist. Three findings, all fixed: the breaker's `half-open` state had no styling and a label that read as a bug (`0-mining (0s)` — the stylesheet expected `half_open` with an underscore), the card headed **"Last eval — 100%"** was showing the *harness self-test*, which says nothing about answer quality, and eight rows of prompt hashes were noise nobody acts on. Also moved the compression card into the left column, which had a 400 px hole under the playground. Three tests hold the fixes.

**Documentation pass — done**: the README was 202 lines with a 42-bullet feature wall, written for someone auditing claims rather than someone deciding whether to use the project. It is now 112 lines in the OSS template's shape — about, why it exists, install, ten features, how it holds itself, docs map, status, licence — with the full list moved to `docs/FEATURES.md`. Following it cold in a fresh clone found the bug that made the whole thing necessary: the first run printed *"Start it with: npx sui start"*, and `npx sui` cannot work before a publish. Every runtime hint now matches how the CLI was invoked, and a test fails if `npx sui` appears in first-run output.

**Windows without npx — done**: `npx sui` cannot work before a publish, so the repo now ships wrappers that need no npm account — `sui.cmd` (CMD), `sui.ps1` (PowerShell), `sui` (sh) — plus `scripts/install-windows.ps1` (checks Node, links workspaces, proves the CLI runs) and `docs/WINDOWS.md` written for someone who has never opened a terminal. `npm link` now gives a global `sui` from the checkout. Also fixed: `sui --version` and `sui --help` fell through to the first-run onboarding, because both arrive as flags rather than as a command.

**Review finding — the budget stopped counting (fixed)**: `todaySpendUsd()` summed the in-memory record window, capped at 5,000. Past 5,000 turns in a day the budget under-reported — 250 turns at a cent each read as $1.00 against a true $2.50 — so the gateway could overspend while believing it was inside its cap. A budget that stops counting is worse than no budget. Spend and per-provider spend now come from a per-day bucket that does not depend on the window, rebuilt from the file on restart, and the ledger file rotates at 64 MB instead of growing forever (at 20 rps a three-day soak writes millions of lines). 4 tests, verified at 18,000 turns across three days.

**Two-plane split, exercised for real — done**: two processes, one config. The model plane answers `403` without the token and `200` with it; the agent plane forwards a real chat, holds no provider key, and serves `/api/runs` while the model plane refuses it (`404`). Found and fixed on the way: `--role`/`--model-plane` were documented in `PLANES.md` but did not exist in the CLI, an agent plane **crashed at boot** without a token instead of starting and explaining, and `--role` parsed as `true` because it was not in `VALUE_FLAGS` — the third time that trap fired, so a test now cross-checks every flag the help text shows with a value.

**Dashboard smoke test — done**: `npm run smoke:dashboard` loads the page in Chromium against a live gateway and fails on any console error, page error or failed request, in three states — healthy, fresh-install (provider declared, no key) and degraded (provider unreachable). All three are clean. A screenshot could not have told us that: an error leaves a half-drawn layout that photographs fine.

**Probe verification loop closed — done**: `sui probe --write` promotes what answered; `--revoke` withdraws. The overlay lives in `$SUI_HOME/catalog-verified.json`, not in the package — writing observations into an installed `node_modules` would be wrong, and one machine's verification is not evidence for another. 8 tests.

**Probe verification loop closed (first pass) — done**: `sui probe` used to print results and write nothing, so nothing ever became routable — the design said "an identity becomes an endpoint when probed", and the probe did not record it. Now `--write` promotes what answered into `packages/catalog/verified.json`, an overlay kept separate from `seed.json` so a probe can never rewrite provenance. `--revoke` withdraws a route by deleting one row. A failure does not erase a previous verification: the endpoint may be down, not wrong. 6 tests.

**Catalogue padding removed — done**: the generated catalogue is now **empty by design**. Three attempts to filter the app-endpoints dataset for model endpoints produced a sudoku API, a model *catalogue*, and 24 QR-code services — each attempt a keyword heuristic, each wrong in a new way. The conclusion was not "filter harder": that dataset holds public APIs, not model endpoints. The catalogue is now exactly the 29 deliberately seeded entries (was 53, of which 24 were filler), and a test asserts nothing enters the catalogue that is not in the seed.

**B2.2 catalogue sync — done**: `npm run catalog:sync` audits the seven-source ledger against the seed, reports orphans and (with `--online`) which pins have moved. It is a report, never a mutation — a test asserts the seed is byte-identical after a run. Also fixed in the prober: an imported entry carries a model *family*, not a model name, so readiness now calls a model the endpoint actually listed rather than sending "openai-compatible" as a model id.

**B2.5 endpoint seeding — done (verification pending egress)**: seven reference projects mined for **facts only**, taking the catalogue from 7 entries with an endpoint to 29. The three keyless providers the spec names — `pollinations`, `ovhcloud-ai`, `llm7` — now have one. Two sources declare no licence, so only base URLs were taken from them; `test/catalog.test.js` enforces that line.

**B2.5 endpoint seeding (first pass) — done**: `npm run import:9router` reads an MIT reference project and imports **facts** — provider labels and base URLs — into the catalogue, plus that project's own exclusion list as a note. No code was taken. Every imported entry is `needs_probe: true` and `tos: review`, because an endpoint someone else recorded is not one this gateway verified. The probeable set went from 7 to 17 entries; `sui probe` on a networked machine is what promotes them.

**B5.6 sandboxed code execution — done**: `sui sandbox <file>` runs a snippet in a **separate process** with Node's permission model (no filesystem outside a work directory, no child processes, no addons), a **network namespace** via `unshare -n`, a stripped environment and hard wall-clock/heap/output limits. The `vm` context is the last layer, not the first. A 14-case attack suite proves the boundary and fails the build if a case escapes. It is deliberately not on the request path. 10 tests + the suite.

**Audit 2026-11-15 — done**: a second audit (`AUDIT-2026-11-15.md`). Four guarantees that had shipped as prose are now invariants I16–I19 with enforcement points and proofs; the security read found one real issue (`POST /api/compress` accepted 20 MB of CPU-bound work on the event loop, now capped at 200 KB with a test) and confirmed no dynamic code execution, no request-controlled file paths, and constant-time comparison in both places secrets are compared. Accepted risks are listed rather than buried.

**B5.7 two-plane split — done**: `role: model|agent|both`. The model plane holds the credentials and is the only thing that needs egress; the agent plane faces agents and holds none, forwarding through a constant-time-checked service token. Run bounds apply before forwarding; health and status stay open; the model plane refuses the agent surface even with a valid token. 13 tests. `docs/PLANES.md`.

**B5.5 bounded runs and approval gates — done**: four bounds (spend, steps, wall clock, repeated call) plus a per-call approval gate, enforced on the chat path through an `x-sui-run` header. Over a bound is a `409` with the reason; an unknown run id is a `404` rather than a silent unbounded call; an approval is single-use. 15 tests.

**B2.7 trend history — done**: the prober's 24 in-memory observations are now backed by a rolling file — capped at 20,000 rows and 7 days, pruned on write, rewritten atomically. `/api/history` serves bucketed series with p50, error rate and uptime per bucket. 11 tests, including a torn-line recovery and a "no field a prompt could occupy" assertion.

**B2.6 local runtime discovery — done**: `sui local` probes the ports those servers use, asks each one what it serves, and `--write` adds what it found through the same applier recipes use, so a second run is a no-op. Loopback-only, unauthenticated GETs, 300 ms per port in parallel.

**B5.3 recipes — done**: `sui recipe list|show|apply`, five shipped recipes, and three rules enforced by test — never overwrite silently, applying twice is a no-op, a dry run touches nothing. `requires.env` is reported before anything is applied. 11 tests.

**B5.4 MCP client — done**: `type: "mcp"` makes an MCP server a provider, so a combo can route to a tool and every existing rule (breaker, budget, privacy, canary, verification, ledger) applies unchanged. Both transports; the prompt argument is configurable because only the operator knows their tool. Token counts are estimated and labelled as such. 10 tests.

**B5.1/B5.2 MCP server — done**: `packages/mcp` implements JSON-RPC 2.0 over **stdio** (newline-delimited, logs to stderr) and **HTTP** (`POST /mcp`, 405 on GET with a reason, 202 for a notification). Six tools — `sui_chat`, `sui_models`, `sui_explain`, `sui_cost`, `sui_compress`, `sui_status` — with provenance in `structuredContent`. One protocol revision is implemented and echoed; resources and prompts are advertised empty rather than faked. 11 tests, plus both transports smoke-tested through the CLI.

**B9.5 token refresh — done**: a provider with an `oauth` block refreshes its access token once on a 401, retries once, and caches it until expiry (a minute early). A refused refresh reports why and does not retry the model call. 6 tests against a local fake token endpoint.

**B6.6 residency — done**: providers declare a `region`; `privacy.region` or `x-sui-region` requires one; an unmarked provider is `unknown` and never matches; nothing eligible fails closed with the reason. 3 tests.

**B7.7 tenant console backend — done**: `GET /api/tenants`, `PATCH /api/tenants/<name>` for a live cap change (in memory, and it says so), `sui tenants`, and an `SUI_ADMIN_TOKEN` gate when one is configured. An uncapped tenant reports `null`, not 0%. 8 tests.

**B7.6 grounding check — done**: `verification.grounding` (`off`/`warn`/`block`) checks that every URL, quoted span of 8+ characters and unit-bearing number in the answer appears in the context it was given. Ungrounded answers take a 0.45 confidence penalty, which usually escalates them. With no context it reports `checked: false` rather than passing silently. 5 tests.

**B9.6 worker hardening — done**: a tick that arrives while the previous one runs is **skipped, not queued** (a slow probe must not become two); a failing job backs off by doubling up to 16x and resets on the first success; the first tick is jittered so a restart does not fire every job at once. `skipped` and `failures` are on the job snapshot. 2 tests.

**B10.4 compression view — done**: `POST /api/compress` and a dashboard card that shows the ratio, the steps, and which protected spans survived. Computed locally — the text is used and dropped, never stored, logged or sent to a provider.

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
3. **B5.6** — sandboxed code execution (needs an explicit decision, see AUDIT.md).
4. **B5.6** — sandboxed code execution (owner decision, see AUDIT.md).
4. **B0.3** — the 72-hour soak, which needs a machine held for three days.
5. **B1.4** — SQLite for a shared ledger, if more than one process is ever wanted.

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
