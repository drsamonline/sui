# Troubleshooting with doctor

**Goal:** turn a symptom into a cause without guessing.

```bash
node apps/cli/bin/sui.js doctor
```

It sends one real turn per combo and then audits the invariants. Read it top to bottom.

## The four symptoms you will actually hit

### 503 `no_route_available`

Every target was skipped or failed, and the message lists each reason:

```
No model could answer "chat-default" right now. Details: groq-70b — resting after a
failure (retrying in 24s); gpt-mini — paid tier is closed (paid_tiers.enabled is false).
```

| Reason | Fix |
|---|---|
| `no API key set (GROQ_API_KEY)` | put it in `.env` |
| `resting after a failure` | wait out the cooldown, or `POST /api/breaker/reset` |
| `paid tier is closed` | `sui config set paid_tiers.enabled true` |
| `daily budget reached` | raise `budgets.dailyUsd`, or wait for local midnight |
| `terms of service marked avoid` | that provider is never auto-routed; name the model directly if you accept it |

### 429

Two different 429s, with different fixes: `rate_limited` carries `Retry-After` (your key is going too fast); `key_budget_reached` names the spent and the cap (raise `dailyUsd` on the key).

### An empty answer

Sui retries an empty turn once on the same target, then fails over. If the client still sees blank text, the provider answered twice with nothing — check `sui cost --json` for `empty_turn` errors on that model, and consider removing it from the combo.

### The answer arrives but `verified: false`

Three possibilities, in order of likelihood: a demo/mock provider answered; verification scored the answer below the threshold (the reasons are in `sui.verification.reasons`); or a route that never cleared the bar was returned fail-closed.

## Deeper tools

```bash
node apps/cli/bin/sui.js probe            # liveness / readiness / suitability per provider
node apps/cli/bin/sui.js probe --json | jq '.state'
node apps/cli/bin/sui.js explain cheap    # why a route would go where it goes
node apps/cli/bin/sui.js invariants       # the fifteen rules and any warning
node apps/cli/bin/sui.js kits             # are the vendored kits loading
```

If `sui doctor` is green and a request still fails, the failure is in the client: check that it is sending `model` as a combo name and that its base URL ends in `/v1`.
