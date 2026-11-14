import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
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
