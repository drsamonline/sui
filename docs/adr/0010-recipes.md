# ADR-0010 — recipes never overwrite, apply idempotently, and dry-run for real

**Status:** accepted · 2026-11-15

## Context

"Working out of the box" and "easy to configure" pull in opposite directions. A config that needs reading a schema is not easy; a config tool that rewrites your file is not out of the box, it is a hazard.

## Decision

A recipe is a named patch in `recipes/*.json` (or `~/.sui/recipes/`), applied by `sui recipe apply <name>`.

Three rules, each enforced by a test rather than by good intentions:

1. **Never overwrite silently.** An existing provider, model or combo is kept; the conflict is reported with `=` and the reason. `--force` replaces it and prints `replaced` rather than `added`. Settings are only set when absent, because a recipe should not quietly change a decision someone already made.
2. **Applying twice is a no-op.** Every change is checked for first, so the second run prints "nothing to change — this recipe is already applied".
3. **A dry run touches nothing.** `applyRecipe()` returns a *new* config and never mutates its input — `test/recipes.test.js` asserts the input is byte-identical afterwards. `--dry-run` prints the same change list and writes no file.

`requires.env` is checked and reported **before** anything is applied. A recipe that needs a key you do not have says so, instead of producing a gateway that silently reaches nothing.

## Consequences

- The shipped set covers the setups people actually ask for: `free-tier-stack`, `privacy-strict`, `coding`, `local-only`, `mcp-tools`.
- Writing one is a JSON file and no code, so the list can grow without touching the CLI.
- A broken recipe is skipped by the loader rather than taking the others down with it.
- Recipes cannot express everything: a change that needs ordering (migrating a combo's targets, say) needs code, and pretending otherwise would produce a patch format nobody can reason about.
