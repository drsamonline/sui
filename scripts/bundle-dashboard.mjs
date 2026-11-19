#!/usr/bin/env node
/**
 * Ship the dashboard with the gateway.
 *
 * The gateway served `apps/dashboard/web/dashboard.html` by walking up from its own
 * source directory, which only resolves inside this repository. From an npm
 * install the file was not there, so every user got:
 *
 *     <h1>Dashboard file missing</h1><p>Reinstall the package.</p>
 *
 * Reinstalling never helped. The fix is to put a copy inside the package, with one
 * source of truth: this script copies it, a test fails if the copy drifts, and the
 * publish workflow runs it before packing.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(ROOT, 'apps', 'dashboard', 'web', 'dashboard.html');
const to = join(ROOT, 'apps', 'gateway', 'web', 'dashboard.html');

if (!existsSync(from)) {
  console.error(`  the dashboard source is missing: ${from}`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);

const bytes = statSync(to).size;
const same = readFileSync(from, 'utf8') === readFileSync(to, 'utf8');
console.log(`  bundled apps/gateway/web/dashboard.html · ${bytes} bytes · identical: ${same}`);
if (!same) process.exit(1);
