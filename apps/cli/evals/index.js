/**
 * The eval harness — the engine behind `sui eval` and `npm run eval`.
 *
 * It lives inside the CLI package on purpose. The product's headline claim is
 * that a route exists only after it was proven, and the only thing that proves
 * *answer quality* is this: fifty prompts, one deterministic grader each, and a
 * pass rate that carries its sample size. Until this shipped in the tarball the
 * claim could only be checked from a git checkout, which is not the artefact a
 * user gets.
 *
 * Two modes, and they answer different questions:
 *
 *   self-test   grades fixture answers (50 known-good, 6 known-bad). Proves the
 *               graders grade. No model, no network, no quota, no config.
 *   real        runs the fifty prompts against a combo through the gateway.
 *
 * Exit codes: 0 green · 1 regression or failures · 2 not meaningful (no combo
 * answered, so the numbers would be a lie). The last one is the point: a run in
 * which every request failed is not a 0% model, and reporting it as one is how a
 * harness starts lying.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiHome } from '@drsamonline/core';
import { GRADER_TYPES, grade } from './graders.js';

export { GRADER_TYPES, grade };

/** Where this file lives: `<cli package>/evals`. */
export const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, or null.
 *
 * `sui eval` is run from two places and must behave the same in both: a
 * checkout, where the committed `evals/last-report.json` is what the dashboard
 * and CI read, and an install, where the only writable place is the user's home.
 * Three levels up from this file is a checkout only if the manifest there is the
 * private workspace root — without that check, a user's own `evals/` directory
 * would be written to because it happens to sit at the same relative path.
 */
function checkoutRoot() {
  const root = join(EVAL_DIR, '..', '..', '..');
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name === 'sui' && pkg.private === true) return root;
  } catch {
    /* an install has no root manifest, which is the normal case */
  }
  return null;
}

/**
 * Every path the harness reads or writes, resolved once.
 *
 * Data files ship inside this package, so they resolve identically in a checkout
 * and in a tarball. State — the report and the baseline — is a record of what
 * this machine measured, so it belongs in the user's home; a verification made
 * on one machine is not evidence for another, and writing into an installed
 * `node_modules` would be wrong.
 */
export function evalPaths(env = process.env) {
  const root = checkoutRoot();
  const home = suiHome(env);
  return {
    golden: join(EVAL_DIR, 'golden.jsonl'),
    fixtures: join(EVAL_DIR, 'fixtures', 'self-test.json'),
    // the report: an explicit override wins, then the checkout's committed
    // artifact, then the user's home
    report: env.SUI_EVAL_REPORT ?? (root ? join(root, 'evals', 'last-report.json') : join(home, 'eval-last-report.json')),
    // the baseline is read from wherever it was recorded, so a checkout keeps
    // its history and an install never inherits a baseline it did not measure
    baseline: env.SUI_EVAL_BASELINE ?? (root ? join(root, 'evals', 'baseline.json') : join(home, 'eval-baseline.json')),
    root,
  };
}

/** The fifty prompts. Read every time, so a corrupt file fails loudly. */
export function loadGolden(path = evalPaths().golden) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** The fixture answers the self-test grades. */
export function loadFixtures(path = evalPaths().fixtures) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Wilson score interval for a proportion.
 *
 * With 50 prompts, one prompt is two percentage points, and a pass rate quoted
 * without a range invites a reader to treat a sample as a measurement. The
 * interval is what the number actually supports.
 */
export function wilson(passed, total, z = 1.96) {
  if (!total) return { low: 0, high: 0 };
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * Read a recorded baseline, or say why it cannot be read.
 *
 * @param {string} path
 * @returns {{baseline: any|null, problem: string|null}}
 */
export function readBaseline(path) {
  if (!existsSync(path)) return { baseline: null, problem: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.passedIds)) {
      return { baseline: null, problem: `${path} has no passedIds list, so it cannot gate anything` };
    }
    return { baseline: parsed, problem: null };
  } catch (err) {
    return { baseline: null, problem: `${path} is not readable JSON (${/** @type {any} */ (err)?.message ?? err})` };
  }
}

function writeReport(path, report) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
    return path;
  } catch {
    // a read-only checkout must not fail an eval run
    return null;
  }
}

/* ------------------------------------------------------------- self-test */

/**
 * Grade the fixture answers. Proves the graders grade what they claim to.
 *
 * @returns {{report: any, exitCode: number, lines: string[]}}
 */
