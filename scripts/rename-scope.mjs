#!/usr/bin/env node
/**
 * Rename every package from one npm scope to another.
 *
 * A scope is an owner, not a namespace you pick: `@drsamonline/cli` can only be published
 * by the npm account or organization named `sui`. When that name is taken, the
 * options are a different scope or no scope at all — and a rename has to touch
 * package names, internal dependency ranges, every import, the lockfile and the
 * documentation, or the build breaks in five places at once.
 *
 *   node scripts/rename-scope.mjs --to @drsamonline --dry-run
 *   node scripts/rename-scope.mjs --to @drsamonline
 *
 * Afterwards: delete node_modules and package-lock.json, run `npm install`, and
 * run the suite. The script prints exactly that.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const to = (args[args.indexOf('--to') + 1] ?? '').trim();
const dryRun = args.includes('--dry-run');

if (!to || !/^@[a-z0-9][a-z0-9-]*$/.test(to)) {
  console.error('Usage: node scripts/rename-scope.mjs --to @scope [--dry-run]');
  console.error('A scope looks like @drsamonline — lowercase, no spaces.');
  process.exit(1);
}

const from = (() => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const name = Object.keys(pkg.workspaces ?? {}).length ? null : null;
  const first = JSON.parse(readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8')).name;
  return first.slice(0, first.indexOf('/'));
})();

if (from === to) {
  console.log(`Already on ${to}. Nothing to do.`);
  process.exit(0);
}

const SKIP = new Set(['node_modules', '.git', 'vendor', 'coverage']);
const TEXT = /\.(js|mjs|cjs|json|md|html|yml|yaml|ts)$/;

/** @type {string[]} */
const changed = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT.test(entry.name)) continue;
    const before = readFileSync(full, 'utf8');
    if (!before.includes(from)) continue;
    const after = before.split(from).join(to);
    if (after !== before) {
      if (!dryRun) writeFileSync(full, after);
      changed.push(relative(ROOT, full));
    }
  }
}

// the lockfile is regenerated rather than patched: its keys encode workspace
// paths, and a half-renamed lockfile is worse than no lockfile
if (existsSync(join(ROOT, 'package-lock.json'))) {
  if (!dryRun) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(ROOT, 'package-lock.json'));
    console.log('  removed package-lock.json (npm install regenerates it)');
  }
}

walk(ROOT);

const byArea = {};
for (const file of changed) {
  const area = file.split('/')[0];
  byArea[area] = (byArea[area] ?? 0) + 1;
}

console.log('');
console.log(`  ${dryRun ? 'would rename' : 'renamed'} ${from} → ${to}`);
console.log(`  ${changed.length} file(s)`);
for (const [area, count] of Object.entries(byArea).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${area.padEnd(14)} ${count}`);
}
console.log('');
if (!dryRun) {
  console.log('  Next:');
  console.log('    rm -rf node_modules package-lock.json');
  console.log('    npm install');
  console.log('    npm test');
  console.log('');
}
