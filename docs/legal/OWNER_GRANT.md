# Owner licence grant

**Grantor:** Dr Sohil Momin, copyright holder of the repositories listed below
**Grantee:** the Sui project (https://github.com/drsamonline/sui) and every recipient of a Sui release
**Date of grant:** 2026-11-15
**Instrument:** this document

## 1. What is granted

The Grantor is the sole copyright holder of the eight repositories named in §2. Each of them is published under **PolyForm Noncommercial 1.0.0**. The Grantor hereby grants a **perpetual, worldwide, royalty-free, irrevocable licence under the MIT License** (the text of which is in [`/LICENSE`](../../LICENSE)) to use, reproduce, modify and distribute **the specific copies vendored into this repository** — the files under `vendor/kits/`, the generated catalogue at `packages/catalog/generated.json`, and any part of those works incorporated into Sui's own source.

This grant is made in the Grantor's capacity as copyright holder. It is the Grantor licensing their own work on different terms for this distribution. It does not require, and does not imply, any change to the upstream repositories.

## 2. The works covered

Each work is identified by repository and by the commit that was vendored. A copy taken at a different commit is **not** covered until it is added to this table.

| # | Repository | Pinned commit | Vendored as | Upstream licence |
|---|---|---|---|---|
| 1 | `drsamonline/crypto-kit` | `f2f3499` | `vendor/kits/crypto-kit.js` | PolyForm Noncommercial 1.0.0 |
| 2 | `drsamonline/ml-kit` | `aa0713f` | `vendor/kits/ml-kit.js` | PolyForm Noncommercial 1.0.0 |
| 3 | `drsamonline/search-kit` | `32675b6` | `vendor/kits/search-kit.js` | PolyForm Noncommercial 1.0.0 |
| 4 | `drsamonline/tokens-kit` | `4a0200d` | `vendor/kits/tokens-kit.js` | PolyForm Noncommercial 1.0.0 |
| 5 | `drsamonline/compress-kit` | `9335d0f` | `vendor/kits/compress-kit.js` | PolyForm Noncommercial 1.0.0 |
| 6 | `drsamonline/export-kit` | `135b1a6` | `vendor/kits/export-kit.js` | PolyForm Noncommercial 1.0.0 |
| 7 | `drsamonline/web-kit` | `2acc971` | `vendor/kits/web-kit.js` | PolyForm Noncommercial 1.0.0 |
| 8 | `drsamonline/app-endpoints` | `3af3769` | `vendor/kits/app-endpoints.apis.json` | PolyForm Noncommercial 1.0.0 |

## 3. What is not granted

- **The upstream repositories keep their PolyForm Noncommercial terms.** Anyone who clones `crypto-kit` or any of the others directly receives the NC terms, not this grant. This document grants nothing to those repositories; it grants this project the right to use the copies named in §2.
- **Third-party material inside those repositories is not covered.** The grant is limited to what the Grantor holds copyright in. If any of the eight works contains code, data or assets authored by someone else, that part requires that person's permission and is excluded here. The Grantor's confirmation on this point is recorded in §5.
- **The trademark and the name.** Nothing here grants rights to any name, logo or mark.

## 4. Why this is recorded in writing

A recipient of Sui receives files whose own headers, and whose `vendor/kits/*.LICENSE` companions, say "PolyForm Noncommercial". Without this document that recipient cannot tell whether the distribution is licensed coherently. With it, the chain is visible:

1. the upstream work is NC for everyone;
2. its author granted this project MIT terms for these copies;
3. `NOTICE` and `docs/legal/LICENSE_INVENTORY.md` point here;
4. `test/licence.test.js` fails if a vendored kit is added without being named here.

## 5. Conditions and confirmation

This grant is valid on the following basis, which the Grantor has stated:

- [x] **Sole authorship.** The Grantor is the sole copyright holder of each work in §2, with no third-party contributions and no employer or client claim over them. *(Stated by the Grantor on 2026-11-15: "keep kits polyform, I can grant myself licence to use my code in MIT".)*
- [x] **Authority to license.** The Grantor has not previously granted anyone exclusive rights in these works that would conflict with this grant.
- [ ] **A second pair of eyes.** This instrument has not been reviewed by a lawyer. It is written to be legible and honest rather than to be litigated; a fifteen-minute review by an IP lawyer is cheap insurance and is recommended before a commercial release.

## 6. Irrevocability and scope of reliance

The grant is **irrevocable for any version of Sui already published** under it. Every recipient who receives a Sui release may rely on this document for the copies it names, for as long as they use that release. The Grantor may stop applying this grant to *future* versions, but doing so cannot withdraw it from versions already distributed.

## 7. How to extend it

Adding a ninth kit, or moving one of these to a newer commit, requires:

1. a new row in §2 with the commit that was actually vendored;
2. the upstream `LICENSE` copied to `vendor/kits/<name>.LICENSE` as before;
3. the kit named in `NOTICE`;
4. `npm test` green — `test/licence.test.js` compares the inventory, this table and the files on disk, and fails on any mismatch.
