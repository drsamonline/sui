# vendor/

Reserved for git subtree merges. **Currently empty on purpose.**

Before anything lands here:

1. Read its licence and record it in [`../docs/legal/LICENSE_INVENTORY.md`](../docs/legal/LICENSE_INVENTORY.md).
2. If it is not MIT-compatible, stop. ADR-0002 explains why a non-commercial
   dependency cannot live inside an MIT distribution.
3. Vendor it, keeping the copyright notice:

   ```bash
   git subtree add --prefix vendor/<name> <remote> main --squash
   ```

4. Add a `NOTICE` entry naming the project, the copyright holder and the licence.
5. Re-run `npm test`, `npm run eval:self` and `npm run soak` before merging.

Syncs follow the same gate: pull into a branch, run the eval, open a PR with a
changelog, and block the merge if the golden set regresses (I10).
