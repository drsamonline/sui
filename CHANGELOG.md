# Changelog

Every entry names what shipped and what it costs you to adopt. Nothing is listed here that a command does not prove.

## 0.10.0 — 2026-11-15

The version where the gateway became usable by agents, and stopped being one process doing everything.

### Agent surface

- **MCP server** over **stdio** and **HTTP** (`sui mcp`). Six tools — `sui_chat`, `sui_models`, `sui_explain`, `sui_cost`, `sui_compress`, `sui_status` — with provenance in `structuredContent`. One protocol revision implemented (`2024-11-05`) and echoed; resources and prompts advertised empty rather than faked.
- **MCP client**: `type: "mcp"` makes an MCP server a provider, so fallback, breakers, budgets, privacy, canary, verification and the ledger apply with no special case.
- **Bounded runs** (`POST /api/runs`, `x-sui-run`): spend, steps, wall clock and repeated-call limits, plus per-call approval gates that are single-use.
- **Two-plane split** (`planes.role`): a model plane that holds the keys and needs egress, and an agent plane that faces agents and holds none, joined by a constant-time-checked service token.

### Routing and cost

- **Free-first ordering**: a free target ranks before a paid one regardless of declaration order, with a per-combo opt-out.
- **Speculative cascade**: a deterministic classifier (under 50 ms, 3 ms on a 20,000-word prompt) picks the cheap or the strong target before the request leaves.
- **Quota windows**: a `429` carrying `Retry-After` closes that target for exactly that long. It is not a breaker trip, because a quota window is a fact and the breaker is an inference.
- **Fallback learning**: a combo reorders its own targets from measured success rate and latency, keeping declared order below the sample floor.
- **Attribution**: `x-sui-user` and `x-sui-tool` charge each turn to a person and a tool; `sui cost --by user|tool`.
- **Tenant console**: `GET /api/tenants`, live cap changes with `PATCH`, and `sui tenants`.

### Trust

- **Grounding check**: a URL, quote or number in the answer that is not in the context it was given costs 0.45 confidence and usually escalates.
- **Residency**: providers declare a region; a request can require one; an unmarked provider never satisfies it.
- **Token refresh**: a provider with an `oauth` block refreshes once on a 401 and retries once, never in a loop.
- **Budget alerts**: 75/90/100 percent of the daily and per-provider caps, once per threshold per day.
- **Owner licence grant**: the kits stay PolyForm upstream and are distributed here under MIT by a written grant, enforced by a test.

### Operations

- **Recipes**: `sui recipe apply free-tier-stack` and four more, which never overwrite silently, apply idempotently, and dry-run for real.
- **Local discovery**: `sui local` finds Ollama and OpenAI-compatible servers on loopback and can wire them up.
- **Drift detection**: EWMA plus a two-sided CUSUM, so a slow slide is caught that no breaker can see.
- **Trend history**: health samples on disk, bucketed into `/api/history`, surviving a restart.
- **Worker hardening**: a tick that arrives mid-run is skipped, not queued; a failing job backs off and resets on success.
- **Compression view**: `POST /api/compress` and a dashboard card showing what a preset would do, without sending anything.

### Documentation

- Nine ADRs (0001–0012, with 0002 amended rather than rewritten), `CONTRIBUTING.md`, `MCP.md`, `PLANES.md`, `RECIPES.md`, and two audits in the repository.

### Verified at this version

459 tests · audit 8/8 · eval self-test 56/56 · soak p95 ≈1 ms against a 15 ms budget · 19 invariants, each with an enforcement point and a named test.

### Known gaps

| Gap | Needs |
|---|---|
| Catalog sync and keyless endpoints (B2.2, B2.5) | a networked machine |
| 72-hour soak (B0.3) | a machine held for three days |
| Sandboxed code execution (B5.6) | an explicit owner decision |
| A lawyer's read of `OWNER_GRANT.md` | the owner |
| `npm publish` | the owner |

## 0.4.0 — 2026-11-14

The first working gateway: monorepo, 15 invariants, paid air-gap, sealed vault, OpenAI-compatible endpoint, four routing strategies, circuit breaker, two-tier cache, compression, verification escalation, eval harness, soak harness, audit script, dashboard, onboarding, migration.

## 0.1.0 — 2026-11-13

The first commit: a plan, a spec, and a promise that every claim would have a test.
