# ADR-0004 — the paid tier is a gate in code, not a flag in a doc

**Status:** accepted · 2026-11-14

## Context

The positioning says paid tiers are "physically air-gapped behind a separate encrypted vault". A promise like that is worth nothing if the only thing enforcing it is a configuration comment.

## Decision

1. `paid_tiers.enabled` defaults to **false**, and is read in exactly one place: `providerHasCredentials()`.
2. When the gate is closed, a provider with `tier: "paid"` reports **no credentials**. The environment variable is not read, the model is skipped from every plan, and the reason given is `paid tier is closed (paid_tiers.enabled is false)`.
3. The gate is checked **before** the environment is touched, so a leaked `.env` with a paid key present cannot leak a paid request.
4. `test/invariants.test.js` proves both directions: invisible while closed, available when opened.
5. The second half — an encrypted vault loaded only when enabled — is batch B6.7. Until then this ADR covers the gate, and `docs/legal`-style honesty applies: the vault is not built.

## Consequences

- A user with only paid keys sees a clear reason rather than a confusing 503.
- `sui doctor` and `/api/invariants` both report the gate state, so the UI cannot claim otherwise.
