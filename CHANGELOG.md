# Changelog

Every entry names what shipped and what it costs you to adopt. Nothing is listed here that a command does not prove.

## 0.12.11 — 2026-11-19

### Added

- **Adaptive admission.** A request that arrives when every slot is busy now waits for one instead of failing: `server.admission` sets `maxConcurrent` (64), `queueMax` (256) and `maxWaitMs` (5000). Only when the queue itself is full, or the wait expires, does the caller get a 503 — with `Retry-After` and a sentence naming the wait it would have needed. The slot is released on `res.close`, so a thrown provider error cannot leak one and slowly strangle the gateway.

### Fixed

- **A queued request could hang instead of timing out.** The waiter's timer was `unref`'d, so the event loop was free to exit while a request was still queued: it neither resolved nor rejected. Removed; a queued request holds the loop for at most `maxWaitMs`, which is the point.

## 0.12.10 — 2026-11-19

Two of the features queued after the OmniRoute review, both built on data this gateway already measures.

### Added

- **`quota-weighted` routing.** Orders targets by remaining budget headroom ÷ turns already answered today, so the target with the most left to give goes first. Unlike a strategy that reads a declared weight, this uses what the ledger recorded: `providerSpendToday()` and a new per-model turn count in the same day bucket. An unknown strategy name is now refused at config time — a typo used to fall through to declared order silently.
- **`forcedModel` per API key.** A key can be pinned to one combo or model; a request naming anything else is refused with 403 rather than quietly routed where the operator did not intend. This is what makes a per-tenant key meaningful on a shared deployment.

### Changed

- `sui explain` narrates the new strategy in sentences, like the others.

## 0.12.9 — 2026-11-19

Full audit pass — [`AUDIT-2026-11-19.md`](AUDIT-2026-11-19.md). Three security findings, all fixed.

### Security

- **`Access-Control-Allow-Origin: *` on every response.** A gateway on `127.0.0.1` is reachable by any page the user has open, and the Host-header guard does not stop it — that page sends the allowed Host. Any website could read answers and spend quota. Cross-origin is denied by default now; `server.corsOrigins` is the opt-in, and Node clients (Cline, Continue, the SDK) never needed it.
- **The prober fetched any address the catalogue named**, including `169.254.169.254` (cloud metadata) and `127.0.0.1:6379`. `probeAddressAllowed()` refuses loopback, link-local, private, ULA and internal hostnames, and requires https. `sui probe <name>` and `sui local` opt in explicitly with `allowLocal`.
- **Serving on a non-loopback host with no API keys is an open relay** and nothing said so. It now refuses to start, naming both ways out; `--allow-open` proceeds with a warning.

### Fixed

- `--headless` did nothing: `normalizeConfig` drops unknown keys and the flag landed in the wrong return block.
- The publish job dirtied the tree its own publisher checks — `evals/last-report.json`, then `package-lock.json`.

### Documentation

- `AUDIT-2026-11-19.md`: findings with file and case, what came back clean, and what this audit did not do.

## 0.12.8 — 2026-11-19

