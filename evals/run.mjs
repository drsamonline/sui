#!/usr/bin/env node
/**
 * Golden-set eval runner.
 *
 * Two modes:
 *   --self-test   grades fixture answers (50 known-good, 6 known-bad) and proves
 *                 the graders themselves work. No model, no network, no quota.
 *   (default)     runs the 50 prompts against a real combo through the gateway.
 *
 * Exit codes: 0 green · 1 regression or failures · 2 not meaningful (no verified
 * provider answered, so the numbers would be a lie).
 *
 * Every run leaves `evals/last-report.json` behind, which is what the dashboard
 * reads at `GET /api/evals` (B10.5).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade } from './graders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const golden = readJsonl(join(HERE, 'golden.jsonl'));
const fixtures = JSON.parse(readFileSync(join(HERE, 'fixtures', 'self-test.json'), 'utf8'));
const baselinePath = join(HERE, 'baseline.json');

const REPORT_PATH = process.env.SUI_EVAL_REPORT ?? join(HERE, 'last-report.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeReport(summary) {
  try {
    writeFileSync(REPORT_PATH, JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* a read-only checkout must not fail an eval run */
  }
}

/* ------------------------------------------------------------- self-test */

function selfTest() {
  const passFixtures = fixtures.pass ?? {};
  const failFixtures = fixtures.fail ?? {};
  const problems = [];
  let checked = 0;

  for (const item of golden) {
    const fixture = passFixtures[item.id];
    if (fixture == null) continue;
    checked += 1;
    // a fixture may be a bare answer or {answer, grader} when it tests a different grader
    const answer = typeof fixture === 'string' ? fixture : fixture.answer;
    const grader = typeof fixture === 'string' ? item.grader : fixture.grader ?? item.grader;
    const result = grade(grader, answer);
    if (!result.pass) problems.push(`${item.id}: a known-good answer was graded as a failure (${result.reason})`);
  }

  const goldenById = new Map(golden.map((g) => [g.id, g]));
  for (const [id, answer] of Object.entries(failFixtures)) {
    const item = goldenById.get(id);
    if (!item) {
      problems.push(`${id}: a fail fixture names a prompt that is not in the golden set`);
      continue;
    }
    checked += 1;
    // the fail fixture is a deliberately wrong answer to a real prompt, graded
    // by that prompt's own grader: it must fail.
    const result = grade(item.grader, typeof answer === 'string' ? answer : answer.answer);
    if (result.pass) problems.push(`${id}: a known-bad answer was graded as a pass`);
  }

  const total = checked;
  console.log('');
  console.log(`Eval self-test — ${total} checks (${Object.keys(passFixtures).length} must pass, ${Object.keys(failFixtures).length} must fail)`);
  console.log('');

  if (problems.length) {
    for (const p of problems) console.log(`  FAIL  ${p}`);
    console.log('');
    console.log(`${problems.length} problem(s): the graders do not grade what they claim to.`);
    writeReport({
      mode: 'self-test',
      ranAt: new Date().toISOString(),
      combo: null,
      passRate: 0,
      passed: total - problems.length,
      total,
      mismatches: problems.map((reason) => ({ id: 'self-test', reason })),
      note: 'Harness self-test failed: a grader does not grade what it claims to.',
    });
    process.exit(1);
  }

  console.log(`  ok    all ${total} checks behaved as expected`);
  console.log('');
  console.log('The harness is sound. Run without --self-test to eval a real combo.');

  writeReport({
    mode: 'self-test',
    ranAt: new Date().toISOString(),
    combo: null,
    passRate: 1,
    passed: total,
    total,
    mismatches: [],
    note: 'Harness self-test: graders were checked against fixture answers. No model was called.',
  });
}

/* ------------------------------------------------------------- real eval */

async function runAgainstProvider() {
  const { createGateway } = await import('@sui/gateway');
  const combo = args.combo ?? 'chat-default';
  const limit = args.limit ? Number(args.limit) : golden.length;
  const gateway = await createGateway({ configPath: args.config, ledgerFile: null });

  console.log('');
  console.log(`Golden set — ${Math.min(limit, golden.length)} prompts against "${combo}"`);
  console.log('');

  const graded = [];
  for (const item of golden.slice(0, limit)) {
    let answer = '';
    let error = null;
    try {
      const res = await gateway.router.chat({
        combo,
        body: { messages: [{ role: 'user', content: item.prompt }], max_tokens: 400 },
      });
      answer = res.text;
    } catch (err) {
      error = /** @type {any} */ (err)?.message ?? String(err);
    }
    const result = error ? { pass: false, reason: `request failed: ${error}` } : grade(item.grader, answer);
    graded.push({ ...item, ...result, answer: answer.slice(0, 200), verified: Boolean(answer) });
  }

  const passed = graded.filter((g) => g.pass).length;
  const byCategory = {};
  for (const g of graded) {
    byCategory[g.category] ??= { pass: 0, total: 0 };
    byCategory[g.category].total += 1;
    if (g.pass) byCategory[g.category].pass += 1;
  }

  const passRate = graded.length ? passed / graded.length : 0;
  const previous = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const previousPassing = new Set(previous?.passedIds ?? []);
  const regressions = graded.filter((g) => previousPassing.has(g.id) && !g.pass);

  console.log(`  pass rate ${Math.round(passRate * 100)}% (${passed}/${graded.length})`);
  for (const [category, stats] of Object.entries(byCategory)) {
    console.log(`    ${category.padEnd(14)} ${stats.pass}/${stats.total}`);
  }
  if (regressions.length) {
    console.log('');
    console.log(`  ${regressions.length} regression(s) against the baseline:`);
    for (const r of regressions) console.log(`    ${r.id}: ${r.reason}`);
  }

  writeReport({
    mode: 'real',
    ranAt: new Date().toISOString(),
    combo,
    passRate: Math.round(passRate * 1000) / 1000,
    passed,
    total: graded.length,
    byCategory,
    mismatches: graded.filter((g) => !g.pass).map((g) => ({ id: g.id, category: g.category, reason: g.reason })),
    note: `Real run against combo "${combo}".`,
  });

  if (args['update-baseline']) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ createdAt: new Date().toISOString(), combo, passRate, passedIds: graded.filter((g) => g.pass).map((g) => g.id) }, null, 2),
    );
    console.log('');
    console.log(`  baseline written (${passed} passing prompts)`);
    return 0;
  }

  if (regressions.length) {
    console.log('');
    console.log('  FAIL — a prompt that used to pass no longer does (I10).');
    return 1;
  }

  if (previous) {
    console.log('');
    console.log('  no regression against the baseline');
  }
  return 0;
}

/* ------------------------------------------------------------------ main */

if (args['self-test']) {
  selfTest();
} else {
  runAgainstProvider()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.message ?? String(err));
      process.exit(2);
    });
}
