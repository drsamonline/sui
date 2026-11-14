#!/usr/bin/env node
/**
 * sui — free tiers, verified before use.
 * MIT licensed. No dependencies.
 */

// B0.2: nothing escapes unhandled. A gateway that dies silently is worse than
// one that reports, because the silence looks like idleness.
let shuttingDown = false;

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`\nsui: an unexpected error escaped (${message}).`);
  console.error('Nothing was corrupted — this is a bug worth reporting: https://github.com/your-org/sui/issues');
  if (process.env.SUI_DEBUG === '1' && reason instanceof Error) console.error(reason.stack);
  if (!shuttingDown) process.exitCode = 1;
});

process.on('uncaughtException', (err) => {
  console.error(`\nsui: fatal — ${err?.message ?? err}`);
  if (process.env.SUI_DEBUG === '1') console.error(err?.stack);
  else console.error('Set SUI_DEBUG=1 to see the stack. In-flight requests were not completed.');
  shuttingDown = true;
  process.exit(1);
});

import('../src/cli.js')
  .then(({ run }) => run())
  .catch((err) => {
    const message = err?.message ?? String(err);
    console.error(`\n${message}\n`);
    if (process.env.SUI_DEBUG === '1' && err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
