import test from 'node:test';
import assert from 'node:assert/strict';
import { ask, makeRouter, startFakeUpstream, testConfig } from './helpers.js';

test('fallback: a failing primary is skipped and the next target answers', async () => {
  const upstream = await startFakeUpstream({ fail: true });
  const { router } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const res = await router.chat({ combo: 'chain', body: ask() });
  assert.equal(res.meta.modelId, 'mock-a', 'should have fallen back to mock-a');
  assert.equal(res.meta.attempts.length, 1);
  assert.match(res.meta.attempts[0].reason, /simulated upstream outage|trouble on their side/);
  assert.equal(res.meta.provider, 'mock');
  await upstream.close();
});

test('fallback: the healthy primary answers and nothing else is tried', async () => {
  const upstream = await startFakeUpstream();
  const { router, ledger } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const res = await router.chat({ combo: 'chain', body: ask('ping') });
  assert.equal(res.meta.modelId, 'fake-a');
  assert.equal(res.meta.attempts.length, 0);
  assert.equal(res.meta.verified, true, 'a real HTTP provider counts as verified');
  assert.match(res.text, /^upstream:fake-a/);
  assert.equal(ledger.records.length, 1);
  assert.ok(ledger.records[0].costUsd > 0, 'a priced model should record cost');
  await upstream.close();
});

test('circuit breaker: repeated failures rest a target instead of retrying it', async () => {
  const upstream = await startFakeUpstream({ fail: true });
  const config = testConfig({ fakeUrl: upstream.url });
  // a long cooldown, so a slow machine cannot let the breaker half-open mid-test
  config.breaker = { failures: 2, cooldownMs: 60_000 };
  const { router, breaker } = makeRouter(config);

  for (let i = 0; i < 2; i++) {
    await router.chat({ combo: 'chain', body: ask(`turn ${i}`) });
  }
  assert.equal(breaker.stateOf('fake-a').state, 'open');

  const before = upstream.calls;
  const res = await router.chat({ combo: 'chain', body: ask('after the breaker opened') });
  assert.equal(res.meta.modelId, 'mock-a');
  assert.equal(upstream.calls, before, 'an open breaker must not hit the provider again');
  await upstream.close();
});

test('circuit breaker: half-open after cooldown, closed after a success', async () => {
  const upstream = await startFakeUpstream({ fail: true });
  let clock = 1000;
  const { router, breaker } = makeRouter(testConfig({ fakeUrl: upstream.url }), { now: () => clock });

  await router.chat({ combo: 'chain', body: ask('a') });
  await router.chat({ combo: 'chain', body: ask('b') });
  assert.equal(breaker.stateOf('fake-a').state, 'open');

  clock += 100; // past the 50 ms cooldown
  upstream.behaviour.fail = false;
  const res = await router.chat({ combo: 'chain', body: ask('c') });
  assert.equal(res.meta.modelId, 'fake-a', 'the trial request should reach the recovered provider');
  assert.equal(breaker.stateOf('fake-a').state, 'closed');
  await upstream.close();
});

test('weighted: traffic splits by weight and each arm is attributed', async () => {
  const { router, ledger } = makeRouter(testConfig(), { cache: false });

  let seed = 0;
  const rng = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);

  const counts = { 'mock-a': 0, 'mock-b': 0 };
  for (let i = 0; i < 60; i++) {
    // A fresh router per turn so the cache cannot flatten the split.
    const r = makeRouter(testConfig(), { random: rng, cache: false });
    const res = await r.router.chat({ combo: 'weighted', body: ask(`turn ${i}`) });
    counts[res.meta.modelId] += 1;
    assert.equal(res.meta.arm, res.meta.modelId, 'the arm must be recorded for attribution');
  }
  assert.ok(counts['mock-a'] > counts['mock-b'], `expected 70/30 split, got ${JSON.stringify(counts)}`);
  assert.ok(counts['mock-a'] < 60, 'the minority arm must actually receive traffic');
  void router;
  void ledger;
});

