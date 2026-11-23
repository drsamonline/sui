# API reference

Base URL: `http://127.0.0.1:8787` unless you changed `server.port`.

Auth: none by default. If `apiKeys` is set in the config (or `SUI_API_KEY` in the environment), every `/v1/*` call needs `Authorization: Bearer <key>`. The dashboard and `/api/*` are unauthenticated — bind to `127.0.0.1` (the default) and put the gateway behind your own ingress before exposing it.

Errors are always `{ "error": { "message": string, "type": string, "retryable": bool } }`, with a `detail` or `attempts` field where useful. Never a stack trace.

---

## POST /v1/chat/completions

OpenAI-compatible.

```json
{
  "model": "chat-default",
  "messages": [{ "role": "user", "content": "Explain this stack trace" }],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 800,
  "top_p": 1,
  "stop": ["\n\n"]
}
```

`model` may be a combo name or a bare model id. Everything else is passed through to the provider, with `max_tokens` clamped by `guardrails.maxOutputTokens`.

**Response** — OpenAI shape plus `sui`:

| Field | Type | Meaning |
|---|---|---|
| `sui.provider` | string | provider id that answered |
| `sui.providerName` | string | human name, for messages |
| `sui.model` | string | the provider's own model name |
| `sui.modelId` | string | your name for it, from `models` |
| `sui.combo` | string | the virtual model that was called |
| `sui.arm` | string \| null | A/B arm, when the strategy is `weighted` |
| `sui.strategy` | string | `fallback` \| `weighted` \| `cheapest` \| `latency` |
| `sui.verified` | bool | `true` when a real upstream answered (mock and local-unverified are `false`) |
| `sui.cached` | bool | served from the response cache |
| `sui.cacheKind` | `"exact"` \| `"semantic"` \| null | which cache tier answered |
| `sui.compression` | object \| null | `{preset, reason, style, styleReason, ratio, savedChars, steps}` when compression or the output axis ran |
| `sui.savedUsd` | number | what this turn's compression saved, at the model's input price |
| `sui.toolInspection` | object \| null | `{mode, findings:[{channel, where, signal, severity, detail}]}` when inspection is on and found something |
| `sui.verification` | object \| null | `{confidence, threshold, verified, reasons, escalated, grounding}` when verification is on |
| `sui.route` | object | `{strategy, privacyTier, learned, considered:[{modelId, provider, outcome, reason?}]}` |
| `sui.promptCache` | object \| null | `{warm, sends, prefixChars, fingerprint, volatile, hint, unsupported}` |
| `sui.latencyMs` | number | full turn |
| `sui.ttftMs` | number \| null | time to first token, streaming only |
| `sui.costUsd` | number | computed from the model's declared prices |
| `sui.attempts` | array | `{modelId, provider, reason}` for each target tried and failed |

Headers on the response: `x-sui-provider`, `x-sui-model`, `x-sui-combo`, `x-sui-verified`, `x-sui-cached`, `x-sui-cost-usd`, `x-sui-latency-ms`, `x-sui-cache-kind`, and — for the overhead budget — `x-sui-handler-ms` (our handler) and `x-sui-overhead-ms` (handler minus provider time). The same two numbers appear as `sui.handlerMs` and `sui.overheadMs`, and `sui.escalation` says when a resting provider was tried under I14. With `stream: true`, also `x-sui-ttft-ms`, set when the first token is written.

**Streaming.** Standard SSE: role frame, content deltas, a final frame carrying `usage` and `sui`, then `data: [DONE]`. The `x-sui-*` headers are written with the first token, so a client can render provenance before the answer finishes.

**Status codes**

| Code | When | What to do |
|---|---|---|
| 200 | answered (possibly after failover) | read `sui.attempts` to see what happened |
| 400 | bad JSON, empty `messages`, blocked by a guardrail | fix the request |
| 401 | key missing or unrecognised | send `Authorization: Bearer` |
| 403 | key may not use this combo/model | check `allowedCombos` / `allowedModels` |
| 404 | `model` is not a combo or a model | `GET /v1/models` |
| 413 | prompt over `guardrails.maxInputChars` | raise the cap or shorten |
| 502 | provider dropped a stream mid-answer | retry the request |
| 503 | no target could answer | the message lists every reason |

