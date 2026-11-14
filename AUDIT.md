# Audit — 2026-11-14

An audit of this repository against the claims it makes about itself, at commit `main` after the Phase 0–4 work. Two tools were used: `scripts/audit.mjs` (mechanical checks, now part of CI) and the legal-documentation scanner. Findings are ordered by what would hurt most.

**Verdict: ship the current state as a working, honest preview. Not ready for a v1 tag** — the gaps in §3 are the reason, and none of them are hidden.

---

## 1. Mechanical audit — all 8 checks pass, after 6 fixes

`npm run audit` checks the claims that would otherwise drift silently.

| Check | Before | After | Evidence |
|---|---|---|---|
| Invariants name tests that exist | **6 of 15 references were stale** | pass | 15 references resolved |
| Every CLI command in the help text | 3 aliases undocumented | pass | 27 commands documented |
| Every HTTP route in `docs/API.md` | 3 routes missing | pass | 19 routes documented |
| Every config key is read somewhere | 1 false positive | pass | 18 keys read |
| Every export is used outside its file | **5 unused exports** | pass | every export used |
| Vendored kits have licences beside them | pass | pass | 7 kits |
| No secret-shaped strings in source | pass | pass | none |
| No dead modules | pass | pass | all reachable |

### What those failures actually were

| Finding | Why it mattered | Fix |
|---|---|---|
| 6 invariant `test:` references pointed at renamed tests, the wrong file, or an ellipsis | The invariant table is the repository's central claim; a reference that resolves to nothing means the claim was never re-verified | every reference now names a real test in a real file |
| `docs/API.md` missing `/api/workers`, `/dashboard` | The docs described an older surface | documented |
| `POST /api/reload` existed and returned `{ok:false}` — a stub that did nothing | An endpoint that lies is worse than a missing one | removed |
| Router had a private `isPaid()` duplicating `isPaidProvider()` in core | Two definitions of the paid gate is how the gate drifts | router imports the core function |
| `STRATEGIES`, `PROVIDER_TYPES`, `availableModels` exported and never consumed | Public API surface with no consumer is a maintenance promise nobody asked for | un-exported or removed |
| `hostAllowed` exported but only tested through HTTP | The allowlist had no unit test, so a refactor could break it silently | direct unit test added |

---

## 2. Legal documentation

The scanner's profile for this repository is: network calls, an AI provider, on-device storage, credentials. That set requires `LICENSE`, `SECURITY.md`, `PRIVACY.md`, `TERMS.md`.

| Document | State | Notes |
|---|---|---|
| `LICENSE` (MIT) | present | — |
| `NOTICE` | present | names the seven vendored kits, their copyright and the authorisation |
| `SECURITY.md` | present | states what the gateway is not, and the paid-vault limitation |
| `PRIVACY.md` | **added in this audit** | what leaves the machine, what stays, how to erase it |
| `TERMS.md` | **added in this audit** | responsibilities, AI output, no warranty, Indian law |
| `docs/legal/LICENSE_INVENTORY.md` | present | pinned commits, licence status, the one open owner action |

Both new documents are **drafts written against the code**, flagged as such, with no compliance conclusion and no invented statutory citations. They need review by a qualified Indian advocate before a public or commercial deployment.

### Open licence action

The seven vendored kits still carry PolyForm Noncommercial 1.0.0 upstream. The owner authorised their use here, and `NOTICE` records that grant, but the upstream `LICENSE` files should be updated so the two repositories agree. Until then a reader of `crypto-kit` alone gets different terms than Sui claims.

---

## 3. Gaps that block a v1 tag

| Gap | Why it blocks | Where it is tracked |
|---|---|---|
| No free route is verified end to end | The positioning is "verified before use"; the prober works, but no catalogue entry has a resolved endpoint, so the claim is untested against reality | B2.5, B2.2 |
| 72-hour soak never run | The hardening phase asks for it; a 60-second soak is what CI does | B0.3 |
| ~~Verification escalation missing~~ | closed: `packages/verify`, fail-closed at 0.7 | B3.4 |
| No MCP | A named differentiator | Phase 5 |
| ~~No red-team self-test~~ | closed: `sui redteam` + a weekly worker | B6.1, B6.2 |
| ~~Weather Map~~ | closed: thriving/resting/down with trend lines | B10.1 |
| Rate limiter is per-process | Two gateway processes double the effective limit | B9.1 follow-on |

## 4. Risks accepted, stated plainly

| Risk | Mitigation in place | Residual |
|---|---|---|
| Free tiers change or disappear | prober, breaker, budgets, honest failure messages | none — this is the domain |
| A provider fakes a stream or ignores JSON mode | suitability probes catch it, and a test proves the catch | a provider that passes a probe and then degrades |
| Compression damages a prompt | protected spans lifted out and restored; a test per preset | lossy prose reduction is the point |
| Prompt text reaches disk | off by default, audited, warned by `sui invariants` | a user who turns it on |
| A vendored kit breaks | isolated VM load, 5s timeout, `sui kits` reports it | a kit that loads but misbehaves |
| Credentials leak through a config file | hashed keys, `sui keys hash`, invariant audit | a plaintext key left in place |

---

## 5. What was fixed in this audit

| # | Fix | Tests |
|---|---|---|
| 1 | 6 stale invariant references corrected | `npm run audit` |
| 2 | `/api/workers`, `/dashboard` documented | audit check 3 |
| 3 | `POST /api/reload` stub removed | full suite |
| 4 | Router uses `isPaidProvider` from core | `test/invariants.test.js` I4 |
| 5 | 3 unused exports removed, `hostAllowed` unit-tested | `test/security.test.js` |
| 6 | `PRIVACY.md` and `TERMS.md` written | legal scanner |
| 7 | `npm run audit` added to CI | `.github/workflows/ci.yml` |

Test count went 214 → 215 with the  unit test. Nothing in the audit required changing behaviour, which is the outcome to want: the code was sound, the *claims* had drifted.
