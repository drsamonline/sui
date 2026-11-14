# ADR-0005 — telemetry stores a hash, not a prompt

**Status:** accepted · 2026-11-14

## Context

Cost and latency attribution needs to know which requests happened. It does not need to know what they said. Most observability stacks store the prompt by default and offer redaction as an option.

## Decision

1. The ledger stores `promptHash` (salted SHA-256, truncated to 16 hex characters) and `promptChars`. Never the text.
2. `guardrails.logPrompts` exists for people who deliberately want the text, defaults to false, and is reported as an invariant warning (I11) when on.
3. The salt is `SUI_LEDGER_SALT`, defaulting to a per-install value, so hashes are not comparable across installs.
4. `/api/traces` exposes the hash view, with the sentence that says what it is.

## Consequences

- "The same prompt was routed forty times" is answerable without holding anyone's code.
- Debugging a bad answer from the ledger alone is not possible. That is the intended trade, and it is why `logPrompts` exists as an explicit act rather than a default.
