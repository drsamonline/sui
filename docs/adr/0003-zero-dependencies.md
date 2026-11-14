# ADR-0003 — zero runtime dependencies

**Status:** accepted · 2026-11-14

## Context

A gateway sits in front of every prompt an organisation sends. Its supply chain is the supply chain of all that traffic. Most gateways pull in a web framework, an ORM, a validation library, a logger, a router and a YAML parser before they route a single request.

## Decision

Runtime dependencies: **none**. Node built-ins only (`node:http`, `node:crypto`, `node:fs`, `fetch`).

What that costs and how it is paid:

| Need | Without a dependency |
|---|---|
| HTTP | `node:http` with a small router in `apps/gateway/src/server.js` |
| Config | JSON + a hand-written validator that names every field and lists all problems at once |
| Validation | `packages/core/src/config.js` |
| Ledger | append-only JSONL, folded in memory |
| Cache | `Map` with TTL and LRU refresh |
| CLI prompts | `node:readline/promises` |
| Dashboard | one HTML file, no build, no framework |
| Tests | `node:test` + `node:assert` |

## Consequences

- `npx sui` works on a machine with no registry access.
- The attack surface is this repository, and `npm audit` has nothing to say.
- Anything genuinely heavy (a semantic-cache embedding model) must be optional and off by default, or it breaks this ADR.
