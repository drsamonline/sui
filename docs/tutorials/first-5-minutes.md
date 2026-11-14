# First five minutes

**Goal:** a gateway answering requests, a dashboard you can read, and one real turn on the record.

## 1. Start it

```bash
node apps/cli/bin/sui.js init
```

It looks for provider keys, looks for coding tools, writes `sui.config.json`, and then **sends a real request** through the gateway. That last part is the point: a green tick without an answer is not a working install.

If you have no keys yet, it wires the built-in demo provider so the rest of the flow works. Every surface says "demo" rather than "ready" — including the response's provenance block.

## 2. Send something

```bash
node apps/cli/bin/sui.js start
```

In another terminal:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chat-default","messages":[{"role":"user","content":"hello"}]}' \
  | jq '{answer: .choices[0].message.content, who: .sui.provider, verified: .sui.verified, ms: .sui.latencyMs}'
```

`verified: false` means a demo or unverified provider answered. That is the honest label, not an error.

## 3. Look at the dashboard

Open <http://127.0.0.1:8787/>. The cards, in reading order:

| Card | What it answers |
|---|---|
| Budget today | how much of today's cap is gone |
| Savings | what cache hits and compression did not spend |
| Turns / spend / p50 / cache hit | the four numbers worth watching |
| Your routing pool | which models your combos can actually reach |
| Free-tier weather | thriving / resting / down, with a trend line |
| Models in the pool | health, turns, cost, latency, prices |
| Prompt-free usage | which prompt hashes recurred, and what they cost |

## 4. Prove it to yourself

```bash
node apps/cli/bin/sui.js doctor      # one real turn per combo, plus the invariant audit
node apps/cli/bin/sui.js cost        # what it spent, on what
node apps/cli/bin/sui.js explain     # why the next request would go where it goes
```

## 5. Next

- Point a tool at it: [connect-a-coding-tool](connect-a-coding-tool.md)
- Understand the routing: [understand-routing](understand-routing.md)
- Something broken: [troubleshooting-doctor](troubleshooting-doctor.md)
