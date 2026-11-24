import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `sui eval` as a command, run the way a user runs it: a child process, argv in,
 * stdout and an exit code out.
 *
 * The harness used to exist only as `evals/run.mjs` in the repository, so the one
 * claim the product makes about answer quality could not be checked from the
 * artefact anybody installs. These tests hold the command to the same contract
 * the rest of the CLI keeps: `--json` puts the document on stdout and nothing
 * else, and the exit code says what happened.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'apps', 'cli', 'bin', 'sui.js');

/** A mock-provider config: no network, no key, no quota. */
function mockConfig(dir, { fail = false } = {}) {
  const path = join(dir, fail ? 'fail.config.json' : 'sui.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      providers: { mock: { type: 'mock', mock: fail ? { failWith: 'simulated outage' } : { delayMs: 1 } } },
      models: { 'mock-1': { provider: 'mock', model: 'mock-1', costPer1kIn: 0, costPer1kOut: 0, quality: 3 } },
      combos: { 'chat-default': { label: 'Everyday chat', strategy: 'fallback', targets: ['mock-1'] } },
      budgets: { dailyUsd: 5 },
      guardrails: { logPrompts: false },
      paidTiers: { enabled: false },
      apiKeys: [],
    }),
  );
  return path;
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sui-eval-cmd-'));
  return {
    dir,
    report: join(dir, 'report.json'),
    baseline: join(dir, 'baseline.json'),
    env: { SUI_HOME: join(dir, '.sui'), SUI_EVAL_REPORT: join(dir, 'report.json'), SUI_EVAL_BASELINE: join(dir, 'baseline.json'), SUI_QUIET: '1' },
  };
}

/** Run `sui eval …` and return its stdout, stderr and exit code — never throw. */
function runEval(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'eval', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? ''), code: err?.status ?? 1 };
  }
}

/* ------------------------------------------------- it is a command at all */

test('sui eval is a command the help text names', () => {
  const help = execFileSync(process.execPath, [BIN, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.match(help, /\bsui eval\b|eval\s+answer quality/, 'help must list `sui eval`');
  assert.match(help, /--self-test/, 'and how to check the graders without a model');
});

test('sui eval --self-test proves the graders grade, with no model and no config', () => {
  const box = sandbox();
  const { stdout, code } = runEval(['--self-test'], box.env);
  assert.equal(code, 0, `self-test exited ${code}`);
  assert.match(stdout, /Eval self-test — \d+ checks \(\d+ must pass, \d+ must fail\)/);
  assert.match(stdout, /all \d+ checks behaved as expected/);

  // the report lands where `--report`/SUI_EVAL_REPORT says, so the dashboard can
  // show it and CI can read it
  const report = JSON.parse(readFileSync(box.report, 'utf8'));
  assert.equal(report.mode, 'self-test');
  assert.equal(report.passed, report.total);
  assert.match(report.note, /No model was called/);
});

test('--json puts the document on stdout and nothing else', () => {
  const box = sandbox();
  const { stdout, code } = runEval(['--self-test', '--json'], box.env);
  assert.equal(code, 0);
  // a preamble on stdout makes the output unparseable, which is how a CI step
  // discovers it before a user does
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.mode, 'self-test');
  assert.equal(parsed.passed, parsed.total);
  assert.equal(typeof parsed.ranAt, 'string');
});

/* ------------------------------------------------------- a real eval run */

test('sui eval measures a combo, and quotes the rate with its sample size', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);
  const { stdout, code } = runEval(['--config', config, '--limit', '6'], box.env);
  assert.equal(code, 0, `a run against a working mock exited ${code}`);
  assert.match(stdout, /95% CI \d+–\d+%/, 'the pass rate must carry its interval');
  assert.match(stdout, /\(\d+\/6\)/, 'and its denominator');
  assert.match(stdout, /coding\s+\d+\/6/, 'every category gets its own line, with its own interval');

  const report = JSON.parse(readFileSync(box.report, 'utf8'));
  assert.equal(report.mode, 'real');
  assert.equal(report.combo, 'chat-default');
  assert.equal(report.total, 6);
  assert.equal(report.confidence.method, 'wilson');
  assert.ok(report.byCategory.coding, 'per-category rates must be in the report');
});

test('a run where nothing answered exits 2 and reports no pass rate', () => {
  const box = sandbox();
  const config = mockConfig(box.dir, { fail: true });
  const { stdout, code } = runEval(['--config', config, '--limit', '3'], box.env);

  // 0/3 is not a 0% model. Every request failed, so the number would measure the
  // network; reporting it as a pass rate is how a harness starts lying.
  assert.equal(code, 2, `expected exit 2 for a meaningless run, got ${code}`);
  assert.match(stdout, /No pass rate is reported/);
  assert.equal(/pass rate \d+%/.test(stdout), false, 'a meaningless run must not print a rate');

  const report = JSON.parse(readFileSync(box.report, 'utf8'));
  assert.equal(report.mode, 'not-meaningful');
  assert.equal(report.passRate, null);
  assert.match(report.note, /measures nothing about the model/);
});