---

## GET /v1/models

```json
{ "object": "list", "data": [
  { "id": "chat-default", "object": "model", "owned_by": "sui-router",
    "label": "Everyday chat", "strategy": "fallback",
    "targets": ["groq-70b", "gemini-flash"] }
] }
```

`?all=1` appends the underlying models with `available: true|false`.

## GET /healthz

```json
{ "ok": true, "service": "sui-router", "uptimeSeconds": 812 }
```

## GET /api/status

Everything the dashboard renders, in one call.

| Field | Contents |
|---|---|
| `server` | host, port, uptime |
| `configPath` | which config is loaded |
| `budget` | `dailyUsd`, `spentUsd`, `pct`, `warnAtPct` |
| `pool` | models with credentials: label, provider, quality, tier, prices, `health`, `retryInMs`, `lastError`, `turnsToday`, `costToday`, `avgLatencyMs` |
| `unconfigured` | models with no key: `modelId`, `provider`, `needsEnv` |
| `combos` | id, label, strategy, targets, `turnsToday`, `costToday` |
| `metrics` | the same aggregate as `/api/metrics`, since local midnight |
| `cache` | `enabled`, `entries`, `hits`, `misses`, `hitRate` |
| `breakers` | one entry per known target: `key`, `state`, `failures`, `lastError`, `retryInMs` |
| `guardrails` | the active guardrail settings |
| `promptUsage` | top 20 prompt hashes by cost |

No key material appears anywhere in this payload.

## GET /api/metrics

`?since=<epoch ms | ISO date | all>` — defaults to local midnight.

```json
{
  "since": 1762992000000,
  "totals": {
    "turns": 41, "attempts": 44, "ok": 41, "failed": 3, "cached": 6,
    "costUsd": 0.0812, "savedUsd": 0.0091,
    "promptTokens": 182340, "completionTokens": 41022,
    "avgLatencyMs": 812, "p50LatencyMs": 690, "p95LatencyMs": 2104, "avgTtftMs": 240
  },
  "byProvider": { "groq": { "turns": 30, "ok": 30, "failed": 0, "cached": 4, "costUsd": 0.02, "tokens": 160000, "avgLatencyMs": 640 } },
  "byModel":  { },
  "byCombo":  { },
  "byArm":    { "balanced/gemini-flash": { "turns": 22, "costUsd": 0.05, "avgLatencyMs": 700 } },
  "recent":   [ ]
}
```

`turns` counts answers; `attempts` counts provider calls; `failed` counts the difference. That split is deliberate — a flaky primary should look like a reliability problem, not like extra traffic.

## GET /api/metrics.csv

One row per attempt, RFC-4180 quoted:

```
timestamp_iso,provider,model,model_id,combo,arm,ok,error,prompt_tokens,completion_tokens,
cost_usd,latency_ms,ttft_ms,cached,verified,streamed,prompt_hash,prompt_chars
```

Served with `content-disposition: attachment`.

## Verifying an endpoint

```bash
npx sui probe                 # report only — nothing changes
npx sui probe --write         # promote what answered into packages/catalog/verified.json
npx sui probe <provider> --revoke   # withdraw a route
```

`seed.json` holds what a source recorded; `$SUI_HOME/catalog-verified.json` holds what **this machine** measured. The overlay lives in the user's home rather than the package on purpose: writing observations into an installed `node_modules` would be wrong, and a verification made on one machine is not evidence for another. Keeping them apart means a probe can never rewrite provenance, and revoking a route is deleting one row rather than editing a curated file. A verified entry becomes routable — that is the only way one ever does. A failed probe does **not** erase a previous verification: the endpoint may be down, not wrong.

## Catalogue contents

`packages/catalog/seed.json` is the catalogue: 41 entries, each naming the source of its endpoint. `packages/catalog/generated.json` is **empty by design** — the app-endpoints dataset is a directory of public APIs (QR codes, avatars, random words), not a source of model endpoints, and three attempts to filter it produced exactly that filler.

## Catalogue sync (B2.2)

