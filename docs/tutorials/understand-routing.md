# Understand routing

**Goal:** you can predict which provider answers, and say why.

## The plan is a pure function

Given a config and a ledger, `plan(combo)` decides an order. No network, no side effects — which is why you can ask without sending anything:

```bash
node apps/cli/bin/sui.js explain chat-default
```

```
"chat-default" is a fallback route with 4 targets.
It would try groq-70b → gemini-flash.
Skipped gpt-mini: paid tier is closed (paid_tiers.enabled is false).
Skipped claude-haiku: paid tier is closed (paid_tiers.enabled is false).
```

The same answer is at `GET /api/explain?combo=chat-default` and as `sui.route` on every response.

## The four strategies

| Strategy | Order is decided by | Use it when |
|---|---|---|
| `fallback` | declaration order | you want predictability |
| `weighted` | a weighted pick, the rest as fallbacks | you are A/B testing two providers |
| `cheapest` | blended cost, after the quality floor | you want the same task cheaper |
| `latency` | measured p50 from your own ledger | you want the fastest one that works |

## What makes a target ineligible

In this order, because money beats health: no credentials → over the daily budget → over the provider budget → below the quality floor → over the cost cap → **breaker open**.

A target whose breaker is open is not skipped forever: it is held back and tried only if every healthy target fails (invariant I14). A `tos: avoid` provider is never auto-routed at all (I12).

## Watch it happen

```bash
node apps/cli/bin/sui.js cost                 # per provider, per combo, per A/B arm
node apps/cli/bin/sui.js cost --json | jq '.byArm'
```

For a weighted combo, `byArm` is the experiment: turns, cost and average latency per arm. Without the arm, an A/B test is just noise.

## Change your mind

```bash
node apps/cli/bin/sui.js config set combos.chat-default.strategy cheapest
node apps/cli/bin/sui.js config set combos.chat-default.minQuality 3
node apps/cli/bin/sui.js explain chat-default
```

Every write is validated first: a change that would break the config is refused and the file is left untouched.
