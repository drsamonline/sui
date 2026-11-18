#!/usr/bin/env node
/**
 * Declare every internal package a workspace actually imports.
 *
 * The monorepo links workspaces into node_modules, so an undeclared dependency
 * still resolves in the repository — and fails the moment someone installs the
 * package from npm. `npm i @drsamonline/cli` installed one package and then could
 * not find @drsamonline/gateway.
 *
 *   node scripts/fix-deps.mjs [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const SCOPE = '@drsamonline/';

const dirs = [
  ...readdirSync(join(ROOT, 'packages')).map((d) => join('packages', d)),
  ...readdirSync(join(ROOT, 'apps')).map((d) => join('apps', d)),
].filter((d) => existsSync(join(ROOT, d, 'package.json')));

const importsOf = (dir) => {
  const used = new Set();
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        for (const m of readFileSync(full, 'utf8').matchAll(/from '(@drsamonline\/[a-z-]+)'/g)) used.add(m[1]);
      }
    }
  };
  const src = join(ROOT, dir, 'src');
  if (existsSync(src)) walk(src);
  return used;
};

let total = 0;
for (const dir of dirs) {
  const path = join(ROOT, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const missing = [...importsOf(dir)].filter((name) => name !== pkg.name && !declared.has(name)).sort();
  if (!missing.length) continue;

  console.log(`  ${pkg.name}`);
  for (const name of missing) console.log(`    + ${name}`);
  total += missing.length;

  if (!dryRun) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}) };
    for (const name of missing) pkg.dependencies[name] = `^${pkg.version}`;
    // alphabetical, because a manifest that shuffles on every run makes diffs useless
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

console.log('');
console.log(`  ${dryRun ? 'would declare' : 'declared'} ${total} missing dependenc${total === 1 ? 'y' : 'ies'}`);
if (!dryRun && total) console.log('  Next: rm -rf node_modules package-lock.json && npm install && npm test');
