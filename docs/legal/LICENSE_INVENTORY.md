# Licence inventory

**Required before any vendor merge** (Section 9 of the project prompt).

Sui is MIT. Every repository in the fleet I would want to reuse is **PolyForm Noncommercial 1.0.0**. That is not a detail: MIT permits commercial use, PolyForm NC forbids it. Code under NC cannot be relicensed as MIT, and embedding it in an MIT distribution would bind the whole distribution by the NC terms.

All of these repositories are authored by the same copyright holder (Dr Sohil Momin), so **relicensing is possible — it is the owner's decision, not a technical blocker.** Until that decision is made, nothing NC is vendored into this tree.

## Status of each candidate

| Repo | Licence | What we would take | Status in Sui | Decision needed |
|---|---|---|---|---|
| `tokens-kit` | PolyForm NC 1.0.0 | 121 colour names / 187 values per mode as design tokens | **not vendored** — dashboard uses its own token ladder | relicense to MIT/Apache-2.0, or keep our ladder |
| `mood-mixer` | PolyForm NC 1.0.0 | WCAG contrast maths for the token audit | **not vendored** — `test/dashboard.test.js` checks structure, not contrast ratios | same |
| `ml-kit` | PolyForm NC 1.0.0 | tf-idf, k-means, PCA for the semantic cache (B4.7) and grounding score (B7.7) | **not vendored** | same |
| `crypto-kit` | PolyForm NC 1.0.0 | AES-256-GCM sealed envelope for the paid vault (B6.7) | **not vendored** — `node:crypto` covers what exists today | same |
| `compress-kit` | PolyForm NC 1.0.0 | gzip/deflate via Compression Streams for B4.2 | **not vendored** | same |
| `heavenzip`, `HCS` | MIT (`heavenzip`), unverified (`HCS`) | CHCE compression binaries + orchestrator for B4.1 | **not vendored** | `heavenzip` is MIT — vendorable after a NOTICE entry; `HCS` needs its own licence read |
| `lexora` | PolyForm NC 1.0.0 | canonicalise-then-compress for B4.1 | **not vendored** | relicense, or clean-room the canonicaliser |
| `ai-bridge` | PolyForm NC 1.0.0 | MCP-shaped tool plumbing, adapter patterns for B5.1/B5.2 | **not vendored** | same |
| `app-endpoints` | PolyForm NC 1.0.0 | 2,214 public APIs filterable by auth, as a catalogue seed (B2.2) | **not vendored** — `packages/catalog/seed.json` is hand-written | same |
| `skills` | PolyForm NC 1.0.0 | Skill catalogue (11,689 files) as machine-consumable docs | **not vendored** | same |
| `search-kit`, `web-kit`, `export-kit`, `ui-kit` | PolyForm NC 1.0.0 | Search index, storage/theme/a11y, CSV export, UI primitives | **not vendored** | same |
| `9router`, `OmniRoute`, `HubGate` | unknown / not in this account | Vendor subtrees per Section 9 | **not vendored** — `sui migrate` imports their *configs*, which is a different act from vendoring their code | upstream licence read required before any subtree |

## What "adapting" means here

Reimplementing the behaviour from the other repository's documentation, without copying its source, is the only path that keeps the MIT tree clean. Three examples already in this tree:

- `hashApiKey` / `verifyApiKey` — SHA-256 plus `timingSafeEqual` from `node:crypto`, not `crypto-kit`.
- the design tokens — written for this dashboard, not lifted from `tokens-kit`.
- exact-match TTL cache — written here; the embedding tier will need either `ml-kit` (post-relicence) or a small native tf-idf.

## If the kits are relicensed

One decision, then this table changes and the work gets shorter:

1. Add `LICENSE` (MIT or Apache-2.0) to each kit repository.
2. Record it here, with the commit SHA that carries the new licence.
3. Vendor with `git subtree add --prefix vendor/<kit> <remote> main --squash`, keeping the copyright notice.
4. Add a `NOTICE` entry: `Portions of this project include code from <repo>, Copyright 2026 Dr Sohil Momin, licensed under <licence>.`
5. Re-run `npm test` and `npm run eval` before merging.

Until then: **adapt, do not copy.**