```bash
npm run catalog:sync            # audit the ledger against the seed
npm run catalog:sync:online     # also compare each pinned commit with GitHub's HEAD
```

It reports; it never rewrites `seed.json`. An upstream URL that moves should be a deliberate update with a human reading the diff, not a background job changing what the gateway talks to.

## Catalogue

`npm run import:9router -- --source ../9router` imports provider endpoints from an MIT reference project into `packages/catalog/seed.json`. Imported entries are always `needs_probe: true` and `tos: review`; `npx sui probe` is what makes one routable.

## Sandbox (B5.6)

`sui sandbox <file.js>` — a contained process, not a `vm` context: permission model, network namespace, stripped environment, hard limits. `sui sandbox --self-test` runs the 14-case attack suite. See [`SANDBOX.md`](SANDBOX.md). It is deliberately **not** on the request path.

## Planes in `/api/status` (B5.7)

```json
"planes": { "role": "model", "agentFacing": false, "holdsProviderCredentials": true,
            "modelPlaneUrl": null, "serviceTokenConfigured": true,
            "serves": { "chat": true, "models": true, "runs": false, "mcp": false } }
```

See [`PLANES.md`](PLANES.md).

## Bounded runs (B5.5)

A caller that names a run gets its calls counted, costed and gated. A caller that does not is unbounded, exactly as before.

```bash
curl -X POST localhost:8787/api/runs -d '{"id":"nightly","limits":{"maxSteps":20,"maxUsd":0.05,"maxMs":600000,"maxRepeats":3,"requireApproval":["shell"]}}'
curl localhost:8787/v1/chat/completions -H 'x-sui-run: nightly' -d '{"model":"chain","messages":[{"role":"user","content":"hi"}]}'
```

| Bound | Stops |
|---|---|
| `maxUsd` | a run that spends |
| `maxSteps` | a loop that is cheap per call |
| `maxMs` | a loop that is cheap and endless |
| `maxRepeats` / `loopWindow` | the same tool with the same input, N times in a window |

`POST /api/runs` creates one (201), `GET /api/runs` lists them, `GET /api/runs/<id>` shows one, `POST /api/runs/<id>/approve` approves **one exact call** (`{tool, input}`), `POST /api/runs/<id>/finish` closes it.

Over the bound, the chat endpoint answers `409` with `run_bounded` and the reason (`step limit reached (2/2) — raise maxSteps or start a new run`). A gated tool answers `409` `run_needs_approval` until that exact call is approved; the approval is **single-use**, because one that carries over to the next call is not an approval, it is a blank cheque.

An `x-sui-run` naming a run that does not exist is a `404`, not a silent unbounded call.

## GET /api/history (B2.7)

Health over time, bucketed, for the Weather Map trend line.

```json
{ "enabled": true, "hours": 24, "buckets": 24,
  "series": [{ "modelId": "groq-70b", "uptime": 0.98, "samples": 288,
               "points": [{ "t": 1763000000000, "samples": 12, "ok": true, "p50": 812, "errorRate": 0, "state": "closed" }] }],
  "summary": { "rows": 2880, "last24h": 288, "models": 6, "oldest": 1762900000000, "maxRows": 20000 } }
```

`?model=` narrows it to one target; `?hours=` and `?buckets=` control the window and resolution. A bucket with no samples reports `samples: 0` and `null` statistics rather than inventing zeros.

Samples are `{ts, modelId, ok, latencyMs, state}` and nothing else — there is no field a prompt could occupy, and a row carrying one is dropped on load. History lives at `<SUI_HOME>/history.jsonl`, capped at 20,000 rows and 7 days, pruned on write.

## MCP endpoint

`sui mcp --transport http` serves the Model Context Protocol at `POST /mcp` on its own port (8788 by default). See [`MCP.md`](MCP.md). It is deliberately not mounted on the gateway port: a request handler that has already answered cannot be second-guessed.

## GET /api/tenants (B7.7)

The tenant console: what each key has spent today, what is left, how fast it is going, and what it may reach.

