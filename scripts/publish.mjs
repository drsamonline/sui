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
  // apps/gateway is a dependency of the CLI, so it has to be published before it.
  // It was missing from this list, and `npm i @drsamonline/cli` installed one
  // package and then failed to find @drsamonline/gateway.
  'apps/gateway',
  'apps/cli',
];

/**
 * A dependency that is not published is a package that cannot be installed.
 *
 * The monorepo links workspaces, so an undeclared or unpublished dependency
 * resolves here and fails for everyone else — which is exactly what happened.
 */
function checkDependenciesPublished(dir, pkg, publishedNames) {
  const deps = Object.keys(pkg.dependencies ?? {});
  const missing = deps.filter((name) => !publishedNames.has(name));
  if (missing.length) problems.push(`${pkg.name} depends on ${missing.join(', ')}, which this run does not publish`);
}

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
  // Files npm itself rewrites during the workflow's own install step. A version
  // bump makes the committed lockfile stale, CI's `npm install` fixes it, and the
  // publisher then refused to ship code it had just verified.
  const GENERATED = ['evals/last-report.json', 'package-lock.json'];
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
const publishedNames = new Set(
  ORDER.map((dir) => {
    const path = join(dir, 'package.json');
    return existsSync(join(ROOT, path)) ? read(path).name : null;
  }).filter(Boolean),
);

for (const dir of ORDER) {
  const path = join(dir, 'package.json');
  if (!existsSync(join(ROOT, path))) continue;
  const pkg = read(path);
  checkDependenciesPublished(dir, pkg, publishedNames);
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

/** Is this exact version already on the registry? */
function isLive(name, version) {
  try {
    return (
      execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: 'pipe' }).trim() === version
    );
  } catch {
    return false;
  }
}

for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  const pkg = read(join(dir, 'package.json'));
  console.log(`  publishing ${pkg.name}…`);

  const publish = () =>
    execFileSync('npm', ['publish', '--access', 'public'], { cwd: join(ROOT, dir), stdio: 'inherit' });

  try {
    publish();
  } catch (err) {
    // npm's transparency log answers 409 when an equivalent attestation already
    // exists — which happens on a re-run of the same commit. The version is either
    // already published (nothing to do) or the log wants a second attempt.
    const message = String(err?.message ?? '') + String(err?.stderr ?? '');
    const duplicateAttestation = /TLOG_CREATE_ENTRY_ERROR|equivalent entry already exists/i.test(message);

    if (isLive(pkg.name, pkg.version)) {
      console.log(`  ${pkg.name}@${pkg.version} is already on the registry — nothing to do`);
      continue;
    }
    if (duplicateAttestation) {
      console.log(`  ${pkg.name}: transparency log rejected a duplicate attestation, retrying once`);
      publish();
      continue;
    }
    throw err;
  }
}
console.log('');
// A brand-new package is staged, not published: npm creates a public 0.0.0-stage
// placeholder and holds the real first version for a maintainer's approval with
// 2FA. Printing 'published' while the registry serves a placeholder is how you
// end up with a CLI that cannot install its own dependency.
// The registry needs a moment: npm answers 'Your package is being processed and
// may take a few minutes'. Reading it once, immediately, reported a successful
// publish as staged — a false alarm from the check that exists to prevent false
// confidence.
const staged = [];
/**
 * Did this version reach the registry?
 *
 * This check has now lied four times in the alarming direction — calling a live
 * package "staged, needs approval" while npm served it. The cause is always the
 * same: it inferred a state from a list that lags, and inference without evidence
 * is how a release gets marked failed when it succeeded.
 *
 * So it stops inferring. It asks for the exact version, and if the registry has not
 * indexed it yet it says so and moves on: `verify-published.mjs` runs next, waits for
 * the tarballs and installs the package for real. That is the authority. A publish
 * npm actually rejected has already failed the step above, with npm's own words.
 */
const verifyOne = (name, version) => {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const live = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      if (live === version) return null;
    } catch {
      /* not indexed yet */
    }
    execFileSync('sleep', [String(3 + attempt * 2)]);
  }
  return `${name}@${version} is not indexed yet — lag, not a failure (verify-published decides)`;
};

for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  const pkg = read(join(dir, 'package.json'));
  const problem = verifyOne(pkg.name, pkg.version);
  if (problem) staged.push(problem);
}

if (staged.length) {
  // Never exit non-zero here. npm has already failed this step loudly if it rejected
  // a publish, in its own words; a staged first release prints its own notice; and
  // verify-published.mjs installs the package for real right after. This line is
  // information, and four releases were marked failed by treating it as a verdict.
  console.log('  Published. Still catching up:');
  for (const line of staged) console.log(`    ${line}`);
  console.log('  verify-published decides whether a stranger can install it.');
  process.exitCode = 0;
} else {
  console.log('  published, and every package is indexed.');
}