Reviewed against [OmniRoute](https://github.com/cheaper-inference/OmniRoute) v3.8.55.

### Added

- **Inflation guard on compression, on by default.** Restoring protected spans could make the "compressed" prompt longer than the input, so a preset charged the user tokens for a prompt it had grown. If the result is not smaller, the original goes through untouched and the result says `inflation: compression would not have shrunk this prompt`. Four presets × five adversarial inputs are asserted in `test/compression.test.js`.
- **`--headless`.** The proxy engine without the dashboard: a gateway on a VPS should not serve a page that can rewrite its own config. `/` answers 404 with an explanation, `/v1` and `/healthz` keep working.
- **`docs/COMPARISON.md`** — where OmniRoute is ahead, where Sui is ahead, what Sui took from it, what it will not copy, and the adoption order. Written to be checkable: every claim about Sui names the file or command that proves it.

### Fixed

- **A flag added to the config schema did nothing.** `normalizeConfig` drops unknown keys, and `--headless` was added to the wrong return block, so the gateway never saw it. The test that caught it is the one that exercises the HTTP route rather than the flag.

## 0.12.7 — 2026-11-18

### Fixed

- **`sui doctor` still told you to run `npx sui init`.** Three hints lived outside the CLI's own file and had escaped the first fix. There is now one definition — `runAs()` in core — and every layer asks it, so an install says `npx @drsamonline/cli`, a checkout says `./sui`, and Windows says `.\sui.cmd`. A test fails if any source file prints `npx sui`.

## 0.12.6 — 2026-11-18

### Fixed

- **Internal ranges pinned the patch.** `cli@0.12.5` declared `@drsamonline/gateway@^0.12.5` while the gateway's newest published version was 0.12.3, because npm staged that one. A partial publish made the CLI uninstallable. Internal ranges now pin the minor (`^0.12.0`), so one package lagging does not break the rest — and a test enforces it.
- **The staged-release check read the registry too early.** npm answers *"being processed, may take a few minutes"*; reading once, immediately, reported a successful release as staged. It now retries with backoff and only calls a release staged when the registry shows the `0.0.0-stage` placeholder.

## 0.12.5 — 2026-11-18

### Fixed

- The audit's help-coverage check looked for the literal `sui <command>`, which stopped matching once the prefix became `${RUN_AS}`. It accepts every form the CLI can print now, so the check still proves what it was written to prove instead of being loosened.

## 0.12.4 — 2026-11-18

### Fixed

- **A registry install reported `0.0.0-unknown` as its version.** The CLI read the version from the repository root, and there is no repository root inside `node_modules`. It reads its own manifest now, falling back to the root only in a checkout.
- **The help told you to run `npx sui`.** That is a bin name, not a package. From an install it now says `npx @drsamonline/cli`, and from a checkout `./sui` or `.\sui.cmd`. Every hint, error message and usage line follows the same rule — the rename had left 24 of them pointing at a command that cannot work.

Both were invisible in the repository and obvious the moment the published package was installed into an empty directory. A test now builds that layout and runs it.

## 0.12.3 — 2026-11-18

### Fixed

- **The published CLI could not run.** `npm i @drsamonline/cli` installed one package and then failed with `Cannot find package '@drsamonline/gateway'`. Two causes, both invisible inside the monorepo because workspaces link by path:
  - **`apps/gateway` was never published.** It is a dependency of the CLI and was missing from the publisher's order list.
  - **33 internal imports were undeclared.** The workspace link resolved them here; a registry install cannot.
- The publisher now refuses to run when a package depends on something the same run does not publish, and a test fails when a workspace imports a package it does not declare.

Found by installing the published package into an empty directory, which is the only way to see it.

## 0.12.2 — 2026-11-18

### Fixed

- **The publish job dirtied the tree its own publisher checks.** The eval self-test writes `evals/last-report.json` (committed, so the dashboard has something to show), and the publisher refuses a dirty tree — correctly, since what you tested should be what you ship. The workflow now restores that one generated file, and the publisher names generated files instead of counting them as edits.

## 0.12.1 — 2026-11-18

The first version that can actually be published.

### Changed

- **Scope renamed `@sui/*` → `@drsamonline/*`.** A scope is an owner, not a namespace: `@sui/*` could only be published by the account or organization named `sui`, which is taken. The account owns `@drsamonline`, so all 18 names are free inside it. `scripts/rename-scope.mjs` does the rename — package names, internal dependency ranges, every import across 107 files, and the lockfile — and is re-runnable if the scope changes again.

### Fixed

- **Three flaky tests**, found while verifying the rename under load: the cascade classifier asserted one wall-clock reading under 50 ms (failed at 52 ms, passed at 3 ms next run) and now takes the best of three, warmed up; the worker kickoff waited a fixed 3 s and now waits up to 15 s; the compression test reported "cannot read properties of undefined" when the fake upstream received no request, and now says that.
- The suite runs one file at a time by default, because two at a time on a busy machine is how all three of those surfaced. CI keeps two: its runner is quiet.

## 0.12.0 — 2026-11-18

The version that stopped trusting its own documentation.

### Fixed

- **The budget stopped counting.** Spend was summed from an in-memory window capped at 5,000 records, so past 5,000 turns in a day the cap under-reported — 250 turns at a cent read as $1.00 against a true $2.50. A gateway could overspend while believing it was inside its cap. Spend and per-provider spend now come from a per-day bucket that does not depend on the window.
- **The ledger file grew forever.** Nothing pruned a file, only an array; at 20 rps a three-day soak writes millions of lines. It rotates at 64 MB, keeping one previous file.
- **`sui --version` and `sui --help` started onboarding** instead of answering, because both arrive as flags rather than as a command.
- **The first-run hint told you to run `npx sui`** — the one command that cannot work before a publish.
- **The dashboard's health column read `0-mining (0s)`.** The breaker emits `half-open`; the stylesheet styled `half_open`. Labels now come from one map and both spellings are styled.
- **The dashboard card headed "Last eval — 100%"** was showing the harness self-test, which says nothing about answer quality. It is headed "Answer quality" and switches to "Harness self-test" when that is what ran.
- **`--role` parsed as `true`** because it was missing from `VALUE_FLAGS` — the third flag to hit that trap. A test now cross-checks every flag the help text shows with a value.
- **An agent plane crashed at boot** without a service token instead of starting and explaining itself.

### Added

- **Windows support**: `sui.cmd`, `sui.ps1` and `sui` wrappers so the CLI runs from a checkout with no npm account, `scripts/install-windows.ps1`, and `docs/WINDOWS.md`.
- **`sui probe --write`** promotes what answered into `$SUI_HOME/catalog-verified.json`; `--revoke` withdraws a route. Before this a probe reported and recorded nothing.
- **`DISCLAIMER.md`** and **`docs/legal/LEGAL-INDEX.md`** — the repository ships AI output and had no document saying what that output must not be relied on for.
- **A catalogue source ledger** (`packages/catalog/sources.json`): seven sources, each with URL, pinned commit, licence, and what was taken and what was not.
- **An architecture diagram** in `docs/ARCHITECTURE.md`, with a test that keeps it matching the code.

### Fixed (found by CI, which had never run)

- **A test wrote to `/proc`.** `mkdirSync('/proc/nonexistent', {recursive:true})` returns EPERM here and **hangs** on a real Linux runner, so a whole test file sat open until CI killed it at 120 seconds. It passed locally every time, which is why it survived four wrong diagnoses — the prober, the keep-alive socket, the CPU count. A read-only temp directory is unwritable everywhere and answers immediately.

- **A worker interval of `0` was a busy loop.** `setInterval(fn, 0)` is not a fast timer — it runs the callback the moment the previous one yields, pegs a core and starves every other timer in the process. `0 ?? fallback` does not help: nullish coalescing only replaces null and undefined. Zero or less now means the job is off.
- `node --test test/` worked on Node 20 and failed on Node 22, which reads the argument as a file. The suite now runs through a runner that passes explicit paths.
- the workflow itself was invalid — a job-level `if` referencing `secrets` — so every run since 14 November completed as a failure with **zero jobs**, and no gate ever ran in CI.
- three tests reached the internet, which is instant here and slow on a runner.

### CI

- The workflow now runs **ADR compliance** and the **ADR-0001 gates**, which existed but were not gated on.
- A **dashboard job** renders the page in a real browser in three states and fails on any console error.
- The probe step gets a short timeout: 29 endpoints with an 8-second default and no egress is four minutes of nothing.
- `sui probe --json` and `sui tenants --json` printed a human preamble to stdout, so their output did not parse. Both emit a clean document now, and `tenants --json` returns an empty result with a note rather than nothing at all.

### Measurement

- The eval pass rate now carries a **95% confidence interval** and a per-category breakdown. One prompt in fifty is two percentage points, so a bare "86%" invited the reader to treat a sample as a measurement.
- Thin categories (fewer than five prompts) are labelled indicative; the aggregate is dominated by coding, which has ten.
- The regression gate says when a drop is a single prompt — inside sampling noise — instead of implying a trend.
- The soak reports how many samples its percentiles rest on, because a p99 from 1,200 requests is the twelfth-worst request, not a bound.
- New `docs/MEASUREMENT.md`: what each number rests on, and what none of them measure.

### Changed

- The README went from 202 lines with a 42-bullet feature wall to 112 lines in the shape its reader needs; the full list moved to `docs/FEATURES.md`.
- The generated catalogue is **empty by design**. Three keyword heuristics for finding model endpoints in a directory of public APIs produced a sudoku API, a model *catalogue* and 24 QR-code services. The catalogue is the 29 deliberately seeded entries.
- Four false claims were removed from the landing page, including two features listed as missing that had shipped.

## 0.11.0 — 2026-11-15

The version where the gateway became usable by agents, stopped being one process doing everything, and learned to run code it does not trust.

### Agent surface

- **MCP server** over **stdio** and **HTTP** (`sui mcp`). Six tools — `sui_chat`, `sui_models`, `sui_explain`, `sui_cost`, `sui_compress`, `sui_status` — with provenance in `structuredContent`. One protocol revision implemented (`2024-11-05`) and echoed; resources and prompts advertised empty rather than faked.
- **MCP client**: `type: "mcp"` makes an MCP server a provider, so fallback, breakers, budgets, privacy, canary, verification and the ledger apply with no special case.
- **Bounded runs** (`POST /api/runs`, `x-sui-run`): spend, steps, wall clock and repeated-call limits, plus per-call approval gates that are single-use.
- **Two-plane split** (`planes.role`): a model plane that holds the keys and needs egress, and an agent plane that faces agents and holds none, joined by a constant-time-checked service token.

### Routing and cost

- **Free-first ordering**: a free target ranks before a paid one regardless of declaration order, with a per-combo opt-out.
- **Speculative cascade**: a deterministic classifier (under 50 ms, 3 ms on a 20,000-word prompt) picks the cheap or the strong target before the request leaves.
- **Quota windows**: a `429` carrying `Retry-After` closes that target for exactly that long. It is not a breaker trip, because a quota window is a fact and the breaker is an inference.
- **Fallback learning**: a combo reorders its own targets from measured success rate and latency, keeping declared order below the sample floor.
- **Attribution**: `x-sui-user` and `x-sui-tool` charge each turn to a person and a tool; `sui cost --by user|tool`.
- **Tenant console**: `GET /api/tenants`, live cap changes with `PATCH`, and `sui tenants`.

### Trust

- **Grounding check**: a URL, quote or number in the answer that is not in the context it was given costs 0.45 confidence and usually escalates.
- **Residency**: providers declare a region; a request can require one; an unmarked provider never satisfies it.
- **Token refresh**: a provider with an `oauth` block refreshes once on a 401 and retries once, never in a loop.
- **Budget alerts**: 75/90/100 percent of the daily and per-provider caps, once per threshold per day.
- **Owner licence grant**: the kits stay PolyForm upstream and are distributed here under MIT by a written grant, enforced by a test.

### Operations

- **Recipes**: `sui recipe apply free-tier-stack` and four more, which never overwrite silently, apply idempotently, and dry-run for real.
- **Local discovery**: `sui local` finds Ollama and OpenAI-compatible servers on loopback and can wire them up.
- **Drift detection**: EWMA plus a two-sided CUSUM, so a slow slide is caught that no breaker can see.
- **Trend history**: health samples on disk, bucketed into `/api/history`, surviving a restart.
- **Worker hardening**: a tick that arrives mid-run is skipped, not queued; a failing job backs off and resets on success.
- **Compression view**: `POST /api/compress` and a dashboard card showing what a preset would do, without sending anything.

### Windows

- `sui.cmd`, `sui.ps1` and `sui` wrappers, so the CLI runs from a checkout with no npm account and no publish
- `scripts/install-windows.ps1` — checks Node, links the workspace, proves the CLI runs
- `docs/WINDOWS.md` — setup for someone who has never opened a terminal
- `npm link` in the checkout now creates a global `sui`
- `sui --version` and `sui --help` answer instead of starting onboarding

### Documentation

- Nine ADRs (0001–0012, with 0002 amended rather than rewritten), `CONTRIBUTING.md`, `MCP.md`, `PLANES.md`, `RECIPES.md`, and two audits in the repository.

### Verified at this version

514 tests · audit 8/8 · eval self-test 56/56 · soak p95 ≈1 ms against a 15 ms budget · 19 invariants, each with an enforcement point and a named test.

### Sandbox (B5.6)

- `sui sandbox <file>` runs a snippet in a separate process with Node's permission model, a network namespace, a stripped environment and hard limits; `sui sandbox --self-test` runs a 14-case attack suite. Not on the request path.

### Catalogue

- `sui probe --write` promotes what answered into `packages/catalog/verified.json`; `--revoke` withdraws a route. Before this, a probe reported and recorded nothing, so no entry could ever become routable.

- `npm run import:all` imports provider endpoints (facts only, credited) from seven reference projects: 29 catalogue entries now carry a base URL, including the three keyless providers the spec names. Nothing is routable until `sui probe` verifies it. `packages/catalog/sources.json` is the ledger.

### Known gaps

| Gap | Needs |
|---|---|
| Catalog sync and keyless endpoints (B2.2, B2.5) | a networked machine |
| 72-hour soak (B0.3) | a machine held for three days |
| — | — |
| A lawyer's read of `OWNER_GRANT.md` | the owner |
| `npm publish` | the owner |

## 0.4.0 — 2026-11-14

The first working gateway: monorepo, 15 invariants, paid air-gap, sealed vault, OpenAI-compatible endpoint, four routing strategies, circuit breaker, two-tier cache, compression, verification escalation, eval harness, soak harness, audit script, dashboard, onboarding, migration.

## 0.1.0 — 2026-11-13

The first commit: a plan, a spec, and a promise that every claim would have a test.
