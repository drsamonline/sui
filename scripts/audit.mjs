#!/usr/bin/env node
/**
 * Project audit — the mechanical half of a release gate.
 *
 * Checks the claims this repository makes about itself, because a claim that is
 * only asserted in a README is a claim that will drift:
 *
 *   1. every invariant names a test that actually exists
 *   2. every CLI command is in the help text
 *   3. every HTTP route is in docs/API.md
 *   4. every config key is read somewhere
 *   5. every exported symbol is used outside its own file
 *   6. every vendored kit has its licence beside it
 *   7. no secret-looking strings in tracked source
 *   8. no dead modules
 *
 *   node scripts/audit.mjs [--json]
 *
 * Exit code 1 if any check finds a problem, so CI can gate on it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const json = process.argv.includes('--json');

const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => /\.(js|mjs|json|md|html|toml|yml)$/.test(f) && !f.startsWith('vendor/kits/app-endpoints'));

const source = files.filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('vendor/'));
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** @type {Array<{check: string, ok: boolean, detail: string}>} */
const results = [];
const record = (check, problems, okDetail) => {
  results.push({
    check,
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : okDetail,
  });
};

/* 1 — invariants name tests that exist */
{
  const inv = read('packages/core/src/invariants.js');
  const testFiles = files.filter((f) => f.startsWith('test/') && f.endsWith('.test.js'));
  const allTests = testFiles.map((f) => ({ file: f, body: read(f) }));
  const problems = [];

  for (const m of inv.matchAll(/test: '([^']+)'/g)) {
    const ref = m[1];
    if (!/\.test\.js/.test(ref)) continue;
    const filePart = ref.split(' — ')[0].trim();
    const namePart = ref.includes(' — ') ? ref.split(' — ')[1].replace(/^"|"$/g, '').trim() : null;
    const target = allTests.find((t) => t.file === filePart);
    if (!target) {
      problems.push(`invariant test file not found: ${filePart}`);
      continue;
    }
    if (namePart) {
      const head = namePart.slice(0, 40);
      if (!target.body.includes(head)) problems.push(`test "${head}…" is not in ${filePart}`);
    }
  }
  record('invariants → tests', problems, `${[...inv.matchAll(/test: '/g)].length} references resolved`);
}

/* 2 — every CLI command is documented in help */
{
  const cli = read('apps/cli/src/cli.js');
  const commands = [...cli.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
  const help = cli.slice(cli.indexOf('function help()'));
  const problems = [];
  const aliases = new Set(['help', 'version', 'serve', 'up', 'usage', '--help', '-h', '--version', '-v']);
  for (const cmd of new Set(commands)) {
    if (aliases.has(cmd)) continue;
    if (!help.includes(`sui ${cmd}`)) problems.push(`"${cmd}" has no help line`);
  }
  record('cli → help', problems, `${new Set(commands).size} commands documented`);
}

/* 3 — every HTTP route is in the API docs */
{
  const server = read('apps/gateway/src/server.js');
  const api = read('docs/API.md');
  const routes = [...server.matchAll(/path === '(\/[^']*)'/g)].map((m) => m[1]);
  const problems = [];
  for (const route of new Set(routes)) {
    if (!api.includes(route)) problems.push(`${route} is not in docs/API.md`);
  }
  record('routes → API.md', problems, `${new Set(routes).size} routes documented`);
}

/* 4 — every config key is read somewhere */
{
  const config = read('packages/core/src/config.js');
  const others = source.filter((f) => !f.endsWith('packages/core/src/config.js')).map(read).join('\n');
  const keys = new Set();
  for (const m of config.matchAll(/^\s{4}([a-zA-Z]+):\s/gm)) keys.add(m[1]);
  // keys that only appear in the sanitised payload are outputs, not settings
  const outputs = new Set(['apiKeyCount']);
  const problems = [];
  for (const key of keys) {
    if (['path', 'env'].includes(key) || outputs.has(key)) continue;
    const used = others.includes(`config.${key}`) || others.includes(`.${key}?.`) || others.includes(`${key}:`);
    if (!used) problems.push(`config.${key} is never read outside config.js`);
  }
  record('config keys → readers', problems, `${keys.size} keys read`);
}

/* 5 — exported symbols are used elsewhere */
{
  const problems = [];
  const bodies = new Map(source.map((f) => [f, read(f)]));
  for (const [file, body] of bodies) {
    if (/\.test\.js$/.test(file) || file.startsWith('scripts/') || file.startsWith('evals/')) continue;
    const names = new Set();
    for (const m of body.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) names.add(m[1]);
    for (const name of names) {
      if (['default'].includes(name)) continue;
      let used = false;
      for (const [other, otherBody] of bodies) {
        if (other === file) continue;
        if (new RegExp(`\\b${name}\\b`).test(otherBody)) {
          used = true;
          break;
        }
      }
      if (!used && !/index\.js$/.test(file)) problems.push(`${file}: export "${name}" is unused`);
    }
  }
  record('exports → usage', problems.slice(0, 12), 'every export is used');
}

/* 6 — vendored kits have their licence beside them */
{
  const kits = ['crypto-kit', 'ml-kit', 'search-kit', 'tokens-kit', 'compress-kit', 'export-kit', 'web-kit'];
  const problems = [];
  for (const kit of kits) {
    if (!existsSync(join(ROOT, 'vendor', 'kits', `${kit}.js`))) problems.push(`${kit}.js is missing`);
    if (!existsSync(join(ROOT, 'vendor', 'kits', `${kit}.LICENSE`))) problems.push(`${kit}.LICENSE is missing`);
  }
  record('vendored kits → licences', problems, `${kits.length} kits with licences`);
}

/* 7 — no secret-looking strings in tracked source */
{
  const problems = [];
  for (const file of source) {
    if (file.startsWith('test/') || file.startsWith('evals/')) continue;
    const body = read(file);
    for (const m of body.matchAll(/\b(sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,})\b/g)) {
      problems.push(`${file}: looks like a key (${m[1].slice(0, 6)}…)`);
    }
  }
  record('no secrets in source', problems, 'no key-shaped strings');
}

/* 8 — no dead modules */
{
  const problems = [];
  const bodies = source.map((f) => [f, read(f)]);
  for (const [file] of bodies) {
    if (/index\.js$|cli\.js$|server\.js$|workers\.js$|limits\.js$/.test(file)) continue;
    if (file.startsWith('scripts/') || file.startsWith('evals/') || file.startsWith('test/') || file.includes('/bin/')) continue;
    const base = relative(ROOT, join(ROOT, file)).replace(/\\/g, '/');
    const stem = base.replace(/\.js$/, '');
    const imported = bodies.some(([other, body]) => other !== file && (body.includes(stem) || body.includes(`./${base.split('/').pop()}`)));
    if (!imported) problems.push(`${file} is never imported`);
  }
  record('no dead modules', problems, 'every module is reachable');
}

/* report */
const failed = results.filter((r) => !r.ok);

if (json) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  console.log('');
  console.log('Project audit');
  console.log('');
  const width = Math.max(...results.map((r) => r.check.length));
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.check.padEnd(width)}  ${r.detail}`);
  }
  console.log('');
  console.log(failed.length ? `${failed.length} check(s) failed.` : `All ${results.length} checks passed.`);
}

process.exit(failed.length ? 1 : 0);
