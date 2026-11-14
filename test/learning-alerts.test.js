import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRouter, testConfig, ask } from './helpers.js';
import { THRESHOLDS, checkBudgets, dedupe } from '@sui/gateway/src/alerts.js';
import { Ledger } from '@sui/telemetry';
import { explainPlan } from '@sui/router';

/* ------------------------------------------------------- B9.3 fallback learning */

function learningConfig() {
  const config = testConfig();
  config.models['a-1'] = { provider: 'mock', model: 'a', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['b-1'] = { provider: 'mock', model: 'b', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['c-1'] = { provider: 'mock', model: 'c', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.providers.mock = { type: 'mock', mock: { delayMs: 1 } };
  config.combos.learned = {
    strategy: 'fallback',
    targets: ['a-1', 'b-1', 'c-1'],
    learning: { enabled: true, minSamples: 4, windowMs: 3600_000 },
  };
  return config;
}

test('learning is off unless a combo asks for it', () => {
  const config = learningConfig();
  delete config.combos.learned.learning;
  const { router } = makeRouter(config);
  const plan = router.plan('learned', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['a-1', 'b-1', 'c-1']);
  assert.equal(plan.learned, false);
});

test('with enough samples, the healthier target is tried first', () => {
  const config = learningConfig();
  const { router, ledger } = makeRouter(config);
  const now = Date.now();

  // a-1 fails often, b-1 is perfect, c-1 has too few samples to judge
  for (let i = 0; i < 6; i++) ledger.record({ provider: 'mock', modelId: 'a-1', ok: i < 2, latencyMs: 50, ts: now });
  for (let i = 0; i < 6; i++) ledger.record({ provider: 'mock', modelId: 'b-1', ok: true, latencyMs: 80, ts: now });
  ledger.record({ provider: 'mock', modelId: 'c-1', ok: true, latencyMs: 10, ts: now });

  const plan = router.plan('learned', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['b-1', 'a-1', 'c-1'], 'measured health beats declared order; too few samples keeps its place');
  assert.equal(plan.learned, true);
});

test('equal success rates fall back to latency, then to declared order', () => {
  const config = learningConfig();
  const { router, ledger } = makeRouter(config);
  const now = Date.now();
  for (let i = 0; i < 5; i++) ledger.record({ provider: 'mock', modelId: 'a-1', ok: true, latencyMs: 900, ts: now });
  for (let i = 0; i < 5; i++) ledger.record({ provider: 'mock', modelId: 'b-1', ok: true, latencyMs: 100, ts: now });
  for (let i = 0; i < 5; i++) ledger.record({ provider: 'mock', modelId: 'c-1', ok: true, latencyMs: 500, ts: now });

  const plan = router.plan('learned', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['b-1', 'c-1', 'a-1']);
});

test('old samples outside the window do not count', () => {
  const config = learningConfig();
  const { router, ledger } = makeRouter(config);
  const old = Date.now() - 10 * 3600_000;
  for (let i = 0; i < 10; i++) ledger.record({ provider: 'mock', modelId: 'b-1', ok: true, latencyMs: 10, ts: old });

  const plan = router.plan('learned', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['a-1', 'b-1', 'c-1'], 'stale evidence leaves the declared order alone');
});

test('explain-my-route says learning is on', () => {
  const config = learningConfig();
  const { router } = makeRouter(config);
  const text = explainPlan(router.plan('learned', {})).join(' ');
  assert.match(text, /Fallback learning is on/);
});

test('a learned combo still answers', async () => {
  const config = learningConfig();
  const { router } = makeRouter(config);
  const res = await router.chat({ combo: 'learned', body: ask('hello') });
  assert.ok(res.text.length > 0);
  // the meta flag lives on the route description, which is what explain-my-route reads
  assert.equal(res.meta.route.learned, true);
});

/* ---------------------------------------------------------- B7.3 budget alerts */

function alertHarness({ dailyUsd = null, perProvider = {}, spend = {}, providerSpend = {} } = {}) {
  const ledger = new Ledger({ file: null });
  for (const [modelId, cost] of Object.entries(spend)) {
    ledger.record({ provider: 'mock', modelId, ok: true, costUsd: cost });
  }
  const config = { budgets: { dailyUsd, perProvider } };
  const stub = {
    todaySpendUsd: () => Object.values(spend).reduce((a, b) => a + b, 0),
    providerSpendToday: (p) => providerSpend[p] ?? 0,
  };
  return { config, ledger: stub };
}

test('the thresholds are 75, 90 and 100 percent', () => {
  assert.deepEqual(THRESHOLDS, [75, 90, 100]);
});

test('nothing fires below 75 percent', () => {
  const h = alertHarness({ dailyUsd: 10, spend: { a: 7.4 } });
  assert.deepEqual(checkBudgets(h), []);
});

test('each threshold fires with the numbers in the message', () => {
  const warn = checkBudgets(alertHarness({ dailyUsd: 10, spend: { a: 7.6 } }));
  assert.equal(warn[0].threshold, 75);
  assert.equal(warn[0].level, 'warning');
  assert.match(warn[0].message, /\$7\.60 of \$10\.00 spent today \(76%\)/);

  const critical = checkBudgets(alertHarness({ dailyUsd: 10, spend: { a: 9.1 } }));
  assert.equal(critical[0].threshold, 90);
  assert.equal(critical[0].level, 'critical');

  const spent = checkBudgets(alertHarness({ dailyUsd: 10, spend: { a: 10.5 } }));
  assert.equal(spent[0].threshold, 100);
  assert.equal(spent[0].level, 'exhausted');
});

test('per-provider caps are checked separately from the daily cap', () => {
  const h = alertHarness({ dailyUsd: 100, perProvider: { groq: 1 }, spend: { a: 0.5 }, providerSpend: { groq: 0.95 } });
  const alerts = checkBudgets(h);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, 'provider');
  assert.equal(alerts[0].scopeId, 'groq');
  assert.match(alerts[0].message, /groq has spent \$0\.95 of \$1\.00/);
});

test('an alert fires once per threshold per scope per day', () => {
  const h = alertHarness({ dailyUsd: 10, spend: { a: 7.6 } });
  const sent = new Set();
  assert.equal(dedupe(checkBudgets(h), sent).length, 1);
  assert.equal(dedupe(checkBudgets(h), sent).length, 0, 'the same threshold must not repeat');

  // crossing to the next threshold is news again
  const higher = alertHarness({ dailyUsd: 10, spend: { a: 9.2 } });
  assert.equal(dedupe(checkBudgets(higher), sent).length, 1);
});

test('no cap means no alerts, rather than a divide by zero', () => {
  assert.deepEqual(checkBudgets(alertHarness({ dailyUsd: null, spend: { a: 99 } })), []);
  assert.deepEqual(checkBudgets(alertHarness({ dailyUsd: 0, spend: { a: 1 } })), []);
});
