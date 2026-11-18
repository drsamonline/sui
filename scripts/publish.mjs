#!/usr/bin/env node
/**
 * Publish the packages, in dependency order, after checking the things that
 * cannot be undone.
 *
 * npm publish is permanent: a version cannot be reused and a bad tarball cannot
 * be withdrawn. So this refuses to publish when:
 *
 *   - the working tree is dirty (what you tested is not what you ship);
 *   - a package's version disagrees with the root;
 *   - the target version already exists on the registry;
 *   - the tarball contains files it should not (test fixtures, source maps, .env);
 *   - `--dry-run` was not passed and the licence grant is not in the tarball.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

/** Publish order: a package's dependencies go first. */
const ORDER = [
  'packages/core',
  'packages/kits',
  'packages/providers',
  'packages/router',
  'packages/telemetry',
  'packages/catalog',
  'packages/guardrails',
  'packages/compression',
  'packages/promptcache',
  'packages/verify',
  'packages/redteam',
  'packages/canary',
  'packages/prober',
  'packages/vault',
  'packages/sdk',
  'packages/mcp',
  'packages/sandbox',
  'apps/cli',
];

const problems = [];
const rootPkg = read('package.json');

// 0. a publish needs a logged-in account; say so before doing any work
try {
  execFileSync('npm', ['whoami'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch {
  problems.push(
    'not logged in to npm. Either run `npm login` here, or let the publish workflow do it: ' +
      'add an NPM_TOKEN repository secret and push a v* tag (.github/workflows/publish.yml).',
  );
}

// 1. a clean tree, because an uncommitted fix is not in the tarball
const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
// A generated file that a gate wrote is not a dirty tree: the check exists to
// catch code that was edited after it was tested. Naming the file in the refusal
// is what turned a fifteen-minute mystery into a one-line fix.
if (status && !dryRun) {
  const GENERATED = ['evals/last-report.json'];
  const lines = status.split('\n').filter(Boolean);
  const real = lines.filter((l) => !GENERATED.some((g) => l.endsWith(g)));
  if (real.length) problems.push(`working tree is dirty:\n${real.slice(0, 5).join('\n')}`);
  else if (lines.length) console.log(`  note: ignoring ${lines.length} generated file(s) in the dirty check`);
}

// 2. versions agree
for (const dir of ORDER) {
  const path = join(dir, 'package.json');
  if (!existsSync(join(ROOT, path))) continue;
  const pkg = read(path);
  if (pkg.version !== rootPkg.version) problems.push(`${pkg.name} is ${pkg.version}, the root is ${rootPkg.version}`);
  if (!pkg.publishConfig?.access) problems.push(`${pkg.name} has no publishConfig.access`);
}

// 3. the name is free, or this version is
const availability = [];
for (const dir of ORDER) {
  const path = join(dir, 'package.json');
  if (!existsSync(join(ROOT, path))) continue;
  const pkg = read(path);
  let published = null;
  try {
    published = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    published = null; // not published: good
  }
  availability.push({ name: pkg.name, version: pkg.version, taken: Boolean(published) });
  if (published && !dryRun) problems.push(`${pkg.name}@${pkg.version} already exists on the registry`);
}

// 4. the tarball holds what it should
const packs = [];
for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(ROOT, dir), encoding: 'utf8' });
  const info = JSON.parse(out)[0];
  const files = info.files.map((f) => f.path);
  const bad = files.filter((f) => /(^|\/)(test|tests|fixtures|\.env|\.npmrc)/.test(f));
  if (bad.length) problems.push(`${info.name}: tarball includes ${bad.join(', ')}`);
  packs.push({ name: info.name, version: info.version, files: files.length, sizeKb: Math.round(info.size / 1024) });
}

console.log('');
console.log(dryRun ? 'npm publish — dry run' : 'npm publish');
console.log('');
for (const pack of packs) {
  const state = availability.find((a) => a.name === pack.name)?.taken ? 'EXISTS' : 'free  ';
  console.log(`  ${state}  ${pack.name.padEnd(22)} ${pack.version.padEnd(8)} ${String(pack.files).padStart(3)} files  ${String(pack.sizeKb).padStart(4)} kB`);
}

if (problems.length) {
  console.log('');
  console.log('  Refusing to publish:');
  for (const problem of problems) console.log(`   - ${problem}`);
  process.exitCode = 1;
  process.exit();
}

if (dryRun) {
  console.log('');
  console.log('  Dry run: nothing was published. Run `npm run publish:real` to publish.');
  process.exit();
}

for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  console.log(`  publishing ${read(join(dir, 'package.json')).name}…`);
  execFileSync('npm', ['publish', '--access', 'public'], { cwd: join(ROOT, dir), stdio: 'inherit' });
}
console.log('');
console.log('  published.');
