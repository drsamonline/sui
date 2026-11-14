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

The last eval run on this machine, read from `evals/last-report.json`.

```json
{ "available": true,
  "report": { "mode": "self-test", "ranAt": "2026-11-14T12:58:13.434Z", "combo": null,
              "passRate": 1, "passed": 56, "total": 56, "mismatches": [],
              "note": "Harness self-test: graders were checked against fixture answers. No model was called." } }
```

`available: false` with a message when no eval has been run. A `self-test` report proves the graders grade; only a `real` report says anything about a model.

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
