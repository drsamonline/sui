# ADR-0006 — invariants are data, and the untestable ones say so

**Status:** accepted · 2026-11-14

## Context

The project prompt lists fifteen non-negotiable invariants. A list in a prompt is a wish. Three of them — the JWT fallback secret, the default `123456` password, and SQLite race conditions — describe defects in a different codebase; Sui has no JWTs, no password login and no SQLite.

## Decision

1. `packages/core/src/invariants.js` holds all fifteen as objects with `statement`, `enforced` (the module), `test` (the test that proves it) and `status`.
2. `test/invariants.test.js` fails if any invariant has `enforced: none`, `test: none`, or a non-`enforced` status without a `gap` explanation.
3. `auditConfig()` answers the subset that can be checked without traffic — the paid gate, ToS posture, plaintext keys, prompt logging — and is surfaced by `sui invariants`, `sui doctor` and `GET /api/invariants`.
4. Inapplicable invariants are documented rather than faked: **I15** covers the host-header bypass (fixed) and hashed keys (fixed); JWT and password items are marked N/A in the invariant's `gap`, with the reason.

## Consequences

- An invariant cannot quietly stop being true; its test fails.
- "We fixed the JWT secret" would be a lie here, so the file says there is no JWT instead.
