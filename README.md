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
- **Two-tier cache** — exact hash, plus an optional lexical tier (`ml-kit` tf-idf at 0.98) for near-duplicate prompts; `cacheKind` says which one answered.
- **Ledger** — one record per attempt: tokens, cost, latency, time to first token, cache, verification, prompt hash. CSV export.
- **Dashboard** — token-based design system, budget bar, routing-pool topology, breaker states, prompt-free usage, recent turns, and a playground whose loading state is the first streamed token.
- **Paid vault** — AES-256-GCM sealed credentials (`crypto-kit`), opened only when `paid_tiers.enabled` is true.
- **Catalogue** — 26 entries from the fleet's `app-endpoints` dataset and a hand-written seed, every one an unverified identity until a probe says otherwise; `sui catalog <query>` searches it.
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
evals/          50-prompt golden set, graders, runner, baseline
scripts/        soak harness
config/         annotated config + JSON schema
docs/           architecture, routing, API, migration, reuse map, ADRs, legal
vendor/kits/    seven vendored kits, each with its upstream LICENSE and API.md
```

npm workspaces, Node 20+, **zero runtime dependencies**. No build step.

## Commands that prove things

```bash
npm test         # 146 tests: routing, invariants, security, dashboard, catalog, sdk, vault, kits, evals
npm run eval:self  # prove the graders grade (50 must-pass, 6 must-fail)
npm run eval     # 50 prompts against a real combo, regression-gated
npm run soak     # 1,200 requests, p95 overhead against the 15ms budget
```

## Licensing

Sui is MIT. Seven kits from the same fleet are vendored in `vendor/kits/` — `crypto-kit`, `ml-kit`, `search-kit`, `tokens-kit`, `compress-kit`, `export-kit`, `web-kit` — each with its upstream `LICENSE` beside it and a pinned commit in [`docs/legal/LICENSE_INVENTORY.md`](docs/legal/LICENSE_INVENTORY.md). The copyright holder authorised that use; the upstream repositories still label themselves PolyForm Noncommercial, and updating those files is the one open task recorded in the inventory. `NOTICE` carries the attribution.

Third-party routers (`9router`, `OmniRoute`, `HubGate`) are not vendored; `sui migrate` reads their config files, which is a different act.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — twelve phases, sixty batches, honest status, next five in dependency order.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, request lifecycle, decisions.
- [`docs/ROUTING.md`](docs/ROUTING.md) — strategies, breakers, budgets, cache, guardrails, per-key policy.
- [`docs/API.md`](docs/API.md) — every endpoint and field.
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — moving from another router.
- [`docs/reuse-map.md`](docs/reuse-map.md) — the fleet, mapped onto phases.
- [`docs/adr/`](docs/adr/) — seven decisions, with their consequences.
- [`SECURITY.md`](SECURITY.md) — what this gateway is and is not, in security terms.
