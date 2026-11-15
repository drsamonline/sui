# MCP server

Sui speaks the **Model Context Protocol**, so an agent can use the gateway without knowing it is a gateway.

```bash
sui mcp                        # stdio — what an editor launches
sui mcp --transport http --port 8788   # POST /mcp — what a remote agent reaches
```

## Transports

| Transport | Framing | Use it when |
|---|---|---|
| `stdio` | newline-delimited JSON-RPC on stdin/stdout | a desktop client launches the process |
| `http` | `POST /mcp` with a JSON-RPC body, JSON back | the client is remote, or in a browser |

**stdout is the protocol.** In stdio mode every log line goes to stderr — a banner on stdout is a parse error for the client. `GET /mcp` answers `405` with a reason rather than holding a socket open, because this server has no server-initiated stream.

## Protocol

One revision is implemented — `2024-11-05` — and the server echoes it when a client asks for something else. It does not claim a revision it has not been written against.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"my-agent","version":"1.0"}}}
```

Notifications (`notifications/initialized` and anything unknown) get **no reply**, which is what the spec requires. Over HTTP that is a `202`.

## Tools

| Tool | What it does | Sends a request? |
|---|---|---|
| `sui_chat` | a prompt through a combo; returns the answer plus provenance | yes |
| `sui_models` | combos, strategies, reachable targets | no |
| `sui_explain` | why a route would go where it goes | no |
| `sui_cost` | spend by provider and combo, plus savings | no |
| `sui_compress` | what a preset would do to a prompt | no |
| `sui_status` | budget, breakers, quota windows, privacy posture | no |

Every `sui_chat` result carries `structuredContent` with `provider`, `model`, `combo`, `verified`, `cached`, `latencyMs`, `costUsd` and `confidence`, so an agent can report who answered without a second call.

## Wiring it into a client

Most clients take a command:

```json
{
  "mcpServers": {
    "sui": { "command": "npx", "args": ["sui", "mcp"] }
  }
}
```

Or a URL, for the HTTP transport:

```json
{ "mcpServers": { "sui": { "url": "http://127.0.0.1:8788/mcp" } } }
```

## Sui as an MCP client

An MCP server can be a **provider**. It takes a prompt and returns text, which is the same contract every other adapter honours — so fallback, breakers, budgets, privacy tiers, canary, verification and the ledger all apply to it with no special case.

```json
{
  "providers": {
    "my-mcp": { "type": "mcp", "url": "http://127.0.0.1:8788/mcp", "tool": "summarise" },
    "local-mcp": { "type": "mcp", "command": "npx", "args": ["-y", "some-mcp-server"], "tool": "ask" }
  },
  "models": {
    "summariser": { "provider": "my-mcp", "model": "summarise", "costPer1kIn": 0, "costPer1kOut": 0, "quality": 3 }
  },
  "combos": { "docs": { "strategy": "fallback", "targets": ["summariser"] } }
}
```

| Field | Meaning |
|---|---|
| `tool` | which MCP tool answers a chat request (required) |
| `url` / `command` | the transport: an endpoint, or a command to launch |
| `argument` | which tool argument carries the prompt (default `prompt`) |
| `arguments` | extra arguments passed on every call |
| `systemArgument`, `maxTokensArgument` | optional mappings for the other two |

The tool's text blocks are joined into the answer; `structuredContent` is kept in `raw` for anyone who wants it. A tool that reports `isError` becomes a provider failure with the tool's own words, so the router falls back exactly as it would from a 500.

**Token counts for an MCP tool are estimated** (characters ÷ 4), because the protocol does not report usage. The ledger records the estimate; it is not a measurement.

Resources and prompts are advertised as empty capability objects rather than being faked: an agent that asks gets an empty list, not an error and not an invention.
