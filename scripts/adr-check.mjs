#!/usr/bin/env node
/**
 * ADR compliance — the decisions, checked against the code.
 *
 * An ADR that nothing enforces is a paragraph. Each check here reads a decision
 * record and looks for the evidence that the code still honours it, so a later
 * commit cannot quietly undo an architectural choice.
 *
 * Run: node scripts/adr-check.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));

/** @type {Array<{adr: string, title: string, check: () => {ok: boolean, evidence: string}}>} */
const CHECKS = [
  {
    adr: 'ADR-0001',
    title: 'npm workspaces and a Node data plane, with a measured gate',
    check: () => {
      const pkg = JSON.parse(read('package.json'));
      const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
      const soak = exists('scripts/soak.mjs') ? read('scripts/soak.mjs') : '';
      const gated = /--rps/.test(soak) && /budget/i.test(soak);
      return {
        ok: workspaces.length > 0 && gated,
        evidence: `${workspaces.length} workspace glob(s), soak harness accepts --rps and enforces a budget`,
      };
    },
  },
  {
    adr: 'ADR-0002',
    title: 'MIT core; vendored kits used under a written owner grant',
    check: () => {
      const licence = read('LICENSE');
      const grant = read('docs/legal/OWNER_GRANT.md');
      const kits = readdirSync(join(ROOT, 'vendor', 'kits')).filter((f) => f.endsWith('.js') || f.endsWith('.apis.json'));
      const named = kits.filter((k) => grant.includes(k.replace(/\.(js|apis\.json)$/, '')));
      return {
        ok: /MIT License/.test(licence) && named.length === kits.length,
        evidence: `${named.length}/${kits.length} vendored works named in the grant`,
      };
    },
  },
  {
    adr: 'ADR-0003',
    title: 'Zero runtime dependencies',
    check: () => {
      const offenders = [];
      for (const dir of ['', 'apps', 'packages']) {
        const base = dir ? join(ROOT, dir) : ROOT;
        const paths = dir
          ? readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).map((d) => join(base, d, 'package.json'))
          : [join(ROOT, 'package.json')];
        for (const path of paths) {
          if (!existsSync(path)) continue;
          const pkg = JSON.parse(readFileSync(path, 'utf8'));
          const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@sui/'));
          if (deps.length) offenders.push(`${pkg.name}: ${deps.join(', ')}`);
        }
      }
      return { ok: offenders.length === 0, evidence: offenders.length ? offenders.join('; ') : 'no non-workspace runtime dependency anywhere' };
    },
  },
  {
    adr: 'ADR-0004',
    title: 'Paid credentials are never loaded while the gate is closed',
    check: () => {
      const gateway = read('apps/gateway/src/index.js');
      const gated = /config\.paidTiers\?\.enabled/.test(gateway) && /openVaultForStartup/.test(gateway);
      const invariant = read('packages/core/src/invariants.js').includes("id: 'I4'");
      return { ok: gated && invariant, evidence: 'vault opens behind paidTiers.enabled; I4 is in the invariant table' };
    },
  },
  {
    adr: 'ADR-0005',
    title: 'Telemetry holds no prompt text',
    check: () => {
      const ledger = read('packages/telemetry/src/ledger.js');
      const history = read('packages/telemetry/src/history.js');
      const ledgerOk = /promptHash/.test(ledger) && !/promptText:\s*(?!null)/.test(ledger.replace(/\/\*[\s\S]*?\*\//g, ''));
      const historyOk = /SAMPLE_FIELDS/.test(history) && /extra\.length\) continue/.test(history);
      return { ok: ledgerOk && historyOk, evidence: 'ledger stores a salted hash; history drops rows with unknown fields' };
    },
  },
  {
    adr: 'ADR-0007',
    title: 'Kits load in an isolated vm context, never by import',
    check: () => {
      const kits = read('packages/kits/src/index.js');
      // Walk the tree in Node rather than shelling out to ripgrep: `rg` is not on
      // a GitHub runner, and a gate that depends on a tool the runner lacks is a
      // gate that silently does not run.
      const pattern = /(?:import\s+[^;]*vendor\/kits|require\(['"][^'"]*vendor\/kits)/;
      const offenders = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
            walk(full);
          } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
            if (pattern.test(readFileSync(full, 'utf8'))) offenders.push(full.replace(`${ROOT}/`, ''));
          }
        }
      };
      for (const dir of ['apps', 'packages']) walk(join(ROOT, dir));
      const imported = offenders.join(' ');
      const vm = /node:vm/.test(kits) && /vm\.createContext|createContext\(/.test(kits);
      return {
        ok: vm && imported === '',
        evidence: imported ? `imported directly in: ${imported}` : 'vm.createContext in packages/kits; no direct import anywhere',
      };
    },
  },
  {
    adr: 'ADR-0009',
    title: 'One MCP protocol revision, advertised honestly',
    check: () => {
      const server = read('packages/mcp/src/server.js');
      const versions = server.match(/SUPPORTED_PROTOCOL_VERSIONS = \[(.*?)\]/s)?.[1] ?? '';
      return {
        ok: /2024-11-05/.test(versions) && !/2025-/.test(versions),
        evidence: `advertises ${versions.trim() || 'nothing'}`,
      };
    },
  },
  {
    adr: 'ADR-0010',
    title: 'Recipes never overwrite silently and apply idempotently',
    check: () => {
      const recipes = read('packages/core/src/recipes.js');
      const tests = read('test/recipes.test.js');
      return {
        ok: /already exists — kept as it is/.test(recipes) && /applying twice is a no-op/.test(tests) && /does not mutate the config/.test(tests),
        evidence: 'conflicts reported, idempotence and input-immutability both tested',
      };
    },
  },
  {
    adr: 'ADR-0011',
    title: 'Attribution is a caller-supplied label, never an inferred identity',
    check: () => {
      const server = read('apps/gateway/src/server.js');
      const tenant = read('packages/core/src/tenants.js');
      return {
        ok:
          /x-sui-user/.test(server) &&
          /hasKeyHash: Boolean\(key\.key_hash\)/.test(tenant) &&
          // an uncapped tenant reports null rather than a number
          /remainingUsd: cap == null \? null/.test(tenant) &&
          // the key itself is never returned
          !/\bkey:\s*key\.key\b/.test(tenant),
        evidence: 'headers read, key never returned, uncapped tenant reports null',
      };
    },
  },
  {
    adr: 'ADR-0012',
    title: 'Every routing policy is opt-out-able and reports itself',
    check: () => {
      const router = read('packages/router/src/router.js');
      return {
        ok: /freeFirst/.test(router) && /cascade/.test(router) && /quotaResets/.test(router),
        evidence: 'free-first, cascade and quota windows all carry their own state and reason',
      };
    },
  },
];

const results = CHECKS.map((entry) => {
  try {
    const outcome = entry.check();
    return { adr: entry.adr, title: entry.title, ok: Boolean(outcome.ok), evidence: outcome.evidence };
  } catch (err) {
    return { adr: entry.adr, title: entry.title, ok: false, evidence: `check threw: ${err?.message ?? err}` };
  }
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('');
  console.log('ADR compliance — does the code still honour the decisions?');
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.adr.padEnd(9)} ${r.title}`);
    if (!r.ok || process.argv.includes('--verbose')) console.log(`       ${r.evidence}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`  ${results.length - failed} of ${results.length} decisions honoured`);
  if (failed) process.exitCode = 1;
}
