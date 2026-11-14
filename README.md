# Sui

**Free tiers, verified before use. Zero blind spots. Zero silent degradation.**

Sui is a verification-first, privacy-aware AI gateway. Every free route is probed, policy-checked and scored before it can answer a prompt. Every escalation is traced and explainable in plain language. Paid credentials are not read at all unless you open the gate.

```bash
npx sui
```

One command: find the keys on this machine, find your coding tools, write a config, send a real request through the gateway, print the endpoint, and start serving. If nothing can answer, it says so — a green tick requires a real round-trip (invariant I7).

![The dashboard: budget, routing pool, combos, prompt-free usage and recent turns](docs/screenshots/dashboard-light.png)

---

## The rules this repository holds itself to

Fifteen invariants, kept as data in `packages/core/src/invariants.js` — each with the module that enforces it and the test that proves it. `npm test` fails if an invariant loses either. The ones you can feel from outside:

| | |
|---|---|
| **I4** | Paid credentials are never read unless `paid_tiers.enabled` is true. Checked before the environment is touched. |
| **I6** | Zero silent degradation: every failover is in the response, the ledger and the dashboard. |
| **I7** | Onboarding cannot report success without a real model round-trip. |
| **I11** | No prompt content in telemetry — a salted hash and a length, nothing else. |
| **I12** | A provider marked `tos: avoid` is never auto-routed. |
| **I13** | The circuit breaker trips on 5xx and transport failures only — never on 401, 404 or 429. |
| **I14** | When every route is resting, a request is still attempted against the unfiltered pool rather than refused. |
| **I15** | Host-header allowlist, SHA-256 API keys compared in constant time, no default password. |

`npx sui invariants` prints all fifteen with their status and, where something is not yet enforced, the gap in plain words.

## What works today

- **OpenAI-compatible gateway** — `POST /v1/chat/completions`, streaming and not; point Cline, Continue, Cursor, Aider, Zed or your own app at it.
- **Four strategies** over virtual model names: `fallback`, `weighted` (per-arm attribution), `cheapest` (quality floor + cost cap), `latency` (measured p50).
- **Circuit breaker** per target, three states, lazy recovery, invariant-correct tripping.
- **Budgets** — daily and per provider, checked before the call, skipped with a reason rather than failed with a stack trace.
- **Prompt compression** — six engines behind four presets, with code, URLs and JSON preserved byte-for-byte; the preset is chosen from remaining quota. Off by default; `sui compress` shows you the result first.
- **Two-tier cache** — exact hash, plus an optional lexical tier (`ml-kit` tf-idf at 0.98) for near-duplicate prompts; `cacheKind` says which one answered.
- **Native prompt caching** — stable-prefix detection with the hint each provider understands (Anthropic breakpoint, OpenAI cache key), and a `volatile` list naming what breaks the cache.
- **Per-key limits** — each key is a tenant: combo/model allow-lists, daily spend cap, token-bucket rate limit, its own guardrails.
- **Red-team self-test** — eleven obfuscations of one injection instruction, a random canary per run, and a verdict that treats an echo as `HIGH`, not a pass.
- **Cache-aware compression** — the system message is never compressed when prompt caching is on, so compression cannot break the provider's prefix cache.
- **Verification escalation** — answers scored by seven deterministic signals; below 0.7 the router escalates once, and a weak answer is never presented as verified.
- **Explain my route** — every response carries the strategy and each target's outcome; `sui explain` narrates it without sending anything.
- **Savings ledger** — cache and compression savings counted separately, valued at the model's price, with the share of cost avoided.
- **Ledger** — one record per attempt: tokens, cost, latency, time to first token, cache, verification, prompt hash. CSV export.
- **Dashboard** — token-based design system, budget bar, savings panel, routing-pool topology, **free-tier weather** (thriving / resting / down with a latency trend), breaker states, probes, prompt-free usage, recent turns, and a playground whose loading state is the first streamed token, with "Why this route?" on demand.
- **Paid vault** — AES-256-GCM sealed credentials (`crypto-kit`), opened only when `paid_tiers.enabled` is true.
- **Background workers** — prober and cache sweep run off the request path, with `/api/workers` and a Probes table on the dashboard.
- **Catalogue + canary prober** — 26 entries, every one an unverified identity until a probe says otherwise; `sui probe` checks liveness, readiness and suitability (streaming, JSON, tools) with versioned synthetic fixtures, disables a route after three failures and re-enables it on recovery.
- **Onboarding** with tool detection and one-click config; **migration** from 9router / OmniRoute / HubGate with a preview diff and a post-import smoke test.
- **Eval harness** — 50-prompt golden set, nine deterministic graders, a self-test that proves the graders grade, and a regression gate against `evals/baseline.json`.
- **Soak harness** — measures the gateway's own overhead (server-side, not client sockets) and gates p95 against the 15ms budget.

Not built yet, and listed honestly in [`ROADMAP.md`](ROADMAP.md): the canary prober, catalogue sync, compression engines, MCP/A2A, red-team self-test, tenant console, Weather Map, Savings Ledger, explain-my-route.

