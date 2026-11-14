# ADR-0002 — MIT core, PolyForm-NC kits stay outside the tree

**Status:** accepted · 2026-11-14

## Context

Sui is MIT. Every reusable kit in the same account — `tokens-kit`, `ml-kit`, `crypto-kit`, `compress-kit`, `lexora`, `app-endpoints`, `ai-bridge`, `skills` — is PolyForm Noncommercial 1.0.0. MIT permits commercial use; PolyForm NC forbids it. Code under NC cannot be relicensed as MIT, and mixing it into an MIT tree would bind the whole distribution by the NC terms.

The same person holds the copyright on all of it, so this is a decision, not an impossibility.

## Decision

1. **No PolyForm-NC code is vendored into this repository.** `docs/legal/LICENSE_INVENTORY.md` records every candidate and its status.
2. **Where a kit's behaviour is needed, it is adapted** — reimplemented from documented behaviour, with `node:*` built-ins where they suffice (SHA-256 and `timingSafeEqual` instead of `crypto-kit`).
3. **Where a kit is MIT** (`heavenzip`), it may be vendored with a `NOTICE` entry and a licence check at the commit SHA.
4. **Relicensing is the owner's call.** If the kits move to MIT or Apache-2.0, this ADR is superseded, the inventory is updated with the commit SHA, and the vendor subtrees can be added.

## Consequences

- Phase 4 (nine compression engines) and the semantic-cache tier are slower to build, and honest about why.
- The MIT promise stays true: anyone can use Sui commercially, which is the point of choosing MIT.
- Nothing in the tree is a licence landmine waiting for an audit.