```json
{ "summary": { "tenants": 2, "capped": 1, "uncapped": 1, "spentUsd": 1.9, "nearestCap": "team-a" },
  "tenants": [{ "name": "team-a", "dailyUsd": 2, "spentUsd": 1.5, "remainingUsd": 0.5, "pct": 75,
                "turns": 1, "failed": 0, "rateLimit": { "rpm": 60 }, "bucket": { "tokens": 58, "limited": 0 },
                "forcedModel": "chat-default", "allowedCombos": ["chat-default"], "hasKeyHash": true }] }
```

| Field | Meaning |
|---|---|
| `dailyUsd`, `spentUsd`, `remainingUsd`, `pct` | the daily cap and what is left of it |
| `rateLimit`, `bucket` | the requests-per-minute limit, and how many tokens are **left** this minute |
| `forcedModel` | the model or combo this key is pinned to; `null` means the caller chooses |
| `allowedCombos`, `allowedModels` | what the key may reach at all |
| `hasKeyHash` | whether a key is stored — the key itself is never returned |

An uncapped tenant reports `dailyUsd: null` and `pct: null` — not 0%. These four are exactly what a refusal cites: `403 forced_model` names `forcedModel`, `403 forbidden_model` names `allowedCombos`, `429 rate_limited` names `rateLimit.rpm`, and `429 key_budget_reached` names `dailyUsd`. The dashboard's Tenants panel and `sui tenants` render the same fields.

`PATCH /api/tenants/<name>` with `{"dailyUsd": 5}` or `{"rpm": 120}` changes a limit **in memory for this process** and says so in `note`; edit `sui.config.json` to make it permanent. If `SUI_ADMIN_TOKEN` is set, every tenant route needs `x-sui-admin: <token>` (or a bearer token).

## Attribution (B7.1)

Send `x-sui-user` and `x-sui-tool` and the ledger charges the turn to them. Without them, the API-key name is the user and the product part of the user agent is the tool; with neither, the row is `unattributed` rather than dropped.

```json
{ "byUser": { "sohil": { "turns": 2, "costUsd": 0.003, "failed": 0 } },
  "byTool": { "cline": { "turns": 1, "costUsd": 0.002, "failed": 0 } } }
```

`sui cost --by user` and `sui cost --by tool` print the same grouping, sorted by cost.

## Privacy reporting in `/api/status` (B6.4)

```json
"privacy": {
  "defaultTier": "strict",
  "providers": [{ "id": "trainer", "retention": "long", "trainsOnData": true,
                  "tiers": { "standard": false, "strict": false } }]
}
```

## Quota windows in `/api/status`

```json
"quotaWindows": [{ "modelId": "groq-70b", "reopensInMs": 24310, "reopensAt": 1763000243100 }]
```

## POST /api/compress

B10.4 — what a preset would do to a prompt. Computed locally; the text is used and dropped, never stored, logged or sent to a provider.

```json
{ "preset": "aggressive", "originalChars": 420, "compressedChars": 230, "ratio": 0.452,
  "savedChars": 190, "skipped": null,
  "steps": [{ "engine": "caveman", "note": "removed 96 chars of function words", "droppedChars": 96 }],
  "text": "…",
  "note": "Computed locally. Nothing was stored, logged or sent to a provider." }
```

`400 bad_preset` for an unknown preset, `400 empty_text` for whitespace only.

## GET /api/alerts

B7.3 budget alerts: 75, 90 and 100 percent of the daily and per-provider caps, fired once per threshold per scope per day.

```json
{ "spentUsd": 4.51, "dailyUsd": 5, "pct": 90.2, "thresholds": [75, 90, 100],
  "alerts": [{ "scope": "daily", "scopeId": "gateway", "pct": 90.2, "threshold": 90,
               "level": "critical", "message": "Daily budget critical: $4.51 of $5.00 spent today (90.2%).", "at": 1763000000000 }] }
```

## GET /api/evals

The last eval run on this machine. `sui eval` writes it to `eval-last-report.json` in the Sui home (or wherever `SUI_EVAL_REPORT` points); a checkout's committed `evals/last-report.json` is read as a fallback.

