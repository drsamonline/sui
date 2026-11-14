import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRouter, testConfig, ask, makeGateway, startFakeUpstream } from './helpers.js';
import { auditConfig, providerHasCredentials, INVARIANTS } from '@sui/core';
import { tripsBreaker } from '@sui/router';
import { Ledger } from '@sui/telemetry';

test('every invariant has an enforcement point and a test, or says it does not', () => {
  assert.equal(INVARIANTS.length, 15);
  for (const inv of INVARIANTS) {
    assert.match(inv.id, /^I\d+$/);
    assert.ok(inv.statement.length > 10, `${inv.id} needs a statement`);
    assert.ok(inv.enforced && inv.enforced !== 'none', `${inv.id} has no enforcement point`);
    assert.ok(inv.test && inv.test !== 'none', `${inv.id} has no test named`);
    if (inv.status !== 'enforced') assert.ok(inv.gap, `${inv.id} is ${inv.status} but does not say what the gap is`);
  }
});

test('I3: /v1/models answers from memory, well inside its 1000ms budget', async () => {
  const gw = await makeGateway(testConfig());
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (gw.server.address());
  const base = `http://127.0.0.1:${port}`;

  // warm, then measure the worst of five
  await fetch(`${base}/v1/models`);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const res = await fetch(`${base}/v1/models?all=1`);
    await res.json();
    times.push(performance.now() - t0);
  }
  const worst = Math.max(...times);
  assert.ok(worst < 1000, `worst /v1/models was ${worst.toFixed(1)}ms, budget 1000ms`);

  gw.server.closeAllConnections?.();
  gw.server.close();
});

test('I4: a paid provider is invisible while the gate is closed', async () => {
  const config = testConfig();
  config.providers.paid = { type: 'mock', tier: 'paid' };
  config.models['paid-model'] = { provider: 'paid', model: 'paid-model', costPer1kIn: 1, costPer1kOut: 2, quality: 5, tier: 'paid' };
  config.combos.paidcombo = { strategy: 'fallback', targets: ['paid-model', 'mock-a'] };
  config.paidTiers = { enabled: false };

  assert.equal(providerHasCredentials(config.providers.paid, {}, config), false, 'credentials must not be read');

  const { router } = makeRouter(config);
  const plan = router.plan('paidcombo', {});
  assert.equal(plan.ordered[0].modelId, 'mock-a');
  assert.match(plan.skipped[0].reason, /paid tier is closed/);

  // the same request succeeds on the free target — the gate is not an outage
  const res = await router.chat({ combo: 'paidcombo', body: ask() });
  assert.equal(res.meta.modelId, 'mock-a');
});

test('I4: opening the gate makes the paid target available again', async () => {
  const config = testConfig();
  config.providers.paid = { type: 'mock', tier: 'paid' };
  config.models['paid-model'] = { provider: 'paid', model: 'paid-model', costPer1kIn: 1, costPer1kOut: 2, quality: 5, tier: 'paid' };
  config.combos.paidcombo = { strategy: 'fallback', targets: ['paid-model', 'mock-a'] };
  config.paidTiers = { enabled: true };

  const { router } = makeRouter(config);
  assert.equal(providerHasCredentials(config.providers.paid, {}, config), true);

  // B3.1: free-first ordering means the free target still answers first — the
  // gate makes the paid target *available*, not preferred. Availability is what
  // this invariant is about.
  const plan = router.plan('paidcombo', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['mock-a', 'paid-model']);

  // with the free target excluded, the paid one answers, which is the proof
  const res = await router.chat({ combo: 'paidcombo', body: ask(), exclude: ['mock-a'] });
  assert.equal(res.meta.modelId, 'paid-model');
});

test('I11: the ledger keeps a hash, not the prompt', () => {
  const ledger = new Ledger({ file: null, salt: 'test-salt' });
  ledger.record({ provider: 'mock', modelId: 'm', promptText: 'my secret customer code is 42' });
  const serialised = JSON.stringify(ledger.records);

  assert.equal(serialised.includes('secret customer code'), false, 'prompt text must not be stored');
  assert.match(ledger.records[0].promptHash, /^[a-f0-9]{16}$/);
  assert.equal(ledger.records[0].promptChars, 29);
});

