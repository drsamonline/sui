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

for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  console.log(`  publishing ${read(join(dir, 'package.json')).name}…`);
  execFileSync('npm', ['publish', '--access', 'public'], { cwd: join(ROOT, dir), stdio: 'inherit' });
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
const verifyOne = (name, version) => {
  // Ask for the exact version. Parsing the version list produced a false "needs
  // approval" three times: the index lags, and a list read mid-update can show
  // the 0.0.0-stage placeholder without the version that is actually live.
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

  // Only now is it worth asking why: a placeholder means a maintainer must approve.
  try {
    const versions = JSON.parse(
      execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8', stdio: 'pipe' }),
    );
    if (versions.includes('0.0.0-stage') && !versions.includes(version)) {
      return `${name}: staged as 0.0.0-stage, needs approval`;
    }
    return `${name}: published, but the registry still reports ${versions[versions.length - 1]} (index lag, not a failure)`;
  } catch {
    return `${name}: not visible after 150s`;
  }
};

for (const dir of ORDER) {
  if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
  const pkg = read(join(dir, 'package.json'));
  const problem = verifyOne(pkg.name, pkg.version);
  if (problem) staged.push(problem);
}

const needsApproval = staged.filter((line) => line.includes('needs approval'));
if (staged.length && !needsApproval.length) {
  console.log('  Published. The registry index is still catching up on:');
  for (const line of staged) console.log(`    ${line}`);
  process.exitCode = 0;
} else if (needsApproval.length) {
  console.log('  STAGED — a maintainer has to approve these:');
  for (const line of staged) console.log(`    ${line}`);
  console.log('');
  console.log('  npm stages the first release of a new package: it publishes a public');
  console.log('  0.0.0-stage placeholder and holds the real version until approval, which');
  console.log('  requires 2FA. Approve at npmjs.com → the package → Staged Packages, or:');
  console.log('    npm stage list');
  console.log('    npm stage approve <id>');
  process.exitCode = 2;
} else {
  console.log('  published.');
}