export function selfTest({ golden = loadGolden(), fixtures = loadFixtures(), paths = evalPaths() } = {}) {
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

  const lines = [];
  lines.push('');
  lines.push(`Eval self-test — ${checked} checks (${Object.keys(passFixtures).length} must pass, ${Object.keys(failFixtures).length} must fail)`);
  lines.push('');

  const report = problems.length
    ? {
        mode: 'self-test',
        ranAt: new Date().toISOString(),
        combo: null,
        passRate: 0,
        passed: checked - problems.length,
        total: checked,
        mismatches: problems.map((reason) => ({ id: 'self-test', reason })),
        note: 'Harness self-test failed: a grader does not grade what it claims to.',
      }
    : {
        mode: 'self-test',
        ranAt: new Date().toISOString(),
        combo: null,
        passRate: 1,
        passed: checked,
        total: checked,
        mismatches: [],
        note: 'Harness self-test: graders were checked against fixture answers. No model was called.',
      };

  if (problems.length) {
    for (const p of problems) lines.push(`  FAIL  ${p}`);
    lines.push('');
    lines.push(`${problems.length} problem(s): the graders do not grade what they claim to.`);
  } else {
    lines.push(`  ok    all ${checked} checks behaved as expected`);
    lines.push('');
    lines.push('The harness is sound. Run without --self-test to eval a real combo.');
  }

  writeReport(paths.report, report);
  return { report, exitCode: problems.length ? 1 : 0, lines };
}

/* ------------------------------------------------------------- real eval */

/**
 * Run the golden set against a combo through the gateway.
 *
 * @param {{
 *   combo?: string, limit?: number, config?: string,
 *   updateBaseline?: boolean, paths?: any, golden?: any[],
 *   createGateway?: (opts: any) => Promise<any>
 * }} [opts]
 * @returns {Promise<{report: any, exitCode: number, lines: string[]}>}
 */
export async function runReal(opts = {}) {
  const paths = opts.paths ?? evalPaths();
  const golden = opts.golden ?? loadGolden(paths.golden);
  const combo = opts.combo ?? 'chat-default';
  const limit = opts.limit == null ? golden.length : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    // `--limit abc` used to slice the golden set to nothing, and the run then
    // reported "0 of 0 prompts got an answer" — a measurement of the argument
    throw new Error(`--limit must be a whole number of prompts, at least 1, not "${opts.limit}".`);
  }

  // imported lazily: `sui eval --self-test` must work with no gateway, no config
  // and no keys, and this is the only part of the file that needs one
  const createGateway = opts.createGateway ?? (await import('@drsamonline/gateway')).createGateway;
  const gateway = await createGateway({ configPath: opts.config, ledgerFile: null });

  const lines = [];
  lines.push('');
  lines.push(`Golden set — ${Math.min(limit, golden.length)} prompts against "${combo}"`);
  lines.push('');

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

  const answered = graded.filter((g) => g.verified).length;
  const passed = graded.filter((g) => g.pass).length;

  // Every request failed. A pass rate over that is a measurement of the network,
  // not of a model, and printing "0%" would be a number nobody should act on.
  if (answered === 0) {
    const firstError = graded.find((g) => /request failed/.test(g.reason ?? ''))?.reason ?? 'no request returned an answer';
    const report = {
      mode: 'not-meaningful',
      ranAt: new Date().toISOString(),
      combo,
      passRate: null,
      passed: 0,
      total: graded.length,
      answered: 0,
      byCategory: {},
      mismatches: [],
      note:
        `No request to "${combo}" returned an answer, so this run measures nothing about the model. ` +
        `Check a key and a verified route first: sui doctor, then sui probe --write. First error: ${firstError}`,
    };
    lines.push(`  0 of ${graded.length} prompts got an answer from "${combo}".`);
    lines.push(`  ${firstError}`);
    lines.push('');
    lines.push('  No pass rate is reported: a run where every request failed measures the network, not the model.');
    lines.push('  Fix the route first — `sui doctor` says which combo is broken.');
    writeReport(paths.report, report);
    return { report, exitCode: 2, lines };
  }

  const byCategory = {};
  for (const g of graded) {
    byCategory[g.category] ??= { pass: 0, total: 0 };
    byCategory[g.category].total += 1;
    if (g.pass) byCategory[g.category].pass += 1;
  }

  const passRate = graded.length ? passed / graded.length : 0;
  // A baseline is a file on the user's disk, and a corrupt one used to abort the
  // run with a raw JSON parse error and exit 2 — "not meaningful" for a run that
  // had already measured every prompt. It is a warning now: the numbers stand, and
  // the regression gate simply has nothing to compare against.
  const { baseline: previous, problem: baselineProblem } = readBaseline(paths.baseline);
  const previousPassing = new Set(previous?.passedIds ?? []);
  const regressions = graded.filter((g) => previousPassing.has(g.id) && !g.pass);

  const ci = wilson(passed, graded.length);
  lines.push(
    `  pass rate ${Math.round(passRate * 100)}% (${passed}/${graded.length}) · 95% CI ${Math.round(ci.low * 100)}–${Math.round(ci.high * 100)}%`,
  );
  // the aggregate is dominated by the largest category; a per-category line stops
  // 0/2 on tools hiding behind 9/10 on coding
  for (const [category, stats] of Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total)) {
    const c = wilson(stats.pass, stats.total);
    lines.push(
      `    ${category.padEnd(14)} ${String(stats.pass).padStart(2)}/${String(stats.total).padEnd(2)} · ${Math.round(c.low * 100)}–${Math.round(c.high * 100)}%`,
    );
  }
  const thin = Object.entries(byCategory).filter(([, s2]) => s2.total < 5).map(([c]) => c);
  if (thin.length) {
    lines.push(`    (${thin.join(', ')} have fewer than five prompts — read those rows as indicative only)`);
  }
  if (regressions.length) {
    lines.push('');
    lines.push(`  ${regressions.length} regression(s) against the baseline:`);
    for (const r of regressions) lines.push(`    ${r.id}: ${r.reason}`);
  }
  if (baselineProblem) {
    lines.push('');
    lines.push(`  WARNING  the baseline could not be read: ${baselineProblem}`);
    lines.push(`  the pass rate above stands; there is no regression gate this run.`);
    lines.push(`  Re-record it with: sui eval --update-baseline`);
  } else if (!previous) {
    lines.push('');
    lines.push(`  no baseline recorded — nothing to compare against. Record one with: sui eval --update-baseline`);
  }

  const report = {
    mode: 'real',
    ranAt: new Date().toISOString(),
    combo,
    passRate: Math.round(passRate * 1000) / 1000,
    passed,
    total: graded.length,
    answered,
    byCategory,
    confidence: { low: Math.round(ci.low * 1000) / 1000, high: Math.round(ci.high * 1000) / 1000, method: 'wilson', n: graded.length },
    mismatches: graded.filter((g) => !g.pass).map((g) => ({ id: g.id, category: g.category, reason: g.reason })),
    baseline: baselineProblem ? { read: false, problem: baselineProblem } : { read: Boolean(previous) },
    note: `Real run against combo "${combo}".`,
  };

  if (opts.updateBaseline) {
    mkdirSync(dirname(paths.baseline), { recursive: true });
    writeFileSync(
      paths.baseline,
      JSON.stringify({ createdAt: new Date().toISOString(), combo, passRate, passedIds: graded.filter((g) => g.pass).map((g) => g.id) }, null, 2),
    );
    lines.push('');
    lines.push(`  baseline written (${passed} passing prompts) at ${paths.baseline}`);
    writeReport(paths.report, report);
    return { report, exitCode: 0, lines };
  }

  if (regressions.length) {
    // one prompt in fifty is two percentage points, so a single regression is
    // inside the noise this sample can resolve. Say which it is.
    const meaningful = regressions.length >= 2 || passed < (previous?.passedIds?.length ?? 0) - 1;
    lines.push('');
    lines.push(
      meaningful
        ? `  FAIL — ${regressions.length} prompt(s) that used to pass no longer do (I10).`
        : `  FAIL — 1 prompt regressed. With ${graded.length} prompts that is inside sampling noise, but the gate still fails: a prompt that used to pass must not stop passing (I10).`,
    );
    writeReport(paths.report, report);
    return { report, exitCode: 1, lines };
  }

  if (previous) {
    lines.push('');
    const baseN = previous.passedIds?.length ?? 0;
    lines.push(`  no regression against the baseline (${baseN} passing then, ${passed} now)`);
  }
  writeReport(paths.report, report);
  return { report, exitCode: 0, lines };
}

