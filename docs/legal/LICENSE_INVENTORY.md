# Licence inventory

**Required before any vendor merge** (Section 9 of the project prompt).

## The decision, recorded

The kits in the `drsamonline` fleet are published under **PolyForm Noncommercial 1.0.0**. Sui is **MIT**. On 2026-11-14 the copyright holder — who owns every one of these repositories — authorised their use in this MIT project:

> "import whole kit code as required in the repo and use it … skills are all mine or mit licences individually so you can take them too"

That authorisation is what makes the vendoring below legitimate: the same person holds the copyright on the kits and on Sui, so they can license their own work to themselves on MIT terms. Two things follow, and both are outstanding:

1. **The upstream `LICENSE` files still say PolyForm NC.** Anyone cloning `crypto-kit` directly still gets the non-commercial terms. Update those files (MIT or Apache-2.0) to make the two repositories agree.
2. **This repository keeps a copy of each upstream licence** in `vendor/kits/*.LICENSE`, so the provenance travels with the code. If the upstream licences change, replace those files with the new ones and record the commit here.

Until (1) is done, the honest reading is: *Sui is MIT by its owner's grant; the upstream repositories are still labelled NC.*

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
2. Keep the upstream `LICENSE` file inside the vendored directory.
3. Add a line to `NOTICE` at the repository root.
4. Re-run `npm test`, `npm run eval:self` and `npm run soak`.
5. If the licence is not MIT-compatible and the owner has not authorised it, stop.
