#!/usr/bin/env node
/**
 * The ADR-0001 gates, made runnable.
 *
 * ADR-0001 decides three things and says what would reverse each one. Prose
 * gates rot, so this script runs them:
 *
 *   1. data plane — p95 handler overhead must stay under 15ms at 200 rps
 *      sustained (10x the soak load the decision was made at);
 *   2. ledger — JSONL until ~100k records or a second process needs it;
 *   3. build — npm workspaces until a compile step exists.
 *
 * Exit code 0 means every gate still holds. A non-zero exit is not a failure of
 * the code: it is the ADR telling you it is time to revisit the decision.
 *
 * Run: node scripts/adr-gate.mjs [--rps 200] [--minutes 1]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const rps = arg('rps', 200);
const minutes = arg('minutes', 1);
const BUDGET_MS = 15;
const LEDGER_RECORDS_GATE = 100_000;

console.log('');
console.log('ADR-0001 gates');
console.log('');

/* ---------------------------------------------------------- 1. the data plane */

console.log(`  data plane: soak at ${rps} rps for ${minutes} min, budget p95 < ${BUDGET_MS}ms`);

let soakOutput = '';
let soakOk = false;
try {
  soakOutput = execFileSync(
    process.execPath,
    ['scripts/soak.mjs', '--minutes', String(minutes), '--rps', String(rps)],
    { cwd: ROOT, encoding: 'utf8', timeout: 240_000, stdio: 'pipe' },
  );
  soakOk = /PASS/.test(soakOutput);
} catch (err) {
  soakOutput = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
  soakOk = false;
}

const overhead = /overhead\s+(.*)/.exec(soakOutput)?.[1]?.trim() ?? 'no measurement';
const p95 = Number(/p95\s+([\d.]+)ms/.exec(overhead)?.[1] ?? NaN);
const withinBudget = Number.isFinite(p95) && p95 < BUDGET_MS;

console.log(`    measured  ${overhead}`);
console.log(`    verdict   ${withinBudget ? `holds — ${(BUDGET_MS / p95).toFixed(0)}x under budget, no rewrite due` : 'REVISIT — the data plane gate has been breached'}`);

/* ---------------------------------------------------------------- 2. the ledger */

const home = process.env.SUI_HOME ?? join(process.env.HOME ?? ROOT, '.sui');
const ledgerPath = join(home, 'ledger.jsonl');
let records = 0;
if (existsSync(ledgerPath)) {
  const body = readFileSync(ledgerPath, 'utf8');
  records = body.split('\n').filter(Boolean).length;
}
const sizeMb = existsSync(ledgerPath) ? Math.round((statSync(ledgerPath).size / 1e6) * 10) / 10 : 0;

console.log('');
console.log(`  ledger: ${records} record(s), ${sizeMb} MB against a ${LEDGER_RECORDS_GATE.toLocaleString()} record gate`);
console.log(`    verdict   ${records < LEDGER_RECORDS_GATE ? 'holds — JSONL is enough, SQLite would buy nothing yet' : 'REVISIT — move to SQLite (ADR-0001 §3)'}`);

/* ----------------------------------------------------------------- 3. the build */

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const hasBuild = Boolean(rootPkg.scripts?.build) && rootPkg.scripts.build !== 'echo "no build step"';

console.log('');
console.log(`  build: ${hasBuild ? 'a build step exists' : 'no build step — workspaces are still the right answer'}`);

/* ------------------------------------------------------------------- verdict */

const breaches = [!withinBudget && 'data plane p95', records >= LEDGER_RECORDS_GATE && 'ledger size', hasBuild && 'build step'].filter(Boolean);
console.log('');
if (breaches.length) {
  console.log(`  ${breaches.length} gate(s) breached: ${breaches.join(', ')}. ADR-0001 should be revisited, not quietly ignored.`);
  process.exitCode = 1;
} else {
  console.log('  All three gates hold. ADR-0001 stands as written.');
}