/* ------------------------------------------------------------------ main */

/**
 * The whole command, for both entry points: `sui eval` and `npm run eval`.
 *
 * `json` moves the document to stdout and every human line to stderr, so a CI
 * step can parse it — the same contract `sui probe --json` keeps.
 *
 * @param {{selfTest?: boolean, json?: boolean, combo?: string, limit?: string|number,
 *          config?: string, updateBaseline?: boolean, report?: string}} options
 * @returns {Promise<number>} the exit code
 */
export async function runEval(options = {}) {
  const say = options.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  const paths = evalPaths();
  if (options.report) paths.report = String(options.report);

  try {
    const outcome = options.selfTest
      ? selfTest({ paths })
      : await runReal({
          combo: options.combo,
          limit: options.limit,
          config: options.config,
          updateBaseline: Boolean(options.updateBaseline),
          paths,
        });

    if (options.json) console.log(JSON.stringify(outcome.report, null, 2));
    else for (const line of outcome.lines) say(line);
    return outcome.exitCode;
  } catch (err) {
    const message = /** @type {any} */ (err)?.message ?? String(err);
    if (options.json) console.log(JSON.stringify({ mode: 'error', error: message, note: 'The run could not start.' }, null, 2));
    else console.error(message);
    return 2;
  }
}

/** argv parsing, so `npm run eval -- --combo cheap` behaves like `sui eval --combo cheap`. */
export function parseArgs(argv) {
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

/** Entry point for `node evals/run.mjs`, kept so CI and `npm run eval` are unchanged. */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  return runEval({
    selfTest: Boolean(args['self-test']),
    json: Boolean(args.json),
    combo: args.combo,
    limit: args.limit,
    config: args.config,
    updateBaseline: Boolean(args['update-baseline']),
    report: args.report,
  });
}
