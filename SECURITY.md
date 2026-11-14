# Security

## Reporting

Open a private security advisory on the repository, or email the maintainer listed in `package.json`. Please do not open a public issue for a vulnerability. Expect a first reply within a few days.

## What this gateway is, in security terms

It is a **local development and single-team gateway**. It holds provider API keys in the environment and accepts requests on a port.

The defaults are chosen for that shape:

- Binds to `127.0.0.1`, not `0.0.0.0`.
- No auth unless you configure `apiKeys` (or set `SUI_API_KEY`).
- API keys are stored as SHA-256 hashes (`key_hash`) and compared with `timingSafeEqual`. A plaintext `key` still works for development, and the invariant audit (I15) flags it; `sui keys hash` rewrites them.
- The Host header is checked against an allowlist (`server.allowedHosts`, default `127.0.0.1`, `localhost`, `[::1]`), so DNS rebinding cannot turn a localhost gateway into a remote one.
- The dashboard and `/api/*` are unauthenticated by design, so the dashboard works from a fresh browser tab. They expose spend, model names and prompt *hashes* — not prompts, not keys.

## If you expose it beyond localhost

Do all of these:

1. `"server": { "host": "0.0.0.0" }` **and** put it behind a reverse proxy that terminates TLS and enforces auth. Do not expose the port directly.
2. Configure `apiKeys` with `allowedCombos` and `allowedModels` so one leaked key cannot reach every provider.
3. Set `budgets.dailyUsd` and `budgets.perProvider` — a budget cap is the difference between a bad day and a bad invoice.
4. Keep `guardrails.logPrompts` false.
5. Restrict egress from the host to the providers you actually use.

## What is never logged or served

- Provider API keys, in any form, in any endpoint or log line. `/api/config` exposes `apiKeyEnv` (a name) and `hasCredentials` (a boolean).
- Prompt text, unless you explicitly set `guardrails.logPrompts: true`. The default record is a salted SHA-256 prefix and a character count.

## Known limitations, stated plainly

- **The paid vault is not built.** The air-gap exists as a gate in code (`paid_tiers.enabled`); the encrypted vault behind it is batch B6.7. Until then, a paid key sitting in `.env` is protected by the gate, not by encryption.
- **The ledger is a local JSONL file** with no encryption and no retention policy beyond a memory cap. If prompts are logged, they are in that file in plain text.
- **The response cache is in memory**, keyed by a hash of the request body. It is not encrypted and it does not survive a restart.
- **Guardrails are a starter set**: output token cap, input size cap, regex block list. No PII redaction on the wire, no content classification, no prompt-injection detection. Do not describe this as a governance layer.
- **No rate limiting** per key or per IP yet.
- **`/api/config/validate` is advisory**: it answers whether a toggle is safe, and the dashboard obeys it, but the config file itself can always be edited by anyone who can write to it.

## Dependencies

There are none at runtime. That is the main reason the attack surface is small: no transitive supply chain, no post-install scripts, nothing to audit beyond this repository.
