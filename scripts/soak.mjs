#!/usr/bin/env node
/**
 * Soak test — B0.3.
 *
 * Holds the provider constant (a mock that answers in a fixed 5ms) and measures
 * what the gateway itself costs: p50/p95 handler time, memory growth, unhandled
 * rejections, and breaker churn. That difference is the data-plane overhead in
 * invariant I2.
 *
 *   node scripts/soak.mjs --minutes 1 --rps 20
 *   node scripts/soak.mjs --minutes 60 --rps 50 --report soak.json
 */

import { writeFileSync } from 'node:fs';
import { createGateway } from '@sui/gateway';

const args = parseArgs(process.argv.slice(2));
const minutes = Number(args.minutes ?? 1);
const rps = Number(args.rps ?? 20);
const providerDelayMs = Number(args['provider-ms'] ?? 5);
const budgetMs = Number(args['budget-ms'] ?? 15);

const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(`rejection: ${/** @type {any} */ (err)?.message ?? err}`));
process.on('uncaughtException', (err) => unhandled.push(`exception: ${err.message}`));

const config = {
  server: { host: '127.0.0.1', port: 0, cache: { enabled: false } },
  providers: {
    steady: { type: 'mock', mock: { delayMs: providerDelayMs } },
    flaky: { type: 'mock', mock: { failWith: 'simulated 503 during soak', failStatus: 503, failRetryable: true } },
  },
  models: {
    'steady-1': { provider: 'steady', model: 'steady-1', costPer1kIn: 0.0001, costPer1kOut: 0.0002, quality: 3 },
    'flaky-1': { provider: 'flaky', model: 'flaky-1', costPer1kIn: 0, costPer1kOut: 0, quality: 2 },
  },
  combos: {
    'chat-default': { strategy: 'fallback', targets: ['steady-1'] },
    // every request here exercises the breaker: fail, fall back, recover
    'chaos': { strategy: 'fallback', targets: ['flaky-1', 'steady-1'] },
  },
  breaker: { failures: 3, cooldownMs: 200, halfOpenSuccesses: 1 },
  budgets: { dailyUsd: null, warnAtPct: 80, perProvider: {} },
  guardrails: { maxOutputTokens: 256, maxInputChars: 200000, blockPatterns: [], logPrompts: false },
  apiKeys: [],
};

const gw = await createGateway({ configObject: config, ledgerFile: null, env: { ...process.env } });
await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
const port = gw.server.address().port;
const base = `http://127.0.0.1:${port}`;

// Warm the JIT and the connection pool before sampling: a cold first request is
// not a data-plane regression, and pretending otherwise makes the gate noise.
for (let i = 0; i < 10; i++) await sendTurn('chat-default');

const startedAt = Date.now();
const deadline = startedAt + minutes * 60_000;
const samples = [];
let requests = 0;
let failures = 0;
let chaosTurns = 0;
const rss = [process.memoryUsage().rss];

console.log('');
console.log(`Soak — ${minutes} min at ~${rps} rps, provider fixed at ${providerDelayMs}ms, budget ${budgetMs}ms p95`);
console.log('');

let iterations = 0;
while (Date.now() < deadline) {
  iterations += 1;
  const tickStart = Date.now();
  const batch = [];
  for (let i = 0; i < rps; i++) {
    const chaos = i % 5 === 0;
    batch.push(sendTurn(chaos ? 'chaos' : 'chat-default'));
  }
  const outcomes = await Promise.all(batch);
  for (const o of outcomes) {
    requests += 1;
    if (o.ok) {
      samples.push(o.overheadMs);
      if (o.chaos) chaosTurns += 1;
    } else {
      failures += 1;
    }
  }
  rss.push(process.memoryUsage().rss);

  const elapsed = Date.now() - tickStart;
  if (args.verbose) process.stdout.write(`\n  batch ${iterations} took ${elapsed}ms\n`);
  if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
  if (requests % (rps * 20) === 0) {
    process.stdout.write(`\r  ${requests} requests · p95 ${p95(samples)}ms · rss ${(rss[rss.length - 1] / 1e6).toFixed(0)}MB   `);
  }
}

/** @param {string} combo */
async function sendTurn(combo) {
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: combo, messages: [{ role: 'user', content: 'soak turn' }] }),
    });
    await res.arrayBuffer();
    // The gateway reports its own handler time and what of it was the provider.
    const overhead = Number(res.headers.get('x-sui-overhead-ms') ?? NaN);
    return { ok: res.ok, chaos: combo === 'chaos', overheadMs: Number.isFinite(overhead) ? overhead : 0 };
  } catch {
    return { ok: false, chaos: combo === 'chaos', overheadMs: 0 };
  }
}

const sorted = [...samples].sort((a, b) => a - b);
const report = {
  ranAt: new Date().toISOString(),
  minutes,
  rps,
  providerDelayMs,
  budgetMs,
  requests,
  failures,
  chaosTurns,
  overhead: {
    p50Ms: round(q(sorted, 0.5)),
    p95Ms: round(q(sorted, 0.95)),
    p99Ms: round(q(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    // how many samples the percentiles rest on. A p99 from 1,200 requests is the
    // twelfth-worst request: it is descriptive, not a bound.
    samples: sorted.length,
    p99SampleRank: Math.max(1, Math.ceil(sorted.length * 0.01)),
  },
  memory: {
    startMb: round(rss[0] / 1e6, 1),
    endMb: round(rss[rss.length - 1] / 1e6, 1),
    growthMb: round((rss[rss.length - 1] - rss[0]) / 1e6, 1),
  },
  unhandled,
  ledgerRecords: gw.ledger.records.length,
  breakers: gw.breaker.snapshot(),
  pass: true,
};

// Memory gate is generous on purpose: Node's heap grows to a high-water mark
// under load and only then collects, so a 60-second run cannot tell a leak from
// a lazy GC. A soak of an hour can. The gate catches the obvious runaway only.
const maxGrowthMb = Number(args['max-growth-mb'] ?? 200);
report.memory.pass = report.memory.growthMb <= maxGrowthMb;
report.pass = report.overhead.p95Ms <= budgetMs && unhandled.length === 0 && report.memory.pass;

console.log('\n');
console.log(`  requests   ${requests} (${failures} failed, ${chaosTurns} through the breaker path)`);
console.log(`  overhead   p50 ${report.overhead.p50Ms}ms · p95 ${report.overhead.p95Ms}ms · p99 ${report.overhead.p99Ms}ms (budget ${budgetMs}ms)`);
console.log(`  memory     ${report.memory.startMb}MB → ${report.memory.endMb}MB (${report.memory.growthMb >= 0 ? '+' : ''}${report.memory.growthMb}MB, gate ${maxGrowthMb}MB — heap high-water, not a leak measurement)`);
console.log(`  unhandled  ${unhandled.length === 0 ? 'none' : unhandled.join('; ')}`);
console.log(`  ledger     ${report.ledgerRecords} records (capped, in memory for this run)`);
console.log('');
console.log(report.pass ? '  PASS — inside budget, no unhandled errors' : '  FAIL — see the numbers above');

if (args.report) writeFileSync(String(args.report), JSON.stringify(report, null, 2) + '\n');

gw.server.closeAllConnections?.();
gw.server.close();
process.exit(report.pass ? 0 : 1);

function p95(list) {
  return round(q([...list].sort((a, b) => a - b), 0.95));
}

function q(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function parseArgs(argv) {
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
