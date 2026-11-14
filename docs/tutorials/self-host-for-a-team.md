# Self-host for a team

**Goal:** one gateway, several people, per-key budgets, and paid keys that are not lying around in plaintext.

## 1. Bind it sensibly

```json
"server": { "host": "0.0.0.0", "port": 8787, "allowedHosts": ["sui.internal", "10.0.0.5"] }
```

`allowedHosts` is an allowlist, not a suggestion: a request with any other `Host` header gets a 403. Keep it behind your own ingress with TLS — the dashboard and `/api/*` are unauthenticated by design.

## 2. Give each person a key

```json
"apiKeys": [
  { "name": "team-a", "key_hash": "…", "allowedCombos": ["chat-default", "cheap"], "dailyUsd": 2, "rateLimit": { "rpm": 60, "burst": 10 }, "guardrails": { "maxOutputTokens": 1024 } }
]
```

Generate the hash rather than storing the key:

```bash
node apps/cli/bin/sui.js keys hash      # rewrites plaintext keys as SHA-256
```

| Field | Effect |
|---|---|
| `allowedCombos` / `allowedModels` | 403 outside the list |
| `dailyUsd` | 429 `key_budget_reached`, with the numbers in the message |
| `rateLimit` | 429 `rate_limited` with `Retry-After` |
| `guardrails.maxOutputTokens` | clamps the request, and wins over it |

## 3. Seal the paid keys

```bash
node apps/cli/bin/sui.js vault init          # generates a passphrase, 0600, beside the vault
echo "$OPENAI_KEY" | node apps/cli/bin/sui.js vault set openai
node apps/cli/bin/sui.js config set paid_tiers.enabled true
node apps/cli/bin/sui.js vault status
```

The vault is AES-256-GCM sealed and opened only when the gate is on. **The passphrase sits beside the vault unless you supply `SUI_VAULT_PASSPHRASE`** — that protects a copied vault file, not a compromised account.

## 4. Watch the money

```bash
node apps/cli/bin/sui.js savings --all      # dollars avoided, tokens never sent
curl -s http://127.0.0.1:8787/api/metrics.csv > usage.csv
```

## 5. Know the limits

One process, one rate limiter — two gateways double the effective limit. The ledger is a local JSONL file, not a shared database. Both are recorded in `AUDIT.md` and `ROADMAP.md`.
