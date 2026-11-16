# Contributing

Sui is a gateway that makes claims — "a paid provider is never called", "a weak answer is never presented as verified", "your prompt is not in the ledger". Every claim in the README has a test that fails if the claim stops being true. That is the whole discipline, and it is the only rule that matters here.

## The invariant rule

The 15 invariants live in `packages/core/src/invariants.js` as data:

```js
{ id: 'I4', claim: 'A paid provider is never called while the gate is closed',
  enforcedBy: ['packages/router/src/router.js#plan'],
  provenBy: ['test/invariants.test.js'] }
```

`test/invariants.test.js` fails if **either** field is missing or names something that does not exist. So there are three ways to add an invariant, and all three are required:

1. Add the entry with a claim written as a falsifiable sentence.
2. Add the enforcement — and name the function that does it.
3. Add the proof — a test that would fail if the enforcement were removed.

If you cannot write (3), the invariant is a wish, not an invariant.

## The four harnesses

Run all four before a PR. They are cheap and they are the point.

```bash
npm test                # unit and integration, no network, no keys
npm run audit           # 8 static checks + 10 ADR compliance checks
npm run eval:self       # 56 checks on the graders themselves
npm run soak            # server-side overhead against a 15ms budget, and a memory gate
npm run smoke:dashboard # the page in a real browser: healthy, empty and degraded
npm run adr:gate        # the ADR-0001 gates, measured
```

`smoke:dashboard` exists because a screenshot cannot tell you a page is broken: a JavaScript error leaves a half-drawn layout that photographs fine. It loads the dashboard in Chromium against a live gateway and fails on any console error, page error or failed request — in three states, because the two that are not the happy path are where a dashboard actually breaks.

The audit is deliberately unforgiving: it has caught unused exports, routes that exist but are undocumented, and a config key nothing read. When it fails, the fix is almost never to relax the check.

## Tests that are allowed to be wrong

Three kinds of failure are worth distinguishing, because the fix differs:

| Symptom | Usually means |
|---|---|
| the test fails, the code is wrong | fix the code |
| the test fails, the **test** is wrong | fix the test — and say so in the commit message |
| the test fails **sometimes** | the test is lying to you; make it deterministic before you trust it again |

The third one is the dangerous one. A circuit-breaker test used a 200 ms cooldown against the real clock and passed by luck for days; on a loaded machine it half-opened mid-test. The fix was a 60 s cooldown, not a retry.

## Adding a provider adapter

An adapter honours one contract:

```js
{ chat(req) -> { text, usage: { prompt_tokens, completion_tokens }, finishReason } }
```

Everything upstream — fallback, breakers, budgets, privacy, residency, canary, verification, the ledger — applies to it automatically. If you find yourself adding a special case in the router, stop: the adapter is probably wrong.

The MCP client (`type: "mcp"`) is the reference for this. It took one adapter to make an entire protocol routable.

## Adding a compression engine

Engines run in a fixed order and must honour the protected-span guarantee: code blocks, URLs, JSON and identifiers are lifted out before anything is dropped and put back afterwards. An engine that loses a protected span fails `test/compression.test.js`, and that test is not negotiable — it is the difference between compression and corruption.

Every engine reports `droppedChars` and a `note`. An engine that cannot describe what it did has not been written yet.

## Kits

Kits are vendored under `vendor/kits/` and loaded in an isolated `node:vm` context (ADR-0007), never imported for side effects. The provenance of each one — upstream repo, pinned commit, licence — is in `docs/legal/LICENSE_INVENTORY.md`. **Do not add a kit whose licence has not been checked against MIT.**

## Honesty in the docs

Three things are labelled as approximations everywhere they appear: `llmlingua_2`, `ccr`, and the embedding tier. They are useful and they are not what their names suggest. If you improve one, remove the label; until then, leaving it in is the feature.

The same rule applies to failures: a skipped target carries a reason that names the fix, not just the failure ("add GROQ_API_KEY", not "no credentials").

## Commits

One batch per commit, message naming the batch id, then what changed and **what broke on the way**. The second part is not modesty — it is the only record of which failure modes this codebase has already hit.

```
feat: B9.6 worker hardening

- a tick arriving mid-run is skipped and counted, not queued
- a failing job doubles its interval up to 16x and resets on first success

Two bugs on the way:
- reschedule() referenced tick from outside its scope, so any job that failed
  once threw a ReferenceError instead of backing off
```

## What not to do

- Do not add a runtime dependency. The zero-dependency rule (ADR-0003) is what makes `npx sui` work on a fresh machine.
- Do not make a paid provider reachable without the gate. That is I4, and it is the invariant the project exists for.
- Do not write a prompt, a key or an answer into the ledger. Hashes and counts only (I11).
- Do not claim a protocol revision, a model capability or a compression ratio you have not measured.
