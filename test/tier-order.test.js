import test from 'node:test';
import assert from 'node:assert/strict';
import { tierRank } from '@sui/core';
import { makeRouter, testConfig, ask } from './helpers.js';

function tieredConfig() {
  const config = testConfig();
  config.providers.freebie = { type: 'mock', mock: { delayMs: 1 }, tier: 'free' };
  config.providers.payg = { type: 'mock', mock: { delayMs: 1 }, tier: 'paid' };
  config.models['free-1'] = { provider: 'freebie', model: 'free-model', costPer1kIn: 0, costPer1kOut: 0, quality: 3 };
  config.models['paid-1'] = { provider: 'payg', model: 'paid-model', costPer1kIn: 5, costPer1kOut: 5, quality: 5 };
  // paid declared first on purpose: this is the mistake the rule exists to prevent
  config.combos.mixed = { strategy: 'fallback', targets: ['paid-1', 'free-1'] };
  config.paidTiers = { enabled: true };
  return config;
}

test('tierRank puts a free provider before a paid one', () => {
  const config = tieredConfig();
  assert.equal(tierRank(config.models['free-1'], config), 0);
  assert.equal(tierRank(config.models['paid-1'], config), 1);
  assert.equal(tierRank({ provider: 'missing' }, config), 0, 'an unknown provider is not assumed paid');
});

test('a paid target declared first does not get the traffic', async () => {
  const { router } = makeRouter(tieredConfig());
  const plan = router.plan('mixed', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['free-1', 'paid-1']);

  const res = await router.chat({ combo: 'mixed', body: ask('hello') });
  assert.equal(res.meta.modelId, 'free-1');
});

test('a combo can opt out of free-first when it really wants the strong model', async () => {
  const config = tieredConfig();
  config.combos.mixed.freeFirst = false;
  const { router } = makeRouter(config);
  const plan = router.plan('mixed', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['paid-1', 'free-1'], 'the declared order stands');
});

test('the gateway can turn the rule off globally', async () => {
  const config = tieredConfig();
  config.routing = { freeFirst: false };
  const { router } = makeRouter(config);
  const plan = router.plan('mixed', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['paid-1', 'free-1']);
});

test('free-first does not change the order within a tier', async () => {
  const config = tieredConfig();
  config.models['free-2'] = { provider: 'freebie', model: 'free-model-2', costPer1kIn: 0, costPer1kOut: 0, quality: 2 };
  config.combos.mixed.targets = ['paid-1', 'free-2', 'free-1'];
  const { router } = makeRouter(config);
  const plan = router.plan('mixed', {});
  assert.deepEqual(plan.ordered.map((t) => t.modelId), ['free-2', 'free-1', 'paid-1'], 'declared order inside each tier');
});

test('a free target that is resting still loses to an available paid one', async () => {
  const config = tieredConfig();
  const { router, breaker } = makeRouter(config);
  for (let i = 0; i < 5; i++) breaker.recordFailure('free-1', 'boom');

  const res = await router.chat({ combo: 'mixed', body: ask('hello') });
  assert.equal(res.meta.modelId, 'paid-1', 'health beats tier when the free one is out');
});
