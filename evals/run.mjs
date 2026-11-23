#!/usr/bin/env node
/**
 * The repository's entry point to the eval harness.
 *
 * The harness itself lives in the CLI package (`apps/cli/evals/index.js`) and
 * ships in the tarball, because a user who installs the product must be able to
 * measure answer quality from what they installed. This file stays so that
 * `npm run eval`, `npm run eval:self` and the CI step keep working, and so there
 * is exactly one copy of the golden set and the graders — a second copy in the
 * repository would be a copy that drifts.
 *
 * Exit codes: 0 green · 1 regression or failures · 2 not meaningful.
 */

import { main } from '../apps/cli/evals/index.js';

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ?? String(err));
    process.exit(2);
  },
);
