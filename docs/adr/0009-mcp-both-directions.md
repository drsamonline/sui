# ADR-0009 — MCP in both directions, on two transports, behind one handler

**Status:** accepted · 2026-11-15

## Context

The Model Context Protocol is the way agents discover and call tools. Sui has two possible relationships to it: be a server (agents call the gateway), or be a client (the gateway calls MCP tools). The spec prompt asks for both, and they are not symmetrical — the server half is a protocol surface, the client half is a provider adapter.

## Decision

**Server half** (`packages/mcp/src/server.js`): one message handler, two transports.

- `stdio` is newline-delimited JSON-RPC. This is what an editor launches.
- `http` is `POST /mcp` with a JSON-RPC body. `GET` answers `405` with a reason rather than holding a socket open, because this server has no server-initiated stream to offer.
- **One protocol revision is implemented** (`2024-11-05`) and echoed when a client asks for another. Claiming a revision that was not written against is a lie a client will discover at the worst moment.
- Resources and prompts are advertised as **empty capability objects**, not faked. An agent that asks gets an empty list, not an error and not an invention.
- Notifications get **no reply**, which the spec requires. Over HTTP that is a `202`.

**Client half** (`packages/mcp/src/adapter.js`): an MCP server is a provider, `type: "mcp"`.

The reason is leverage: an MCP tool takes a prompt and returns text, which is the contract every adapter already honours. Making it a provider means fallback, breakers, budgets, privacy tiers, residency, canary, verification and the ledger apply with **no special case**. A parallel path would have meant re-implementing all of that for tools.

## Consequences

- `providers` dispatches `mcp` through a **lazy import**, because `@drsamonline/mcp` depends on the router, which depends on `providers`. A static import is a cycle that fails at module-eval time — which is exactly how it failed the first time.
- The prompt argument name is configurable (`argument`, default `prompt`), because only the operator knows what their tool expects.
- A tool that reports `isError` becomes a provider failure carrying the tool's own words, so the router falls back as it would from a 500.
- **Token counts for an MCP tool are estimated** (characters ÷ 4), because the protocol reports no usage. The ledger records an estimate and the docs say so.
- Three bugs were found only by running real JSON through the real binary: a CLI banner on stdout in stdio mode, the HTTP handler mounted behind a server that had already answered `404`, and `--transport` not being a value-taking flag. Unit tests passed through all three.
