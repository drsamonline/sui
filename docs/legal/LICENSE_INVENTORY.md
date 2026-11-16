# Licence inventory

**Required before any vendor merge** (Section 9 of the project prompt).

## The decision, recorded

The kits in the `drsamonline` fleet are published under **PolyForm Noncommercial 1.0.0**. Sui is **MIT**. On 2026-11-14 the copyright holder — who owns every one of these repositories — authorised their use in this MIT project:

> "import whole kit code as required in the repo and use it … skills are all mine or mit licences individually so you can take them too"

That authorisation is what makes the vendoring below legitimate: the same person holds the copyright on the kits and on Sui, so they can license their own work on different terms for this distribution.

**Decision, 2026-11-15 — the upstream repositories stay PolyForm Noncommercial.** The owner's grant is the instrument, not a relicence: see [`OWNER_GRANT.md`](OWNER_GRANT.md), which names every work, its pinned commit, and the exact scope of the MIT licence it grants to *these copies*.

What that means in practice:

1. **Sui is MIT.** Every file in this repository, including `vendor/kits/*`, is distributed under the MIT licence in `/LICENSE`, by the owner's grant.
2. **The upstream repositories are still NC** for everyone else. Someone who clones `crypto-kit` directly gets the non-commercial terms — as its own `LICENSE` says. The two facts coexist because the copyright holder licensed their work differently in two places, which is their right.
3. **This repository keeps a copy of each upstream licence** in `vendor/kits/*.LICENSE`, so the provenance travels with the code even though the terms here are MIT.
4. **`test/licence.test.js` enforces the paperwork.** A vendored kit that is not named in both this table and the grant fails the build.

## Vendored

| Kit | Pinned commit | Used by | What it does here |
|---|---|---|---|
| `crypto-kit` | `f2f3499` | `packages/vault` | AES-256-GCM sealed envelope for the paid-credential vault (B6.7) |
| `ml-kit` | `aa0713f` | `packages/telemetry` | tf-idf index for the semantic cache tier (B4.7) |
| `search-kit` | `32675b6` | `sui catalog` | ranked search over the provider catalogue (B2.2) |
| `tokens-kit` | `4a0200d` | `sui tokens --check` | WCAG contrast maths for the token audit (B8.1, B8.7) |
| `compress-kit` | `9335d0f` | `sui cost --export --gzip` | gzip for usage exports |
| `export-kit` | `135b1a6` | vendored, not yet wired | CSV/zip helpers for the export work in B7.x |
| `web-kit` | `2acc971` | vendored, not yet wired | storage, theme and a11y helpers for the dashboard (B8.7) |
| `app-endpoints` | `3af3769` | `scripts/build-catalog.mjs` | 2,214 public APIs, filtered to 15 model-ish keyless entries |

Each file lives in `vendor/kits/<name>.js` with its `LICENSE` and its generated `API.md` beside it. `vendor/kits/app-endpoints.apis.json` is the dataset.

**How they load:** `packages/kits` evaluates each kit in an isolated `node:vm` context, because they are browser IIFEs that attach to a global. No global pollution, no ESM/CJS mismatch, and one broken kit cannot take the gateway down. See ADR-0007.

## Third-party code and facts (MIT, credited)

Separate from the owner grant above: one external MIT project contributed **facts**, not code.

| Source | Pinned commit | What was taken | Licence |
|---|---|---|---|
| [`herliansyah/9router-auto-free`](https://github.com/herliansyah/9router-auto-free) | `ae6c91d` | a table of provider labels and base URLs, and that project's own exclusion list, imported into `packages/catalog/seed.json` | MIT |

**What was not taken:** no code. The discovery adapters, credential scanners and scheduler in that project are not used here, and nothing from it is vendored into `vendor/`.

**What was not assumed:** every imported entry is `needs_probe: true` and `tos: review`. An endpoint that someone else recorded is not an endpoint this gateway has verified, and a URL is not a terms-of-service read. `test/catalog.test.js` fails if an imported entry is ever marked routable on the strength of the import alone.

Re-run the import with `npm run import:9router -- --source ../9router`. It is idempotent: a second run adds nothing.

## Not vendored, and why

| Repo | Reason | Path forward |
|---|---|---|
| `lexora` | Python, and its canonicaliser is a whole subsystem | port the idea in Phase 4 (B4.1) rather than the code |
| `heavenzip`, `HCS`, `ziptastic`, `kosh` | C++/Rust binaries; Sui ships no native modules | use them as external tools if a compression batch needs them |
| `ai-bridge` | TypeScript VS Code extension; its value is the adapter patterns | reference for B5.1/B5.2 |
| `skills` | 11,689 files of prompt documentation, not code | reference; skills live with the agent, not in the gateway |
| `9router`, `OmniRoute`, `HubGate` | third-party, licences unknown | `sui migrate` imports their *configs*; vendoring their code needs a licence read first |

## Rules for the next vendor

1. Record the repository, the pinned commit and the licence here **before** the merge.
2. Add a matching row to [`OWNER_GRANT.md`](OWNER_GRANT.md) §2 — a kit not named there is not covered by the MIT grant, and `test/licence.test.js` will fail.
3. Keep the upstream `LICENSE` file inside the vendored directory.
4. Add a line to `NOTICE` at the repository root.
5. Re-run `npm test`, `npm run eval:self` and `npm run soak`.

A kit that is **not** authored by the owner cannot be covered by an owner grant. It needs its own licence check, and MIT-compatible terms, before it goes anywhere near `vendor/`.
5. If the licence is not MIT-compatible and the owner has not authorised it, stop.