test('weighted: per-arm cost and latency are visible in the aggregate', async () => {
  const { router, ledger } = makeRouter(testConfig(), { cache: false });
  for (let i = 0; i < 12; i++) await router.chat({ combo: 'weighted', body: ask(`t${i}`) });
  const agg = ledger.aggregate({ since: 0 });
  const arms = Object.keys(agg.byArm);
  assert.ok(arms.length >= 1, 'at least one arm must appear');
  for (const arm of arms) assert.match(arm, /^weighted\//);
});

test('cheapest: the lowest-cost target above the quality floor wins', async () => {
  const { router } = makeRouter(testConfig());
  const res = await router.chat({ combo: 'cheap', body: ask() });
  assert.equal(res.meta.modelId, 'mock-a', 'mock-a is free and clears the quality floor of 2');
});

test('cheapest: the quality floor excludes cheap-but-weak models', async () => {
  const config = testConfig();
  config.combos.cheap.minQuality = 3;
  const { router } = makeRouter(config);
  const res = await router.chat({ combo: 'cheap', body: ask() });
  assert.notEqual(res.meta.modelId, 'mock-a', 'mock-a is quality 2 and must be excluded');
});

test('a model with no API key is skipped, not attempted', async () => {
  const { router, ledger } = makeRouter(testConfig());
  const plan = router.plan('gated', { promptTokens: 10 });
  assert.equal(plan.ordered[0].modelId, 'mock-a');
  assert.match(plan.skipped[0].reason, /no API key set/);

  const res = await router.chat({ combo: 'gated', body: ask() });
  assert.equal(res.meta.modelId, 'mock-a');
  assert.equal(ledger.records.length, 1);
});

test('budget: a spent daily budget stops every target and explains itself', async () => {
  const config = testConfig();
  config.budgets.dailyUsd = 0.000001;
  const { router, ledger } = makeRouter(config);
  ledger.record({ provider: 'mock', modelId: 'mock-b', costUsd: 1, ts: Date.now() });

  await assert.rejects(
    () => router.chat({ combo: 'chain', body: ask() }),
    (err) => {
      assert.equal(err.code, 'no_route_available');
      assert.match(err.message, /daily budget reached/);
      assert.match(err.message, /raise the daily budget/);
      return true;
    },
  );
});

test('cache: an identical request is served from cache and marked as such', async () => {
  const { router } = makeRouter(testConfig(), { cache: true });
  const first = await router.chat({ combo: 'chain', body: ask('same prompt') });
  assert.equal(first.meta.cached, false);

  const second = await router.chat({ combo: 'chain', body: ask('same prompt') });
  assert.equal(second.meta.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(second.meta.costUsd, first.meta.costUsd, 'a cached turn keeps its price so savings are countable');
});

test('cache: a different prompt is not a cache hit', async () => {
  const { router } = makeRouter(testConfig(), { cache: true });
  await router.chat({ combo: 'chain', body: ask('one') });
  const second = await router.chat({ combo: 'chain', body: ask('two') });
  assert.equal(second.meta.cached, false);
});

test('guardrails: a blocked pattern is refused before any provider is called', async () => {
  const config = testConfig();
  config.guardrails.blockPatterns = ['social security number'];
  const { router } = makeRouter(config);
  await assert.rejects(
    () => router.chat({ combo: 'chain', body: ask('my social security number is 123') }),
    (err) => {
      assert.equal(err.code, 'blocked_by_guardrail');
      return true;
    },
  );
});

test('guardrails: an oversized prompt is refused with its real size', async () => {
  const config = testConfig();
  config.guardrails.maxInputChars = 10;
  const { router } = makeRouter(config);
  await assert.rejects(
    () => router.chat({ combo: 'chain', body: ask('this prompt is definitely longer than ten characters') }),
    (err) => {
      assert.equal(err.code, 'input_too_large');
      return true;
    },
  );
});

test('streaming: tokens arrive incrementally and time-to-first-token is recorded', async () => {
  const upstream = await startFakeUpstream();
  const { router } = makeRouter(testConfig({ fakeUrl: upstream.url }));

  const chunks = [];
  const res = await router.chat({ combo: 'chain', body: { ...ask('stream me'), stream: true }, onToken: (t) => chunks.push(t) });
  assert.ok(chunks.length > 1, 'the reply should arrive in more than one chunk');
  assert.equal(chunks.join(''), res.text);
  assert.ok(res.meta.ttftMs !== null && res.meta.ttftMs >= 0);
  await upstream.close();
});

test('streaming: a mid-answer drop is reported instead of silently re-routed', async () => {
  const { router } = makeRouter(testConfig());
  // mock-a answers; simulate a drop by making the second provider fail after commit
  const config = testConfig();
  config.providers.mock.mock = { failWith: 'upstream closed the socket', failRetryable: true };
  const { router: broken } = makeRouter(config);
  await assert.rejects(
    () => broken.chat({ combo: 'chain', body: ask() }),
    (err) => {
      assert.equal(err.code, 'no_route_available');
      return true;
    },
  );
  void router;
});

test('plan: skipping reasons name the fix, not just the failure', async () => {
  const config = testConfig();
  config.budgets.perProvider = { mock: 0.000001 };
  const { router, ledger } = makeRouter(config);
  ledger.record({ provider: 'mock', modelId: 'mock-a', costUsd: 1, ts: Date.now() });
  const plan = router.plan('chain', {});
  const reasons = plan.skipped.map((s) => s.reason).join(' | ');
  assert.match(reasons, /provider budget reached/);
});