```json
{ "available": true,
  "report": { "mode": "self-test", "ranAt": "2026-11-14T12:58:13.434Z", "combo": null,
              "passRate": 1, "passed": 56, "total": 56, "mismatches": [],
              "note": "Harness self-test: graders were checked against fixture answers. No model was called." } }
```

`available: false` with a message when no eval has been run. A `self-test` report proves the graders grade; only a `real` report says anything about a model.

A run in which every request failed is stored with `mode: "not-meaningful"` and `passRate: null` — no rate is reported, because there is nothing to measure.

## GET /api/canary

```json
{ "id": "candidate-canary", "baseline": "chat-default", "candidate": "chat-default-v2",
  "percent": 10, "state": "running",
  "slo": { "minSuccessRate": 0.9, "maxP95Ms": 8000, "minSamples": 20 },
  "stats": { "samples": 12, "successRate": 0.92, "p95Ms": 810, "excludedOutages": 3 },
  "events": [{ "at": 1763000000000, "event": "promoted", "detail": "success 95%, p95 640ms over 20 samples" }] }
```

`POST /api/canary/rollback` rolls it back by hand and returns the new snapshot.

## GET /api/explain

Why a route would go where it goes, without sending a request.

```json
{ "combo": "chat-default",
  "lines": ["\"chat-default\" is a fallback route with 4 targets.", "It would try groq-70b → gemini-flash.", "Skipped gpt-mini: paid tier is closed (paid_tiers.enabled is false)."],
  "plan": { "ordered": ["groq-70b", "gemini-flash"], "resting": [], "skipped": [{ "modelId": "gpt-mini", "provider": "openai", "reason": "paid tier is closed (paid_tiers.enabled is false)" }] } }
```

`404` if the combo does not exist.

## GET /api/limits

```json
{ "buckets": [{ "key": "team-a", "tokens": 7, "limited": 0 }],
  "keys": [{ "name": "team-a", "rateLimit": { "rpm": 60, "burst": 10 }, "dailyUsd": 2 }] }
```

## GET /api/savings

B7.2 — what cache hits and compression did not spend.

```json
{ "since": 1762992000000,
  "savings": { "cacheUsd": 0.003, "compressionUsd": 0.001, "totalUsd": 0.004,
               "tokensSaved": 100, "cacheHits": 1, "compressedTurns": 1 },
  "spentUsd": 0.004,
  "turns": 2,
  "avoidedShare": 0.5 }
```

`avoidedShare` is `saved / (spent + saved)` — the honest framing: of what these turns would have cost, this much did not happen.

## GET /api/traces

```json
{ "prompts": [ { "promptHash": "9f2c1a…", "turns": 12, "chars": 1840, "costUsd": 0.0031,
                 "combos": ["chat-default"], "models": ["groq-70b"] } ],
  "note": "Hashes only. Prompt text is never stored unless guardrails.logPrompts is on." }
```

## GET /api/workers

Background job state (B9.1).

```json
{ "enabled": true,
  "jobs": [{ "name": "prober", "intervalMs": 3600000, "runs": 3, "lastRunAt": 1763000000000, "nextRunAt": 1763003600000, "lastError": null, "lastResult": { "probed": 7, "verified": 0 } }],
  "probes": [{ "provider": "groq", "status": "degraded", "failures": 1, "reasons": ["liveness: timed out"] }] }
```

Programmatic gateways run no workers (`enabled: false`) — `sui start` is what turns them on.

## GET /api/invariants

The fifteen invariants with their status, the config-level audit, and the paid-gate state.

```json
{ "invariants": [{ "id": "I4", "status": "enforced", "statement": "…", "enforced": "…", "test": "…" }],
  "budgets": { "dataPlaneOverheadP95Ms": 15, "modelsResponseMs": 1000 },
  "audit": [{ "id": "I15", "ok": false, "detail": "1 API key(s) stored in plaintext; run `sui keys hash`…" }],
  "paidTiers": { "enabled": false } }
```

## GET /api/config

The loaded config with every secret removed: providers show `hasCredentials`, `apiKeyEnv` (a name, never a value), `baseUrl`, `type`.

## POST /api/config/validate

The commit gate for a toggle. A change is refused when its dependency is missing.

```json
{ "disableProvider": "groq" }
```

