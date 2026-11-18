import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCanary } from '@drsamonline/canary';
import { makeRouter, makeGateway, testConfig, ask } from './helpers.js';

const slo = { minSuccessRate: 0.9, maxP95Ms: 5000, minSamples: 5 };

function fixedRandom(value) {
  let calls = 0;
  return () => {
    calls += 1;
    return value;
  };
}

test('a canary needs two different combos', () => {
  assert.throws(() => createCanary({ baseline: 'a' }), /needs a baseline and a candidate/);
  assert.throws(() => createCanary({ baseline: 'a', candidate: 'a' }), /cannot compare a combo with itself/);
});

test('pick() sends the configured share to the candidate', () => {
  const always = createCanary({ baseline: 'b', candidate: 'c', percent: 100, random: fixedRandom(0) });
  assert.equal(always.pick().arm, 'candidate');

  const never = createCanary({ baseline: 'b', candidate: 'c', percent: 0, random: fixedRandom(0) });
  assert.equal(never.pick().arm, 'baseline');

  const quarter = createCanary({ baseline: 'b', candidate: 'c', percent: 25, random: fixedRandom(0.2) });
  assert.equal(quarter.pick().arm, 'candidate');
  const above = createCanary({ baseline: 'b', candidate: 'c', percent: 25, random: fixedRandom(0.3) });
  assert.equal(above.pick().arm, 'baseline');
});

test('no verdict until the sample floor is met', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c', slo });
  for (let i = 0; i < 4; i++) {
    const result = canary.observe({ ok: false, latencyMs: 100 });
    assert.equal(result.event, null, 'four failures is not a verdict at a floor of five');
    assert.equal(result.state, 'running');
  }
  const fifth = canary.observe({ ok: false, latencyMs: 100 });
  assert.equal(fifth.event, 'rolled_back');
  assert.equal(canary.state, 'rolled_back');
});

test('a success-rate breach rolls back, with the numbers in the reason', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c', slo });
  let last;
  for (let i = 0; i < 5; i++) last = canary.observe({ ok: i < 3, latencyMs: 100 }); // 60% success
  assert.equal(last.event, 'rolled_back');
  assert.match(last.detail, /60% fell below 90%/);
});

test('a latency breach rolls back even when every answer succeeded', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c', slo: { ...slo, maxP95Ms: 500 } });
  let last;
  for (let i = 0; i < 5; i++) last = canary.observe({ ok: true, latencyMs: 900 });
  assert.equal(last.event, 'rolled_back');
  assert.match(last.detail, /p95 900ms exceeded 500ms/);
});

test('an SLO that holds promotes the candidate', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c', slo });
  let last;
  for (let i = 0; i < 5; i++) last = canary.observe({ ok: true, latencyMs: 200 });
  assert.equal(last.event, 'promoted');
  assert.equal(canary.state, 'promoted');
  assert.equal(canary.pick().arm, 'baseline', 'a finished canary sends everything to the baseline again');
});

test('an outage is excluded, not counted against the candidate', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c', slo });
  for (let i = 0; i < 20; i++) {
    const result = canary.observe({ ok: false, latencyMs: 100, outage: true });
    assert.equal(result.event, null, 'a provider outage must never trigger a rollback');
  }
  const snapshot = canary.snapshot();
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.stats.samples, 0);
  assert.equal(snapshot.stats.excludedOutages, 20);
});

test('an operator can roll back by hand, and it is recorded', () => {
  const canary = createCanary({ baseline: 'b', candidate: 'c' });
  const result = canary.rollback('the numbers looked wrong on the dashboard');
  assert.equal(result.event, 'rolled_back');
  assert.equal(canary.snapshot().events.at(-1).detail, 'the numbers looked wrong on the dashboard');
});

/* ------------------------------------------------------- router integration */

async function upstream(behaviour) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const fail = behaviour(body.model);
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"boom"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function canaryConfig(url, overrides = {}) {
  const config = testConfig();
  config.providers.fake = { type: 'openai', baseUrl: url, apiKeyEnv: null, timeoutMs: 3000 };
  config.models['base-1'] = { provider: 'fake', model: 'base-model', costPer1kIn: 0.1, costPer1kOut: 0.1, quality: 4 };
  config.models['cand-1'] = { provider: 'fake', model: 'cand-model', costPer1kIn: 0.1, costPer1kOut: 0.1, quality: 4 };
  config.combos.baseline = { strategy: 'fallback', targets: ['base-1'] };
  config.combos.candidate = { strategy: 'fallback', targets: ['cand-1'] };
  config.canary = { enabled: true, baseline: 'baseline', candidate: 'candidate', percent: 100, slo: { minSuccessRate: 0.9, maxP95Ms: 5000, minSamples: 2 }, ...overrides };
  return config;
}

test('the router sends traffic to the candidate and records the arm', async () => {
  const up = await upstream(() => false);
  const config = canaryConfig(up.url);
  const gateway = await makeGateway(config);

  const res = await gateway.router.chat({ combo: 'baseline', body: ask('hello') });
  assert.equal(res.meta.modelId, 'cand-1', '100% of traffic went to the candidate combo');
  assert.equal(res.meta.canary.arm, 'candidate');
  assert.match(res.meta.canary.reason, /100% of traffic/);
  await gateway.close();
  await up.close();
});

test('a breaching candidate is rolled back by the router, and traffic returns to the baseline', async () => {
  const up = await upstream((model) => String(model).includes('cand'));
  const config = canaryConfig(up.url);
  const gateway = await makeGateway(config);

  try {
    // the candidate fails; after the sample floor the canary rolls itself back
    for (let i = 0; i < 3; i++) {
      try {
        await gateway.router.chat({ combo: 'baseline', body: ask('hello') });
      } catch {
        /* the request fails; the canary is what we are testing */
      }
    }
    assert.equal(gateway.canary.state, 'rolled_back');
    assert.equal(gateway.canary.snapshot().events.at(-1).event, 'rolled_back');

    const after = await gateway.router.chat({ combo: 'baseline', body: ask('hello') });
    assert.equal(after.meta.modelId, 'base-1', 'after rollback, the baseline answers');
    assert.equal(after.meta.canary.arm, 'baseline');
  } finally {
    await gateway.close();
    await up.close();
  }
});

test('/api/canary reports state, stats and events; a manual rollback works', async () => {
  const up = await upstream(() => false);
  const config = canaryConfig(up.url, { percent: 0 });
  const gateway = await makeGateway(config);
  await new Promise((r) => gateway.server.listen(0, '127.0.0.1', r));
  const { port } = gateway.server.address();

  const before = await (await fetch(`http://127.0.0.1:${port}/api/canary`)).json();
  assert.equal(before.state, 'running');
  assert.equal(before.baseline, 'baseline');

  const rolled = await (await fetch(`http://127.0.0.1:${port}/api/canary/rollback`, { method: 'POST' })).json();
  assert.equal(rolled.state, 'rolled_back');
  assert.equal(rolled.snapshot.state, 'rolled_back');
  await gateway.close();
  await up.close();
});

test('a canary naming a combo that does not exist is refused at load time', async () => {
  const config = canaryConfig('http://127.0.0.1:1/v1', { candidate: 'ghost' });
  await assert.rejects(() => makeGateway(config), /canary\.candidate points at combo "ghost"/);
});
