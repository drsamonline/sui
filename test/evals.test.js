import test from 'node:test';
/**
 * A config with a mock provider, so the eval tests exercise the harness rather
 * than the network.
 *
 * Running the real eval here meant 50 prompts × an 8-second provider timeout,
 * twice: invisible in a sandbox with no egress (every call fails instantly) and
 * fifteen minutes on a CI runner that has egress and then waits.
 */
function mockConfig() {
  // ESM: `require` is not defined here, and a helper that throws inside the
  // test's try/catch turns a real failure into an empty string
  const dir = mkdtempSync(join(tmpdir(), 'sui-eval-'));
  const path = join(dir, 'sui.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      providers: { mock: { type: 'mock', mock: { delayMs: 1 } } },
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { grade, GRADER_TYPES } from '../evals/graders.js';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('I10: the golden set has 50 prompts, each with a known grader type', () => {
  const golden = readFileSync(join(ROOT, 'evals', 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(golden.length, 50);
  for (const item of golden) {
    assert.ok(item.id && item.category && item.prompt, `incomplete item: ${JSON.stringify(item).slice(0, 60)}`);
    assert.ok(GRADER_TYPES.includes(item.grader.type), `${item.id} uses unknown grader ${item.grader.type}`);
  }
  const ids = new Set(golden.map((g) => g.id));
  assert.equal(ids.size, 50, 'ids must be unique');
});

test('I10: the eval harness self-test passes (graders grade what they claim)', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'evals', 'run.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.match(out, /all \d+ checks behaved as expected/);
});

test('graders reject sloppy answers and accept precise ones', () => {
  assert.equal(grade({ type: 'json_valid', keys: ['a'] }, '{"a":1}').pass, true);
  assert.equal(grade({ type: 'json_valid', keys: ['a'] }, 'The answer is a.').pass, false);
  assert.equal(grade({ type: 'max_words', value: 3 }, 'one two three').pass, true);
  assert.equal(grade({ type: 'max_words', value: 3 }, 'one two three four').pass, false);
  assert.equal(grade({ type: 'contains_any', values: ['yes'] }, 'YES, they are.').pass, true);
  assert.equal(grade({ type: 'refuses', compliance_markers: ['here is how'] }, 'Here is how you do it.').pass, false);
  assert.equal(grade({ type: 'refuses', compliance_markers: ['here is how'] }, 'I cannot help with that.').pass, true);
  assert.equal(grade({ type: 'regex', pattern: '^\\d+$' }, '42').pass, true);
  assert.equal(grade({ type: 'nope' }, 'anything').pass, false, 'an unknown grader must fail loudly');
});

test('a fenced JSON answer still counts as JSON', () => {
  assert.equal(grade({ type: 'json_valid', keys: ['ok'] }, '```json\n{"ok": true}\n```').pass, true);
});

test('/api/evals serves the last report, and says so when there is none', async () => {
  const { makeGateway, testConfig } = await import('./helpers.js');
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address();

  const json = await (await fetch(`http://127.0.0.1:${port}/api/evals`)).json();
  assert.equal(json.available, true, 'the self-test report written by the eval run is picked up');
  assert.equal(json.report.mode, 'self-test');
  assert.equal(json.report.passed, json.report.total);
  assert.match(json.report.note, /No model was called/);
  await gw.close();
});

/* ------------------- the numbers must carry their sample size (review) */

test('a 50-prompt pass rate is reported with a confidence interval', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['evals/run.mjs', '--config', mockConfig()], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (err) {
    out = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  }

  // one prompt in fifty is two percentage points; a bare percentage invites the
  // reader to treat a sample as a measurement
  assert.match(out, /95% CI \d+–\d+%/, 'the pass rate must come with its interval');
  assert.match(out, /\(\d+\/50\)/, 'and its denominator');
});

test('per-category rates are shown, so the aggregate cannot hide a category', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['evals/run.mjs', '--config', mockConfig()], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (err) {
    out = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  }

  for (const category of ['coding', 'json', 'tools']) {
    assert.match(out, new RegExp(category), `${category} must appear in the breakdown`);
  }
  // two prompts cannot support a rate, and the runner says so
  assert.match(out, /fewer than five prompts/, 'thin categories must be flagged as indicative');
});

test('the Wilson interval behaves', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'evals', 'run.mjs'), 'utf8');
  assert.match(source, /function wilson\(/);
  // a proportion of 0 or 1 must not produce a zero-width interval at n=50
  assert.match(source, /Math\.max\(0, centre - spread\)/);
});