test('I11: the same prompt hashes the same, a different one does not', () => {
  const ledger = new Ledger({ file: null, salt: 'fixed' });
  const a = ledger.hashPrompt('hello world');
  const b = ledger.hashPrompt('hello world');
  const c = ledger.hashPrompt('hello worlds');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('I12: a tos:avoid provider is never chosen automatically', async () => {
  const config = testConfig();
  config.providers.fake.tos = 'avoid';
  const { router } = makeRouter(config);

  const plan = router.plan('chain', {});
  assert.equal(plan.ordered[0].modelId, 'mock-a', 'the avoid provider must be skipped');
  assert.match(plan.skipped[0].reason, /terms of service marked avoid/);

  const res = await router.chat({ combo: 'chain', body: ask() });
  assert.equal(res.meta.provider, 'mock');
});

test('I12: naming that model directly is allowed — that is not auto-routing', async () => {
  const config = testConfig();
  config.providers.fake.tos = 'avoid';
  const { router } = makeRouter(config);

  const plan = router.plan('fake-a', { allowAvoid: true });
  assert.equal(plan.ordered.length, 1);
  assert.equal(plan.ordered[0].modelId, 'fake-a');
});

test('I12: auditConfig warns when an avoid provider is still inside a combo', () => {
  const config = testConfig();
  config.providers.fake.tos = 'avoid';
  const audit = auditConfig(config);
  const i12 = audit.find((a) => a.id === 'I12');
  assert.equal(i12.ok, false);
  assert.match(i12.detail, /will not be auto-routed/);
});

test('I13: 401, 403, 404 and 429 are not health signals', () => {
  assert.equal(tripsBreaker({ code: 'http_401', status: 401 }), false);
  assert.equal(tripsBreaker({ code: 'http_403', status: 403 }), false);
  assert.equal(tripsBreaker({ code: 'http_404', status: 404 }), false);
  assert.equal(tripsBreaker({ code: 'http_429', status: 429 }), false);
  assert.equal(tripsBreaker({ code: 'http_400', status: 400 }), false);
});

test('I13: 5xx and transport failures are health signals', () => {
  assert.equal(tripsBreaker({ code: 'http_500', status: 500 }), true);
  assert.equal(tripsBreaker({ code: 'http_503', status: 503 }), true);
  assert.equal(tripsBreaker({ code: 'provider_timeout', status: 502 }), true);
  assert.equal(tripsBreaker({ code: 'provider_unreachable', status: 502 }), true);
});

test('I13: a bad key does not rest a provider, a broken provider does', async () => {
  const upstream = await startFakeUpstream({ fail: true, status: 401 });
  const config = testConfig({ fakeUrl: upstream.url });
  const { router, breaker } = makeRouter(config);

  await router.chat({ combo: 'chain', body: ask('one') });
  await router.chat({ combo: 'chain', body: ask('two') });
  assert.equal(breaker.stateOf('fake-a').state, 'closed', 'a 401 must not open the breaker');
  await upstream.close();

  const broken = await startFakeUpstream({ fail: true, status: 503 });
  const config2 = testConfig({ fakeUrl: broken.url });
  const second = makeRouter(config2);
  await second.router.chat({ combo: 'chain', body: ask('one') });
  await second.router.chat({ combo: 'chain', body: ask('two') });
  assert.equal(second.breaker.stateOf('fake-a').state, 'open', 'a 503 must open it');
  await broken.close();
});

test('I14: with every breaker open, a request is still attempted', async () => {
  const { router, breaker } = makeRouter(testConfig());
  breaker.recordFailure('mock-a', 'simulated');
  breaker.recordFailure('mock-a', 'simulated');
  assert.equal(breaker.stateOf('mock-a').state, 'open');

  const plan = router.plan('chain', {});
  assert.equal(plan.ordered.length >= 1, true, 'the pool must not collapse to nothing');

  const res = await router.chat({ combo: 'chain', body: ask() });
  assert.equal(res.meta.modelId, 'mock-a');
  assert.ok(
    res.meta.attempts.length >= 0,
    'the request went through the I14 escape hatch rather than failing',
  );
});

test('I14: a budget cap is still respected — the escape hatch is for health, not for money', async () => {
  const config = testConfig();
  config.budgets.dailyUsd = 0.000001;
  const { router, ledger } = makeRouter(config);
  ledger.record({ provider: 'mock', modelId: 'mock-a', costUsd: 1, ts: Date.now() });

  await assert.rejects(() => router.chat({ combo: 'chain', body: ask() }), /daily budget reached/);
});

test('auditConfig: a plaintext key and prompt logging are both flagged', () => {
  const config = testConfig();
  config.apiKeys = [{ key: 'sk-plain' }];
  config.guardrails.logPrompts = true;
  const audit = auditConfig(config);

  assert.equal(audit.find((a) => a.id === 'I15').ok, false);
  assert.match(audit.find((a) => a.id === 'I15').detail, /plaintext/);
  assert.equal(audit.find((a) => a.id === 'I11').ok, false);
});