```json
{
  "ok": false,
  "blockers": [{
    "code": "provider_in_use",
    "message": "Provider \"groq\" still backs 2 models (groq-fast, groq-70b).",
    "fix": "Combos chat-default, cheap would lose targets. Disable or re-point those models first."
  }]
}
```

`200` when `ok` is true, `409` when it is not. Accepted keys: `disableProvider`, `disableModel`, `enableCombo`, `deleteCombo`.

## POST /api/breaker/reset

`{ "modelId": "groq-70b" }` resets one target; `{}` resets all. Returns the new snapshot.

## POST /api/cache/clear

Empties the response cache. Returns the new cache stats.

## GET / and GET /dashboard

The dashboard. Self-contained HTML, no external requests, no build step. Both paths serve the same file.

## The CLI — `--json` documents

Every command that reports data takes `--json`. The contract is one line, and it is
the same everywhere:

| Rule | |
|---|---|
| stdout | exactly one JSON document, nothing before or after it |
| stderr | anything a person needs to read — progress, warnings, provider errors |
| exit code | the one the human path would have used: `0` fine, `1` a problem, `2` not meaningful |
| `command` | present on documents that carry it, so a caller can tell two apart without guessing |

The **shapes differ on purpose**: a `probe` document and a `vault` document answer
different questions, and forcing them into one envelope would mean inventing fields
that are null most of the time. What is identical is the transport.

| Command | Document |
|---|---|
| `sui doctor --json` | `command`, `ranAt`, `ok`, `node`, `platform`, `configPath`, `configFound`, `keys[]` (`env`, `length`, `state`, never the value), `catalogue`, `combos[]` (`combo`, `ok`, `modelId`, `provider`, `latencyMs`, `tokens`, `costUsd`, `error`), `models`, `kits`, `vault`, `invariants[]`, `warnings[]`, `exitCode` |
| `sui eval --json` | the eval report: `mode` (`self-test` \| `real` \| `not-meaningful`), `ranAt`, `combo`, `passRate` (null when not meaningful), `passed`, `total`, `answered`, `byCategory`, `confidence`, `mismatches[]`, `note` |
| `sui probe --json` | `fixtureVersion`, `results[]` (three levels, reasons, latency), `state[]` |
| `sui invariants --json` | `command`, `ok`, `total`, `invariants[]` (`id`, `status`, `statement`, `enforcedBy`, `gap`), `checked[]` (`id`, `ok`, `detail`), `gaps[]` |
| `sui catalog --json` | `summary` (`total`, `routable`, `awaiting_probe`, `tos_avoid`) and `rows[]` |
| `sui free-budget --json` | `verifiedTokens`, `unverifiedTokens`, `verified[]`, `unverified[]`, `pools`, `withoutBudget`, `note` |
| `sui cost --json` | the ledger aggregate; `--by user\|tool` groups it |
| `sui savings --json` | what cache hits and compression did not spend |
| `sui models --json` | the sanitised config: combos, models, provider status. Never a key |
| `sui kits --json` | `command`, `ok`, `loaded`, `total`, `kits[]` (`name`, `loaded`, `version`, `error`) |
| `sui tokens --check --json` | `command`, `ok`, `failures`, `standard`, `pairs[]` (`mode`, `pair`, `values`, `ratio`, `needs`, `ok`) |
| `sui budget --json` | `command`, `fraction`, `chosen` (`preset`, `reason`), `presets` |
| `sui tools --json` | `command`, `tools[]` (`id`, `name`, `detected`, `setup`, `configPath`), `found` |
| `sui recipe list\|show\|apply --json` | `command`, `action`, then `recipes[]` / `patch` / `changes[]`, `conflicts[]`, `missingEnv[]`, `written` |
| `sui local --json` | `command`, `ok`, `scanned`, `runtimes[]` (`kind`, `port`, `latencyMs`, `models`), `written` |
| `sui vault status\|list --json` | `command`, `action`, `exists`, `path`, `passphrase` (source only), `gateOpen`, `providers[]` — never a key |
| `sui lang --json` | the locales this build speaks |

`sui config show` prints JSON without a flag, because the config *is* the document.
