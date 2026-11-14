# ADR-0001 — npm workspaces now, Node data plane now, Go/Rust behind a benchmark

**Status:** accepted · 2026-11-14

## Context

The blueprint asks for Turborepo + pnpm, a compiled Go/Rust data plane, and SQLite in WAL mode. Those are good answers to a load profile Sui does not have yet: no users, no traffic, and a 15ms p95 budget that a Node handler currently meets with 0.38ms to spare.

## Decision

1. **npm workspaces, not Turborepo.** `apps/*` and `packages/*` are workspaces; `npm install` links them; `npm test` runs everything. Turborepo adds a task graph and a cache for a repository that builds nothing (there is no compile step). When a build step appears — a Go binary, a bundled dashboard — revisit.
2. **The data plane stays Node 20 ESM until a benchmark says otherwise.** The gate: p95 handler overhead must exceed 15ms under 10× the current soak load (200 rps sustained) before a rewrite is considered. Current measurement: p50 0.38ms, p95 2.57ms, p99 5.84ms at 20 rps over 60s.
3. **JSONL ledger before SQLite.** The ledger is append-only by design (I11 keeps prompts out of it, and the aggregate is a fold over records). SQLite buys indexing and concurrency we do not need yet, and costs a native dependency. Revisit when the ledger exceeds ~100k records or two processes must share it.

## Consequences

- Fast iteration: no compile step, no native modules, `npx sui` runs the source.
- The 15ms budget is currently met with margin, measured rather than asserted (`npm run soak`).
- If traffic arrives, the rewrite is a swap behind the same HTTP contract, and ADR-0001 is what tells us when to do it.
