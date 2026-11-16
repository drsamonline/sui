# The two-plane split

One process doing everything is the wrong shape for the two jobs a gateway does. B5.7 splits it.

| Plane | Holds | Talks to | Faces |
|---|---|---|---|
| **model** | provider credentials | providers (the only plane that needs egress) | the agent plane, on loopback |
| **agent** | run bounds, approvals, attribution | the model plane | agents: MCP, HTTP |

```bash
# the model plane: keys, egress, nothing else
export SUI_PLANE_TOKEN=$(openssl rand -hex 32)
sui start --role model --port 8787

# the agent plane: agents talk to this one, in a second terminal
SUI_PLANE_TOKEN=<the same value> sui start --role agent --port 8790 \
  --model-plane http://127.0.0.1:8787
```

`--role` and `--model-plane` override the config for that run only; nothing is written back to `sui.config.json`.

**If the agent plane cannot forward**, it still starts — `/api/status` reports `planes.error` with the reason, and a chat request answers `503` with the same sentence. A plane that dies on boot with a stack trace tells you nothing you can act on.

## Why

The credential boundary. If an agent-facing surface is exposed, or an MCP client is compromised, it **cannot reach a provider key** — because it does not have one and cannot get one. It can only ask the model plane, which knows who is talking to it.

| Rule | Enforced by |
|---|---|
| the model plane serves only the agent plane | `x-sui-plane-token`, compared in constant time |
| health and status stay open | a probe cannot hold a secret |
| the model plane does not serve `/api/runs` or `/mcp` | `404 not_this_plane`, token or not |
| the agent plane has no providers | it forwards; it never routes |
| run bounds apply before forwarding | a bounded run is refused at the agent plane |

## What `both` is

`role: "both"` is the default and does exactly what the gateway did before this batch: one process, every surface. The split is opt-in, because most deployments are one machine and one user, and a second process is a cost with no benefit there.

## Failure modes, stated plainly

| Situation | What happens |
|---|---|
| agent plane has no `modelPlaneUrl` | `503 model_plane_not_configured` — it does not fall back to routing locally |
| model plane unreachable | `502 model_plane_unreachable`, naming the address |
| wrong or missing token | `403 plane_token_required` |
| token not set at all | the model plane refuses everything except health and status |

`/api/status` reports `planes: {role, agentFacing, holdsProviderCredentials, modelPlaneUrl, serviceTokenConfigured, serves}` on both sides, so "which process am I talking to?" is answerable without guessing.
