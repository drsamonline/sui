# Handoff

Everything needed to pick this up cold. Last updated 2026-11-23 at `0.12.45`.

## What this is

Sui — a verification-first, privacy-aware gateway for LLM providers, MIT licensed, zero runtime dependencies. One OpenAI-compatible endpoint in front of many providers, where **a route exists only after a probe proved it answers**. The alternative it is measured against is 9router / OmniRoute, which optimises for breadth and savings; this optimises for being able to prove what it did.

- Repo: https://github.com/drsamonline/sui
- Landing: https://drsamonline.github.io/sui/ (GitHub Pages only — Netlify was refused)
- npm: https://www.npmjs.com/package/@drsamonline/cli

## State, verified

| | |
|---|---|
| Version | `0.12.45`, 20 packages under `@drsamonline/*`, all published |
| Tests | 643, no network, no keys |
| Audit | 8/8 static checks |
| ADR | 10/10 compliant |
| CI | **green on every job** (test 20, test 22, eval, soak, dashboard, migration) at `fe67660` |
| Catalogue | 41 entries, each with a recorded source |
| Verified routes | **1** — Groq, on the owner's machine (0 from CI: no provider egress) |
| Tarball | `node scripts/verify-published.mjs` green at `0.12.38`: 12 checks, including `sui eval --self-test` (56/56), `doctor --json` and `kits --json` from an install |
| Tarball | `node scripts/verify-published.mjs` green at `0.12.38`: 12 checks, including `sui eval --self-test` (56/56), `doctor --json` and `kits --json` from an install |
| Languages | en, hi, gu, mr, ta, te |
| Answer quality | measurable from the tarball: `sui eval --self-test` (56 grader checks), `sui eval` for a real combo |
| Last commit | `fe67660` (`v0.12.37` tag at `edf8bf8`; the only later change is the smoke script, which ships in no package) |

Proof it works end to end, from the owner's Windows machine:

```
sui init      → answered by groq-70b (groq) in 2455 ms
sui doctor    → chat-default ok · cheap ok · coding ok
sui probe --write → groq verified
dashboard     → "Hello! How can I assist you today?" 1468 ms · $0.00007 · verified
```

## Commands that must pass before anything ships

```bash
npm install            # after every pod restart
npm test               # 643 tests
npm run audit          # 8 static checks
npm run adr:check      # 10 ADRs
npm run smoke:dashboard  # needs CHROME_PATH + PUPPETEER_PATH
node scripts/verify-published.mjs   # installs the real tarball and runs the flow
```

Release: bump every `package.json`, add a CHANGELOG entry, commit, then create the tag through the API (the App cannot push tags):

```bash
git push origin main
sha=$(git rev-parse HEAD)
gh api repos/drsamonline/sui/git/refs -X POST -f ref="refs/tags/vX.Y.Z" -f sha="$sha" --jq '.ref'
```

The tag triggers `.github/workflows/publish.yml`: bundle → tests → audit → publish → verify the published tarball.

## The one rule this project keeps relearning

**A file that resolves in this repository does not necessarily exist in a tarball.** Nine bugs of exactly this shape reached the user before it was caught:

| Missing from the tarball | Symptom |
|---|---|
| `packages/catalog/seed.json` | `sui catalog` showed 0 entries, `probe` had nothing to probe |
| `apps/dashboard/web/dashboard.html` | `GET /` served "Dashboard file missing" |
| `config/sui.config.json` | first run found the user's key and then ignored it, wiring a demo provider |
| `vendor/kits/*` | `Vendor kits: 0/7 loaded` |
| `apps/cli/evals/*` | `sui eval` was not a command at all; the harness lived only in the repo |

`scripts/bundle-dashboard.mjs` copies all of them into their packages, `scripts/verify-published.mjs` installs the real tarball and uses it the way the README says to, and tests fail if a shipped copy drifts from its source. **Any new data file a command reads must be added to a package's `files` and resolved from either location.**

The eval harness is the worked example: the engine, `golden.jsonl` and `fixtures/self-test.json` live in `apps/cli/evals/`, the CLI package's `files` names `evals`, `evalPaths()` resolves them relative to the engine (so the same path in a checkout and in a tarball), and three things check it — a test asserting there is no second copy in the repo, a test that runs `npm pack --dry-run` and looks for the files, and a `verify-published` check that runs `sui eval --self-test` from the installed tarball.

## Bugs found by running, not reading

Do not reintroduce any of these. Each has a test.

