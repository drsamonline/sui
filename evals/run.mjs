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
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade } from './graders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = parseArgs(process.argv.slice(2));
const golden = readFileSync(join(HERE, 'golden.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (args['self-test']) {
  runSelfTest();
} else {
  await runAgainstProvider();
}

/* ------------------------------------------------------------------ self-test */

function runSelfTest() {
  const fixtures = JSON.parse(readFileSync(join(HERE, 'fixtures', 'self-test.json'), 'utf8'));
  const problems = [];

  for (const item of golden) {
    const answer = fixtures.pass[item.id];
    if (answer === undefined) {
      problems.push(`${item.id}: no passing fixture — the golden set and the fixtures have drifted apart`);
      continue;
    }
    const result = grade(item.grader, answer);
    if (!result.pass) problems.push(`${item.id}: a known-good answer was graded as failing (${result.reason})`);
  }

  for (const [id, answer] of Object.entries(fixtures.fail)) {
    const item = golden.find((g) => g.id === id);
    if (!item) {
      problems.push(`${id}: fixture refers to a prompt that is not in the golden set`);
      continue;
    }
    const result = grade(item.grader, answer);
    if (result.pass) problems.push(`${id}: a known-bad answer passed the grader — the grader is too loose`);
  }

  const total = golden.length + Object.keys(fixtures.fail).length;
  console.log('');
  console.log(`Eval self-test — ${total} checks (${golden.length} must pass, ${Object.keys(fixtures.fail).length} must fail)`);
  console.log('');
  if (problems.length) {
    for (const p of problems) console.log(`  FAIL  ${p}`);
    console.log('');
    console.log(`${problems.length} problem(s): the graders do not grade what they claim to.`);
    process.exit(1);
  }
  console.log(`  ok    all ${total} checks behaved as expected`);
  console.log('');
  console.log('The harness is sound. Run without --self-test to eval a real combo.');
}

/* --------------------------------------------------------------- real eval */

async function runAgainstProvider() {
  const { createGateway } = await import('@sui/gateway');
  const combo = args.combo ?? 'chat-default';
  const limit = args.limit ? Number(args.limit) : golden.length;
  const items = golden.slice(0, limit);

  let gateway;
  try {
    gateway = await createGateway({ configPath: args.config, ledgerFile: null });
  } catch (err) {
    console.error(`\nCould not load the gateway: ${/** @type {any} */ (err).message}\n`);
    process.exit(2);
  }

  console.log('');
  console.log(`Eval — ${items.length} prompts against "${combo}"`);
  console.log('');

  const results = [];
  for (const item of items) {
    const started = Date.now();
    try {
      const res = await gateway.router.chat({
        combo,
        body: { messages: [{ role: 'user', content: item.prompt }], max_tokens: 400 },
      });
      const verdict = grade(item.grader, res.text);
      results.push({
        id: item.id,
        category: item.category,
        pass: verdict.pass,
        reason: verdict.reason,
        verified: res.meta.verified,
        provider: res.meta.provider,
        modelId: res.meta.modelId,
        latencyMs: Date.now() - started,
        costUsd: res.meta.costUsd,
        answer: res.text.slice(0, 500),
      });
    } catch (err) {
      results.push({
        id: item.id,
        category: item.category,
        pass: false,
        reason: `request failed: ${/** @type {any} */ (err).message.slice(0, 160)}`,
        verified: false,
        provider: null,
        modelId: null,
        latencyMs: Date.now() - started,
        costUsd: 0,
        answer: '',
      });
    }
    const r = results[results.length - 1];
    console.log(`  ${r.pass ? 'pass' : 'FAIL'}  ${r.id.padEnd(11)} ${r.modelId ?? '-'}  ${r.latencyMs}ms  ${r.pass ? '' : r.reason}`);
  }

  const passed = results.filter((r) => r.pass);
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { total: 0, pass: 0 };
    byCategory[r.category].total += 1;
    if (r.pass) byCategory[r.category].pass += 1;
  }
  const unverified = results.filter((r) => !r.verified).length;
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  const summary = {
    ranAt: new Date().toISOString(),
    combo,
    total: results.length,
    passed: passed.length,
    passRate: Math.round((passed.length / results.length) * 1000) / 1000,
    unverified,
    costUsd: Math.round(cost * 1e6) / 1e6,
    p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
    byCategory,
    results,
  };

  console.log('');
  console.log(`  pass ${passed.length}/${results.length} (${Math.round(summary.passRate * 100)}%)  cost $${summary.costUsd}  p50 ${summary.p50LatencyMs}ms  p95 ${summary.p95LatencyMs}ms`);
  for (const [cat, v] of Object.entries(byCategory)) {
    console.log(`    ${cat.padEnd(13)} ${v.pass}/${v.total}`);
  }

  if (unverified === results.length) {
    console.log('');
    console.log('  Every answer came from a mock or unverified provider, so these numbers say nothing');
    console.log('  about a real model. Add a provider key and re-run.');
    writeReport(summary);
    process.exit(2);
  }

  const baselinePath = join(HERE, 'baseline.json');
  let exitCode = 0;

  if (args['update-baseline'] || !existsSync(baselinePath)) {
    writeFileSync(
      baselinePath,
      JSON.stringify(
        { createdAt: summary.ranAt, combo, passRate: summary.passRate, passIds: passed.map((r) => r.id) },
        null,
        2,
      ) + '\n',
    );
    console.log('');
    console.log(`  baseline written (${passed.length}/${results.length} passing)`);
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const nowPassing = new Set(passed.map((r) => r.id));
    const regressions = (baseline.passIds ?? []).filter((id) => !nowPassing.has(id));
    console.log('');
    if (regressions.length) {
      console.log(`  REGRESSION against baseline (${baseline.createdAt}): ${regressions.join(', ')}`);
      exitCode = 1;
    } else {
      const delta = summary.passRate - (baseline.passRate ?? 0);
      console.log(`  no regression against baseline${delta > 0 ? ` (+${Math.round(delta * 100)}%)` : ''}`);
    }
  }

  writeReport(summary);
  process.exit(exitCode);
}

function writeReport(summary) {
  const stamp = summary.ranAt.replace(/[:.]/g, '-');
  const jsonPath = join(HERE, `report-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n');

  const md = [
    `# Eval report — ${summary.combo}`,
    '',
    `- ran: ${summary.ranAt}`,
    `- pass rate: **${Math.round(summary.passRate * 100)}%** (${summary.passed}/${summary.total})`,
    `- cost: $${summary.costUsd}`,
    `- latency: p50 ${summary.p50LatencyMs}ms · p95 ${summary.p95LatencyMs}ms`,
    `- unverified answers: ${summary.unverified}`,
    '',
    '| category | pass | total |',
    '|---|---|---|',
    ...Object.entries(summary.byCategory).map(([c, v]) => `| ${c} | ${v.pass} | ${v.total} |`),
    '',
    '| id | result | model | ms | note |',
    '|---|---|---|---|---|',
    ...summary.results.map((r) => `| ${r.id} | ${r.pass ? 'pass' : 'fail'} | ${r.modelId ?? '—'} | ${r.latencyMs} | ${r.pass ? '' : r.reason.replace(/\|/g, '/')} |`),
  ].join('\n');
  writeFileSync(jsonPath.replace(/\.json$/, '.md'), md + '\n');
  console.log(`  report: evals/${jsonPath.split('/').pop()}`);
}

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
