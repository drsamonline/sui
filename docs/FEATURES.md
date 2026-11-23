# Everything Sui does

Every item below is built and covered by `npm test` unless it says otherwise. The README keeps the ten that matter most; this is the full list, in the order a reader meets them.

## Gateway and routing

- **OpenAI-compatible gateway** — `POST /v1/chat/completions`, streaming and not; point Cline, Continue, Cursor, Aider, Zed or your own app at it.
- **Four strategies** over virtual model names: `fallback`, `weighted` (per-arm attribution), `cheapest` (quality floor + cost cap), `latency` (measured p50).
- **Circuit breaker** per target, three states, lazy recovery, invariant-correct tripping.
- **Budgets** — daily and per provider, checked before the call, skipped with a reason rather than failed with a stack trace.
- **Prompt compression** — seven engines, canonicalisation first behind four presets, with code, URLs and JSON preserved byte-for-byte; the preset is chosen from remaining quota. Off by default; `sui compress` shows you the result first.
- **Tenant console** — `sui tenants` and `GET /api/tenants` show what each key spent, what is left and what it may reach; caps can be changed live.
- **Attribution** — `x-sui-user` and `x-sui-tool` charge each turn to a person and a tool, with `sui cost --by user|tool`.
- **Free-first ordering** — a free target ranks before a paid one regardless of declaration order, with a per-combo opt-out.
- **Speculative cascade** — a sub-50 ms classifier sends easy questions to the cheap model and hard ones to the strong one.
- **Quota windows** — a `429` with `Retry-After` closes that target for exactly that long, instead of guessing from failures.
- **Two-tier cache** — exact hash, plus an optional lexical tier (`ml-kit` tf-idf at 0.98) for near-duplicate prompts; `cacheKind` says which one answered.
- **Native prompt caching** — stable-prefix detection with the hint each provider understands (Anthropic breakpoint, OpenAI cache key), and a `volatile` list naming what breaks the cache.
- **Per-key limits** — each key is a tenant: combo/model allow-lists, daily spend cap, token-bucket rate limit, its own guardrails.
- **Residency** — providers declare a region; a request can require one, and an unmarked provider never satisfies it.
- **Token refresh** — a provider with an `oauth` block refreshes once on a 401 and retries once, never in a loop.
- **Privacy tiers** — route by retention and training posture (`any` / `standard` / `strict`), with unknown posture failing the strict tier and a strict request failing closed rather than downgrading.
- **Dual-channel inspection** — tool definitions and tool results are inspected as well as prompts, because a tool result is the channel an attacker controls outright.
- **Fallback learning** — a combo can reorder its own targets from measured success rate and latency, keeping the declared position below the sample floor.
- **Budget alerts** — 75/90/100 percent of the daily and per-provider caps, fired once per threshold per day, with the numbers in the message.
- **Canary rollout** — a share of traffic to a candidate combo, rolled back automatically on a success-rate or p95 breach, with provider outages excluded from the verdict.
- **Red-team self-test** — eleven obfuscations of one injection instruction, a random canary per run, and a verdict that treats an echo as `HIGH`, not a pass.
- **Cache-aware compression** — the system message is never compressed when prompt caching is on, so compression cannot break the provider's prefix cache.
- **Verification escalation** — answers scored by seven deterministic signals; below 0.7 the router escalates once, and a weak answer is never presented as verified.
- **Grounding check** — a URL, quote or number in the answer that is not in the context it was given costs 0.45 confidence and usually escalates.
- **Explain my route** — every response carries the strategy and each target's outcome; `sui explain` narrates it without sending anything.
- **Savings ledger** — cache and compression savings counted separately, valued at the model's price, with the share of cost avoided.
- **Ledger** — one record per attempt: tokens, cost, latency, time to first token, cache, verification, prompt hash. CSV export.
- **Sandbox** — `sui sandbox` runs model-written code in a separate process with no filesystem, no network and no environment, and proves it with a 14-case attack suite.
- **Two-plane split** — a model plane that holds the keys and an agent plane that faces agents and holds none.
- **Bounded runs** — spend, steps, wall clock and repeated-call limits per agent run, with per-call approval gates.
- **Trend history** — health samples on disk, bucketed into a sparkline that survives a restart.
- **Local discovery** — `sui local` finds a model server on this machine and wires it up, loopback-only.
- **Recipes** — `sui recipe apply free-tier-stack` and four more named setups, applied without overwriting your work.
- **Drift detection** — EWMA plus a two-sided CUSUM, so a slow slide is caught that no breaker can see.
- **MCP server and client** — the gateway as a Model Context Protocol server over stdio or HTTP, and an MCP server as just another provider inside a combo.
- **Dashboard** — token-based design system, budget bar, savings panel, compression view, routing-pool topology, **free-tier weather** (thriving / resting / down with a latency trend), breaker states, probes, **tenants** (each key's cap, rate, pinned model and reach — the four things a refusal cites), **providers** (the whole catalogue, with what is a route and what is still only a name), prompt-free usage, recent turns, and a playground whose loading state is the first streamed token, with "Why this route?" on demand.
- **Paid vault** — AES-256-GCM sealed credentials (`crypto-kit`), opened only when `paid_tiers.enabled` is true.
- **Background workers** — prober and cache sweep run off the request path, with `/api/workers` and a Probes table on the dashboard.
- **Catalogue + canary prober** — 41 entries, every one an unverified identity until a probe says otherwise (`sui probe --write` promotes what answers); `sui probe` checks liveness, readiness and suitability (streaming, JSON, tools) with versioned synthetic fixtures, disables a route after three failures and re-enables it on recovery. A sweep is bounded (`--concurrency`, 8 by default) and every level carries a hard deadline, so a provider that drops packets cannot hang it.
- **Onboarding** with tool detection and one-click config; **migration** from 9router / OmniRoute / HubGate with a preview diff and a post-import smoke test.
- **`auto`** — a combo you do not have to write: the cheapest combo that clears the floor answers a simple prompt, the highest-quality combo answers a complex one, using the classifier that was already there. It is built from your own combos, listed in `/v1/models`, and narrated by `sui explain`.
- **Eval harness, as a command** — `sui eval` runs a 50-prompt golden set through nine deterministic graders, with a self-test that proves the graders grade (`sui eval --self-test`), a regression gate against a recorded baseline (`--update-baseline`), a 95% Wilson interval on every rate, and `--json` for CI. It ships inside the CLI package, so an install can measure answer quality rather than taking the README's word for it. A run where nothing answered exits 2 and reports no rate at all.
- **Soak harness** — measures the gateway's own overhead (server-side, not client sockets) and gates p95 against the 15ms budget.

---

See [`ROADMAP.md`](../ROADMAP.md) for what is not built, and why.