test('the regression gate fails a prompt that used to pass (I10)', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);
  assert.equal(runEval(['--config', config, '--limit', '6'], box.env).code, 0);

  // take an id this combo genuinely fails, and claim it passed in the baseline
  const first = JSON.parse(readFileSync(box.report, 'utf8'));
  const failedId = first.mismatches[0]?.id;
  assert.ok(failedId, 'the mock must fail at least one prompt for this test to mean anything');
  writeFileSync(
    box.baseline,
    JSON.stringify({ createdAt: new Date().toISOString(), combo: 'chat-default', passRate: 1, passedIds: [failedId] }),
  );

  const second = runEval(['--config', config, '--limit', '6'], box.env);
  assert.equal(second.code, 1, `a regression must fail the gate, got ${second.code}`);
  assert.match(second.stdout, /regression\(s\) against the baseline/);
  assert.match(second.stdout, /FAIL/);
});

test('--update-baseline records the ids that passed, and the next run is green', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);

  const first = runEval(['--config', config, '--limit', '6', '--update-baseline'], box.env);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /baseline written \(\d+ passing prompts\)/);
  assert.ok(existsSync(box.baseline), 'the baseline must be written where the next run reads it');

  const baseline = JSON.parse(readFileSync(box.baseline, 'utf8'));
  assert.ok(Array.isArray(baseline.passedIds));

  const second = runEval(['--config', config, '--limit', '6'], box.env);
  assert.equal(second.code, 0, 'the run that recorded the baseline must not regress against itself');
  assert.match(second.stdout, /no regression against the baseline/);
});

/* ------------------------------------ the data must travel with the package */

test('the golden set ships inside the CLI package, and there is only one copy', async () => {
  const { evalPaths } = await import('../apps/cli/evals/index.js');
  const paths = evalPaths({ SUI_HOME: join(tmpdir(), 'unused') });

  // nine bugs of this shape shipped: a path that resolves in the repository and
  // not in a tarball. The engine must read its own package's copy.
  assert.equal(paths.golden, join(ROOT, 'apps', 'cli', 'evals', 'golden.jsonl'));
  assert.ok(existsSync(paths.golden));
  assert.ok(existsSync(paths.fixtures));
  assert.equal(existsSync(join(ROOT, 'evals', 'golden.jsonl')), false, 'a second copy would be a copy that drifts');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'cli', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('evals'), 'the eval directory must be in the package files');
});

test('the packed tarball actually contains the golden set and the fixtures', () => {
  // the only check that answers the question the bug reports asked: is the file
  // in the tarball, not just in the repository
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: join(ROOT, 'apps', 'cli'),
    encoding: 'utf8',
    timeout: 120_000,
    stdio: 'pipe',
  });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const required of ['evals/index.js', 'evals/graders.js', 'evals/golden.jsonl', 'evals/fixtures/self-test.json']) {
    assert.ok(files.includes(required), `${required} is not in the tarball`);
  }
});

/* --------------------------------- the dashboard reads what the command wrote */

test('/api/evals finds the report an install wrote, not only a checkout copy', async () => {
  const { makeGateway, testConfig } = await import('./helpers.js');
  const home = mkdtempSync(join(tmpdir(), 'sui-eval-home-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'eval-last-report.json'),
    JSON.stringify({ mode: 'real', combo: 'chat-default', passRate: 0.8, passed: 8, total: 10, note: 'written by an install' }),
  );

  const previousHome = process.env.SUI_HOME;
  const previousReport = process.env.SUI_EVAL_REPORT;
  // the server reads the process environment, the way it does when the CLI starts it
  delete process.env.SUI_EVAL_REPORT;
  process.env.SUI_HOME = home;
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();
  try {
    const json = await (await fetch(`http://127.0.0.1:${port}/api/evals`)).json();
    assert.equal(json.available, true, 'a report in the user home must be found');
    assert.equal(json.report.note, 'written by an install');
  } finally {
    await gw.close();
    if (previousHome === undefined) delete process.env.SUI_HOME;
    else process.env.SUI_HOME = previousHome;
    if (previousReport !== undefined) process.env.SUI_EVAL_REPORT = previousReport;
  }
});

/* ------------------- a file on the user's disk must not abort a measurement */

test('a corrupt baseline is a warning, not a dead run', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);
  writeFileSync(box.baseline, '{not json');

  const { stdout, code } = runEval(['--config', config, '--limit', '5'], box.env);
  assert.equal(code, 0, 'the run measured every prompt; a bad baseline must not turn that into "not meaningful"');
  assert.match(stdout, /pass rate \d+%/, 'the number stands');
  assert.match(stdout, /WARNING {2}the baseline could not be read/);
  assert.match(stdout, /sui eval --update-baseline/, 'and it names the fix');

  const report = JSON.parse(readFileSync(box.report, 'utf8'));
  assert.equal(report.baseline.read, false);
  assert.match(report.baseline.problem, /not readable JSON/);
});

test('a baseline with no passedIds cannot gate anything, and says so', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);
  writeFileSync(box.baseline, JSON.stringify({ createdAt: 'then', combo: 'chat-default' }));

  const { stdout, code } = runEval(['--config', config, '--limit', '5'], box.env);
  assert.equal(code, 0);
  assert.match(stdout, /has no passedIds list/);
});

test('an unusable --limit is refused instead of measuring nothing', () => {
  const box = sandbox();
  const config = mockConfig(box.dir);
  const { stderr, code } = runEval(['--config', config, '--limit', 'abc'], box.env);
  assert.equal(code, 2);
  assert.match(stderr, /--limit must be a whole number of prompts/);
});
