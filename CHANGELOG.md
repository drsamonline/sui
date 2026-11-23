# Changelog

Every entry names what shipped and what it costs you to adopt. Nothing is listed here that a command does not prove.

## 0.12.43 — 2026-11-23

### Added

- **A provider's durable probe history, drawn in its detail row.** The snapshot above it is what this *process* has seen and dies with the process; `/api/history` is what the worker wrote to disk, so it is the only part that survives a restart. One bar per bucket, height by p50 latency, colour by whether the bucket was clean, with the sample count and uptime beside it.
- `GET /api/providers` carries `poolKey`, because the prober files its history under the pool key rather than the provider name — without it the page could list a provider and never find its samples.

### Fixed

- The smoke test clicked "the first provider" and would have broken the moment the catalogue order changed; it now names the provider it seeded history for.

### Known gaps

- History is drawn, not zoomed: 24 buckets over 24 hours is what `/api/history` defaults to, and there is no control to change the window. The endpoint takes `hours` and `buckets`; the page does not offer them yet.
- A probe against a network that blackholes DNS still holds the process open for ~20 s after the answer arrives (0.12.42's gap, unchanged).
- No eval baseline is recorded at this version.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 638 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `npm run smoke:dashboard` | four scenarios; the seeded history is required to appear in the detail row |
| `node scripts/verify-published.mjs` | installs the published tarball and runs the flow |

## 0.12.42 — 2026-11-23

### Added

- **One endpoint can be probed from the Providers card** — the last network action that was terminal-only. It needed a consent design rather than a button, and it has two conditions: `dashboard.allowProbe` must be `true` (off by default, in the schema and the template), and off the loopback interface the admin token is required, the same rule cap writes follow.
- One provider per request, never a sweep: forty endpoints at once is a sweep, and a sweep belongs on the command line where its cost is visible.
- **A probe from the page reports; it does not promote.** `promoted: false` is in the response and the page says so next to the button. Promotion stays `sui probe --write`, because making an entry routable is the step that deserves a deliberate command.
- The detail row states the address a click would contact, so the consent is about a named host rather than "the internet".

### Fixed

- `config/sui.schema.json` had `additionalProperties: false` and no `dashboard` section, so the new key would have been an editor error in every config that used it. It is in the schema now, with the rest of the template's keys.
- The smoke test asserted nothing about the probe control, so a page that offered it with the flag off would have passed. Both directions are checked now: present in `--tenants` (flag on), absent with an explanation everywhere else.

### Known gaps

- A probe against a network that blackholes DNS still holds the process open for ~20 s after the answer arrives. The answer is on time; the exit is not. Cancelling `getaddrinfo` is not something Node offers, and the fix is to stop using `fetch` for probing, which is its own release.
- The probe control cannot be exercised end to end in CI: it needs provider egress, which CI does not have. The refusal paths and the request path are tested; the "a provider answered" path is not.
- No eval baseline is recorded at this version.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 637 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `npm run smoke:dashboard` | four scenarios; the probe control is asserted present and absent in the right places |
| `node scripts/verify-published.mjs` | installs the published tarball and runs the flow |

## 0.12.41 — 2026-11-23

### Added

- **The catalogue, on the dashboard.** `sui catalog` was the only way to see the forty-odd identities this gateway could route to, so the product's central distinction — an identity is not a route — was invisible to anyone who only opened the page. `GET /api/providers` joins the seed (what was imported), the overlay `sui probe --write` leaves (what a probe observed *here*) and the prober's snapshot (what this process has seen), and the page renders it with a detail row per provider that says which of the three it is and what would change it.
- The tenant panel edits the rate as well as the cap, so both refusals the API enforces (`429 rate_limited`, `429 key_budget_reached`) are reachable from the page.

### Fixed

- **The background prober never ran from an install.** `loadProbeTargets` looked in `packages/catalog` relative to the working directory and then three levels above its own file — neither exists once the gateway is inside `node_modules`. It found zero entries, so the worker that is supposed to keep routes verified quietly did nothing, while `sui probe` worked because the CLI resolves the package. It asks `@drsamonline/catalog` first now, which is the only path that exists in both places.
- **Two implementations of the verified-overlay parser.** The CLI had one and the new provider route needed another; it lives in `@drsamonline/catalog` now and both call it, because a second copy is a second place for the same bug.
- The provider detail row used a raw hex colour, which I9 forbids outside the token block. The test caught it.

### Known gaps

- The providers list is read-only. Probing from the page would be a network action against forty endpoints on the operator's behalf, and that belongs behind an explicit command.
- `probe.history` is what this process has seen since it started (up to 24 samples). Durable history is in `history.jsonl` and reaches the page through `/api/history`.
- No eval baseline is recorded at this version.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 633 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `npm run smoke:dashboard` | four scenarios; the providers card and the cap control are both exercised |
| `node scripts/verify-published.mjs` | installs the published tarball and runs the flow |

## 0.12.40 — 2026-11-23

### Added

- **A cap can be changed from the tenant panel**, which is the one write on the dashboard. It is a form, not a stepper: it states the current cap, takes the new one by hand, and says afterwards that the change is **in memory for this process** with the config file named — a cap that silently reverts on restart is worse than no control.
- A refresh no longer wipes the form. The panel reloads every 15 seconds, and a half-typed cap used to vanish mid-keystroke.

### Fixed

- **A cap could be raised by anyone who could reach a gateway bound to the network.** With no `SUI_ADMIN_TOKEN`, every tenant route was open, so on a `0.0.0.0` bind any caller could PATCH their own limit — the code's own comment says a console that can raise a cap is a console that can spend your money. Writes now need the admin token unless the gateway is bound to loopback. Reading the console stays open: it holds spend, limits and names, never prompt text or a key.
- Two tests in `test/tenants.test.js` left a listener open when an assertion threw, so the file hung until the runner killed it and a real failure read as a timeout.

### Known gaps

- The panel edits the daily cap only. `rpm` is accepted by the API and is not on the page: it throttles rather than spends, and the rarer action did not earn a second input.
- The change is in memory. Writing it back to `sui.config.json` would mean the dashboard editing its own config, which is a bigger decision than a cap.
- No eval baseline is recorded at this version.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 633 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `npm run smoke:dashboard` | four scenarios, and the cap control is clicked through in `--tenants` |
| `node scripts/verify-published.mjs` | installs the published tarball and runs the flow |

## 0.12.39 — 2026-11-23

### Added

- **The tenant console, on the dashboard.** A key is a tenant, and four things are enforced per key: a daily cap, a requests-per-minute limit, a pinned model (`forcedModel`) and the combos it may reach. The page showed the spend and none of the other three, so the two that decide whether a request is *refused* — the pin and the rate — were only readable in the config file. A gateway that refuses a request must be able to say why, on the page.
- The panel names the cause of each refusal next to the number that causes it: `403 forced_model` is the pinned column, `403 forbidden_model` is "may reach", `429 rate_limited` is the rate, `429 key_budget_reached` is the cap.
- `sui tenants` gains a `pinned to` column, and `reaches` now falls back to `allowedModels` when no combos are named.
- A fourth dashboard smoke scenario, `--tenants`, runs a keyed gateway: the page carries the key, the panel must show both tenants, the pin and the rate, and Send must still answer. It runs in CI.

### Fixed

- **`tenantSnapshot` did not include `forcedModel`**, so no consumer — CLI, API or page — could show the pin. The API enforced it with a 403 and the console had no way to mention it.
- The smoke test's "does the page explain a failure" assertion treated any non-`healthy` scenario as failing, which the new keyed-but-working scenario is not. The two failing scenarios are named explicitly now.

### Known gaps

- The panel reads `/api/tenants`, which needs `SUI_ADMIN_TOKEN` when one is configured; without the token it says so rather than rendering empty.
- `PATCH /api/tenants/<name>` is still curl-only. A control on the page would be a write that can raise a cap, and that needs its own confirmation design.
- No eval baseline is recorded at this version.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 630 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `npm run smoke:dashboard` | four scenarios: healthy, empty, degraded, tenants |
| `node scripts/verify-published.mjs` | installs the published tarball and runs the flow |

## 0.12.38 — 2026-11-23

### Added

- **`--json` on every command that reports data.** It was on three, in three different styles, and absent from eleven — so "scriptable" was true of whichever command you happened to try. Now `invariants`, `kits`, `tokens`, `budget`, `tools`, `recipe list|show|apply`, `local`, and `vault status|list` join `probe`, `eval`, `doctor`, `catalog`, `free-budget`, `cost`, `savings`, `models` and `lang`.
- **The contract is one line, and it is tested as a contract**: stdout parses as exactly one JSON document, diagnostics go to stderr, and the exit code is the one the human path would have used. `test/cli-json.test.js` runs twelve commands and asserts it, and asserts the tables are still printed when the flag is absent.
- Each document is documented field by field in `docs/API.md`, because the shapes differ on purpose: a `probe` document and a `vault` document answer different questions.

### Fixed

- `sui local --json` and `sui vault status --json` were impossible: `local` printed its scan and returned, and `vault` printed a status block. Both are documents now — and `vault` reports the passphrase *source* and the provider names, never a key.
- `sui recipe apply --json` reports `written: false` on a dry run, so a script can tell "nothing to do" from "changed the file" without reading prose.

### Known gaps

- `sui config get` still prints a bare value rather than a document. `config show` prints JSON without a flag, because the config is the document.
- `sui init`, `start`, `mcp` and `tools --set` stay human: they are interactive or long-running, and a document from them would describe a process, not a result.
- No eval baseline is recorded at this version; that still needs one working provider key.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 627 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `node scripts/verify-published.mjs` | installs the published tarball: 12 checks, including `sui eval --self-test`, `doctor --json` and `kits --json` |

## 0.12.37 — 2026-11-23

### Added

- **`sui eval` — answer quality, measurable from the artefact a user installs.** The harness existed only as `evals/run.mjs` in the repository, so the one claim this product makes about its own answers could not be checked by anyone who installed it. The engine, the 50-prompt golden set and the self-test fixtures now ship inside `@drsamonline/cli`; `npm run eval` runs the same code, so there is no second copy to drift. `--self-test` proves the graders grade with no model, no network and no config; `--combo`, `--limit`, `--update-baseline`, `--report` and `--json` do the rest.
- **A run where nothing answered exits 2 and reports no pass rate.** The header always said that; the code did not do it. Every request failing produced `pass rate 0%` and exit 0 — a number that measures the network, printed as if it measured a model. The report is now `mode: "not-meaningful"` with `passRate: null`, the dashboard shows the reason instead of a percentage, and the exit code is 2.
- **`sui doctor --json`.** The health check printed a table and nothing else, so nothing could be scripted against it. Stdout is now the document — node, config path, keys by length and state (never by value), every combo with its result, kits, vault, the invariants it checked, and `warnings`. Exit 1 when a config exists and no combo answered.
- **`sui probe --concurrency N`.** A sweep is bounded at 8 by default instead of firing all 41 at once: 41 simultaneous handshakes from one IP is what a free tier answers with 429, and a 429 was being recorded as "not suitable", so a working provider was demoted for being asked too eagerly.

### Fixed

- **A probe against a network that drops packets never finished.** `AbortSignal.timeout` does not interrupt a DNS lookup, so every level's `timed()` waited on a fetch that never settled: measured here, `sui probe --timeout 2000` produced no output for more than five minutes. Each level now has a hard deadline of its own, and 41 blackholed endpoints report in seconds.
- **`--concurrency -1` was read as a bare flag**, which quietly became `1` and ran the whole sweep one entry at a time. A flag that takes a number refuses to be a boolean.
- **The dashboard's eval card showed `0%` for a run that measured nothing**, because `passRate ?? 0` turns "no rate" into the worst possible rate.
- **`/api/evals` only read the checkout's copy**, so an installed gateway said "no eval has been run here yet" however many times you ran one. It reads `SUI_EVAL_REPORT`, then the Sui home, then the repository copy.
- **The dashboard smoke test could never pass its two failing scenarios.** In `empty` and `degraded` the gateway is configured to fail, the test clicks Send, and the resulting 5xx was counted as a page problem — so the only scenarios that check "does the page say what broke" were red for their own correct behaviour. A 5xx on the chat endpoint is now tolerated in exactly those two scenarios, and the test additionally requires the page to *explain* it, so the tolerance cannot hide a silent failure.
- **`ci.yml` would not parse.** A step name began with a backtick, which cannot start a YAML plain scalar: GitHub reported "this run likely failed because of a workflow file issue" and no step ran. A test now rejects a `name:` beginning with any character YAML reserves.
- **The publisher refused this release.** Its guard against shipping test fixtures caught `evals/fixtures/self-test.json`, which is product data — `sui eval --self-test` grades those answers. The exception is one exact path, subtracted from the pattern, with a test pinning it.

### Known gaps

- No eval baseline is recorded at this version, because that needs one working provider key and provider egress.
- The 1 verified route is still Groq, verified on the owner's Windows machine — CI has no provider egress, so the suite proves the harness, not the route.
- `sui eval` against a blackholed network still takes ~20 s to exit after printing: the pending DNS lookups hold the process open, and Node cannot cancel `getaddrinfo`. The results are complete before that wait.
- `--json` is a consistent contract on `probe`, `eval` and `doctor`; `catalog`, `free-budget` and `cost` predate it and differ in shape.

### Verified at this version

| Gate | Result |
|---|---|
| `npm test` | 623 tests, no network, no keys |
| `npm run audit` | 8/8 static checks |
| `npm run adr:check` | 10/10 decisions honoured |
| `node scripts/verify-published.mjs` | installs the published tarball and runs `sui eval --self-test`, `sui doctor --json`, the catalogue, the dashboard and a stream |

## 0.12.36 — 2026-11-23

### Fixed

- **The probe called a working provider an "empty completion".** Groq's `gpt-oss` answered the readiness probe with its thinking in `reasoning` and an empty `content`, and the probe read only `content` — the same bug fixed in the adapter in 0.12.32, still present in the prober. A provider that answers perfectly through the gateway was recorded unusable, so `sui probe --write` promoted nothing.
- The probe's readiness fixture asked for **8 tokens**. A reasoning model spends them thinking and returns nothing. It asks for 256, the same as the adapter.

The lesson is the one this project keeps relearning: a second implementation of the same parsing is a second place for the same bug.

## 0.12.35 — 2026-11-23

### Fixed

- **A working provider was recorded as unsuitable, so no route was ever promoted.** Groq answered readiness (`ready: yes`) and then all three suitability checks returned HTTP 404 — they asked for `modelFor(entry)`, a family name like `openai-compatible`, instead of the model that had just proved it works. Every later check uses the proven model now, which is the difference between `0 routable` and a route with a real provider behind it.
- `doctor` asks for 256 tokens rather than 64: a reasoning model spends them thinking before it emits anything, and at 64 the "reply" was the model's own thinking.

## 0.12.34 — 2026-11-21

### Fixed

- **The Send button on the dashboard did nothing.** `send()` threw `ReferenceError: threadEl is not defined` on its first line — the variable is called `thread` — so every click died before sending a request. The answer appears in the conversation thread above the box, which is why there was nowhere to look.
- **A click with an empty box said nothing.** It now says "Type a message first — then Send."
- **Every combo could render as `disabled`**, which leaves a select that cannot be used and a page that looks broken. An unavailable combo is labelled "— nothing available yet" and remains clickable; the gateway answers with the reason.
- **The probe picked a text-to-speech model.** Groq's `/models` lists `canopylabs/orpheus-arabic-saudi` first, so the chat probe asked for a TTS voice and reported "that model does not exist" — for a model that exists and is simply not a chat model. `pickChatModel` (shared by the adapter and the prober) skips embeddings, audio, guard and image models.
- `doctor` now says when a combo names a provider whose key has been removed since the config was written, and gives the one command that rewrites it.

### Added

- The dashboard smoke test **clicks Send** — with an empty box and with a prompt — and fails if nothing appears. Nothing in it clicked the button before, which is why a dead button shipped.

## 0.12.33 — 2026-11-21

### Fixed

- The audit's dead-module check counted the vendored kit copies inside `@drsamonline/kits` as unreachable, because they are loaded by name at runtime (`kits.load('crypto-kit')`) and never imported. It excludes `/vendor/kits/` now. The 0.12.32 publish stopped there.

## 0.12.32 — 2026-11-21

### Fixed

- **A reasoning model that answered was reported as an empty turn.** Groq's `gpt-oss` models put their thinking in `reasoning` and leave `content` empty when the token budget runs out; the adapter read only `content`, so a real answer looked like a blank one and the router retried and then failed the combo. The adapter falls back to the reasoning text.
- **`doctor` asked for 16 tokens.** A reasoning model spends 16 tokens thinking and returns nothing, so the health check failed every reasoning model on the market. It asks for 64.
- **None of the seven vendored kits loaded from an install.** They were read from `vendor/kits` at the repository root, so `sui doctor` reported `0/7 loaded — broken: crypto-kit, ml-kit, …` for every user who installed the package. They travel inside `@drsamonline/kits` now, and a test fails if the shipped copy drifts.

## 0.12.31 — 2026-11-21

### Fixed

- **A key with a trailing space, a wrapping quote or a leading `Bearer` was sent as-is**, so the provider answered 401 and the user was told their brand-new key had been rejected. `sanitiseKey` strips all of it before the header is built — the most common way a correct key fails on Windows.
- **`sui doctor` shows what it can see about each key without printing it**: which variable, how many characters, and whether it needed cleaning. "Rejected the API key" is true and useless when the key is fine and the whitespace is not; this is the line that tells the two apart.

`redteam`'s tarball also took longer than the new wait once more, so the publish step's post-check is advisory only (0.12.28) and the tarball wait is 20 × 20 s (0.12.30).

## 0.12.30 — 2026-11-21

### Fixed

- **The tarball wait was too short for one package.** `redteam`'s tarball has twice taken over three minutes to appear, and `cli` depends on it — which is how `npm install -g` failed for the first person to try. The wait is 20 × 20 s now.
- `docs/WINDOWS.md` names that failure in its troubleshooting table, because it looks like a broken setup and is not: npm lists a version a few minutes before its tarball is downloadable.

## 0.12.29 — 2026-11-21

### Fixed

- **The seed named two models Groq shut down on 16 August 2026.** `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` were retired; every first run answered "Groq says that model does not exist". They are `openai/gpt-oss-120b` and `openai/gpt-oss-20b` now, per Groq's own deprecation notice.
- **A retired model id is recovered instead of failing.** When a provider answers 404, the adapter asks that provider's `/models` endpoint, picks a chat model, retries once, and reports what it switched to (`modelSwitchedFrom`). A hardcoded model id in a config file cannot keep up with a provider's deprecation schedule; the provider can.
- **A rejected key now says what to do** — which page to copy the key from, and that unsetting it is a valid option — instead of only that it was rejected.
- **`${runAs()} init` printed literally** in the failure message, because the string was not a template literal.

### Note

The Groq failure was ours. The Gemini failure is not: the key is sent correctly (`x-goog-api-key`, a valid model id), so a 401 from Google means the key itself was rejected — expired, restricted, or from a different product.

## 0.12.28 — 2026-11-21

### Fixed

- **The post-publish check failed a release for the fourth time while npm served it.** `core@0.12.27` was live and the job reported "staged as 0.0.0-stage, needs approval". The check now stops inferring: it asks for the exact version, reports an unindexed one as lag, and never fails the run. A publish npm actually rejected has already failed the step above in npm's own words, and `verify-published.mjs` installs the package for real right after — that is the authority.

Four releases were marked failed by this line while users could install them. A check that cannot distinguish "not yet" from "never" is worse than no check.

## 0.12.27 — 2026-11-21

### Fixed

- **The published-package check called a release broken during npm's processing window.** It fetched every tarball once, immediately after publishing, and `redteam@0.12.26` was still a 404 a few seconds later — the same gap that made `npm install -g` fail for the first person to try. It now waits for the registry instead of failing on it: a 404 is retried for a few minutes, and only a tarball that never arrives fails the run.

## 0.12.26 — 2026-11-21

### Fixed

- **Your provider keys were found and then ignored.** `sui init` printed `found GROQ_API_KEY`, then `No provider keys are set, so I am wiring a demo provider` — because the first-run template was read from a repository-relative path, so from an install the provider list was empty and every key the user had was discarded. The template ships with the CLI now and is resolved from either place.
- **A crash message pointed at `github.com/your-org/sui`** — a placeholder, so the person who just hit a bug was sent to a 404. It names the real issue tracker, and a test fails if a placeholder URL ships again.
- `fs.existsSync` is called with a coerced argument where a caller could pass a non-string, which is a deprecation (DEP0187) on Node 22+.

This is the fifth bug of the same shape — a file that resolves inside this repository and not from a tarball. The verifier covers four of them now; the template is the fifth.

## 0.12.25 — 2026-11-21

### Fixed

- **`sui doctor` refused to run without a config.** It is the health check and the most natural first command; answering "No sui config found" and nothing else turned it into a dead end. It now reports what it can see — node version, whether a key is present in this window, how many catalogue entries exist, and where a config *would* live — then names `init` as the command that creates one.
- The docs told people to run `doctor` before anything had written a config: `docs/WINDOWS.md` and `docs/MIGRATION.md` now lead with `init`, because `doctor` needs a config to test.

A test runs `doctor` in an empty directory and fails if it goes back to refusing.

## 0.12.24 — 2026-11-21

### Fixed

- **`sui catalog` reported zero entries from an npm install.** The CLI read the catalogue from a repository-relative path, so everyone who installed the package saw an empty table — and `sui probe --write`, the command that turns catalogue entries into routes, had nothing to probe. The catalogue now ships inside `@drsamonline/catalog` and the CLI resolves it from either place.
- `verify-published.mjs` checks it: an install that reports zero entries fails the run.

This is the fourth bug of the same shape — a path, a version, a command or a data file that resolves inside this repository and not from a tarball — and the only one that would have made the documented first-run steps do nothing.

## 0.12.23 — 2026-11-19

Audit pass. Five metadata gaps across 19 packages, one of them a licence violation.

### Fixed

- **No package shipped a LICENSE file.** Every manifest said `"license": "MIT"` and no tarball carried the text — and MIT requires the notice to travel with every copy. Each package has the file now, and `files` includes it.
- **No package declared `engines`**, so npm could not warn a Node 18 user about a gateway that needs 20.
- **No package had keywords**, so npm search found none of them.
- **No package had an issues link**, so its npm page offered no way to report a bug.
- **npm was cleaning the `bin` path on every publish** (`bin[sui] script name was cleaned`).
- Stale numbers: the README and the landing page said 572 tests when there were 583; `docs/PUBLISHING.md` still showed `v0.12.0` in its example, which would have failed the version check it documents.

A test now fails if any published package loses its `engines`, its keywords, its issues link, its LICENSE, or puts `./` in a bin path.

### Changed

- `ROADMAP.md` rewritten as a plan rather than a status board: quick wins first, then medium, then the decisions, and the human steps last. A test fails if the order drifts or the roadmap stops saying what is unproven.

## 0.12.22 — 2026-11-19

### Fixed

- **A body over 20 MB reset the connection instead of answering.** The caller saw `ECONNRESET` and never read the 413 that said why. The request is paused now, the response is sent, and the socket closes with it.
- **"not a combo or model this gateway knows" did not say what it does know.** The 404 now lists the combos and models that exist, because a dead end with no map is not an error message.

### Added

- **A malformed-input suite** (`test/robustness.test.js`): truncated JSON, an empty body, an unknown model, an oversized body, a prompt in three scripts and an emoji, a caller-supplied header full of markup, twenty concurrent requests, an unserved method, an unknown path, and a forged Host. The contract for all of them is the same — an answer, never a crash, never a stack trace, never a hang.
- **Streaming is verified from the published tarball**: `verify-published.mjs` asks for `stream: true` the way a coding tool does and asserts `text/event-stream`, `data:` frames and the `[DONE]` terminator. It is the feature every client depends on and it had never been checked outside the repository.

## 0.12.21 — 2026-11-19

### Fixed

- **Every npm user got a broken dashboard.** `GET /` answered 200 with `<h1>Dashboard file missing</h1><p>Reinstall the package.</p>` — the gateway read the page from a path that only resolves inside this repository, so reinstalling never helped. The gateway now ships its own copy, generated from the single source by `scripts/bundle-dashboard.mjs`, and a test fails if the copy drifts.
- **`sui start --port 0` printed port 0** instead of the port the OS assigned, sending the user to a URL that cannot work.

### Added

- **`scripts/verify-published.mjs`** — installs the published tarball into an empty directory and uses it the way the README says to: version, help, a real round-trip, a language, the dashboard page, and every package present at that version. CI runs it after publishing, because every other check tests the working tree and a user installs a tarball.

It found the dashboard bug on its first run.

## 0.12.20 — 2026-11-19

### Added

- **Twelve more catalogue endpoints**, every one with its source recorded: Z.ai (GLM Flash, listed free permanently), IBM watsonx Lite (300k tokens/month), Baseten, Nebius Token Factory, Novita, AI21, Alibaba Model Studio (intl), Vercel AI Gateway, Jina, Arli AI, Clarifai, Typhoon. 29 → 41.
- A new ledger entry for the source — a site read on a date rather than a repository, so the date is the pin and the licence line says only facts were taken.

### Changed

- The source ledger now accepts a dated source. A repository is pinned by a commit; a page read on a date has no commit, and pretending otherwise would mean either dropping the source or inventing a pin.

### Honest about what this is

All 41 entries remain `needs_probe`. A base URL from a third party is a candidate, not a route — `sui probe --write` is still what turns one into the other, and `sui free-budget` still reports **0 verified** until it does.

## 0.12.19 — 2026-11-19

### Fixed

- The audit flagged `RTL` as an export nothing imports, which is exactly right: `direction()` is the public way to ask, and the set is an implementation detail. The 0.12.18 publish stopped at the audit step because of it.

## 0.12.18 — 2026-11-19

### Added

- **Hindi, Gujarati, Marathi, Tamil and Telugu** for the strings a person actually meets: the CLI tagline and help header, the first-run messages, the errors a beginner hits, and the dashboard's four headline labels plus its attention sentence. `SUI_LANG=hi` or `"locale": "hi"`; `sui lang` lists what the build ships.
- Anything unlisted falls back to English rather than failing — a typo in a language code must not stop a gateway from starting.
- `direction()` is independent of the string table: Urdu reads right-to-left even on a build that has no Urdu strings, so a browser is never told the page is LTR when it is not.

### Deliberate limits, documented and tested

- The numeric foot lines and the detail tables stay English: they are numbers and identifiers (`x-sui-cost-usd`, `fallback`, `demo-b`), and a translated identifier is harder to read than an English one.
- `docs/LANGUAGES.md` states that boundary, and a test fails if the page stops stating it.
- Every language translates exactly the same key set with the same placeholders; a test fails if either drifts.

## 0.12.17 — 2026-11-19

### Fixed

- **npm's transparency log rejected a duplicate attestation and stopped the run.** `TLOG_CREATE_ENTRY_ERROR (409) an equivalent entry already exists` — which happens when the same commit is published twice. The publisher now asks whether the version is already live (nothing to do), retries once if the log wants a second attempt, and only then fails. The 0.12.16 release stopped at `router`; `core` and `gateway` had already gone out.

## 0.12.16 — 2026-11-19

### Added

- **`auto`** — a combo you do not have to write. The cheapest combo that clears the floor answers a simple prompt; the highest-quality combo answers a complex one, using the classifier that was already deciding cheap-versus-strong for every request. It is built from combos you already have, listed first in `/v1/models`, and narrated by `sui explain`. A combo you name `auto` yourself replaces it, so nothing is taken away.

## 0.12.15 — 2026-11-19

### Added

- **An editable architecture diagram.** `docs/diagrams/sui-architecture.excalidraw` opens at [excalidraw.com](https://excalidraw.com) and stays editable: 47 elements, every arrow bound at both ends, every label at `fontFamily: 5`, no two boxes overlapping. Generated by `scripts/diagram.mjs`, and a test fails if the committed scene stops being valid — a diagram that fails those checks is a picture that happens to be JSON.
- The two annotations carry the design: *the prober feeds the catalogue; the catalogue feeds the router*, and *the gate is a branch in the startup path, not a flag*.

## 0.12.14 — 2026-11-19

### Fixed

- **The publish check reported a live package as staged, for the third time.** It parsed the version list; the index lags and a list read mid-update can show the `0.0.0-stage` placeholder without the version that is actually live. It asks the registry for the exact version now (`npm view <name>@<version> version`) and only asks why if that fails. The 0.12.13 publish was complete while the job reported failure.

## 0.12.13 — 2026-11-19

### Added

- **The dashboard leads with what needs attention.** Four numbers above every detail card — turns today, spent today, verified routes, p95 — and one sentence that names the worst thing first: disabled providers, resting routes, budget over 80%, or nothing verified yet. The detail below is unchanged; it is now the second thing you read, not the first.

### Fixed

- **The SSRF guard disabled every local model server.** Ollama and LM Studio live on `127.0.0.1`; the guard refused loopback for all entries, so a probe sweep marked them down. A catalogue entry marked `local: true` may now be probed on loopback — a remote entry claiming `127.0.0.1` is still refused.
- `--warn` and `--bad` are tokens now, measured rather than asserted: 5.9:1 and 7.4:1 on the surface, 8.7:1 and 7.6:1 in dark.

## 0.12.12 — 2026-11-19

### Added

- **`sui free-budget`** — free headroom per month, in two columns that are never added together: what a probe reached, and what is only a published claim. A pool is counted once however many names point at it, and an entry with no published budget is counted as missing rather than assumed. `--json` emits the same split.
- Catalogue entries can carry `monthly_tokens` and `budget_source`; a test fails if a budget has no source.
- Three seeded budgets (Mistral 1B, LLM7 150M, Groq 30M) carry the source they came from — OmniRoute's catalogue, MIT — and sit in the unverified column until a probe reaches them.

The verified total on a fresh machine is **zero**, and the command says so with the reason and the command that fixes it. That is the point: a headline that mixes claims with measurements is a marketing number.

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