## Quickstart

```bash
npx sui                    # first run: keys, tools, a real round-trip, then serve
npx sui start              # run the gateway            --port 8787  --config <file>
npx sui doctor             # one real turn per combo, plus the invariant audit
npx sui invariants         # the fifteen rules and their status
npx sui models             # combos and what they can reach
npx sui cost               # spend, latency, A/B arms    --all  --json
npx sui tools              # point a coding tool here    --set continue
npx sui migrate <file>     # import another router's config   --apply  --only a,b
npx sui keys hash          # replace plaintext API keys with SHA-256
npx sui vault init         # sealed storage for paid credentials  (set · list · remove · status)
npx sui config set budgets.dailyUsd 7    # edit config, validated before writing
npx sui catalog <query>    # the catalogue, and what is still unverified
npx sui probe [name]       # liveness, readiness, suitability — and what failed
npx sui compress <file>    # see what a preset does to a prompt before enabling it
npx sui budget             # which preset the remaining quota would choose
npx sui savings            # what cache hits and compression did not spend
npx sui explain [combo]    # why a route would go where it goes
npx sui redteam [combo]    # attack your own route with 11 obfuscations
npx sui tokens --check     # WCAG AA on the dashboard tokens, computed by tokens-kit
npx sui kits               # the vendored kits and whether they load
```

Then anything that speaks OpenAI:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sui-local
```

## Repository layout

```
apps/
  gateway/      HTTP surface, auth, SSE, dashboard API
  dashboard/    one HTML file, no build, token-based CSS
  cli/          the `sui` command
packages/
  core/         errors, config schema, cost model, the invariant table
  providers/    openai · anthropic · gemini · mock
  router/       planning, strategies, circuit breaker
  telemetry/    ledger, cache, aggregates, CSV
  catalog/      provider catalogue: dedupe, ToS posture, scoring
  guardrails/   prompt size, blocked patterns, output clamp
  sdk/          JavaScript client
  kits/         loader for the vendored kits (isolated VM context)
  vault/        AES-256-GCM sealed paid credentials
  prober/       liveness, readiness and suitability checks
  compression/  six engines, four presets, the quota budget manager
  promptcache/  stable-prefix detection and per-provider cache hints
  verify/       reference-free confidence scoring, fail-closed
  redteam/      injection toolkit and self-test
evals/          50-prompt golden set, graders, runner, baseline
scripts/        soak harness
config/         annotated config + JSON schema
docs/           architecture, routing, API, migration, reuse map, ADRs, legal
vendor/kits/    seven vendored kits, each with its upstream LICENSE and API.md
```

npm workspaces, Node 20+, **zero runtime dependencies**. No build step.

## Commands that prove things

```bash
npm test         # 214 tests: routing, invariants, security, dashboard, catalog, sdk, vault, kits, prober, evals
npm run eval:self  # prove the graders grade (50 must-pass, 6 must-fail)
npm run eval     # 50 prompts against a real combo, regression-gated
npm run soak     # 1,200 requests, p95 overhead against the 15ms budget
npm run audit    # invariants→tests, routes→API.md, dead exports, secrets
```

## Licensing

Sui is MIT. Seven kits from the same fleet are vendored in `vendor/kits/` — `crypto-kit`, `ml-kit`, `search-kit`, `tokens-kit`, `compress-kit`, `export-kit`, `web-kit` — each with its upstream `LICENSE` beside it and a pinned commit in [`docs/legal/LICENSE_INVENTORY.md`](docs/legal/LICENSE_INVENTORY.md). The copyright holder authorised that use; the upstream repositories still label themselves PolyForm Noncommercial, and updating those files is the one open task recorded in the inventory. `NOTICE` carries the attribution.

Third-party routers (`9router`, `OmniRoute`, `HubGate`) are not vendored; `sui migrate` reads their config files, which is a different act.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — twelve phases, sixty batches, honest status, next five in dependency order.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, request lifecycle, decisions.
- [`docs/ROUTING.md`](docs/ROUTING.md) — strategies, breakers, budgets, cache, guardrails, per-key policy.
- [`docs/API.md`](docs/API.md) — every endpoint and field.
- [`docs/quickstarts/`](docs/quickstarts/) — cURL, Node, Python and PHP, run against a live gateway.
- [`docs/tutorials/`](docs/tutorials/) — seven walkthroughs: first five minutes, connect a coding tool, understand routing, red-team your own routes, self-host for a team, build a free agent, troubleshooting.
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — moving from another router.
- [`docs/reuse-map.md`](docs/reuse-map.md) — the fleet, mapped onto phases.
- [`docs/adr/`](docs/adr/) — seven decisions, with their consequences.
- [`SECURITY.md`](SECURITY.md) — what this gateway is and is not, in security terms.
- [`PRIVACY.md`](PRIVACY.md) — what leaves the machine, what stays, and how to erase it.
- [`TERMS.md`](TERMS.md) — responsibilities, AI output, no warranty.
- [`AUDIT.md`](AUDIT.md) — the audit of this repository, with findings and fixes.