| Bug | Cause |
|---|---|
| `sui catalog` 0 entries from an install | repo-relative path |
| dashboard 404s the page | repo-relative path |
| keys found then ignored | repo-relative path to the config template |
| kits 0/7 | repo-relative path |
| dashboard Send did nothing | `send()` threw `ReferenceError: threadEl` — the variable is `thread` |
| reasoning models read as "empty turn" | `content` is empty, the answer is in `reasoning` — fixed in the adapter **and** the prober (twice) |
| `doctor` failed every reasoning model | asked for 16 tokens |
| probe picked a TTS voice | took `/models[0]`, which was `canopylabs/orpheus-arabic-saudi` |
| probe marked a working provider unsuitable | suitability asked for `modelFor(entry)` (a family name) not the proven model |
| Groq model ids retired | `llama-3.3-70b-versatile` shut down 16 Aug 2026 → `openai/gpt-oss-120b` |
| a key with a trailing space was sent as-is | `sanitiseKey` strips spaces, quotes and a `Bearer` prefix |
| publish check failed live releases 4× | it inferred "staged" from a lagging list; it is advisory now |
| `${runAs()} init` printed literally | missing backtick |
| crash message pointed at `github.com/your-org/sui` | placeholder URL |
| no package shipped a LICENSE file | MIT requires the notice in every copy |
| `--port 0` printed `0` | the bound port was thrown away |
| a cap could be raised by anyone on the network | tenant writes were open when no admin token was set, on any bind |
| a provider could execute script in the dashboard | `probeModel` came from the provider's `/models` and was interpolated unescaped |
| one click could hold a socket for an hour | `/api/providers/probe` passed the caller's `timeoutMs` straight through |
| the background prober never ran from an install | the catalogue was resolved relative to the checkout, so it found zero entries inside `node_modules` |
| an eval run where nothing answered reported `0%` and exit 0 | the exit-2 contract was in the header comment, never in the code — 0/50 there measures the network |
| `sui probe` never finished on a network that drops packets | `AbortSignal.timeout` does not interrupt a DNS lookup, so `timed()` waited on a fetch that never settled; each level now has its own hard deadline |
| `--concurrency -1` ran the sweep one entry at a time | a value starting with `-` is parsed as a bare flag, and `Number(true)` is 1 |
| the dashboard showed `0%` for a run that measured nothing | `passRate ?? 0` turns "no rate" into the worst rate |
| `/api/evals` said "no eval has been run here" after one was | it read only the checkout's copy, not the user's home |

## Sandbox facts

| | |
|---|---|
| Node | 20.20.2 here; CI covers 22 |
| Provider egress | **blocked** — a probe from here always writes 0 |
| DNS here | blackholed, not refused: a lookup hangs ~20 s, and Node cannot cancel `getaddrinfo`, so a probe process prints its results and then takes ~20 s to exit. Results are complete before that. |
| `github.io` from bash | blocked; `web_get_contents` works |
| `fetch` to loopback | aborts instantly — use `node:http` |
| `fetch` through the proxy | ignores `HTTPS_PROXY` — use `curl` |
| `npm install` | must be re-run after every pod restart |
| Chrome | `CHROME_PATH=/usr/local/bin/chromium`, `PUPPETEER_PATH=/usr/lib/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js` |
| npm staging | the first release of a new package is held for 2FA approval |
| npm index lag | up to ~3 min for a tarball after its version is listed |

## What is left

### Can be done alone, in this order

| # | Item | Why |
|---|---|---|
| 1 | A `CHANGELOG` entry generated from commit subjects | the changelog is hand-written and has been wrong once; only the "what shipped" half is generatable |
| 3 | More catalogue providers | 41 → hundreds needs LLM-specific sources; the vendored `app-endpoints` set is public-apis (2,214 general APIs), not providers, so it cannot be grown offline |
| 4 | A `CHANGELOG` entry generated from commit subjects | the changelog is hand-written and has been wrong once |
| 5 | `--json` on the last four narrating commands | `init`, `mcp`, `tools --set`, `config get` — each describes a process, so each needs a shape decided first |

### Needs the owner

| # | Item | Command |
|---|---|---|
| 1 | Point an editor at it | `sui tools --set continue` |
| 2 | Cap spending | `budgets.dailyUsd` in the config |
| 3 | A second free key for redundancy | Cerebras or Mistral, then `sui probe --write` |
| 4 | 72-hour soak | `sui soak --minutes 4320 --rps 20` |

### Deliberately not built

| Refused | Reason |
|---|---|
| MITM/TPROXY capture | intercepting TLS contradicts the privacy posture |
| A headline token number | cannot be verified from the user's machine |
| Credential masking on by default | changes what the model sees |
| A quality score without an eval run | the harness self-test is labelled as one |
| More languages | 6 is what was checked; 67 would be a claim this project cannot verify |

### Closed

- **`sui eval` as a command** (0.12.37), **probe concurrency** (0.12.37), **`doctor --json`** (0.12.37)
- **One `--json` contract everywhere** (0.12.38) — sixteen commands, enforced by `test/cli-json.test.js`
- **Tenant console shows the pin and the rate** (0.12.39) — plus a fourth smoke scenario that runs a keyed gateway
- **A cap control on the tenant panel** (0.12.40) — a form, in-memory, and writes off loopback need the admin token
- **The catalogue on the dashboard** (0.12.41) — `GET /api/providers`, and the install bug that kept the prober from running
- **A probe from the page** (0.12.42) — `dashboard.allowProbe`, one endpoint per request, reports but never promotes
- **Per-provider probe history** (0.12.43) — the durable file, drawn in the detail row; the snapshot above it dies with the process
- **`--json` on the whole CLI** (0.12.44) — `init`, `config get`, `tools --set`; `mcp` refuses with a reason
- **A sweep from the page** — refused, and stated as refused: one click must not become forty outbound requests
- Legal: LICENSE (MIT), NOTICE, OWNER_GRANT, DISCLAIMER, SECURITY — **reviewed and signed off by the owner, 2026-11-23**
- Translation: **dropped** by the owner; 6 languages stand and the boundary is documented in `docs/LANGUAGES.md`

## Where the design lives

| Question | File |
|---|---|
| Why is a route only a route after a probe? | `docs/ARCHITECTURE.md`, `docs/diagrams/sui-architecture.excalidraw` |
| Every hard constraint | `packages/core/src/invariants.js` (19), `npm run audit` |
| Decisions and their reasons | `docs/adr/` (12) |
| How it compares to OmniRoute | `docs/COMPARISON.md` |
| What is measured and how | `docs/MEASUREMENT.md` |
| Windows, for someone who has never used a terminal | `docs/WINDOWS.md` |
| Publishing | `docs/PUBLISHING.md` |
