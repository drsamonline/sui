# Reuse map — the fleet, mapped onto Sui's phases

Every repository in the `drsamonline` account that Sui can learn from, what it would contribute, and how it can be taken **given the licence** (see `docs/legal/LICENSE_INVENTORY.md`: the kits are PolyForm Noncommercial, Sui is MIT).

Legend for *how*: **adapt** = reimplement the behaviour, copy nothing · **vendor** = subtree the code (licence permitting) · **reference** = read it for design, write our own.

## Phase 2 — free-tier intelligence

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `app-endpoints` | 2,214 public APIs with an auth filter — a real catalogue seed instead of eleven hand-written entries | vendor (post-relicence) | B2.2 |
| `search-kit` | inverted index + prefix/fuzzy matching for catalogue search and docs | vendor | B2.2, B11 |
| `ai-bridge` | provider adapters and the "bring a web chat model into your editor" pattern; also the honest source of ToS caution | reference | B2.3, B2.5 |

## Phase 3 — routing core

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `audit` | the evidence habit: every claim carries the measurement that produced it | reference | B3.7 |
| `dashboard` | live status page patterns for the Weather Map | reference | B10.1 |

## Phase 4 — compression & caching

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `heavenzip` (MIT) | CHCE orchestrator chaining compression binaries into one pipeline | vendor (add NOTICE) | B4.1 |
| `HCS` | reference compressor sources the CHCE engines are built from | reference (licence to confirm) | B4.1 |
| `compress-kit` | gzip/deflate via Compression Streams — the browser/Node baseline engine | adapt | B4.2 |
| `lexora` | canonicalise text, then compress: exactly the "session dedup then ratio" shape Sui needs | reference | B4.1 |
| `ziptastic`, `kosh`, `compress-arena`, `chce-compress` | codec coverage, archive verification, benchmark harness | vendor/reference per licence | B4.1, B4.2 |
| `ml-kit` | tf-idf / k-means / PCA for the semantic cache tier and reference-free quality scoring | adapt now, vendor post-relicence | B4.7, B7.7 |

## Phase 5 — agents & protocols

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `ai-bridge` | tool-definition plumbing, per-adapter capability declarations | reference | B5.1, B5.2 |
| `Matneo` | automation platform patterns for recipes and bounded runs | reference | B5.4, B5.5 |

## Phase 6 — security & privacy

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `crypto-kit` | AES-256-GCM sealed envelope for the paid-credential vault | adapt (`node:crypto`) now, vendor post-relicence | B6.7 |
| `All4ONE` | security-check and hashing tool patterns; a 403-tool surface that never phones home | reference | B6.1 |

## Phase 8 — UI / UX

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `tokens-kit` | a real token set (121 names, 187 values per mode) to replace our hand-written ladder | adapt now, vendor post-relicence | B8.1 |
| `mood-mixer` | WCAG contrast computation for the token audit | adapt | B8.1, B8.7 |
| `ui-kit`, `widgets-kit`, `form-kit`, `motion-kit`, `markdown-kit`, `code-kit`, `export-kit` | component primitives, CSV/JSON export, motion with reduced-motion respect | vendor per licence | B8.2, B8.3 |
| `web-kit` | storage, i18n, theme, PWA, a11y helpers | vendor | B8.7 |

## Phase 9–11 — automation, docs

| Repo | Contribution | How | Phase |
|---|---|---|---|
| `forge` (private) | control-plane templates and the live dashboard — the shape of a worker scheduler | reference | B9.1 |
| `registry`, `control-panel` | service registry and operator console patterns | reference | B7.6, B9.1 |
| `skills` | 11,689 machine-consumable skill files; a real test bed for MCP tool surfaces | reference / vendor post-relicence | B11 |
| `audit`, `drsamonline.github.io` | changelog and public-status habits | reference | B11 |
| `backup` | snapshot-before-merge workflow for vendor subtree syncs | vendor | Section 9 CI |

## What has actually been taken so far

Nothing vendored. Two ideas borrowed and reimplemented:

- **the single-file, dependency-free kit style** — `packages/*` are small ESM modules with no dependencies, in the same spirit as `crypto-kit`/`ml-kit`.
- **the evidence habit from `audit`** — every status in `ROADMAP.md` cites the command that produced it, and `docs/legal/LICENSE_INVENTORY.md` is a table, not a claim.
