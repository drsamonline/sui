# Contributing

Zero dependencies is a feature, not an accident. Before adding one, open an issue explaining what breaks without it.

## Get running

```bash
git clone https://github.com/your-org/sui
cd sui
node --version                 # 20 or newer
npm install                    # links the workspaces; installs nothing else
npm test                       # 117 tests, no network, no keys
npm run eval:self              # proves the eval graders grade
npm run soak                   # p95 overhead against the 15ms budget
node apps/cli/bin/sui.js init  # writes ./sui.config.json and proves the route
```

Nothing is built. There is no compile step and no runtime dependency (ADR-0003).

The test suite never touches the internet: a fake OpenAI-shaped upstream runs on a local socket, and a `mock` provider covers the no-network path. If a test needs a key, it is testing the wrong thing.

## Where things live

| Path | What belongs there |
|---|---|
| `packages/core/src/config.js` | loading, validation, combo resolution, `checkToggle`, the paid gate, key hashing |
| `packages/core/src/invariants.js` | the fifteen invariants and the config-level audit |
| `packages/router/src/router.js` | planning and execution — no HTTP, no provider protocols |
| `packages/router/src/breaker.js` | the health state machine |
| `packages/providers/src/index.js` | one function per wire format, all returning the same shape |
| `packages/guardrails/src/index.js` | prompt checks before any provider is called |
| `packages/telemetry/src/*` | ledger, cache, aggregation, CSV |
| `packages/catalog/src/index.js` | catalogue schema, dedupe, ToS posture, scoring |
| `apps/gateway/src/server.js` | HTTP, auth, host allowlist, SSE, dashboard API |
| `apps/cli/src/*` | the human path |
| `apps/dashboard/web/dashboard.html` | the dashboard — one file, no build, no external requests |
| `evals/` | golden set, graders, runner, baseline |
| `scripts/soak.mjs` | the overhead harness |

## Rules the code holds itself to

0. **An invariant is only real if a test proves it.** Add it to `packages/core/src/invariants.js` with its `enforced` module and its `test` name, or `npm test` will reject the change.

1. **Errors are sentences.** Name the field, say what to do next, never a stack trace. `new ConfigError('combos.chain.strategy is "fallbak" — use one of: …')`.
2. **Validate at load, not at request time.** Anything knowable from the config is checked in `normalizeConfig`.
3. **Decisions are pure.** `Router#plan()` takes no network action. If you cannot test a routing rule without a provider, the rule is in the wrong place.
4. **Observability never breaks a request.** The ledger write is wrapped; a full disk must not become a 500.
5. **The ledger records failures.** A failed attempt is evidence. Do not filter it out to make numbers look tidy.
6. **No secrets in logs, in `/api/config`, or in error messages.** Env var *names* are fine; values never.
7. **Dashboard tokens only.** No raw colour values in components; one neutral ladder, one signal colour, a fixed type scale, `font-variant-numeric: tabular-nums` on numbers, WCAG 2.2 AA contrast, status never signalled by colour alone, keyboard navigable.
8. **Skeletons, not spinners.** And the first streamed token is the loading state.
9. **JSDoc annotations** on exported functions — they give editors types without a build step.

## Tests

```bash
npm test                            # everything
node --test test/router.test.js     # one file
npm run eval:self                   # the graders themselves
node evals/run.mjs --combo cheap    # a real eval against a live provider
```

New behaviour needs a test that would fail without it. For routing changes, that usually means a test in `test/router.test.js` asserting the *order* and the *reason*, not just the final answer.

Test naming is a sentence about behaviour: `'circuit breaker: half-open after cooldown, closed after a success'`.

## Commits

Conventional Commits, one idea per commit:

```
feat(router): add latency strategy based on measured p50
fix(server): send provenance headers with the first streamed token
docs(routing): explain why a mid-stream failure is not retried
```

## Pull requests

Include: what changed, why, how you verified it (the command and its output), and anything you deliberately did not do. If a change touches the request path, say what happens when a provider fails mid-request.

## Adding a provider

1. Write `myProviderChat(providerId, provider, apiKey, req, opts)` in `src/providers/index.js` returning `{ text, usage, finishReason, raw }`, calling `opts.onToken(delta)` per streamed chunk.
2. Throw `ProviderError` with `retryable` set honestly — that flag is what the router and the breaker act on.
3. Register the type in `createAdapter` and in `PROVIDER_TYPES` (`src/config.js`).
4. Add the model entries to `config/sui.config.json` with prices you have checked against the provider's page, and say in the PR where you checked them.

## Licence

MIT. By contributing you agree your work is licensed under it.
