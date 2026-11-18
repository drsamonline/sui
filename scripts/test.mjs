#!/usr/bin/env node
/**
 * Run the test suite on any Node and any shell.
 *
 * `node --test test/` works on Node 20 and fails on Node 22, which reads the
 * argument as a file and reports "Cannot find module .../test". Passing a glob
 * instead moves the problem to the shell: bash expands it, cmd.exe does not.
 *
 * So this script enumerates the files itself and passes explicit paths, which
 * every Node version and every shell understands. CI caught the difference on a
 * matrix that tests both versions; locally there was only one.
 *
 * Extra arguments are forwarded, so `npm test -- --test-name-pattern=x` still
 * works.
 */

import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));

if (!files.length) {
  console.error('No test files found in test/.');
  process.exit(1);
}

// A test that leaves a handle open makes `node --test` wait forever, and in CI
// that reads as "still running" rather than "hung". --test-force-exit turns it
// into a normal finish; the per-job timeout in the workflow is the backstop.
const forceExit = Number(process.versions.node.split('.')[0]) >= 22 || Number(process.versions.node.split('.')[1]) >= 14;

// A per-test timeout turns "the job is still running" into "this test hung",
// which is the difference between a mystery and a bug report. 60s is well above
// the slowest test here (a CLI spawn at ~9s) and well below a CI job timeout.
const TIMEOUT_MS = process.env.SUI_TEST_TIMEOUT_MS ?? '120000';

// Files run concurrently, and each one starts gateways, binds ports and spawns
// CLI children. On a two-core CI runner that contention made a file that takes
// 2s locally exceed a 60s budget. Two at a time is still faster than serial and
// stops the suite racing itself.
// Serial by default. Three different tests proved load-sensitive at two at a
// time on a busy machine — a 52ms classifier budget, a worker kickoff, and a fake
// upstream that received no request. Correct and slow beats fast and occasionally
// wrong, and CI overrides this to 2 where the runner is quiet.
const CONCURRENCY = process.env.SUI_TEST_CONCURRENCY ?? '1';

const child = spawn(
  process.execPath,
  ['--test', ...(forceExit ? ['--test-force-exit'] : []), `--test-timeout=${TIMEOUT_MS}`,
    `--test-concurrency=${CONCURRENCY}`, ...process.argv.slice(2), ...files],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
